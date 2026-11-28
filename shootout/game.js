// WHIZHACK SHOOTOUT
// A fork of Finger Gun Tabs by Rajvi Shah (MIT): same finger-gun engine, same
// laser, lock-on, shatter, streaks and banners. The targets are no longer your
// browser tabs but devices on a power plant's network. Shoot the intruders,
// spare the real equipment, and let the WhizHack decoys expose the disguised ones.
import { createTracker, analyze, GunTrigger, HandFinder, OneEuro, HAND_EDGES, TUNING } from './hand.js';

const GOAL = 5;
const ROUND_SECS = 90;
const COMIC_URL = 'comic/';
const $ = (id) => document.getElementById(id);
const range = $('range');
const laser = $('laser');
const fxLayer = $('fx');
const flash = $('flash');
const banner = $('banner');
const statusEl = $('status');
const phoneStatus = $('phoneStatus');
const debugEl = $('debug');
const video = $('video');
const skel = $('skeleton');
const skelCtx = skel.getContext('2d');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (a, b) => a + Math.random() * (b - a);
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pickN = (arr, n) => shuffle([...arr]).slice(0, n);

// ------------------------------------------------------------- devices ----
// kind: real (don't shoot) | decoy (bulletproof) | threat (shoot) | hidden (an
// intruder that looks real until a decoy exposes it).
const REAL = [
  { title: 'Boiler PLC-07', host: '10.0.1.7 · Modbus', img: 'plc' },
  { title: 'Turbine HMI-2', host: '10.0.1.20 · operator console', img: 'hmi' },
  { title: 'Substation RTU-4', host: '10.0.2.4 · DNP3', img: 'rtu' },
  { title: 'Feed-pump PLC-11', host: '10.0.1.11 · Modbus', img: 'plc' },
  { title: 'Control-room HMI-1', host: '10.0.1.21 · operator console', img: 'hmi' },
  { title: 'Grid RTU-9', host: '10.0.2.9 · IEC 104', img: 'rtu' },
];
const THREATS = [
  { title: 'Unknown device', host: '10.0.4.99 · new MAC address', img: 'crawler' },
  { title: 'Rogue USB on HMI-2', host: 'autorun.exe', img: 'usb' },
  { title: 'Ransomware', host: 'encrypting historian files', img: 'ransom' },
  { title: 'Malware beacon', host: 'calling 185.22.x.x every 60s', img: 'crawler' },
  { title: 'Infected USB stick', host: 'plugged into RTU-4 cabinet', img: 'usb' },
  { title: 'Ransomware dropper', host: 'scheduled task · 02:00', img: 'ransom' },
  { title: 'Port scanner', host: '10.0.4.13 · sweeping Modbus', img: 'crawler' },
];
const APTS = [
  { title: 'APT remote session', host: 'VPN login · 03:12 AM', img: 'hood' },
  { title: 'Stolen vendor account', host: 'login from new country', img: 'hood' },
];
// Disguised intruders: they look like plant equipment. The clue is in the details.
const DISGUISED = [
  { title: 'Maintenance laptop', host: 'login 03:40 AM · 10.0.9.3', img: 'hmi' },
  { title: 'RTU-4 firmware update', host: 'unsigned · from 10.0.4.66', img: 'update' },
  { title: 'Sensor gateway', host: '10.0.9.44 · not in asset list', img: 'sensor' },
  { title: 'Engineering workstation', host: 'new admin user · 02:51 AM', img: 'hmi' },
];
const DECOYS = [
  { title: 'Decoy PLC-21', host: 'WhizHack trap · 10.0.1.31', img: 'decoy' },
  { title: 'Decoy PLC-14', host: 'WhizHack trap · 10.0.1.14', img: 'decoy' },
];

let devices = new Map(); // id -> device
let nextId = 1;
let wave = 0;
let rects = []; // cached card positions for aim assist

function buildWave() {
  wave += 1;
  $('wave').textContent = String(wave);
  const small = innerWidth < 760;
  const total = small ? 10 : 12;
  const nReal = 3, nDecoy = small ? 1 : 2, nHidden = 2;
  const nApt = wave >= 2 ? 1 : 0;
  const nThreat = total - nReal - nDecoy - nHidden - nApt;
  const reals = pickN(REAL, nReal).map((d) => ({ ...d, kind: 'real' }));
  const list = [
    ...reals,
    ...pickN(DECOYS, nDecoy).map((d) => ({ ...d, kind: 'decoy', badge: { cls: 'decoy', text: 'Decoy' } })),
    ...pickN(THREATS, nThreat).map((d) => ({ ...d, kind: 'threat', badge: { cls: 'threat', text: 'Intruder' } })),
    ...pickN(APTS, nApt).map((d) => ({ ...d, kind: 'threat', bounty: true, badge: { cls: 'wanted', text: 'Wanted: APT' } })),
  ];
  // one disguised intruder is a clone of a real device's name (the original's DUPLICATE tab)
  const cloneOf = reals[(Math.random() * reals.length) | 0];
  list.push({ title: cloneOf.title, host: `10.0.${(Math.random() * 3 + 6) | 0}.${(Math.random() * 200 + 20) | 0} · same name, new MAC`, img: cloneOf.img, kind: 'hidden', badge: { cls: 'dupe', text: 'Duplicate?' } });
  pickN(DISGUISED, nHidden - 1).forEach((d) => list.push({ ...d, kind: 'hidden' }));

  devices = new Map();
  range.replaceChildren();
  setLocked(null);
  const now = performance.now();
  for (const d of shuffle(list)) {
    d.id = nextId++;
    if (d.kind === 'hidden') d.exposeAt = now + rand(3500, 8000) + (wave === 1 ? 1500 : 0);
    devices.set(d.id, d);
    const el = document.createElement('div');
    fillCard(el, d);
    range.append(el);
  }
  layout();
  updateStats();
}

