// INCOMING — a WhizHack game about OT security.
// Traffic falls onto a power plant: threats mixed with real, legitimate traffic.
// Shoot the threats with a finger gun (or a tap), spare the real ones.
// Finger-gun hand tracking is adapted from finger-gun-tabs by Rajvi Shah (MIT).

const GOAL = 20;
const COMIC_URL = 'comic/';
const DEBUG = /[?&]debug/.test(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- canvas ---
const cv = $('cv');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, U = 90, GROUND = 0;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  U = clamp(Math.min(W, H) * 0.17, 64, 130);
  GROUND = H * (W > H ? 0.6 : 0.64);
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- sprites --
const IMG = {};
for (const n of ['crawler', 'hood', 'ransom', 'usb', 'update', 'sensor', 'hmi']) {
  IMG[n] = new Image();
  IMG[n].src = `art/${n}.webp`;
}
function drawSprite(im, x, y, size, alpha = 1, rot = 0) {
  if (!im || !im.complete || !im.naturalWidth) return;
  const s = size / Math.max(im.naturalWidth, im.naturalHeight);
  const w = im.naturalWidth * s, h = im.naturalHeight * s;
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); if (rot) ctx.rotate(rot);
  ctx.drawImage(im, -w / 2, -h / 2, w, h); ctx.restore();
}

// What can fall. kind: threat | real | fake (a threat dressed as a real update)
const TYPES = {
  crawler: { kind: 'threat', img: 'crawler', label: 'MALWARE', pts: 1, speed: 1 },
  ransom: { kind: 'threat', img: 'ransom', label: 'RANSOMWARE', pts: 1, speed: 1.25 },
  usb: { kind: 'threat', img: 'usb', label: 'ROGUE USB', pts: 1, speed: 0.95 },
  hood: { kind: 'threat', img: 'hood', label: 'APT OPERATOR', pts: 2, speed: 0.75, big: 1.15 },
  fake: { kind: 'fake', img: 'update', label: 'UNSIGNED UPDATE', pts: 2, speed: 0.9 },
  update: { kind: 'real', img: 'update', label: 'SIGNED UPDATE', speed: 0.9 },
  sensor: { kind: 'real', img: 'sensor', label: 'SENSOR DATA', speed: 1 },
  cmd: { kind: 'real', img: 'hmi', label: 'OPERATOR COMMAND', speed: 0.85 },
};

// ------------------------------------------------------------------ sound --
let AC = null;
function audio() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { AC = null; } }
  if (AC && AC.state === 'suspended') AC.resume();
}
function tone(type, f0, f1, dur, vol = 0.12, delay = 0) {
  if (!AC) return;
  const t = AC.currentTime + delay, o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol = 0.2) {
  if (!AC) return;
  const n = Math.floor(AC.sampleRate * dur), b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  const s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 1800; s.buffer = b; g.gain.value = vol;
  s.connect(f).connect(g).connect(AC.destination); s.start();
}
const SFX = {
  pew: () => tone('square', 1400, 180, 0.13, 0.07),
  kill: () => { noise(0.25, 0.25); tone('sawtooth', 240, 50, 0.3, 0.08); },
  oops: () => { tone('sawtooth', 440, 430, 0.16, 0.08); tone('sawtooth', 330, 320, 0.22, 0.08, 0.18); },
  hit: () => { tone('sine', 120, 40, 0.5, 0.3); noise(0.45, 0.25); },
  safe: () => tone('sine', 880, 1175, 0.1, 0.05),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.22, 0.12, i * 0.12)),
};

// ------------------------------------------------------------- game state --
let state = 'menu', mode = 'tap';
let score, lives, items, fx, callouts, spawnT, elapsed, shake, combo, lastKill, fakesCaught, ownGoals, wonOnce, flashRed;
let best = 0;
try { best = +localStorage.getItem('incoming.best') || 0; } catch {}

