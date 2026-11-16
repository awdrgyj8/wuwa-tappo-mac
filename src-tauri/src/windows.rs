use crate::{
    geometry::{work_area_insets, HitRegion},
    session::SessionStore,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, RwLock,
    },
    time::{Duration, Instant},
};
use tauri::{
    utils::config::BackgroundThrottlingPolicy, AppHandle, Emitter, Listener, LogicalPosition,
    LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

/// Closed secondary windows keep a whole WebView process alive while hidden. These ones
/// rebuild cleanly from their route, so they are destroyed after staying closed for a while.
const RELEASABLE_WINDOWS: &[&str] = &["panel", "about", "oss-notice", "update"];
const RELEASE_CLOSED_WINDOW_AFTER: Duration = Duration::from_secs(60);

// Click-through follows the cursor. The input tap reports every movement while
// it runs; otherwise a background thread samples the cursor through CoreGraphics.
// Neither path needs the main thread unless the click-through state changes.
const PASSTHROUGH_MOVING_POLL: Duration = Duration::from_millis(16);
const PASSTHROUGH_IDLE_POLL: Duration = Duration::from_millis(100);
const PASSTHROUGH_TAP_POLL: Duration = Duration::from_millis(250);
const PASSTHROUGH_SETTLE: Duration = Duration::from_secs(1);
const GEOMETRY_SAFETY_REFRESH: Duration = Duration::from_secs(2);
// Logical pixels around pet/dock content that still count as "near" for input pacing.
const INTERACTIVE_MARGIN: f64 = 64.;

pub const COMMANDS: &[&str] = &[
    "apply_main_window_position",
    "close_about_window",
    "close_login_window",
    "close_oss_notice_window",
    "close_panel_window",
    "close_update_window",
    "ensure_main_taskbar_icon",
    "exit_app",
    "finish_main_window_monitor_switch",
    "get_app_update_detail",
    "get_main_desktop_safe_area",
    "get_main_taskbar_insets",
    "get_maintenance_notice_payload",
    "has_maintenance_notice",
    "hide_main_after_maintenance_notice_ready",
    "is_force_update_locked",
    "open_about_window",
    "open_login_window",
    "open_maintenance_notice",
    "open_oss_notice_window",
    "open_panel_window",
    "open_update_window",
    "popup_main_dock_context_menu",
    "raise_panel_window_above_pets",
    "resize_login_window_to_content",
    "set_main_force_cursor_ignore",
    "set_main_hit_region",
    "set_main_skip_taskbar",
    "set_main_swallow_mouse",
    "set_main_window_content_bounds",
    "set_main_window_fullscreen_shell",
    "set_main_window_monitor_bounds",
    "set_native_input_cursor",
    "set_overlay_cursor",
    "set_panel_window_collapsed",
    "show_toast_overlay",
    "sync_aux_windows_to_main_monitor",
    "sync_main_window_to_current_monitor",
    "sync_native_menu",
    "sync_auto_chest_menu",
    "login_window_ready",
];

#[derive(Default)]
pub struct WindowState {
    hit: RwLock<HitState>,
    update: Mutex<Value>,
    maintenance: Mutex<Option<Value>>,
    panel_collapsed: Mutex<bool>,
    pending_login: Mutex<Option<Value>>,
    login_ready: AtomicBool,
    auxiliary: RwLock<BTreeMap<String, HitRegion>>,
    main_geometry: RwLock<MainGeometry>,
    stop: AtomicBool,
    closed: Mutex<BTreeMap<String, u64>>,
    close_generation: AtomicU64,
    /// Click-through state the cursor currently calls for.
    passthrough: Mutex<Option<bool>>,
    /// Click-through state last set on the window (main thread only).
    passthrough_applied: Mutex<Option<bool>>,
    /// Last time the input tap reported the cursor.
    cursor_observed_at: Mutex<Option<Instant>>,
}

#[derive(Clone, Copy, Default)]
struct MainGeometry {
    left: f64,
    top: f64,
    scale: f64,
}

#[derive(Default)]
struct HitState {
    regions: Vec<HitRegion>,
    input_regions: Vec<HitRegion>,
    window_passthrough: bool,
    force_ignore: bool,
    swallow: bool,
}

impl HitState {
    /// Whether a cursor at main-window logical coordinates should click through the pet window.
    fn ignores_cursor(&self, x: f64, y: f64) -> bool {
        if self.swallow {
            return false;
        }
        if self.force_ignore {
            return true;
        }
        let regions = if self.window_passthrough {
            &self.input_regions
        } else {
            &self.regions
        };
        !regions.iter().any(|r| r.contains(x, y))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HitUpdate {
    regions: Vec<HitRegion>,
    #[serde(default)]
    input_regions: Vec<HitRegion>,
    #[serde(default)]
    update_native_input: bool,
    #[serde(default)]
    window_passthrough: bool,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".into())
}

fn initialize(app: &AppHandle, label: &str) -> Result<String, String> {
    let script = app.state::<SessionStore>().initialization_script()?;
    let preferences = app
        .try_state::<crate::preferences::PreferenceStore>()
        .map(|store| store.initialization_script())
        .unwrap_or_default();
    // Preferences wrap Storage before the session bridge captures its methods.
    let mut initialization = format!(
        "{}\n{preferences}\n{}\n{script}\n{}\n{}\n{}",
        crate::profile::Region::from_app(app).initialization_script(),
        include_str!("../../scripts/mac-preferences.js"),
        include_str!("../../scripts/mac-websocket.js"),
        include_str!("../../scripts/mac-platform.js"),
        include_str!("../../scripts/mac-auto-chest.js")
    );
    if label == "main" && cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--self-test")
    {
        initialization.push_str(include_str!("../../scripts/runtime-smoke.js"));
    }
    Ok(initialization)
}

fn refresh_geometry(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or("Window geometry unavailable")?;
    let scale = window.scale_factor().map_err(err)?;
    let pos = window.inner_position().map_err(err)?;
    let state = app.state::<WindowState>();
    if label == "main" {
        *state.main_geometry.write().map_err(err)? = MainGeometry {
            left: pos.x as f64 / scale,
            top: pos.y as f64 / scale,
            scale,
        };
    } else if label != "toast" {
        let pos = window.outer_position().map_err(err)?;
        let size = window.outer_size().map_err(err)?;
        state.auxiliary.write().map_err(err)?.insert(
            label.to_string(),
            HitRegion {
                left: pos.x as f64 / scale,
                top: pos.y as f64 / scale,
                width: size.width as f64 / scale,
                height: size.height as f64 / scale,
                member_id: None,
            },
        );
    }
    Ok(())
}

/// Applies main-window click-through for a global logical cursor point. Only a
/// change reaches AppKit; everything else comes from cached geometry and regions.
fn apply_passthrough(app: &AppHandle, x: f64, y: f64) -> Result<(), String> {
    let state = app.state::<WindowState>();
    let geometry = *state.main_geometry.read().map_err(err)?;
    let ignored = state
        .hit
        .read()
        .map_err(err)?
        .ignores_cursor(x - geometry.left, y - geometry.top);
    {
        let mut desired = state.passthrough.lock().map_err(err)?;
        if *desired == Some(ignored) {
            return Ok(());
        }
        *desired = Some(ignored);
    }
    // Callers on other threads reach AppKit through the event loop while main-
    // thread callers do not, so requests can arrive out of order. The main thread
    // therefore applies whatever state is desired when it runs, never a stale one.
    if objc2::MainThreadMarker::new().is_some() {
        return sync_passthrough(app);
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = sync_passthrough(&handle) {
            eprintln!("Click-through update failed: {error}");
        }
    })
    .map_err(err)
}

fn sync_passthrough(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<WindowState>();
    let Some(desired) = *state.passthrough.lock().map_err(err)? else {
        return Ok(());
    };
    let mut applied = state.passthrough_applied.lock().map_err(err)?;
    if *applied != Some(desired) {
        main_window(app)?
            .set_ignore_cursor_events(desired)
            .map_err(err)?;
        *applied = Some(desired);
    }
    Ok(())
}

/// Re-evaluates click-through at the current cursor after regions, flags or
/// geometry changed, instead of waiting for the next movement.
fn refresh_passthrough(app: &AppHandle) -> Result<(), String> {
    match crate::input::cursor_location() {
        Some((x, y)) => apply_passthrough(app, x, y),
        None => Ok(()),
    }
}

/// Records a click-through state that a command set on the window directly
/// (main thread), so queued updates and later changes compare against it.
fn assume_passthrough(app: &AppHandle, ignored: bool) -> Result<(), String> {
    let state = app.state::<WindowState>();
    *state.passthrough.lock().map_err(err)? = Some(ignored);
    *state.passthrough_applied.lock().map_err(err)? = Some(ignored);
    Ok(())
}

/// Main-thread refresh after the main window was moved or resized by a command.
fn refresh_main_layout(app: &AppHandle) -> Result<(), String> {
    refresh_geometry(app, "main")?;
    refresh_passthrough(app)
}

/// WebKit suspends a page it considers inactive (for example while the screen saver or
/// another window covers it), which stopped click reporting, the room socket and the
/// automatic chest claim for as long as the user was away. The always-visible pet
/// keeps running; other windows keep WebKit's default.
fn background_policy(label: &str) -> Option<BackgroundThrottlingPolicy> {
    (label == "main").then_some(BackgroundThrottlingPolicy::Disabled)
}

fn build_window(
    app: &AppHandle,
    label: &str,
    route: &str,
    size: (f64, f64),
    focus: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("index.html#{route}").into()),
    );
    if let Some(policy) = background_policy(label) {
        builder = builder.background_throttling(policy);
    }
    let window = builder
    .title(crate::profile::Region::from_app(app).name())
    .initialization_script(initialize(app, label)?)
    .on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
            crate::socket::close_window(window.app_handle(), window.label());
            if let Err(error) = crate::shortcuts::release_capture(window.app_handle(), window.label()) {
                eprintln!("Could not restore shortcuts after page reload: {error}");
            }
        }
    })
    .inner_size(size.0, size.1)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(label == "panel")
    .maximizable(false)
    .visible(false)
    .focused(focus)
    .focusable(focus)
    .always_on_top(true)
    .disable_drag_drop_handler()
    .build()
    .map_err(err)?;
    window.set_visible_on_all_workspaces(true).map_err(err)?;
    if label == "panel" {
        window
            .set_min_size(Some(LogicalSize::new(1100., 760.)))
            .map_err(err)?;
    }
    window.on_window_event({
        let app = app.clone();
        let label = label.to_string();
        move |event| {
            if matches!(event, tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }) {
                if let Err(error) = crate::shortcuts::release_capture(&app, &label) {
                    eprintln!("Could not restore shortcuts after {label} lost focus: {error}");
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                crate::socket::close_window(&app, &label);
            }
            if matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                let tracked = label == "main"
                    || app
                        .state::<WindowState>()
                        .auxiliary
                        .read()
                        .is_ok_and(|windows| windows.contains_key(&label));
                if tracked {
                    let refreshed = if label == "main" {
                        refresh_main_layout(&app)
                    } else {
                        refresh_geometry(&app, &label)
                    };
                    if let Err(error) = refreshed {
                        eprintln!("Could not refresh {label} geometry: {error}");
                    }
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Ok(mut windows) = app.state::<WindowState>().auxiliary.write() {
                    windows.remove(&label);
                }
                if let Some(w) = app.get_webview_window(&label) {
                    if let Err(error) = w.hide() {
                        eprintln!("Could not hide {label}: {error}");
                    }
                    schedule_release(&app, &label);
                }
                if label == "panel" {
                    if let Err(error) = app.emit("cat-panel-window-closed", ()) {
                        eprintln!("Panel close event failed: {error}");
                    }
                }
                if label == "login" {
                    if let Err(error) = app.emit("cat-login-overlay", json!({"open":false})) {
                        eprintln!("Login close event failed: {error}");
                    }
                }
            }
        }
    });
    Ok(window)
}

