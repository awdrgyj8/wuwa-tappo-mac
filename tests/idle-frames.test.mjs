import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { profile, root, findSource } from './frontend-context.mjs';
import { patchMacEmotionMenuIdle } from '../scripts/patch-frontend.mjs';

// Same spring loop, press handler and mount hook as the official 1.0.2 EmotionMenu.
const component = 'const Gv=Xs({__name:"EmotionMenu",props:{visible:{type:Boolean}},setup(n){const S=new Map,P={};let L=0,C=performance.now();const D=!1;function E(X,O,K,G,Q,be){const He=(K-X)*G-O*Q;return O+=He*be,X+=O*be,[X,O]}function I(){return{x:1,y:1,r:0,vx:0,vy:0,vr:0,targetX:1,targetY:1,targetR:0,pressedAt:0,held:!1,releaseTimer:0,returnTimer:0}}function B(X){let O=S.get(X);return O||(O=I(),S.set(X,O)),O}function N(X){X.releaseTimer&&(clearTimeout(X.releaseTimer),X.releaseTimer=0),X.returnTimer&&(clearTimeout(X.returnTimer),X.returnTimer=0)}function H(X,O){P[X]=O.x}function U(X){if(D)return;const O=B(X);N(O),O.held=!0,O.pressedAt=performance.now(),O.targetX=.86,O.targetY=.72,O.targetR=-.025,O.vy-=.8}function V(X){const O=S.get(X);if(!O||!O.held)return;O.held=!1,O.releaseTimer=setTimeout(()=>{O.targetX=1.48,O.targetY=1.2,O.targetR=.035,O.vx+=2.4,O.vy+=3.3,O.vr+=.32,O.returnTimer=setTimeout(()=>{O.targetX=1,O.targetY=1,O.targetR=0,O.returnTimer=0},115),O.releaseTimer=0},80)}function Fe(X){const O=Math.min((X-C)/1e3,.028);C=X;for(const[K,G]of S)[G.x,G.vx]=E(G.x,G.vx,G.targetX,245,13.2,O),[G.y,G.vy]=E(G.y,G.vy,G.targetY,285,14,O),[G.r,G.vr]=E(G.r,G.vr,G.targetR,205,12.5,O),H(K,G);L=requestAnimationFrame(Fe)}return zs(()=>{C=performance.now(),L=requestAnimationFrame(Fe),window.addEventListener("resize",h)}),Ri(()=>{cancelAnimationFrame(L)}),{press:U,release:V,styles:P,states:S}}});';

function mount(source) {
  let now = 0, nextId = 1;
  const frames = new Map(), timers = new Map();
  const env = vm.createContext({
    performance: { now: () => now },
    requestAnimationFrame: callback => { const id = nextId++; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    window: { addEventListener() {} }, h: () => {},
    Xs: options => options, zs: callback => callback(), Ri() {},
  });
  vm.runInContext(`${source};globalThis.menu=Gv.setup({})`, env);
  let rendered = 0;
  return {
    menu: env.menu,
    pending: () => frames.size,
    get rendered() { return rendered; },
    advance(milliseconds) {
      for (const end = now + milliseconds; now < end;) {
        now += 16;
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
        const due = [...frames]; frames.clear();
        for (const [, callback] of due) { rendered += 1; callback(now); }
      }
    },
  };
}

test('official emote menu keeps a frame loop alive while nothing moves', () => {
  const view = mount(component);
  view.advance(10_000);
  assert.equal(view.pending(), 1);
  assert.ok(view.rendered >= 600, 'the unpatched pet window wakes every frame');
});

test('patched emote menu sleeps until a press and stops once the spring settles', () => {
  const patched = patchMacEmotionMenuIdle(component);
  parse(patched, { sourceType: 'module', ecmaVersion: 'latest' });
  const view = mount(patched);
  view.advance(10_000);
  assert.equal(view.pending(), 0);
  assert.equal(view.rendered, 0, 'an idle pet requests no frames');
  view.menu.press('happy');
  assert.equal(view.pending(), 1);
  view.advance(500);
  assert.equal(view.pending(), 1, 'a held button keeps animating');
  assert.ok(view.menu.styles.happy < 1, 'the press squashes the button');
  view.menu.release('happy');
  view.advance(5_000);
  assert.equal(view.pending(), 0, 'the loop stops after the release bounce settles');
  const state = view.menu.states.get('happy');
  assert.ok(Math.abs(state.x - 1) < 0.002 && Math.abs(state.vx) < 0.02);
  const used = view.rendered;
  assert.ok(used > 30 && used < 200, `bounce used ${used} frames`);
  view.advance(10_000);
  assert.equal(view.rendered, used);
  view.menu.press('happy');
  view.menu.press('angry');
  assert.equal(view.pending(), 1, 'presses share one frame loop');
});

test('emote menu patch stops the build when the official animation changes', () => {
  const changed = /Original emote menu animation changed/;
  assert.throws(() => patchMacEmotionMenuIdle(''), changed);
  assert.throws(() => patchMacEmotionMenuIdle(component.replace('"EmotionMenu"', '"EmoteMenu"')), changed);
  assert.throws(() => patchMacEmotionMenuIdle(component.replace('returnTimer:0}}', 'resetTimer:0}}')), changed);
  assert.throws(() => patchMacEmotionMenuIdle(component.replace('L=requestAnimationFrame(Fe)}', 'requestAnimationFrame(Fe)}')), changed);
  assert.throws(() => patchMacEmotionMenuIdle(component.replace('C=performance.now(),L=requestAnimationFrame(Fe),window', 'L=requestAnimationFrame(Fe),window')), changed);
  assert.throws(() => patchMacEmotionMenuIdle(component.replace('.pressedAt=performance.now()', '.pressedAt=Date.now()')), changed);
});

test('prepared pet view only animates the emote menu on demand', async () => {
  const view = findSource(source => source.includes('__name:"EmotionMenu"'));
  const prepared = await readFile(path.join(root, profile.preparedDir, 'assets', view.name), 'utf8');
  const tree = parse(prepared, { sourceType: 'module', ecmaVersion: 'latest' });
  assert.ok(tree.body.some(node => node.type === 'FunctionDeclaration' && node.id.name === '__wuwatappoSpringActive'));
  assert.equal((prepared.match(/=__wuwatappoSpringActive\([$\w]+\)\?requestAnimationFrame\(/g) ?? []).length, 1);
  assert.match(prepared, /\.vy-=\.8,([$\w]+)\|\|\(([$\w]+)=performance\.now\(\),\1=requestAnimationFrame\(/);
});