function fillCard(el, d) {
  const look = d.kind === 'hidden' ? 'real' : d.kind;
  el.className = `card ${look}` + (d.badge ? ` ${d.badge.cls}` : '');
  el.dataset.id = String(d.id);
  const img = document.createElement('img');
  img.alt = ''; img.draggable = false; img.src = `art/${d.img}.webp`;
  const title = document.createElement('div');
  title.className = 'title'; title.textContent = d.title;
  const host = document.createElement('div');
  host.className = 'host'; host.textContent = d.host;
  const parts = [img, title, host];
  if (d.badge) {
    const b = document.createElement('div');
    b.className = 'badge'; b.textContent = d.badge.text;
    parts.unshift(b);
  }
  el.replaceChildren(...parts);
}

function layout() {
  const n = range.children.length;
  if (n) {
    const { clientWidth: w, clientHeight: h } = range;
    const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt((n * (w / h)) / 1.5))));
    range.style.setProperty('--cols', String(cols));
  }
  rects = [...range.children].map((el) => {
    const r = el.getBoundingClientRect();
    return { el, l: r.left, t: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
}
addEventListener('resize', layout);

// A decoy exposes a disguised intruder: a tripwire line runs from the decoy to it.
function expose(d, el) {
  d.kind = 'threat';
  d.exposed = true;
  d.badge = { cls: 'threat', text: 'Exposed by decoy' };
  const wasLocked = el === locked;
  fillCard(el, d);
  if (wasLocked) el.classList.add('locked');
  restart(el, 'exposed');
  const decoyEl = [...range.querySelectorAll('.card.decoy:not(.dead)')].sort(() => Math.random() - 0.5)[0];
  const r = el.getBoundingClientRect();
  if (decoyEl) {
    const dr = decoyEl.getBoundingClientRect();
    const sx = dr.left + dr.width / 2, sy = dr.top + dr.height / 2;
    const ex = r.left + r.width / 2, ey = r.top + r.height / 2;
    const line = document.createElement('div');
    line.className = 'link';
    line.style.cssText = `left:${sx}px;top:${sy}px;width:${Math.hypot(ex - sx, ey - sy)}px;transform:rotate(${Math.atan2(ey - sy, ex - sx)}rad);`;
    fxLayer.append(line);
    line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 900, easing: 'ease-in' }).onfinish = () => line.remove();
    restart(decoyEl, 'tripped');
  }
  pop(r.left + r.width / 2, r.top + 16, 'Decoy tripped', 'blue');
  blip();
}

// -------------------------------------------------------------- score ----

const score = { shots: 0, kills: 0, streak: 0, best: 0, own: 0, lastKillAt: -1e9 };
const STREAK_MS = 2500;
const STREAK_NAMES = [null, null, 'DOUBLE TRACE', 'TRIPLE TRACE', 'PLANT RAMPAGE', 'UNSTOPPABLE', 'ZERO TRUST', 'SOC LEGEND'];
let state = 'menu'; // menu | play | over | won
let endsAt = 0;
let wonOnce = false;

function updateStats() {
  $('kills').textContent = String(score.kills);
  $('s-accuracy').textContent = score.shots ? `${Math.round((score.kills / score.shots) * 100)}%` : '–';
  $('s-streak').textContent = String(score.best);
  $('s-own').textContent = String(score.own);
  [...$('lamps').children].forEach((l, i) => l.classList.toggle('on', i < score.kills));
}

function showBanner(text, sticky = false) {
  banner.textContent = text;
  banner.classList.remove('go', 'stay');
  void banner.offsetWidth;
  banner.classList.add(sticky ? 'stay' : 'go');
}

function checkSweep() {
  const left = [...devices.values()].filter((d) => !d.dead && (d.kind === 'threat' || d.kind === 'hidden')).length;
  if (left === 0 && state === 'play') {
    setTimeout(() => showBanner(`Clean sweep, wave ${wave}`), 350);
    setTimeout(() => { if (state === 'play') buildWave(); }, 1500);
  }
}

// ------------------------------------------------------------- sounds ----