fn show_aux(
    app: &AppHandle,
    label: &str,
    route: &str,
    size: (f64, f64),
) -> Result<(WebviewWindow, bool), String> {
    app.state::<WindowState>()
        .closed
        .lock()
        .map_err(err)?
        .remove(label);
    let existing = app.get_webview_window(label);
    let existed = existing.is_some();
    let window = match existing {
        Some(w) => w,
        None => build_window(app, label, route, size, true)?,
    };
    center_on_main(app, &window)?;
    window.show().map_err(err)?;
    window.set_focus().map_err(err)?;
    refresh_geometry(app, label)?;
    Ok((window, existed))
}

// `Option::or` would evaluate the primary-display query even when the current
// display is known; each query enumerates NSScreen.
fn current_or_primary_monitor(window: &WebviewWindow) -> Result<tauri::Monitor, String> {
    match window.current_monitor().map_err(err)? {
        Some(monitor) => Ok(monitor),
        None => window
            .primary_monitor()
            .map_err(err)?
            .ok_or_else(|| "No display is available".into()),
    }
}

fn center_on_main(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let main = main_window(app)?;
    let monitor = current_or_primary_monitor(&main)?;
    let size = window
        .outer_size()
        .map_err(err)?
        .to_logical::<f64>(window.scale_factor().map_err(err)?);
    let work = monitor.work_area();
    let scale = monitor.scale_factor();
    window
        .set_position(LogicalPosition::new(
            work.position.x as f64 / scale + (work.size.width as f64 / scale - size.width) / 2.,
            work.position.y as f64 / scale + (work.size.height as f64 / scale - size.height) / 2.,
        ))
        .map_err(err)
}

