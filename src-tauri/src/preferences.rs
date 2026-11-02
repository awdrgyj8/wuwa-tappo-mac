//! User settings mirrored out of the WebView's localStorage into Application Support, so
//! they survive app updates and WebKit data resets. scripts/mac-preferences.js keeps the
//! WebView copy live and restores it from this file when it goes missing.
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

/// localStorage keys that hold settings, never sign-in data or caches.
pub const KEYS: &[&str] = &[
    "wuwatappo-settings",
    "wuwatappo-locale",
    "wuwatappo-main-pet-placement-v1",
    "wuwatappo-main-window-outer-pos",
    "role_switch_emote_confirm_skip",
    "about_startup_skip",
    "wuwatappo-mac-auto-chest-v1",
];
const MAX_VALUE_BYTES: usize = 256 * 1024;
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default, Serialize, Deserialize)]
struct PreferenceFile {
    version: u32,
    values: BTreeMap<String, String>,
}

pub struct PreferenceStore {
    path: PathBuf,
    values: Mutex<BTreeMap<String, String>>,
}

fn allowed(key: &str, value: &str) -> bool {
    KEYS.contains(&key) && value.len() <= MAX_VALUE_BYTES
}

impl PreferenceStore {
    pub fn open(path: PathBuf) -> Self {
        let mut values = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<PreferenceFile>(&bytes) {
                Ok(file) => file.values,
                Err(error) => {
                    eprintln!("Saved settings are unreadable and were ignored: {error}");
                    BTreeMap::new()
                }
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => {
                eprintln!("Saved settings could not be read: {error}");
                BTreeMap::new()
            }
        };
        values.retain(|key, value| allowed(key, value));
        Self {
            path,
            values: Mutex::new(values),
        }
    }

    pub fn initialization_script(&self) -> String {
        let values = self
            .values
            .lock()
            .ok()
            .and_then(|values| serde_json::to_string(&*values).ok())
            .unwrap_or_else(|| "{}".into());
        format!("Object.defineProperty(window,'__WUWATAPPO_PREFERENCES__',{{value:Object.freeze({values}),writable:false,configurable:false}});")
    }

    pub fn save(&self, key: &str, value: Option<String>) -> Result<(), String> {
        if !KEYS.contains(&key) {
            return Err("preference_key_not_allowed".into());
        }
        if value.as_ref().is_some_and(|value| !allowed(key, value)) {
            return Err("preference_value_too_large".into());
        }
        let mut values = self
            .values
            .lock()
            .map_err(|_| "preference_store_poisoned")?;
        let changed = match value {
            Some(value) if values.get(key) == Some(&value) => false,
            Some(value) => {
                values.insert(key.into(), value);
                true
            }
            None => values.remove(key).is_some(),
        };
        if !changed {
            return Ok(());
        }
        write(&self.path, &values)
    }
}

fn write(path: &Path, values: &BTreeMap<String, String>) -> Result<(), String> {
    let directory = path.parent().ok_or("preference_directory_missing")?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(directory)
        .map_err(|error| format!("preference_directory_failed: {error}"))?;
    let temporary = directory.join(format!(
        ".preferences-{}-{}.tmp",
        std::process::id(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("preference_write_failed: {error}"))?;
        let data = PreferenceFile {
            version: 1,
            values: values.clone(),
        };
        serde_json::to_writer_pretty(&mut file, &data)
            .map_err(|error| format!("preference_serialize_failed: {error}"))?;
        file.write_all(b"\n")
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("preference_sync_failed: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("preference_replace_failed: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub fn save_preference(
    store: tauri::State<'_, PreferenceStore>,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    store.save(&key, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "wuwatappo-preferences-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn settings_survive_a_new_store_and_deletions_are_kept() {
        let path = directory("roundtrip").join("preferences.json");
        let store = PreferenceStore::open(path.clone());
        store
            .save("wuwatappo-settings", Some("{\"petScale\":125}".into()))
            .unwrap();
        store.save("about_startup_skip", Some("1".into())).unwrap();
        store.save("about_startup_skip", None).unwrap();
        let reopened = PreferenceStore::open(path.clone());
        let script = reopened.initialization_script();
        assert!(script.contains("__WUWATAPPO_PREFERENCES__"));
        assert!(script.contains(r#""wuwatappo-settings":"{\"petScale\":125}""#));
        assert!(!script.contains("about_startup_skip"));
        assert!(script.contains("configurable:false"));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn only_setting_keys_of_bounded_size_are_stored() {
        let path = directory("allowlist").join("preferences.json");
        let store = PreferenceStore::open(path.clone());
        assert!(store
            .save("__KrSDK_USER_TOKEN__", Some("secret".into()))
            .is_err());
        assert!(store
            .save("wuwatappo-locale", Some("x".repeat(MAX_VALUE_BYTES + 1)))
            .is_err());
        assert!(!path.exists(), "rejected values never create the file");
        store.save("wuwatappo-locale", Some("zh-tw".into())).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        store.save("wuwatappo-locale", Some("zh-tw".into())).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn damaged_or_foreign_files_fall_back_to_defaults() {
        let path = directory("damaged").join("preferences.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{broken").unwrap();
        assert_eq!(
            PreferenceStore::open(path.clone()).initialization_script(),
            "Object.defineProperty(window,'__WUWATAPPO_PREFERENCES__',{value:Object.freeze({}),writable:false,configurable:false});"
        );
        fs::write(
            &path,
            br#"{"version":1,"values":{"__KrSDK_USER_TOKEN__":"secret","wuwatappo-locale":"en"}}"#,
        )
        .unwrap();
        let script = PreferenceStore::open(path.clone()).initialization_script();
        assert!(!script.contains("secret"));
        assert!(script.contains(r#""wuwatappo-locale":"en""#));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }
}