let actx = null;
function audio() {
  actx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function noise(a, seconds) {
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * seconds), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  return src;
}
function pew(pitch = 1) {
  const a = audio();
  const t = a.currentTime;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(1900 * pitch, t);
  osc.frequency.exponentialRampToValueAtTime(170 * pitch, t + 0.2);
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  osc.connect(g).connect(a.destination);
  osc.start(t); osc.stop(t + 0.25);
  const n = noise(a, 0.07);
  const ng = a.createGain();
  ng.gain.setValueAtTime(0.18, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  n.connect(ng).connect(a.destination);
  n.start(t);
}
function crash() {
  const a = audio();
  const t = a.currentTime + 0.03;
  const n = noise(a, 0.35);
  const f = a.createBiquadFilter();
  f.type = 'highpass'; f.frequency.value = 2200;
  const g = a.createGain();
  g.gain.setValueAtTime(0.28, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
  n.connect(f).connect(g).connect(a.destination);
  n.start(t);
}
function ting() {
  const a = audio();
  const t = a.currentTime + 0.02;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(2600, t);
  osc.frequency.exponentialRampToValueAtTime(3400, t + 0.18);
  g.gain.setValueAtTime(0.2, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(g).connect(a.destination);
  osc.start(t); osc.stop(t + 0.32);
}
function alarm() {
  const a = audio();
  const t = a.currentTime + 0.02;
  [0, 0.2].forEach((d) => {
    const osc = a.createOscillator(), g = a.createGain();
    osc.type = 'square'; osc.frequency.value = d ? 330 : 440;
    g.gain.setValueAtTime(0.08, t + d); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.18);
    osc.connect(g).connect(a.destination); osc.start(t + d); osc.stop(t + d + 0.2);
  });
}
function blip() {
  if (!actx) return;
  const a = actx, t = a.currentTime;
  const osc = a.createOscillator(), g = a.createGain();
  osc.type = 'sine'; osc.frequency.setValueAtTime(880, t); osc.frequency.exponentialRampToValueAtTime(1760, t + 0.12);
  g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(g).connect(a.destination); osc.start(t); osc.stop(t + 0.16);
}
function fanfare(level) {
  const a = audio();
  const t = a.currentTime + 0.08;
  [0, 4, 7].forEach((semi, i) => {
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = 'square';
    osc.frequency.value = 440 * 2 ** ((semi + level * 2) / 12);
    g.gain.setValueAtTime(0.0001, t + i * 0.06);
    g.gain.exponentialRampToValueAtTime(0.09, t + i * 0.06 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.06 + 0.16);
    osc.connect(g).connect(a.destination);
    osc.start(t + i * 0.06); osc.stop(t + i * 0.06 + 0.18);
  });
}

// ------------------------------------------------------------ effects ----

function restart(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function muzzle(x, y) {
  flash.style.setProperty('--fx', `${x}px`);
  flash.style.setProperty('--fy', `${y}px`);
  restart(flash, 'go');
  restart(document.body, 'recoil');
  const sx = innerWidth / 2;
  const sy = innerHeight + 10;
  const len = Math.hypot(x - sx, y - sy);
  const el = document.createElement('div');
  el.className = 'tracer';
  el.style.cssText = `left:${sx}px;top:${sy}px;width:${len}px;transform:rotate(${Math.atan2(y - sy, x - sx)}rad);`;
  fxLayer.append(el);
  el.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).onfinish = () => el.remove();
}

function hole(x, y) {
  const el = document.createElement('div');
  el.className = 'hole';
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  fxLayer.append(el);
  el.addEventListener('animationend', () => el.remove());
}

function pop(x, y, text, cls = '') {
  const el = document.createElement('div');
  el.className = 'pop ' + cls;
  el.textContent = text;
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  fxLayer.append(el);
  el.animate(
    [{ transform: 'translate(-50%, -50%)', opacity: 1 }, { transform: 'translate(-50%, -190%)', opacity: 0 }],
    { duration: 1000, easing: 'ease-out' },
  ).onfinish = () => el.remove();
}

function sparks(x, y) {
  for (let i = 0; i < 8; i++) {
    const el = document.createElement('div');
    el.className = 'spark';
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    fxLayer.append(el);
    const ang = Math.random() * Math.PI * 2;
    const d = 30 + Math.random() * 60;
    el.animate(
      [{ transform: 'translate(0, 0)', opacity: 1 }, { transform: `translate(${Math.cos(ang) * d}px, ${Math.sin(ang) * d + 30}px)`, opacity: 0 }],
      { duration: 350 + Math.random() * 200, easing: 'ease-out' },
    ).onfinish = () => el.remove();
  }
}

// Break the card into triangles that fan out from the bullet's impact point.
function shatter(card, x, y) {
  const r = card.getBoundingClientRect();
  const ix = clamp(x - r.left, 2, r.width - 2);
  const iy = clamp(y - r.top, 2, r.height - 2);
  const rim = [[0, 0], [r.width, 0], [r.width, r.height], [0, r.height]];
  const rays = 9;
  for (let k = 0; k < rays; k++) {
    const ang = ((k + Math.random() * 0.7) / rays) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const tx = dx > 0 ? (r.width - ix) / dx : dx < 0 ? -ix / dx : Infinity;
    const ty = dy > 0 ? (r.height - iy) / dy : dy < 0 ? -iy / dy : Infinity;
    const t = Math.min(tx, ty);
    rim.push([ix + dx * t, iy + dy * t]);
  }
  rim.sort((a, b) => Math.atan2(a[1] - iy, a[0] - ix) - Math.atan2(b[1] - iy, b[0] - ix));
  rim.forEach((p, i) => {
    const q = rim[(i + 1) % rim.length];
    const shard = document.createElement('div');
    shard.className = 'shard';
    shard.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
    shard.style.clipPath = `polygon(${ix}px ${iy}px, ${p[0]}px ${p[1]}px, ${q[0]}px ${q[1]}px)`;
    const copy = card.cloneNode(true);
    copy.classList.remove('locked');
    shard.append(copy);
    fxLayer.append(shard);
    const cx = (ix + p[0] + q[0]) / 3 - ix;
    const cy = (iy + p[1] + q[1]) / 3 - iy;
    const len = Math.hypot(cx, cy) || 1;
    const fly = 70 + Math.random() * 170;
    const spin = (Math.random() - 0.5) * 240;
    shard.animate(
      [{ transform: 'translate(0, 0) rotate(0deg)', opacity: 1 }, { transform: `translate(${(cx / len) * fly}px, ${(cy / len) * fly + 130}px) rotate(${spin}deg)`, opacity: 0 }],
      { duration: 650 + Math.random() * 350, easing: 'cubic-bezier(0.2, 0.6, 0.35, 1)' },
    ).onfinish = () => shard.remove();
  });
}

// ------------------------------------------------- aiming and shooting ----

let locked = null;
function setLocked(card) {
  if (card === locked) return;
  if (locked) locked.classList.remove('locked');
  if (card) card.classList.add('locked');
  locked = card;
}

// Aim assist: lock the nearest card, and stay on it until the laser is clearly
// closer to another one. Negative distance means "inside the card".
const LOCK_REACH = 40;
const LOCK_STICKY = 16;
function distToRect(r, x, y) {
  const dx = Math.max(r.l - x, 0, x - r.r);
  const dy = Math.max(r.t - y, 0, y - r.b);
  if (dx || dy) return Math.hypot(dx, dy);
  return -Math.min(x - r.l, r.r - x, y - r.t, r.b - y);
}
function pickTarget(x, y) {
  let best = null, bestD = Infinity, currentD = Infinity;
  for (const r of rects) {
    if (r.el.classList.contains('dead')) continue;
    const d = distToRect(r, x, y);
    if (r.el === locked) currentD = d;
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best || bestD > LOCK_REACH) return null;
  if (locked && best.el !== locked && currentD <= LOCK_REACH && bestD > currentD - LOCK_STICKY) {
    return rects.find((r) => r.el === locked);
  }
  return best;
}

// Moves the laser. With `assist`, the dot is pulled toward the locked card's centre.
function aim(x, y, assist) {
  const target = pickTarget(x, y);
  setLocked(target ? target.el : null);
  let lx = x, ly = y;
  if (assist && target) {
    lx = x + (target.cx - x) * 0.55;
    ly = y + (target.cy - y) * 0.55;
  }
  laser.style.transform = `translate(${lx}px, ${ly}px)`;
  return { x: lx, y: ly, card: target ? target.el : null };
}

function shoot(x, y, card) {
  if (state !== 'play') return;
  const now = performance.now();
  if (now - score.lastKillAt > STREAK_MS) score.streak = 0;
  score.shots += 1;
  window.__shots = (window.__shots || 0) + 1;
  pew(1 + Math.min(score.streak, 8) * 0.07);
  muzzle(x, y);

  if (card && card.classList.contains('dead')) card = null;
  if (!card) {
    score.streak = 0;
    hole(x, y);
    updateStats();
    return;
  }
  const r = card.getBoundingClientRect();
  x = clamp(x, r.left + 4, r.right - 4);
  y = clamp(y, r.top + 4, r.bottom - 4);
  const d = devices.get(Number(card.dataset.id));

  if (d.kind === 'decoy') {
    ting(); sparks(x, y);
    pop(x, y, "Bulletproof: that's your decoy", 'blue');
    restart(card, 'ricochet');
    updateStats();
    return;
  }
  if (d.kind === 'real') {
    alarm(); sparks(x, y);
    score.kills = Math.max(0, score.kills - 2); score.own += 1; score.streak = 0;
    pop(x, y, 'Plant tripped −2', 'bad');
    restart(card, 'ricochet');
    updateStats();
    return;
  }

  // threat or still-hidden intruder: down it goes
  const early = d.kind === 'hidden';
  const rush = endsAt - now <= 10000 && !wonOnce;
  const pts = (early || d.bounty ? 2 : 1) * (rush ? 2 : 1);
  crash();
  shatter(card, x, y);
  card.classList.remove('locked');
  card.classList.add('dead');
  d.dead = true;
  if (locked === card) locked = null;

  score.kills += pts;
  score.streak += 1;
  score.best = Math.max(score.best, score.streak);
  score.lastKillAt = now;
  if (d.bounty) pop(x, y, `Bounty claimed +${pts}`);
  else if (early) pop(x, y, `Sharp eye +${pts}`, 'good');
  else pop(x, y, rush ? `Double +${pts}` : '+1');
  const name = STREAK_NAMES[Math.min(score.streak, STREAK_NAMES.length - 1)];
  if (name) {
    showBanner(name);
    fanfare(Math.min(score.streak, 7) - 2);
  }
  updateStats();
  if (score.kills >= GOAL && !wonOnce) return win();
  checkSweep();
}

// ------------------------------------------------------ hand tracking ----

let finder = null;
let lastVideoTime = -1;
let lastHandAt = -1e9;
let mouseAiming = false;
let frames = 0, fps = 0, fpsMark = performance.now();
let detectErrors = 0, usingCPU = false;
const trigger = new GunTrigger();
const filtX = new OneEuro();
const filtY = new OneEuro();
const aimHistory = [];

// The hand controls the laser like a trackpad: wherever the hand first shows
// up becomes the middle of the screen, and a comfortable reach covers all of it.
const zone = { set: false, cx: 0.5, cy: 0.5, hw: 0.2, hh: 0.26 };
function handToScreen(px, py) {
  if (!zone.set) {
    zone.set = true;
    const frameAspect = video.videoWidth / video.videoHeight || 16 / 9;
    zone.hw = clamp((zone.hh * (innerWidth / innerHeight)) / frameAspect, 0.12, 0.42);
    zone.cx = clamp(px, zone.hw, 1 - zone.hw);
    zone.cy = clamp(py, zone.hh, 1 - zone.hh);
  }
  let nx = (px - zone.cx) / (2 * zone.hw) + 0.5;
  let ny = (py - zone.cy) / (2 * zone.hh) + 0.5;
  if (nx < 0) { zone.cx += nx * 2 * zone.hw; nx = 0; }
  if (nx > 1) { zone.cx += (nx - 1) * 2 * zone.hw; nx = 1; }
  if (ny < 0) { zone.cy += ny * 2 * zone.hh; ny = 0; }
  if (ny > 1) { zone.cy += (ny - 1) * 2 * zone.hh; ny = 1; }
  return [nx, ny];
}

let statusKey = '';
function setStatus(key, text, cls = '') {
  if (key === statusKey) return;
  statusKey = key;
  statusEl.textContent = text;
  statusEl.className = cls;
  phoneStatus.textContent = text;
}

function drawSkeleton(hand, isGun) {
  skelCtx.clearRect(0, 0, skel.width, skel.height);
  if (!hand) return;
  const lm = hand.landmarks;
  const px = (p) => [p.x * skel.width, p.y * skel.height];
  skelCtx.lineWidth = Math.max(2, skel.width / 160);
  skelCtx.strokeStyle = isGun ? '#ff2d3d' : 'rgba(255,255,255,0.8)';
  skelCtx.beginPath();
  for (const [a, b] of HAND_EDGES) { skelCtx.moveTo(...px(lm[a])); skelCtx.lineTo(...px(lm[b])); }
  skelCtx.stroke();
  skelCtx.fillStyle = isGun ? '#ff2d3d' : '#fff';
  skelCtx.beginPath();
  skelCtx.arc(...px(lm[8]), skelCtx.lineWidth * 2.2, 0, Math.PI * 2);
  skelCtx.fill();
}

function aimAt(time) {
  for (let i = aimHistory.length - 1; i >= 0; i--) if (aimHistory[i].t <= time) return aimHistory[i];
  return aimHistory[0];
}

async function switchToCPU() {
  if (usingCPU) return;
  usingCPU = true;
  try { finder = new HandFinder(await createTracker('CPU')); detectErrors = 0; } catch {}
}

// Firing: aim with a finger gun, then either FLICK the hand sideways or TILT
// the gun onto its side. The shot goes where you were aiming just before the move.
const SLOW = /[?&]slowcam/.test(location.search) ? 4 : 1; // for low-fps test rigs
const FIRE = { flickPalms: 1.0, flickMs: 220 * SLOW, tiltDeg: 45, tiltMs: 450 * SLOW, coolMs: 650, steadySpeed: 2.2 };
const motion = []; // recent { t, x, y, roll, palm } in video pixels
let pointingAt = -1e9, coolUntil = 0, steadyAim = null, firedFlash = 0;
let home = null; // pose the hand fired from; the move back to it must not fire again
const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
function checks(hand, gun, fire) {
  $('ckHand').classList.toggle('on', hand); $('ckGun').classList.toggle('on', gun); $('ckThumb').classList.toggle('on', fire);
}
function detectFireMove(lm, now) {
  const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
  const P = (i) => ({ x: lm[i].x * vw, y: lm[i].y * vh });
  const w = P(0), m = P(9), k5 = P(5), k17 = P(17);
  const palm = Math.hypot(m.x - w.x, m.y - w.y) || 1;
  const roll = (Math.atan2(k17.y - k5.y, k17.x - k5.x) * 180) / Math.PI;
  const cur = { t: now, x: (w.x + m.x) / 2, y: (w.y + m.y) / 2, roll, palm };
  const prev = motion[motion.length - 1];
  motion.push(cur);
  while (motion.length > 2 && now - motion[0].t > Math.max(FIRE.flickMs, FIRE.tiltMs)) motion.shift();
  // speed right now, in palm-lengths per second: slow = steady aiming
  let speed = 0, dRollNow = 0;
  if (prev) {
    const dt = Math.max(0.016, (now - prev.t) / 1000);
    speed = Math.hypot(cur.x - prev.x, cur.y - prev.y) / palm / dt;
    dRollNow = Math.abs(wrapDeg(roll - prev.roll)) / dt;
  }
  const steady = speed < FIRE.steadySpeed && dRollNow < 120;
  if (home) {
    const back = Math.hypot(cur.x - home.x, cur.y - home.y) / palm < 0.45 && Math.abs(wrapDeg(roll - home.roll)) < 20;
    if (back || now > home.until) { home = null; motion.length = 0; motion.push(cur); }
    return { steady, move: null };
  }
  if (now < coolUntil) return { steady, move: null };
  const armed = now - pointingAt < 450; // pointing now, or a moment ago (the pose can blur mid-move)
  if (!armed) return { steady, move: null };
  for (const old of motion) {
    const age = now - old.t;
    if (age <= 0) break;
    if (age <= FIRE.flickMs) {
      const dx = cur.x - old.x, dy = cur.y - old.y;
      if (Math.abs(dx) / palm > FIRE.flickPalms && Math.abs(dx) > 1.4 * Math.abs(dy)) { home = { ...old, until: now + 2000 }; return { steady, move: 'flick' }; }
    }
    if (age <= FIRE.tiltMs && Math.abs(wrapDeg(roll - old.roll)) > FIRE.tiltDeg) { home = { ...old, until: now + 2000 }; return { steady, move: 'tilt' }; }
  }
  return { steady, move: null };
}

function trackHand(now) {
  if (!finder || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let hand;
  try { hand = finder.detect(video); detectErrors = 0; } catch { if (++detectErrors > 8) switchToCPU(); return; }
  frames += 1;
  if (now - fpsMark > 1000) { fps = Math.round((frames * 1000) / (now - fpsMark)); frames = 0; fpsMark = now; }

  if (!hand) {
    trigger.update(null, now);
    drawSkeleton(null, false);
    const gone = now - lastHandAt;
    if (gone > 500 && !mouseAiming) {
      laser.classList.remove('on', 'aiming');
      setLocked(null);
      filtX.reset(); filtY.reset();
      aimHistory.length = 0;
    }
    if (gone > 1200) zone.set = false;
    if (gone > 500) setStatus('idle', 'No hand seen. Hold a finger gun up where the camera box can see it.');
    checks(false, false, false); motion.length = 0;
    debug(null);
    return;
  }

  lastHandAt = now;
  mouseAiming = false;
  const a = analyze(hand.world, trigger.isGun);
  const fired = trigger.update(a, now);
  drawSkeleton(hand, trigger.isGun);

  // Aim with the whole index finger, not just the tip.
  const lm = hand.landmarks;
  const ax = (lm[5].x + lm[6].x + lm[7].x + lm[8].x) / 4;
  const ay = (lm[5].y + lm[6].y + lm[7].y + lm[8].y) / 4;
  const [nx, ny] = handToScreen(1 - ax, ay); // mirrored
  const x = filtX.filter(nx, now / 1000) * innerWidth;
  const y = filtY.filter(ny, now / 1000) * innerHeight;

  laser.classList.add('on');
  laser.classList.toggle('aiming', trigger.isGun || a.index > 0.78);
  const shown = aim(x, y, true);
  aimHistory.push({ t: now, ...shown });
  while (aimHistory.length > 1 && now - aimHistory[0].t > 500) aimHistory.shift();

  const pointing = trigger.isGun || a.index > 0.78;
  if (pointing) pointingAt = now;
  const fm = detectFireMove(lm, now);
  if (fm.steady && pointing) steadyAim = { t: now, ...shown };
  const move = fm.move || (fired && now >= coolUntil ? 'thumb' : null);
  if (move) {
    (window.__moves ||= []).push(move + '@' + Math.round(now));
    // shoot where the hand was steady just before the move, not where the move threw the laser
    const at = steadyAim && now - steadyAim.t < 900 ? steadyAim : aimAt(now - 250);
    if (at && state === 'play') {
      let card = at.card;
      if (card && card.classList.contains('dead')) card = null;
      shoot(at.x, at.y, card);
    }
    coolUntil = now + FIRE.coolMs;
    firedFlash = now;
  }
  checks(true, pointing, now - firedFlash < 350);

  if (pointing) setStatus('aim', 'Aiming. Flick your hand sideways or tilt the gun to fire.', 'live');
  else setStatus('hand', 'Hand found. Make a finger gun: index finger out, other fingers curled.', 'live');
  debug(a);
}
function debug(a) {
  if (debugEl.hidden) return;
  debugEl.textContent = `fps ${fps} ${usingCPU ? 'CPU' : 'GPU'}  video ${video.videoWidth}x${video.videoHeight}\n` +
    (a ? `gun ${trigger.isGun ? 'yes' : 'no'}  armed ${trigger.armed ? 'yes' : 'no'}\nindex ${a.index.toFixed(2)}  others ${a.others.map((v) => v.toFixed(2)).join(' ')}\nthumb ${a.thumb.toFixed(2)}  peak ${trigger.peak.toFixed(2)}  shots ${window.__shots || 0}` : 'no hand');
}

// ---------------------------------------------------------- main loop ----

function tick(now) {
  requestAnimationFrame(tick);
  trackHand(now);
  if (state === 'play') {
    // decoys expose disguised intruders over time
    for (const d of devices.values()) {
      if (d.kind === 'hidden' && !d.dead && now >= d.exposeAt) {
        const el = range.querySelector(`.card[data-id="${d.id}"]`);
        if (el) expose(d, el);
      }
    }
    const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
    const t = $('timer');
    if (t.textContent !== String(left)) {
      t.textContent = String(left); t.classList.toggle('low', left <= 10);
      if (left === 10 && !wonOnce) { showBanner('Double points'); fanfare(3); document.body.classList.add('rush'); }
    }
    if (left <= 0) timeUp();
  }
}

// ------------------------------------------------------------- camera ----

const cameraEl = $('camera');
let stream = null;
async function openStream(deviceId) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) },
    audio: false,
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  skel.width = Math.round(video.videoWidth / 2) || 640;
  skel.height = Math.round(video.videoHeight / 2) || 360;
  $('camwrap').style.aspectRatio = `${video.videoWidth || 16} / ${video.videoHeight || 9}`;
  lastVideoTime = -1;
  zone.set = false;
  return stream.getVideoTracks()[0].getSettings().deviceId;
}
// Pick the laptop's own camera over a phone or virtual camera unless the player chose one.
async function chooseCamera(currentId) {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  let saved = null; try { saved = localStorage.getItem('shootout.cameraId'); } catch {}
  const builtIn = cams.find((c) => /facetime|built-?in|integrated|front/i.test(c.label));
  const want = (saved && cams.some((c) => c.deviceId === saved) && saved) || (builtIn && builtIn.deviceId) || currentId;
  cameraEl.replaceChildren(...cams.map((c, i) => { const o = document.createElement('option'); o.value = c.deviceId; o.textContent = c.label || `Camera ${i + 1}`; return o; }));
  cameraEl.hidden = cams.length < 2;
  let active = currentId;
  if (want && want !== currentId) { try { active = await openStream(want); } catch { active = await openStream(null); } }
  cameraEl.value = active;
}
cameraEl.addEventListener('change', async () => {
  try { localStorage.setItem('shootout.cameraId', cameraEl.value); } catch {}
  try { await openStream(cameraEl.value); } catch { setStatus('camfail' + cameraEl.value, 'That camera would not start. Pick another one.', 'error'); }
});
cameraEl.addEventListener('click', (e) => e.stopPropagation());