fn fullscreen_shell(app: &AppHandle) -> Result<(), String> {
    let w = main_window(app)?;
    let monitor = current_or_primary_monitor(&w)?;
    w.set_position(*monitor.position()).map_err(err)?;
    w.set_size(*monitor.size()).map_err(err)?;
    Ok(())
}

fn safe_area(app: &AppHandle) -> Result<Value, String> {
    let w = main_window(app)?;
    let m = w
        .current_monitor()
        .map_err(err)?
        .ok_or("No current display")?;
    let p = m.position();
    let s = m.size();
    let a = m.work_area();
    let insets = work_area_insets(
        (p.x as f64, p.y as f64, s.width as f64, s.height as f64),
        (
            a.position.x as f64,
            a.position.y as f64,
            a.size.width as f64,
            a.size.height as f64,
        ),
        m.scale_factor(),
    );
    Ok(
        json!({"insets": insets, "autoHideEdge": null, "foregroundFullscreen": foreground_fullscreen(app)?,
            "foregroundApplicationFullscreen": crate::fullscreen::foreground_application_fullscreen()?}),
    )
}

// Other applications' window content is never inspected. macOS supplies the
// current Space's fullscreen presentation state through the application's menu.
fn foreground_fullscreen(_app: &AppHandle) -> Result<bool, String> {
    use objc2_app_kit::{NSApplication, NSApplicationPresentationOptions};
    let mtm =
        objc2::MainThreadMarker::new().ok_or("Screen state must be read on the main thread")?;
    Ok(NSApplication::sharedApplication(mtm)
        .currentSystemPresentationOptions()
        .contains(NSApplicationPresentationOptions::FullScreen))
}