function reset() {
  score = 0; lives = 3; items = []; fx = []; callouts = []; spawnT = 0.6; elapsed = 0;
  shake = 0; combo = 0; lastKill = -9; fakesCaught = 0; ownGoals = 0; flashRed = 0;
  updateHud();
}
function updateHud() {
  $('score').innerHTML = `${score}<span> / ${GOAL}</span>`;
  $('bar').firstElementChild.style.width = Math.min(100, (score / GOAL) * 100) + '%';
  [...$('lives').querySelectorAll('i')].forEach((el, i) => el.classList.toggle('lost', i >= lives));
}
function say(text, x, y, color = '#fff', size = 22, life = 1.1) {
  x = clamp(x, 90, W - 90);
  callouts.push({ text, x, y, color, size, t: 0, life });
}

function pickType() {
  const r = Math.random();
  if (score >= 5 && r < 0.14) return 'fake';
  if (r < 0.38) return ['update', 'sensor', 'cmd'][(Math.random() * 3) | 0];
  if (score >= 3 && r < 0.48) return 'hood';
  return ['crawler', 'ransom', 'usb'][(Math.random() * 3) | 0];
}
function spawn() {
  const key = pickType(), t = TYPES[key];
  const lvl = Math.min(score, 30);
  const size = U * (t.big || 1);
  // keep new items from overlapping ones that just spawned
  let x = 0;
  for (let k = 0; k < 6; k++) {
    x = rand(0.1, 0.9) * W;
    if (!items.some((o) => o.y < U * 1.2 && Math.abs(o.x - x) < size)) break;
  }
  items.push({
    key, ...t, x, y: -size * 0.6, size,
    vy: H * (0.075 + lvl * 0.0034) * t.speed * rand(0.9, 1.1),
    sway: rand(10, 28), ph: rand(0, 6.28), rot: rand(-0.15, 0.15), vr: rand(-0.4, 0.4), dead: false,
  });
}

function step(dt) {
  elapsed += dt;
  if (state === 'play') {
    spawnT -= dt;
    if (spawnT <= 0) {
      spawn();
      spawnT = Math.max(0.55, 1.35 - score * 0.035) * rand(0.75, 1.25);
    }
  }
  for (const o of items) {
    if (o.dead) continue;
    o.ph += dt * 1.6;
    o.y += o.vy * dt;
    o.x += Math.cos(o.ph) * o.sway * dt;
    o.rot += o.vr * dt;
    if (o.y >= GROUND - o.size * 0.15) landed(o);
  }
  items = items.filter((o) => !o.dead);
  for (const p of fx) p.t += dt;
  fx = fx.filter((p) => p.t < p.life);
  for (const c of callouts) c.t += dt;
  callouts = callouts.filter((c) => c.t < c.life);
  shake = Math.max(0, shake - dt * 40);
  flashRed = Math.max(0, flashRed - dt * 1.5);
}

function landed(o) {
  o.dead = true;
  if (state !== 'play') return;
  if (o.kind === 'real') {
    say('✓ ' + o.label, o.x, GROUND - 20, '#a6f0d9', 15, 0.9);
    SFX.safe();
    return;
  }
  lives--; shake = 16; flashRed = 1; updateHud(); SFX.hit();
  for (let i = 0; i < 26; i++) {
    const a = rand(Math.PI, 2 * Math.PI), sp = rand(100, 420);
    fx.push({ kind: 'shard', x: o.x, y: GROUND, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.4, 0.9), c: Math.random() < 0.6 ? '#ff5a3b' : '#ffcf7a' });
  }
  fx.push({ kind: 'ring', x: o.x, y: GROUND, t: 0, life: 0.6, r: o.size * 0.6, c: '255,90,60' });
  say((o.kind === 'fake' ? 'FAKE UPDATE' : o.label) + ' HIT THE PLANT', o.x, GROUND - 40, '#ff6a52', 18, 1.4);
  if (lives <= 0) gameOver(o);
}