async function startCamera() {
  const btn = $('bCam'); btn.disabled = true; $('camErr').textContent = '';
  try {
    btn.textContent = 'Starting camera…';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('nocam'), { name: 'NoCam' });
    const current = await openStream(null);
    await chooseCamera(current).catch(() => {});
    btn.textContent = 'Loading hand tracking…';
    setStatus('loading2', 'Camera on. Loading hand tracking…');
    finder = new HandFinder(await createTracker('GPU'));
    setStatus('idle', 'No hand seen yet. Hold a finger gun up where the camera box can see it.');
    document.body.classList.remove('tapmode');
    return true;
  } catch (err) {
    console.error('camera or hand tracking failed', err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    $('camErr').textContent = denied
      ? 'Camera is blocked. Allow it from the camera icon in the address bar, then try again. Or play with tap.'
      : err && err.name === 'NoCam' ? 'This browser has no camera access. Play with tap instead.'
      : `Hand tracking could not start (${err && err.message}). Play with tap instead.`;
    stopCamera();
    return false;
  } finally {
    btn.disabled = false; btn.textContent = 'Play with finger gun';
  }
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  finder = null;
  document.body.classList.add('tapmode');
}

// ------------------------------------------------- mouse, touch, keys ----

addEventListener('mousemove', (e) => {
  if (performance.now() - lastHandAt < 600) return; // the hand has the laser
  mouseAiming = true;
  laser.classList.add('on', 'aiming');
  aim(e.clientX, e.clientY, false);
});
addEventListener('click', (e) => {
  if (e.target.closest('.ui')) return;
  audio();
  const under = document.elementFromPoint(e.clientX, e.clientY);
  shoot(e.clientX, e.clientY, under && under.closest ? under.closest('#range .card:not(.dead)') : null);
});
addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if (e.key === 'd' || e.key === 'D') debugEl.hidden = !debugEl.hidden;
  else if ((e.key === 'r' || e.key === 'R') && state !== 'menu') startRound();
});
if (/[?&]debug/.test(location.search)) debugEl.hidden = false;