fn payload(args: &Value) -> &Value {
    args.get("payload").unwrap_or(args)
}
fn number(args: &Value, name: &str) -> Result<f64, String> {
    args.get(name)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("Invalid {name}"))
}

fn schedule_release(app: &AppHandle, label: &str) {
    if !RELEASABLE_WINDOWS.contains(&label) {
        return;
    }
    let state = app.state::<WindowState>();
    let generation = state.close_generation.fetch_add(1, Ordering::AcqRel) + 1;
    match state.closed.lock() {
        Ok(mut closed) => closed.insert(label.to_string(), generation),
        Err(_) => return,
    };
    let app = app.clone();
    let label = label.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(RELEASE_CLOSED_WINDOW_AFTER);
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || release(&handle, &label, generation)) {
            eprintln!("Could not schedule closed window release: {error}");
        }
    });
}

fn release(app: &AppHandle, label: &str, generation: u64) {
    let state = app.state::<WindowState>();
    let Ok(mut closed) = state.closed.lock() else {
        return;
    };
    if closed.get(label) != Some(&generation) {
        return;
    }
    closed.remove(label);
    drop(closed);
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    if window.is_visible().unwrap_or(true) {
        return;
    }
    if label == "panel" {
        // A rebuilt panel starts at its expanded default size.
        if let Ok(mut collapsed) = state.panel_collapsed.lock() {
            *collapsed = false;
        }
    }
    if let Err(error) = window.destroy() {
        eprintln!("Could not release closed {label} window: {error}");
    }
}

fn close(app: &AppHandle, label: &str) -> Result<Value, String> {
    app.state::<WindowState>()
        .auxiliary
        .write()
        .map_err(err)?
        .remove(label);
    if let Some(w) = app.get_webview_window(label) {
        w.hide().map_err(err)?;
        schedule_release(app, label);
    }
    if label == "panel" {
        app.emit("cat-panel-window-closed", ()).map_err(err)?;
    }
    if label == "login" {
        app.emit("cat-login-overlay", json!({"open": false}))
            .map_err(err)?;
    }
    Ok(Value::Null)
}