// ---------------------------------------------------------------- shooting -
const TURRET = () => ({ x: W / 2, y: H - 6 });
function nearestItem(x, y, reach) {
  let best = null, bd = reach;
  for (const o of items) {
    if (o.dead) continue;
    const d = Math.hypot(o.x - x, o.y - y);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}
function shoot(x, y) {
  if (state !== 'play') return;
  window.__shots = (window.__shots || 0) + 1;
  SFX.pew();
  const from = TURRET();
  const o = nearestItem(x, y, U * 0.62);
  const tx = o ? o.x : x, ty = o ? o.y : y;
  fx.push({ kind: 'beam', x0: from.x, y0: from.y, x1: tx, y1: ty, t: 0, life: 0.16 });
  if (!o) { fx.push({ kind: 'spark', x, y, t: 0, life: 0.3, c: '#fff' }); return; }
  o.dead = true;
  if (o.kind === 'real') {
    score = Math.max(0, score - 2); ownGoals++; shake = 8; combo = 0;
    say('THAT WAS REAL  −2', o.x, o.y - o.size * 0.5, '#f2c230', 20, 1.3);
    fx.push({ kind: 'ring', x: o.x, y: o.y, t: 0, life: 0.5, r: o.size * 0.5, c: '242,194,48' });
    SFX.oops(); updateHud();
    return;
  }
  combo = elapsed - lastKill < 1.6 ? combo + 1 : 1;
  lastKill = elapsed;
  score += o.pts; updateHud(); shake = Math.max(shake, 5); SFX.kill();
  if (o.kind === 'fake') fakesCaught++;
  for (let i = 0; i < 18; i++) {
    const a = rand(0, 6.28), sp = rand(80, 340);
    fx.push({ kind: 'shard', x: o.x, y: o.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: 0, life: rand(0.35, 0.7), c: Math.random() < 0.7 ? '#ff4b3b' : '#ffd0a0' });
  }
  fx.push({ kind: 'ring', x: o.x, y: o.y, t: 0, life: 0.45, r: o.size * 0.5, c: '255,120,90' });
  let txt = o.kind === 'fake' ? 'FAKE CAUGHT  +2' : o.key === 'hood' ? 'APT DOWN  +2' : 'BLOCKED  +1';
  if (combo === 2) txt = 'DOUBLE BLOCK';
  else if (combo === 3) txt = 'TRIPLE BLOCK';
  else if (combo >= 4) txt = `CHAIN ×${combo}`;
  say(txt, o.x, o.y - o.size * 0.5, combo >= 2 || o.kind === 'fake' ? '#f2c230' : '#ff8a6e', combo >= 2 ? 26 : 21);
  if (score >= GOAL && !wonOnce) win();
}

// ----------------------------------------------------------------- render --
function render() {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (shake > 0) ctx.translate(rand(-shake, shake) * 0.6, rand(-shake, shake) * 0.6);

  // shield line over the plant
  const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2);
  const g = ctx.createLinearGradient(0, GROUND - 30, 0, GROUND + 10);
  g.addColorStop(0, 'rgba(99,214,180,0)'); g.addColorStop(1, `rgba(99,214,180,${0.18 + pulse * 0.1})`);
  ctx.fillStyle = g; ctx.fillRect(0, GROUND - 30, W, 40);
  ctx.strokeStyle = `rgba(166,240,217,${0.45 + pulse * 0.3})`; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, GROUND); ctx.lineTo(W, GROUND); ctx.stroke();
  ctx.font = '700 11px "Chakra Petch",sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(166,240,217,.75)';
  ctx.fillText('PLANT SHIELD', 10, GROUND + 16);
  if (flashRed > 0) { ctx.fillStyle = `rgba(255,40,30,${flashRed * 0.28})`; ctx.fillRect(-20, -20, W + 40, H + 40); }

  // falling items
  ctx.textAlign = 'center';
  for (const o of items) {
    const bad = o.kind !== 'real';
    const glitch = o.kind === 'fake' && Math.sin(elapsed * 9 + o.ph) > 0.82;
    // halo
    ctx.beginPath(); ctx.arc(o.x, o.y, o.size * 0.5, 0, 6.28);
    ctx.fillStyle = o.kind === 'threat' ? 'rgba(255,50,40,.10)' : glitch ? 'rgba(255,50,40,.22)' : 'rgba(99,214,180,.08)'; ctx.fill();
    if (glitch) { ctx.save(); ctx.filter = 'hue-rotate(-130deg) saturate(3)'; drawSprite(IMG[o.img], o.x + rand(-3, 3), o.y, o.size, 1, o.rot); ctx.restore(); }
    else drawSprite(IMG[o.img], o.x, o.y, o.size, 1, o.rot);
    // label
    ctx.font = `700 ${Math.max(10, U * 0.13)}px "Chakra Petch",sans-serif`;
    const label = o.label, tw = ctx.measureText(label).width + 10, ly = o.y + o.size * 0.58;
    ctx.fillStyle = bad ? 'rgba(50,0,0,.7)' : 'rgba(0,30,22,.7)';
    ctx.fillRect(o.x - tw / 2, ly - U * 0.12, tw, U * 0.17);
    ctx.fillStyle = o.kind === 'threat' ? '#ffb3a3' : o.kind === 'fake' ? (glitch ? '#ff8a6e' : '#d9efe6') : '#a6f0d9';
    ctx.fillText(label, o.x, ly);
  }

  // effects
  for (const p of fx) {
    const k = p.t / p.life;
    if (p.kind === 'beam') {
      ctx.lineCap = 'round'; ctx.shadowColor = '#ff2d2d'; ctx.shadowBlur = 18;
      ctx.strokeStyle = `rgba(255,70,50,${1 - k})`; ctx.lineWidth = 7 * (1 - k) + 1;
      ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); ctx.stroke();
      ctx.strokeStyle = `rgba(255,240,220,${1 - k})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); ctx.stroke(); ctx.shadowBlur = 0;
    } else if (p.kind === 'shard') {
      ctx.globalAlpha = 1 - k; ctx.fillStyle = p.c;
      ctx.fillRect(p.x + p.vx * p.t - 2, p.y + p.vy * p.t + 300 * p.t * p.t - 2, 4, 4); ctx.globalAlpha = 1;
    } else if (p.kind === 'ring') {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + k * 1.6), 0, 6.28);
      ctx.strokeStyle = `rgba(${p.c},${1 - k})`; ctx.lineWidth = 3; ctx.stroke();
    } else if (p.kind === 'spark') {
      ctx.beginPath(); ctx.arc(p.x, p.y, 6 + k * 16, 0, 6.28);
      ctx.globalAlpha = 1 - k; ctx.strokeStyle = p.c; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  // turret
  const t = TURRET();
  ctx.fillStyle = '#0b1a17'; ctx.strokeStyle = 'rgba(166,240,217,.7)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(t.x, t.y + 4, 26, Math.PI, 0); ctx.fill(); ctx.stroke();
  if (cross.on) {
    const ang = Math.atan2(cross.y - t.y, cross.x - t.x);
    ctx.save(); ctx.translate(t.x, t.y - 4); ctx.rotate(ang);
    ctx.fillStyle = '#a6f0d9'; ctx.fillRect(0, -4, 34, 8); ctx.restore();
  }

  // crosshair
  if (cross.on) {
    const r = 20, gun = cross.gun;
    ctx.strokeStyle = gun ? '#ff3b3b' : 'rgba(255,255,255,.85)'; ctx.lineWidth = 2.5;
    ctx.shadowColor = '#ff3b3b'; ctx.shadowBlur = gun ? 14 : 0;
    ctx.beginPath(); ctx.arc(cross.x, cross.y, r, 0, 6.28); ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath(); ctx.moveTo(cross.x + dx * (r - 7), cross.y + dy * (r - 7)); ctx.lineTo(cross.x + dx * (r + 9), cross.y + dy * (r + 9)); ctx.stroke();
    }
    ctx.fillStyle = gun ? '#ff3b3b' : '#fff'; ctx.beginPath(); ctx.arc(cross.x, cross.y, 3, 0, 6.28); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // callouts
  ctx.textAlign = 'center';
  for (const c of callouts) {
    const k = c.t / c.life, pop = c.t < 0.12 ? 0.7 + (c.t / 0.12) * 0.3 : 1;
    ctx.font = `700 ${c.size * pop}px "Chakra Petch",sans-serif`;
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.75)';
    ctx.strokeText(c.text, c.x, c.y - k * 30); ctx.fillStyle = c.color; ctx.fillText(c.text, c.x, c.y - k * 30);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ------------------------------------------------------------ main loop ---
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (mode === 'cam' && finder) trackHand(now);
  if (state !== 'menu') step(state === 'play' ? dt : dt * 0.4);
  render();
}

// ----------------------------------------------------------------- input --
const cross = { on: false, x: 0, y: 0, gun: false };
cv.addEventListener('pointerdown', (e) => { audio(); shoot(e.clientX, e.clientY); });
cv.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' && performance.now() - lastHandAt > 600) { cross.on = true; cross.x = e.clientX; cross.y = e.clientY; cross.gun = true; }
});

// --------------------------------------------------------- hand tracking ---
// Same pipeline as finger-gun-tabs: zoomed hand finder, finger-gun pose,
// thumb-drop trigger, One Euro smoothing, trackpad-style aim and lag-compensated shots.
const video = $('cam'), skel = $('skel'), sctx = skel.getContext('2d'), camBox = $('camBox');
let HJ = null, finder = null, trigger = null, fX = null, fY = null;
let lastVideoTime = -1, lastHandAt = -1e9, detectErrors = 0, usingCPU = false;
let frames = 0, fps = 0, fpsMark = 0, lastA = null;
const aimHist = [];
const zone = { set: false, cx: 0.5, cy: 0.5, hw: 0.2, hh: 0.26 };

function handToScreen(px, py) {
  if (!zone.set) {
    zone.set = true;
    const fa = video.videoWidth / video.videoHeight || 16 / 9;
    zone.hw = clamp((zone.hh * (W / H)) / fa, 0.12, 0.42);
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
function drawSkeleton(hand, gun) {
  sctx.clearRect(0, 0, skel.width, skel.height);
  if (!hand) return;
  // The box uses object-fit:cover; map video coords to the box's canvas.
  const vw = video.videoWidth, vh = video.videoHeight, bw = skel.width, bh = skel.height;
  const s = Math.max(bw / vw, bh / vh), ox = (bw - vw * s) / 2, oy = (bh - vh * s) / 2;
  const P = (p) => [p.x * vw * s + ox, p.y * vh * s + oy];
  const lm = hand.landmarks;
  sctx.lineWidth = Math.max(2, bw / 110); sctx.strokeStyle = gun ? '#ff2d3d' : 'rgba(255,255,255,.9)';
  sctx.beginPath();
  for (const [a, b] of HJ.HAND_EDGES) { sctx.moveTo(...P(lm[a])); sctx.lineTo(...P(lm[b])); }
  sctx.stroke();
  sctx.fillStyle = gun ? '#ff2d3d' : '#fff'; sctx.beginPath(); sctx.arc(...P(lm[8]), sctx.lineWidth * 2.4, 0, 6.28); sctx.fill();
}
let statusKey = '';
function status(key, text, cls = '') {
  if (key === statusKey) return;
  statusKey = key; const el = $('status');
  el.textContent = text; el.className = 'chip on ' + cls;
}
function aimAt(t) { for (let i = aimHist.length - 1; i >= 0; i--) if (aimHist[i].t <= t) return aimHist[i]; return aimHist[0]; }

async function switchToCPU() {
  if (usingCPU) return;
  usingCPU = true;
  try { finder = new HJ.HandFinder(await HJ.createTracker('CPU')); detectErrors = 0; } catch {}
}

function trackHand(now) {
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let hand;
  try { hand = finder.detect(video); detectErrors = 0; }
  catch (e) { if (++detectErrors > 8) switchToCPU(); return; }
  frames++;
  if (now - fpsMark > 1000) { fps = Math.round((frames * 1000) / (now - fpsMark)); frames = 0; fpsMark = now; }

  if (!hand) {
    trigger.update(null, now);
    drawSkeleton(null);
    if (now - lastHandAt > 500) { cross.on = false; fX.reset(); fY.reset(); aimHist.length = 0; camBox.classList.remove('gun'); }
    if (now - lastHandAt > 1200) zone.set = false;
    if (state === 'play' && now - lastHandAt > 600) status('none', '✋ Hold your hand up so the camera box sees it', 'warn');
    showDebug(null);
    return;
  }
  lastHandAt = now;
  const a = HJ.analyze(hand.world, trigger.isGun);
  lastA = a;
  const fired = trigger.update(a, now);
  drawSkeleton(hand, trigger.isGun);
  camBox.classList.toggle('gun', trigger.isGun);

  // aim with the whole index finger: steadier, and it barely moves when the thumb drops
  const lm = hand.landmarks;
  const ax = (lm[5].x + lm[6].x + lm[7].x + lm[8].x) / 4;
  const ay = (lm[5].y + lm[6].y + lm[7].y + lm[8].y) / 4;
  const [nx, ny] = handToScreen(1 - ax, ay);
  let x = fX.filter(nx, now / 1000) * W, y = fY.filter(ny, now / 1000) * H;
  // aim assist: pull toward whatever item is nearest (real ones too, so you still have to choose)
  const near = nearestItem(x, y, U * 0.9);
  if (near) { x += (near.x - x) * 0.45; y += (near.y - y) * 0.45; }
  cross.on = true; cross.x = x; cross.y = y; cross.gun = trigger.isGun;
  aimHist.push({ t: now, x, y });
  while (aimHist.length > 1 && now - aimHist[0].t > 500) aimHist.shift();
  if (fired) { const p = aimAt(now - HJ.TUNING.aimLagMs); shoot(p.x, p.y); }

  if (state === 'play') {
    if (trigger.isGun) status('gun', '🎯 Aiming. Drop your thumb to fire', 'gun');
    else status('hand', '👉 Point your index finger, curl the rest, thumb up', 'live');
  }
  showDebug(a);
}
function showDebug(a) {
  const el = $('debugBox');
  if (!DEBUG && el.style.display !== 'block') return;
  el.style.display = 'block';
  el.textContent = `fps ${fps} ${usingCPU ? 'CPU' : 'GPU'}  video ${video.videoWidth}x${video.videoHeight}\n` +
    (a ? `gun ${a.isGun ? 'YES' : 'no'}  armed ${trigger.armed ? 'yes' : 'no'}\nindex ${a.index.toFixed(2)} others ${a.others.map((v) => v.toFixed(2)).join(' ')}\nthumb ${a.thumb.toFixed(2)} peak ${trigger.peak.toFixed(2)}  shots ${window.__shots || 0}` : 'no hand');
}

async function startCamera() {
  const btn = $('bCam'); btn.disabled = true; $('camErr').textContent = '';
  try {
    btn.textContent = 'Starting camera…';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
    camBox.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    camBox.classList.add('on');
    skel.width = Math.round(video.videoWidth / 2) || 640; skel.height = Math.round(video.videoHeight / 2) || 360;
    btn.textContent = 'Loading hand tracking…';
    HJ = await import('./hand.js');
    finder = new HJ.HandFinder(await HJ.createTracker('GPU'));
    trigger = new HJ.GunTrigger(); fX = new HJ.OneEuro(); fY = new HJ.OneEuro();
    lastVideoTime = -1; zone.set = false;
    mode = 'cam';
    return true;
  } catch (e) {
    console.error('camera/tracking start failed', e);
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    $('camErr').textContent = denied
      ? 'Camera is blocked. Allow it from the camera icon in the address bar, then try again. Or play with tap.'
      : e && e.message === 'nocam' ? 'This browser has no camera access. Play with tap instead.'
      : 'Hand tracking could not start on this device. Play with tap instead.';
    stopCamera();
    return false;
  } finally {
    btn.textContent = '👉 Play with finger gun'; btn.disabled = false;
  }
}
function stopCamera() {
  const s = video.srcObject; if (s) s.getTracks().forEach((t) => t.stop());
  video.srcObject = null; camBox.classList.remove('on');
  finder = null; mode = 'tap'; cross.on = false;
}

// ------------------------------------------------------------ screens -----
function show(id) { for (const o of document.querySelectorAll('.ov')) o.classList.toggle('on', o.id === id); }
function startGame() {
  reset(); state = 'play'; show(null);
  $('hud').classList.add('on'); statusKey = '';
  if (mode === 'cam') status('none', '✋ Hold your hand up so the camera box sees it', 'warn');
  else { status('tap', 'Tap the red threats. Let the green ones land.', 'live'); setTimeout(() => { if (statusKey === 'tap') $('status').classList.remove('on'); }, 3500); }
  say('INCOMING', W / 2, H * 0.35, '#ff8a6e', 34, 1.4);
}
const LESSONS = [
  'In a real plant, most traffic is legitimate. The skill is stopping the attack <b>without blocking the updates, sensor data and commands the plant needs to run</b>. That is what ZeroHack OT is built for.',
  'Some attacks arrive dressed as normal traffic, like an unsigned update posing as a real one. <b>Deep visibility into OT traffic</b> is how you tell them apart.',
  'Shooting real traffic hurts the plant too. Good OT defence is <b>precise</b>: block the threat, never break the process.',
];
function gameOver() {
  state = 'over';
  if (score > best) { best = score; try { localStorage.setItem('incoming.best', best); } catch {} }
  setTimeout(() => {
    $('overScore').textContent = score;
    $('overNeed').textContent = score >= GOAL ? 'comic already unlocked' : `${GOAL - score} more to unlock the comic`;
    $('stBest').textContent = best; $('stFake').textContent = fakesCaught; $('stOwn').textContent = ownGoals;
    $('lesson').innerHTML = LESSONS[(Math.random() * LESSONS.length) | 0];
    $('bSwitch').textContent = mode === 'cam' ? 'Switch to tap' : '👉 Try the finger gun';
    show('ovOver'); $('status').classList.remove('on');
  }, 900);
}
let cdTimer = null;
function win() {
  wonOnce = true; state = 'won'; SFX.win();
  if (score > best) { best = score; try { localStorage.setItem('incoming.best', best); } catch {} }
  for (const o of items) { o.dead = true; fx.push({ kind: 'ring', x: o.x, y: o.y, t: 0, life: 0.5, r: o.size * 0.4, c: '166,240,217' }); }
  say('PLANT SECURED', W / 2, H * 0.35, '#a6f0d9', 34, 2);
  setTimeout(() => {
    $('winScore').textContent = score; show('ovWin'); $('status').classList.remove('on');
    const total = 5, t0 = performance.now();
    cdTimer = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      $('cdBar').style.width = Math.min(100, (el / total) * 100) + '%';
      $('cdN').textContent = Math.max(0, Math.ceil(total - el));
      if (el >= total) { clearInterval(cdTimer); cdTimer = null; location.href = COMIC_URL; }
    }, 100);
  }, 1100);
}

$('bCam').onclick = async () => { audio(); if (mode !== 'cam' && !(await startCamera())) return; startGame(); };
$('bTap').onclick = () => { audio(); if (mode === 'cam') stopCamera(); startGame(); };
$('bAgain').onclick = () => { audio(); startGame(); };
$('bSwitch').onclick = async () => {
  audio();
  if (mode === 'cam') { stopCamera(); startGame(); return; }
  show('ovStart'); state = 'menu'; $('hud').classList.remove('on');
  if (await startCamera()) startGame();
};
$('bStay').onclick = () => { if (cdTimer) clearInterval(cdTimer); cdTimer = null; show(null); state = 'play'; statusKey = ''; };
addEventListener('keydown', (e) => { if (e.key === 'd' || e.key === 'D') { $('debugBox').style.display = $('debugBox').style.display === 'block' ? 'none' : 'block'; } });

// test hooks
window.__game = { get state() { return state; }, get score() { return score; }, set score(v) { score = v; updateHud(); }, get items() { return items; } };

resize(); reset(); state = 'menu';
requestAnimationFrame(frame);