// ------------------------------------------------- players + database ----
// Same Supabase project and pattern as Decoy Dash / Merge Rush, tables ss_*.
const API_URL = 'https://juemnyijhvqlpxrvsibg.supabase.co', API_KEY = 'sb_publishable_LDopq-erBLDteakwk08pOQ_qKnIafQI';
const store = { get(k, d) { try { const v = localStorage.getItem('shootout.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('shootout.' + k, JSON.stringify(v)); } catch {} } };
let DEVICE = store.get('device', null);
if (!DEVICE) { DEVICE = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12); store.set('device', DEVICE); }
async function rpc(fn, args) {
  const r = await fetch(`${API_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: API_KEY }, body: JSON.stringify(args || {}) });
  if (!r.ok) { let m = 'Error ' + r.status; try { m = (await r.json()).message || m; } catch {} throw new Error(m); }
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const PERSONAL=new Set(["gmail.com","googlemail.com","yahoo.com","yahoo.co.in","yahoo.in","ymail.com","rocketmail.com","hotmail.com","hotmail.co.in","outlook.com","outlook.in","live.com","live.in","msn.com","icloud.com","me.com","mac.com","aol.com","protonmail.com","proton.me","pm.me","zohomail.com","zohomail.in","gmx.com","gmx.net","mail.com","yandex.com","yandex.ru","mail.ru","rediffmail.com","rediff.com","tutanota.com","tuta.io","fastmail.com","hey.com","qq.com","163.com","126.com","duck.com","indiatimes.com","sify.com"])
;
const TEMP_RE = /(mailinator|yopmail|guerrilla|sharklasers|10minute|20minute|tempmail|temp-mail|tmpmail|throwaway|trashmail|trash-mail|dispostable|maildrop|getnada|fakeinbox|fakemail|burner|spam|discard|mailnesia|mohmal|emailondeck|1secmail|mailsac|dropmail|minuteinbox|mytemp|tempinbox|tempr\.|wegwerf|jetable)/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const WORK_MSG = { personal: 'Use your work email. Gmail, Yahoo, Outlook and other personal addresses are not accepted.', temporary: 'Disposable emails are not accepted. Use your work email.', invalid: 'Enter a valid work email, like priya@company.com.' };
const SERVER_MSG = { 'work email required': WORK_MSG.personal, 'temporary email not allowed': WORK_MSG.temporary, 'bad email': WORK_MSG.invalid };
function emailKind(em) { if (!EMAIL_RE.test(em)) return 'invalid'; const d = em.split('@')[1]; if (PERSONAL.has(d)) return 'personal'; if (TEMP_RE.test(d)) return 'temporary'; return 'ok'; }
const cleanName = (v) => (v || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
const nameEl = $('pName'), emailEl = $('pEmail'), consentEl = $('pConsent');
nameEl.value = store.get('name', ''); emailEl.value = store.get('email', ''); consentEl.checked = !!store.get('consent', false);
function formError(m) { $('ferr').textContent = m; }
[nameEl, emailEl, consentEl].forEach((el) => el.addEventListener('input', () => formError('')));
let registered = store.get('regKey', null);
let registering = false;
// Returns true once the player is saved. Ask once per device; later rounds skip straight in.
async function ensurePlayer() {
  if (registering) return false;
  const n = cleanName(nameEl.value), em = (emailEl.value || '').trim().toLowerCase();
  if (n.length < 2) { formError('Enter your name.'); nameEl.focus(); return false; }
  const k = emailKind(em); if (k !== 'ok') { formError(WORK_MSG[k]); emailEl.focus(); return false; }
  if (!consentEl.checked) { formError('Tick the box so WhizHack can store your details.'); consentEl.focus(); return false; }
  formError('');
  store.set('name', n); store.set('email', em); store.set('consent', true);
  const key = n + '|' + em;
  if (registered === key) return true;
  registering = true;
  try {
    await Promise.race([rpc('ss_register_player', { p_device: DEVICE, p_name: n, p_email: em, p_consent: true }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 6000))]);
    registered = key; store.set('regKey', key); return true;
  } catch (e) {
    const m = SERVER_MSG[e.message];
    if (m) { formError(m); emailEl.focus(); return false; }
    return true; // network trouble at the booth should never block play; the run still counts locally
  } finally { registering = false; }
}
const firstName = () => (store.get('name', '') || 'You').split(' ')[0];
async function loadBoard() { try { return (await rpc('ss_leaderboard_today')) || []; } catch { return null; } }
function renderBoard(id, rows, mine) {
  const box = $(id); const ol = box.querySelector('ol'); const rank = box.querySelector('.rank');
  if (!rows) { box.hidden = true; return; }
  box.hidden = false;
  const me = firstName();
  let myPlace = -1;
  ol.replaceChildren(...(rows.length ? rows : [{ name: 'Nobody yet', best_score: 0 }]).map((r, i) => {
    const li = document.createElement('li');
    const isMe = mine != null && myPlace < 0 && r.name === me && r.best_score === mine;
    if (isMe) { li.className = 'me'; myPlace = i; }
    const nm = document.createElement('span'); nm.textContent = r.name;
    const sc = document.createElement('b'); sc.textContent = String(r.best_score);
    li.append(nm, sc); return li;
  }));
  if (mine == null) rank.textContent = '';
  else if (myPlace === 0) rank.textContent = `You're number 1 today. Hold the line.`;
  else if (myPlace > 0) rank.textContent = `You're number ${myPlace + 1} today.`;
  else if (rows.length >= 5) rank.textContent = `${rows[4].best_score + 1} gets you onto the board.`;
  else rank.textContent = '';
}
async function refreshTopLine() {
  const rows = await loadBoard();
  const el = $('topLine');
  el.textContent = rows && rows.length ? `Today's best: ${rows[0].name} with ${rows[0].best_score}. Beat it.` : '';
}
let submitted = false;
async function submitRun() {
  if (submitted) return; submitted = true;
  const best = store.get('best', 0);
  if (score.kills > best) store.set('best', score.kills);
  const pb = $('pbNote'); if (pb) pb.textContent = score.kills > best && best > 0 ? `New personal best. Your old one was ${best}.` : '';
  if (registered) {
    try { await rpc('ss_submit_run', { p_device: DEVICE, p_score: score.kills, p_shots: score.shots, p_best_streak: score.best, p_own_goals: score.own, p_wave: wave, p_mode: finder ? 'gun' : 'tap' }); } catch {}
  }
  const rows = await loadBoard();
  renderBoard(state === 'won' ? 'boardWin' : 'boardOver', rows, registered ? score.kills : null);
}
refreshTopLine();

// ------------------------------------------------------------- rounds ----

function show(id) { for (const o of document.querySelectorAll('.ov')) o.classList.toggle('on', o.id === id); }
function startRound() {
  Object.assign(score, { shots: 0, kills: 0, streak: 0, best: 0, own: 0, lastKillAt: -1e9 });
  wave = 0; wonOnce = false; submitted = false;
  banner.classList.remove('go', 'stay');
  show(null);
  document.body.classList.remove('rush');
  state = 'play';
  endsAt = performance.now() + ROUND_SECS * 1000;
  buildWave();
  showBanner('WEAPONS FREE');
}
const LESSONS = [
  'Most of a plant network is legitimate equipment. Good OT defence takes out the intruder <b>without tripping the PLC next to it</b>. That precision is what ZeroHack OT is built for.',
  'The disguised intruders looked like normal devices until they touched a decoy. That is how <b>WhizHack deception</b> works: real operators never touch a decoy, so anyone who does is an attacker.',
  'Cloned device names, 3 AM logins and devices missing from the asset list are real warning signs. <b>Asset visibility</b> is the first step to catching them.',
];
function timeUp() {
  state = 'over';
  document.body.classList.remove('rush');
  laser.classList.remove('on', 'aiming');
  $('overKills').textContent = String(score.kills);
  $('overSub').textContent = `intruders shot. ${Math.max(0, GOAL - score.kills)} more unlocks the comic.`;
  $('lesson').innerHTML = LESSONS[(Math.random() * LESSONS.length) | 0];
  $('bSwitch').textContent = finder ? 'Switch to tap' : 'Try the finger gun';
  show('ovOver');
  submitRun();
}
let cdTimer = null;
function win() {
  wonOnce = true; state = 'won';
  setTimeout(() => showBanner('PLANT SECURED', true), 300);
  setTimeout(() => {
    banner.classList.remove('stay');
    $('winKills').textContent = String(score.kills);
    show('ovWin');
    submitRun();
    const total = 5, t0 = performance.now();
    cdTimer = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      $('cdBar').style.width = Math.min(100, (el / total) * 100) + '%';
      $('cdN').textContent = String(Math.max(0, Math.ceil(total - el)));
      if (el >= total) { clearInterval(cdTimer); cdTimer = null; location.href = COMIC_URL; }
    }, 100);
  }, 1500);
}

$('bCam').onclick = async () => { audio(); if (!(await ensurePlayer())) return; if (finder || (await startCamera())) startRound(); };
$('bTap').onclick = async () => { audio(); if (!(await ensurePlayer())) return; stopCamera(); startRound(); };
$('bAgain').onclick = () => { audio(); startRound(); };
$('restart').onclick = (e) => { e.stopPropagation(); if (state !== 'menu') startRound(); };
$('bSwitch').onclick = async () => {
  audio();
  if (finder) { stopCamera(); startRound(); return; }
  show('ovStart'); state = 'menu';
  if (await startCamera()) startRound();
};
$('bStay').onclick = () => { submitted = false; if (cdTimer) clearInterval(cdTimer); cdTimer = null; show(null); state = 'play'; endsAt = performance.now() + 30000; checkSweep(); };

// Test hook for automated checks.
window.__range = { get state() { return state; }, get kills() { return score.kills; }, set kills(v) { score.kills = v; updateStats(); }, devices: () => [...devices.values()], shoot, end: () => { endsAt = performance.now(); } };

document.body.classList.add('tapmode');
buildWave();
requestAnimationFrame(tick);