pub fn dispatch(
    app: &AppHandle,
    label: &str,
    command: &str,
    args: &Value,
) -> Result<Value, String> {
    let state = app.state::<WindowState>();
    match command {
        "open_about_window" => {
            let (w, existed) = show_aux(app, "about", "/about", (680., 700.))?;
            if existed {
                w.emit("about-open", ()).map_err(err)?;
            }
        }
        "open_oss_notice_window" => {
            let (w, existed) = show_aux(app, "oss-notice", "/oss-notice", (780., 680.))?;
            if existed {
                w.emit("oss-notice-open", ()).map_err(err)?;
            }
        }
        "open_login_window" => {
            let intent = args
                .get("intent")
                .and_then(Value::as_str)
                .unwrap_or("login");
            if !["login", "show"].contains(&intent) {
                return Err("Unknown login intent".into());
            }
            *state.pending_login.lock().map_err(err)? =
                Some(json!({"intent":intent,"compact":args.get("compact")}));
            let (w, _) = show_aux(app, "login", "/login", (600., 660.))?;
            app.emit("cat-login-overlay", json!({"open": true}))
                .map_err(err)?;
            if state.login_ready.load(Ordering::Acquire) {
                if let Some(pending) = state.pending_login.lock().map_err(err)?.take() {
                    w.emit("login-modal-open", pending).map_err(err)?;
                }
            }
        }
        "login_window_ready" => {
            if label != "login" {
                return Err("Login readiness requires the login window".into());
            }
            state.login_ready.store(true, Ordering::Release);
            if let Some(pending) = state.pending_login.lock().map_err(err)?.take() {
                app.get_webview_window("login")
                    .ok_or("Login window is unavailable")?
                    .emit("login-modal-open", pending)
                    .map_err(err)?;
            }
        }
        "open_panel_window" => {
            let tab = payload(args)
                .get("tab")
                .and_then(Value::as_str)
                .unwrap_or("bag");
            if !["bag", "atlas", "exchange", "room", "setting"].contains(&tab) {
                return Err("Unknown panel tab".into());
            }
            let (w, existed) = show_aux(app, "panel", &format!("/panel?tab={tab}"), (1100., 760.))?;
            if existed {
                w.emit("panel-open-tab", tab).map_err(err)?;
            }
        }
        "open_update_window" => {
            *state.update.lock().map_err(err)? = args.get("detail").cloned().unwrap_or(Value::Null);
            let (w, _) = show_aux(app, "update", "/update", (600., 500.))?;
            w.emit("update-modal-open", ()).map_err(err)?;
            w.emit(
                "cat-app-update-available",
                args.get("detail").cloned().unwrap_or(Value::Null),
            )
            .map_err(err)?;
        }
        "open_maintenance_notice" => {
            let notice = args.get("payload").cloned().filter(|v| !v.is_null());
            *state.maintenance.lock().map_err(err)? = Some(notice.clone().unwrap_or(Value::Null));
            let (w, _) = show_aux(app, "update", "/update", (600., 500.))?;
            w.emit("maintenance-notice-open", notice).map_err(err)?;
        }
        "close_about_window" => return close(app, "about"),
        "close_oss_notice_window" => return close(app, "oss-notice"),
        "close_login_window" => return close(app, "login"),
        "close_panel_window" => return close(app, "panel"),
        "close_update_window" => return close(app, "update"),
        "get_app_update_detail" => return Ok(state.update.lock().map_err(err)?.clone()),
        "get_maintenance_notice_payload" => {
            return Ok(state
                .maintenance
                .lock()
                .map_err(err)?
                .clone()
                .unwrap_or(Value::Null))
        }
        "has_maintenance_notice" => {
            return Ok(json!(state.maintenance.lock().map_err(err)?.is_some()))
        }
        "is_force_update_locked" => {
            let detail = state.update.lock().map_err(err)?;
            return Ok(json!(detail
                .get("forceUpdate")
                .or_else(|| detail.get("forced"))
                .and_then(Value::as_bool)
                .unwrap_or(false)));
        }
        "hide_main_after_maintenance_notice_ready" => main_window(app)?.hide().map_err(err)?,
        "resize_login_window_to_content" => {
            let p = payload(args);
            let width = number(p, "width")?;
            let height = number(p, "height")?;
            if width <= 0. || height <= 0. {
                return Err("Login dimensions must be positive".into());
            }
            let w = app
                .get_webview_window("login")
                .ok_or("Login window is unavailable")?;
            w.set_size(LogicalSize::new(width, height)).map_err(err)?;
            // Official 1.0.4 can ask to leave a login window where the user dragged it.
            if p.get("keepPosition").and_then(Value::as_bool) != Some(true) {
                center_on_main(app, &w)?;
            }
        }
        "raise_panel_window_above_pets" => {
            let w = app
                .get_webview_window("panel")
                .ok_or("Panel window is unavailable")?;
            w.set_always_on_top(true).map_err(err)?;
            w.set_focus().map_err(err)?;
        }
        "set_panel_window_collapsed" => {
            let w = app
                .get_webview_window("panel")
                .ok_or("Panel window is unavailable")?;
            let collapsed = payload(args)
                .get("collapsed")
                .and_then(Value::as_bool)
                .ok_or("Missing collapsed state")?;
            let mut previous = state.panel_collapsed.lock().map_err(err)?;
            if *previous != collapsed {
                let size = w
                    .inner_size()
                    .map_err(err)?
                    .to_logical::<f64>(w.scale_factor().map_err(err)?);
                let min_width = if collapsed { 958. } else { 1100. };
                w.set_min_size(Some(LogicalSize::new(min_width, 760.)))
                    .map_err(err)?;
                let width = (size.width + if collapsed { -142. } else { 142. }).max(min_width);
                w.set_size(LogicalSize::new(width, size.height.max(760.)))
                    .map_err(err)?;
                *previous = collapsed;
            }
        }
        "set_main_hit_region" => {
            let update: HitUpdate = serde_json::from_value(payload(args).clone()).map_err(err)?;
            if update
                .regions
                .iter()
                .chain(update.input_regions.iter())
                .any(|r| !r.is_valid())
            {
                return Err("Invalid hit region geometry".into());
            }
            {
                let mut hit = state.hit.write().map_err(err)?;
                hit.regions = update.regions;
                if update.update_native_input {
                    hit.input_regions = update.input_regions;
                }
                hit.window_passthrough = update.window_passthrough;
                hit.force_ignore = false;
            }
            refresh_passthrough(app)?;
        }
        "set_main_force_cursor_ignore" => {
            state.hit.write().map_err(err)?.force_ignore = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("Missing enabled state")?;
            main_window(app)?
                .set_ignore_cursor_events(true)
                .map_err(err)?;
            assume_passthrough(app, true)?;
            refresh_passthrough(app)?;
        }
        "set_main_swallow_mouse" => {
            let enabled = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("Missing enabled state")?;
            state.hit.write().map_err(err)?.swallow = enabled;
            if enabled {
                main_window(app)?
                    .set_ignore_cursor_events(false)
                    .map_err(err)?;
                assume_passthrough(app, false)?;
            }
            refresh_passthrough(app)?;
        }
        "set_main_window_fullscreen_shell" => {
            fullscreen_shell(app)?;
            refresh_main_layout(app)?;
        }
        "set_main_window_monitor_bounds" => {
            let p = payload(args);
            let x = number(p, "x")?;
            let y = number(p, "y")?;
            let width = number(p, "width")?;
            let height = number(p, "height")?;
            if width <= 0. || height <= 0. {
                return Err("Monitor dimensions must be positive".into());
            }
            let w = main_window(app)?;
            state.hit.write().map_err(err)?.force_ignore = true;
            w.set_ignore_cursor_events(true).map_err(err)?;
            assume_passthrough(app, true)?;
            let target = w
                .available_monitors()
                .map_err(err)?
                .into_iter()
                .find(|m| {
                    m.position().x == x as i32
                        && m.position().y == y as i32
                        && m.size().width == width as u32
                        && m.size().height == height as u32
                })
                .ok_or("Selected display is no longer available")?;
            let scale = target.scale_factor();
            w.set_position(LogicalPosition::new(x / scale, y / scale))
                .map_err(err)?;
            w.set_size(LogicalSize::new(width / scale, height / scale))
                .map_err(err)?;
            refresh_main_layout(app)?;
        }
        "finish_main_window_monitor_switch" => {
            state.hit.write().map_err(err)?.force_ignore = false;
            refresh_passthrough(app)?;
        }
        "set_main_window_content_bounds" => {
            let p = payload(args);
            let width = number(p, "width")?;
            let height = number(p, "height")?;
            if width <= 0. || height <= 0. {
                return Err("Window dimensions must be positive".into());
            }
            let w = main_window(app)?;
            if p.get("x").is_some() || p.get("y").is_some() {
                w.set_position(LogicalPosition::new(number(p, "x")?, number(p, "y")?))
                    .map_err(err)?;
            }
            w.set_size(LogicalSize::new(width, height)).map_err(err)?;
            refresh_main_layout(app)?;
        }
        "apply_main_window_position" => {
            let top = payload(args)
                .get("alwaysOnTop")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            main_window(app)?.set_always_on_top(top).map_err(err)?;
            // In the original fullscreen shell the Vue dock, not the OS window,
            // applies the selected corner; moving this window would move it twice.
            fullscreen_shell(app)?;
            refresh_main_layout(app)?;
        }
        "sync_main_window_to_current_monitor" => {
            let w = main_window(app)?;
            w.set_visible_on_all_workspaces(true).map_err(err)?;
        }
        "sync_aux_windows_to_main_monitor" => {
            for (name, w) in app.webview_windows() {
                if name != "main" && name != "toast" {
                    center_on_main(app, &w)?;
                }
            }
        }
        "get_main_desktop_safe_area" => return safe_area(app),
        "get_main_taskbar_insets" => return Ok(safe_area(app)?["insets"].clone()),
        "set_overlay_cursor" | "set_native_input_cursor" => {
            let kind = args
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("default");
            let cursor = match kind {
                "pointer" => tauri::CursorIcon::Hand,
                "grab" => tauri::CursorIcon::Grab,
                "grabbing" => tauri::CursorIcon::Grabbing,
                "default" => tauri::CursorIcon::Default,
                _ => return Err("Unsupported cursor".into()),
            };
            main_window(app)?.set_cursor_icon(cursor).map_err(err)?;
        }
        "ensure_main_taskbar_icon" => {
            app.set_dock_visibility(true).map_err(err)?;
            main_window(app)?.set_skip_taskbar(false).map_err(err)?;
        }
        "set_main_skip_taskbar" => {
            let skip = args.get("skip").and_then(Value::as_bool).ok_or("Missing skip state")?;
            app.set_dock_visibility(!skip).map_err(err)?;
            main_window(app)?.set_skip_taskbar(skip).map_err(err)?;
        }
        "show_toast_overlay" => {
            let w = if let Some(w) = app.get_webview_window("toast") {
                w
            } else {
                build_window(app, "toast", "/toast", (620., 160.), false)?
            };
            center_on_main(app, &w)?;
            w.set_ignore_cursor_events(true).map_err(err)?;
            w.show().map_err(err)?;
        }
        "sync_native_menu" => return crate::menu::sync(app, args),
        "sync_auto_chest_menu" => {
            if label != "main" {
                return Err("Auto chest records require the pet window".into());
            }
            return crate::menu::sync_auto_chest(app, args);
        }
        "popup_main_dock_context_menu" => {
            return crate::menu::popup(
                app,
                &main_window(app)?,
                number(args, "x")?,
                number(args, "y")?,
            )
        }
        "exit_app" => {
            state.stop.store(true, Ordering::Release);
            app.exit(0);
        }
        _ => return Err(format!("Unsupported native command {command} from {label}")),
    }
    Ok(Value::Null)
}

pub fn setup(app: &AppHandle) -> Result<(), String> {
    let w = build_window(app, "main", "/", (900., 650.), false)?;
    fullscreen_shell(app)?;
    refresh_geometry(app, "main")?;
    w.set_ignore_cursor_events(true).map_err(err)?;
    assume_passthrough(app, true)?;
    w.show().map_err(err)?;
    if cfg!(debug_assertions) && std::env::args().any(|arg| arg == "--inspect") {
        w.open_devtools();
    }
    let app_for_input = app.clone();
    app.state::<crate::input::InputMonitor>()
        .set_member_resolver(move |x, y| {
            let state = app_for_input.state::<WindowState>();
            let geometry = state.main_geometry.read().ok()?;
            let (x, y) = (
                x / geometry.scale - geometry.left,
                y / geometry.scale - geometry.top,
            );
            let hit = state.hit.read().ok()?;
            hit.input_regions
                .iter()
                .chain(hit.regions.iter())
                .rev()
                .find(|r| r.contains(x, y))
                .and_then(|r| r.member_id)
        })?;
    let app_for_auxiliary = app.clone();
    app.state::<crate::input::InputMonitor>()
        .set_auxiliary_hit_test(move |x, y| {
            let state = app_for_auxiliary.state::<WindowState>();
            let Ok(geometry) = state.main_geometry.read() else {
                return false;
            };
            let (x, y) = (x / geometry.scale, y / geometry.scale);
            state
                .auxiliary
                .read()
                .is_ok_and(|regions| regions.values().any(|region| region.contains(x, y)))
        })?;
    let app_for_permission = app.clone();
    app.listen("mac-request-input-access", move |_| {
        let app = app_for_permission.clone();
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            if let Err(error) = crate::input::request_input_access(handle) {
                eprintln!("Input access request failed: {error}");
            }
        }) {
            eprintln!("Could not schedule input access request: {error}");
        }
    });
    let app_for_pacing = app.clone();
    app.state::<crate::input::InputMonitor>()
        .set_interactive_hit_test(move |x, y| {
            let state = app_for_pacing.state::<WindowState>();
            let (Ok(geometry), Ok(hit)) = (state.main_geometry.read(), state.hit.read()) else {
                return true;
            };
            let (x, y) = (
                x / geometry.scale - geometry.left,
                y / geometry.scale - geometry.top,
            );
            hit.input_regions
                .iter()
                .chain(hit.regions.iter())
                .any(|r| r.near(x, y, INTERACTIVE_MARGIN))
        })?;
    let app_for_cursor = app.clone();
    app.state::<crate::input::InputMonitor>()
        .set_cursor_observer(move |x, y| {
            let state = app_for_cursor.state::<WindowState>();
            if let Ok(mut observed) = state.cursor_observed_at.lock() {
                *observed = Some(Instant::now());
            }
            // The fallback thread reports persistent failures; one event must not log.
            let _ = apply_passthrough(&app_for_cursor, x, y);
        })?;
    std::thread::Builder::new()
        .name("wuwatappo-passthrough".into())
        .spawn({
            let app = app.clone();
            move || passthrough_fallback(app)
        })
        .map_err(err)?;
    Ok(())
}

/// Keeps click-through correct when the input tap is unavailable (no Input
/// Monitoring permission) and acts as a slow safety net while it runs. Reading
/// the cursor through CoreGraphics needs no main-thread round trip.
fn passthrough_fallback(app: AppHandle) {
    let mut last_cursor = None;
    let mut moved_at: Option<Instant> = None;
    let mut geometry_at = Instant::now();
    loop {
        let state = app.state::<WindowState>();
        if state.stop.load(Ordering::Acquire) || app.get_webview_window("main").is_none() {
            break;
        }
        let now = Instant::now();
        let cursor = crate::input::cursor_location();
        if cursor != last_cursor {
            last_cursor = cursor;
            moved_at = Some(now);
        }
        if let Some((x, y)) = cursor {
            if let Err(error) = apply_passthrough(&app, x, y) {
                eprintln!("Hit region update stopped: {error}");
                break;
            }
        }
        let moving = moved_at.is_some_and(|at| now.duration_since(at) < PASSTHROUGH_SETTLE);
        // Window moves arrive as events; this only covers display changes that
        // shift the window's global origin without one, and only while in use.
        if moving && now.duration_since(geometry_at) >= GEOMETRY_SAFETY_REFRESH {
            geometry_at = now;
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = refresh_main_layout(&handle) {
                    eprintln!("Could not refresh main geometry: {error}");
                }
            }) {
                eprintln!("Could not schedule main geometry refresh: {error}");
            }
        }
        let tap_active = state
            .cursor_observed_at
            .lock()
            .ok()
            .and_then(|observed| *observed)
            .is_some_and(|at| now.duration_since(at) < PASSTHROUGH_SETTLE);
        std::thread::sleep(passthrough_poll_interval(tap_active, moving));
    }
}

fn passthrough_poll_interval(tap_active: bool, moving: bool) -> Duration {
    if tap_active {
        PASSTHROUGH_TAP_POLL
    } else if moving {
        PASSTHROUGH_MOVING_POLL
    } else {
        PASSTHROUGH_IDLE_POLL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn region(left: f64, top: f64) -> HitRegion {
        HitRegion {
            left,
            top,
            width: 100.,
            height: 50.,
            member_id: None,
        }
    }

    #[test]
    fn pet_regions_capture_the_cursor_and_the_rest_clicks_through() {
        let hit = HitState {
            regions: vec![region(10., 20.)],
            input_regions: vec![region(500., 500.)],
            ..HitState::default()
        };
        assert!(!hit.ignores_cursor(10., 20.));
        assert!(!hit.ignores_cursor(109.9, 69.9));
        assert!(hit.ignores_cursor(110., 20.));
        assert!(hit.ignores_cursor(520., 520.));
        let passthrough = HitState {
            window_passthrough: true,
            ..hit
        };
        assert!(passthrough.ignores_cursor(50., 40.));
        assert!(!passthrough.ignores_cursor(520., 520.));
    }

    #[test]
    fn only_the_pet_page_keeps_running_while_covered() {
        assert_eq!(
            background_policy("main"),
            Some(BackgroundThrottlingPolicy::Disabled)
        );
        for label in ["panel", "login", "about", "update", "toast"] {
            assert_eq!(background_policy(label), None);
        }
    }

    #[test]
    fn cursor_sampling_slows_down_when_idle_or_fed_by_the_input_tap() {
        assert_eq!(
            passthrough_poll_interval(false, true),
            PASSTHROUGH_MOVING_POLL
        );
        assert_eq!(
            passthrough_poll_interval(false, false),
            PASSTHROUGH_IDLE_POLL
        );
        assert_eq!(passthrough_poll_interval(true, true), PASSTHROUGH_TAP_POLL);
    }

    #[test]
    fn swallow_and_forced_ignore_override_regions() {
        let forced = HitState {
            regions: vec![region(0., 0.)],
            force_ignore: true,
            ..HitState::default()
        };
        assert!(forced.ignores_cursor(5., 5.));
        let swallow = HitState {
            swallow: true,
            ..forced
        };
        assert!(!swallow.ignores_cursor(5000., 5000.));
    }
}
