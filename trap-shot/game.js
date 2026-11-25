// TRAP SHOT — a WhizHack game about deception in OT security.
// Attackers move through the plant almost invisible. When one touches a blue
// decoy it is unmasked, and only then can the player shoot it.
// Finger-gun hand tracking is adapted from finger-gun-tabs by Rajvi Shah (MIT).

const GOAL = 20;
const COMIC_URL = 'comic/';
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// ---------------------------------------------------------------- canvas ---
const cv = $('cv');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, U = 100; // U = sprite size in CSS px
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  U = clamp(Math.min(W, H) * 0.21, 70, 165);
  layoutAssets();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- sprites --
const IMG = {};
for (const n of ['crawler', 'hood', 'plc', 'hmi', 'rtu', 'decoy']) {
  IMG[n] = new Image();
  IMG[n].src = `art/${n}.webp`;
}
const ready = (im) => im && im.complete && im.naturalWidth > 0;
function drawSprite(im, x, y, size, alpha = 1) {
  if (!ready(im)) return;
  const s = size / Math.max(im.naturalWidth, im.naturalHeight);
  const w = im.naturalWidth * s, h = im.naturalHeight * s;
  ctx.globalAlpha = alpha;
  ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ sound --
let AC = null;
function audio() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch { AC = null; } }
  if (AC && AC.state === 'suspended') AC.resume();
}
function tone(type, f0, f1, dur, vol = 0.12, delay = 0) {
  if (!AC) return;
  const t = AC.currentTime + delay;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(AC.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol = 0.2, delay = 0) {
  if (!AC) return;
  const t = AC.currentTime + delay, n = Math.floor(AC.sampleRate * dur);
  const b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2;
  const s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 1800;
  s.buffer = b; g.gain.value = vol; s.connect(f).connect(g).connect(AC.destination); s.start(t);
}
const SFX = {
  pew: () => tone('square', 1400, 180, 0.13, 0.07),
  kill: () => { noise(0.28, 0.25); tone('sawtooth', 220, 50, 0.3, 0.09); },
  unmask: () => { tone('sine', 880, 1320, 0.09, 0.1); tone('sine', 1320, 1760, 0.09, 0.08, 0.09); },
  trip: () => { tone('sawtooth', 440, 430, 0.18, 0.08); tone('sawtooth', 330, 320, 0.25, 0.08, 0.2); },
  breach: () => { tone('sine', 120, 40, 0.5, 0.3); noise(0.4, 0.2); },
  ghost: () => tone('triangle', 300, 200, 0.12, 0.05),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.22, 0.12, i * 0.12)),
};

// ----------------------------------------------------------------- assets --
// Front row: the decoy mesh. Back row: the real plant.
const REAL = [
  { sprite: 'plc', label: 'BOILER PLC' },
  { sprite: 'hmi', label: 'TURBINE HMI' },
  { sprite: 'rtu', label: 'SUBSTATION RTU' },
];
const DECOY_NAMES = ['PLC-07', 'PLC-11', 'PLC-14'];
let assets = [];
function buildAssets() {
  const realCols = [0, 1, 2].sort(() => Math.random() - 0.5);
  const decoyCols = [0, 1, 2].sort(() => Math.random() - 0.5);
  assets = [];
  REAL.forEach((r, i) => assets.push({ kind: 'real', sprite: r.sprite, label: r.label, col: realCols[i], row: 1, flash: 0, hurt: 0 }));
  DECOY_NAMES.forEach((n, i) => assets.push({ kind: 'decoy', sprite: 'decoy', label: 'DECOY · ' + n, col: decoyCols[i], row: 0, flash: 0, hurt: 0, burned: 0 }));
  layoutAssets();
}
function layoutAssets() {
  const xs = [0.19, 0.5, 0.81];
  const ys = H > W ? [0.5, 0.78] : [0.5, 0.8];
  for (const a of assets) {
    a.x = xs[a.col] * W + (a.row === 0 ? 0 : 0);
    a.y = ys[a.row] * H;
  }
}
const decoys = () => assets.filter((a) => a.kind === 'decoy');
const reals = () => assets.filter((a) => a.kind === 'real');

// ------------------------------------------------------------- game state --
let state = 'menu'; // menu | play | over | won
let mode = 'tap'; // tap | cam
let score, lives, attackers, fx, callouts, spawnT, elapsed, shake, combo, lastKill, tripped, ownGoals, wonOnce, lastBreach;
let best = 0;
try { best = +localStorage.getItem('trapshot.best') || 0; } catch {}

function reset() {
  score = 0; lives = 3; attackers = []; fx = []; callouts = []; spawnT = 0.9; elapsed = 0;
  shake = 0; combo = 0; lastKill = -9; tripped = 0; ownGoals = 0; lastBreach = '';
  buildAssets(); updateHud();
}

function updateHud() {
  $('score').innerHTML = `${score}<span> / ${GOAL}</span>`;
  $('bar').firstElementChild.style.width = Math.min(100, (score / GOAL) * 100) + '%';
  [...$('lives').querySelectorAll('i')].forEach((el, i) => el.classList.toggle('lost', i >= lives));
}

function say(text, x, y, color = '#fff', size = 22, life = 1.1) {
  callouts.push({ text, x, y, color, size, t: 0, life });
}

function spawn() {
  const ops = score >= 4 && Math.random() < 0.25;
  const free = decoys().filter((d) => !d.burned);
  const pool = free.length ? free : decoys();
  // Head for the decoy closest to where it enters the plant (a lure on its path).
  const x = rand(0.08, 0.92) * W;
  pool.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
  const target = Math.random() < 0.7 ? pool[0] : pick(pool);
  const base = H * (0.1 + Math.min(score, 30) * 0.0035);
  attackers.push({
    type: ops ? 'hood' : 'crawler', pts: ops ? 2 : 1,
    x, y: -U * 0.4, target, state: 'hidden', speed: base * (ops ? 0.8 : 1),
    phase: rand(0, 6.28), t: 0, ip: `10.0.${(Math.random() * 9) | 0}.${(20 + Math.random() * 200) | 0}`,
    size: U * (ops ? 0.85 : 0.7),
  });
}

function unmask(a, decoy) {
  a.state = 'unmasked'; a.t = 0;
  const rs = reals();
  a.target = rs.sort((p, q) => Math.abs(p.x - a.x) - Math.abs(q.x - a.x))[Math.random() < 0.6 ? 0 : (Math.random() * 3) | 0];
  a.speed = H * (0.075 + Math.min(score, 30) * 0.0026) * (a.type === 'hood' ? 0.85 : 1);
  decoy.flash = 1; tripped++;
  say('TRIPWIRE', decoy.x, decoy.y + U * 0.12, '#7fd8ff', 18, 0.9);
  SFX.unmask();
}

function breach(a) {
  a.state = 'dead';
  if (state !== 'play') return;
  const t = a.target; t.hurt = 1; lives--; shake = 14; lastBreach = t.label;
  say('BREACH · ' + t.label, t.x, t.y - U * 0.6, '#ff6a52', 20, 1.4);
  SFX.breach(); updateHud();
  if (lives <= 0) gameOver();
}

function step(dt) {
  elapsed += dt;
  // spawning
  if (state === 'play') {
    spawnT -= dt;
    const live = attackers.filter((a) => a.state !== 'dead').length;
    const cap = 3 + Math.floor(score / 6);
    if (spawnT <= 0 && live < cap) {
      spawn();
      spawnT = Math.max(0.85, 2.0 - score * 0.055) * rand(0.8, 1.2);
    }
  }
  for (const as of assets) {
    as.flash = Math.max(0, as.flash - dt * 1.4);
    as.hurt = Math.max(0, as.hurt - dt * 1.2);
    if (as.burned) as.burned = Math.max(0, as.burned - dt);
  }
  for (const a of attackers) {
    if (a.state === 'dead') continue;
    a.t += dt; a.phase += dt * 3;
    const tx = a.target.x, ty = a.target.y;
    const dx = tx - a.x, dy = ty - a.y, d = Math.hypot(dx, dy);
    const v = a.speed * dt;
    const wob = Math.sin(a.phase) * (a.state === 'hidden' ? 40 : 25) * dt;
    if (d > 1) { a.x += (dx / d) * v + (-dy / d) * wob; a.y += (dy / d) * v + (dx / d) * wob; }
    if (a.state === 'hidden') {
      // passing near any live decoy also trips it
      for (const dc of decoys()) {
        if (dc.burned) continue;
        if (Math.hypot(dc.x - a.x, dc.y - a.y) < U * 0.38) { unmask(a, dc); break; }
      }
      if (a.state === 'hidden' && d < U * 0.3) {
        // its decoy was burned: it slips past unseen
        const rs = reals();
        a.target = rs.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y))[0];
        a.state = 'slipping';
      }
    } else if (d < U * 0.32) {
      breach(a);
    }
  }
  attackers = attackers.filter((a) => a.state !== 'dead' || false);
  for (const p of fx) p.t += dt;
  fx = fx.filter((p) => p.t < p.life);
  for (const c of callouts) c.t += dt;
  callouts = callouts.filter((c) => c.t < c.life);
  shake = Math.max(0, shake - dt * 40);
}

// ---------------------------------------------------------------- shooting -
let beamFrom = null; // screen point the laser starts from (fingertip)
function shoot(x, y) {
  if (state !== 'play') return;
  SFX.pew();
  const from = beamFrom || { x: W / 2, y: H + 10 };
  fx.push({ kind: 'beam', x0: from.x, y0: from.y, x1: x, y1: y, t: 0, life: 0.16 });

  const reach = U * 0.62;
  let hit = null, hd = Infinity;
  for (const a of attackers) {
    if (a.state !== 'unmasked') continue;
    const d = Math.hypot(a.x - x, a.y - y);
    if (d < reach && d < hd) { hit = a; hd = d; }
  }
  if (hit) return kill(hit);

  for (const a of attackers) {
    if ((a.state === 'hidden' || a.state === 'slipping') && Math.hypot(a.x - x, a.y - y) < reach * 0.9) {
      say('NO SIGNAL', a.x, a.y - U * 0.4, '#9ab8ae', 17, 0.9);
      if (!shoot.hinted) { shoot.hinted = true; say('Let it hit a decoy first', a.x, a.y - U * 0.15, '#9ab8ae', 14, 1.6); }
      SFX.ghost(); spark(x, y, '#9ab8ae');
      return;
    }
  }
  for (const as of assets) {
    if (Math.abs(as.x - x) < U * 0.42 && Math.abs(as.y - y) < U * 0.42) {
      if (as.kind === 'real') {
        score = Math.max(0, score - 3); ownGoals++; as.hurt = 1; shake = 10;
        say('PLANT TRIP  −3', as.x, as.y - U * 0.62, '#f2c230', 20, 1.3);
        SFX.trip();
      } else {
        score = Math.max(0, score - 1); as.burned = 5; as.flash = 0;
        say('DECOY BURNED  −1', as.x, as.y - U * 0.62, '#f2c230', 18, 1.3);
        SFX.trip();
      }
      updateHud(); spark(x, y, '#f2c230');
      return;
    }
  }
  spark(x, y, '#ffffff');
}
function spark(x, y, color) { fx.push({ kind: 'spark', x, y, color, t: 0, life: 0.3 }); }

function kill(a) {
  a.state = 'dead';
  const now = elapsed;
  combo = now - lastKill < 1.7 ? combo + 1 : 1;
  lastKill = now;
  score += a.pts; updateHud();
  shake = Math.max(shake, 5);
  SFX.kill();
  for (let i = 0; i < 18; i++) {
    const ang = rand(0, 6.28), sp = rand(80, 340);
    fx.push({ kind: 'shard', x: a.x, y: a.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, t: 0, life: rand(0.35, 0.7), c: Math.random() < 0.7 ? '#ff4b3b' : '#ffd0a0' });
  }
  fx.push({ kind: 'ring', x: a.x, y: a.y, t: 0, life: 0.45, r: a.size * 0.6 });
  let txt = a.type === 'hood' ? 'APT DOWN  +2' : 'TRACED  +1';
  if (combo === 2) txt = 'DOUBLE TRACE';
  else if (combo === 3) txt = 'TRIPLE TRACE';
  else if (combo >= 4) txt = `CHAIN TRACE ×${combo}`;
  say(txt, a.x, a.y - a.size * 0.55, combo >= 2 ? '#f2c230' : '#ff8a6e', combo >= 2 ? 26 : 21, 1.1);
  say(a.ip, a.x, a.y - a.size * 0.25, 'rgba(255,200,190,.8)', 12, 0.8);
  if (score >= GOAL && !wonOnce) win();
}

// ----------------------------------------------------------------- render --
function render() {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (shake > 0) ctx.translate(rand(-shake, shake) * 0.6, rand(-shake, shake) * 0.6);

  // IT/OT boundary
  const by = H * 0.13 + 10;
  ctx.strokeStyle = 'rgba(255,90,70,.35)'; ctx.setLineDash([8, 8]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '600 11px "Chakra Petch",sans-serif'; ctx.fillStyle = 'rgba(255,140,120,.6)'; ctx.textAlign = 'center';
  ctx.fillText('IT / OT BOUNDARY', W / 2, by + 16);

  // links from decoys to the plant (the "mesh")
  ctx.strokeStyle = 'rgba(76,195,255,.12)'; ctx.lineWidth = 1;
  for (const d of decoys()) for (const r of reals()) { ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(r.x, r.y); ctx.stroke(); }

  // assets
  for (const as of assets) {
    const isD = as.kind === 'decoy';
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2 + as.col);
    // floor ring
    ctx.beginPath(); ctx.ellipse(as.x, as.y + U * 0.42, U * 0.46, U * 0.11, 0, 0, 6.28);
    ctx.fillStyle = isD ? `rgba(76,195,255,${as.burned ? 0.04 : 0.1 + pulse * 0.06})` : 'rgba(99,214,180,.1)'; ctx.fill();
    if (isD && !as.burned) {
      // trap field
      ctx.beginPath(); ctx.arc(as.x, as.y, U * 0.38, 0, 6.28);
      ctx.strokeStyle = `rgba(76,195,255,${0.15 + pulse * 0.15 + as.flash * 0.6})`; ctx.lineWidth = 1 + as.flash * 4; ctx.stroke();
    }
    if (as.flash > 0) {
      ctx.beginPath(); ctx.arc(as.x, as.y, U * (0.4 + (1 - as.flash) * 0.6), 0, 6.28);
      ctx.strokeStyle = `rgba(127,216,255,${as.flash})`; ctx.lineWidth = 3; ctx.stroke();
    }
    let alpha = isD && as.burned ? 0.25 : 0.95;
    if (as.hurt > 0 && Math.sin(elapsed * 40) > 0) alpha = 0.35;
    drawSprite(IMG[as.sprite], as.x, as.y, U * (isD ? 0.82 : 0.86), alpha);
    if (as.hurt > 0) {
      ctx.fillStyle = `rgba(255,59,59,${as.hurt * 0.35})`;
      ctx.beginPath(); ctx.arc(as.x, as.y, U * 0.5, 0, 6.28); ctx.fill();
    }
    ctx.font = `700 ${Math.max(10, U * 0.105)}px "Chakra Petch",sans-serif`;
    ctx.fillStyle = isD ? (as.burned ? 'rgba(242,194,48,.8)' : 'rgba(127,216,255,.95)') : 'rgba(166,240,217,.95)';
    ctx.fillText(as.burned ? 'DECOY BURNED' : as.label, as.x, as.y + U * 0.62);
  }

  // attackers
  for (const a of attackers) {
    if (a.state === 'dead') continue;
    const im = IMG[a.type];
    if (a.state === 'hidden' || a.state === 'slipping') {
      const flick = 0.2 + 0.1 * Math.max(0, Math.sin(a.phase * 3.7)) + (Math.random() < 0.04 ? 0.15 : 0);
      ctx.save(); ctx.filter = 'grayscale(1) brightness(1.4) blur(1px)';
      drawSprite(im, a.x + rand(-1, 1), a.y, a.size, flick);
      ctx.restore();
    } else {
      const k = Math.min(1, a.t * 4);
      ctx.beginPath(); ctx.arc(a.x, a.y, a.size * (0.55 + (1 - k) * 0.6), 0, 6.28);
      ctx.strokeStyle = `rgba(255,59,59,${0.35 + 0.25 * Math.sin(elapsed * 10)})`; ctx.lineWidth = 2; ctx.stroke();
      drawSprite(im, a.x, a.y, a.size * (1 + (1 - k) * 0.3), 1);
      // tag
      ctx.font = `700 ${Math.max(10, U * 0.1)}px "Chakra Petch",sans-serif`;
      const label = 'TRACED · ' + a.ip, tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(60,0,0,.75)'; ctx.fillRect(a.x - tw / 2, a.y - a.size * 0.78, tw, U * 0.15);
      ctx.fillStyle = '#ffb3a3'; ctx.fillText(label, a.x, a.y - a.size * 0.78 + U * 0.115);
      // line to its target
      ctx.strokeStyle = 'rgba(255,59,59,.3)'; ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.target.x, a.target.y); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // effects
  for (const p of fx) {
    const k = p.t / p.life;
    if (p.kind === 'beam') {
      ctx.strokeStyle = `rgba(255,70,50,${1 - k})`; ctx.lineWidth = 7 * (1 - k) + 1; ctx.lineCap = 'round';
      ctx.shadowColor = '#ff2d2d'; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); ctx.stroke();
      ctx.strokeStyle = `rgba(255,240,220,${1 - k})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(p.x0, p.y0); ctx.lineTo(p.x1, p.y1); ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (p.kind === 'shard') {
      ctx.fillStyle = p.c; ctx.globalAlpha = 1 - k;
      ctx.fillRect(p.x + p.vx * p.t - 2, p.y + p.vy * p.t - 2, 4, 4); ctx.globalAlpha = 1;
    } else if (p.kind === 'ring') {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 + k * 1.6), 0, 6.28);
      ctx.strokeStyle = `rgba(255,120,90,${1 - k})`; ctx.lineWidth = 3; ctx.stroke();
    } else if (p.kind === 'spark') {
      ctx.beginPath(); ctx.arc(p.x, p.y, 6 + k * 16, 0, 6.28);
      ctx.strokeStyle = p.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  // hand skeleton (camera mode)
  if (handDraw) drawHand(handDraw);

  // crosshair
  if (cross.on) {
    const r = 18, gun = cross.gun;
    ctx.strokeStyle = gun ? '#ff3b3b' : 'rgba(255,255,255,.8)'; ctx.lineWidth = 2;
    ctx.shadowColor = gun ? '#ff3b3b' : 'transparent'; ctx.shadowBlur = gun ? 12 : 0;
    ctx.beginPath(); ctx.arc(cross.x, cross.y, r, 0, 6.28); ctx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.beginPath(); ctx.moveTo(cross.x + dx * (r - 6), cross.y + dy * (r - 6)); ctx.lineTo(cross.x + dx * (r + 8), cross.y + dy * (r + 8)); ctx.stroke();
    }
    ctx.fillStyle = gun ? '#ff3b3b' : '#fff'; ctx.beginPath(); ctx.arc(cross.x, cross.y, 2.5, 0, 6.28); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // callouts
  ctx.textAlign = 'center';
  for (const c of callouts) {
    const k = c.t / c.life, pop = c.t < 0.12 ? 0.7 + (c.t / 0.12) * 0.3 : 1;
    ctx.font = `700 ${c.size * pop}px "Chakra Petch",sans-serif`;
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.7)';
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
  if (mode === 'cam' && tracker) trackHand(now);
  if (state === 'play' || state === 'won' || state === 'over') step(state === 'play' ? dt : dt * 0.4);
  if (state !== 'menu' || mode === 'cam') render();
}

// ----------------------------------------------------------------- input --
const cross = { on: false, x: 0, y: 0, gun: false };
cv.addEventListener('pointerdown', (e) => { audio(); if (state === 'play') shoot(e.clientX, e.clientY); });
cv.addEventListener('pointermove', (e) => {
  if (mode === 'tap' && e.pointerType === 'mouse') { cross.on = true; cross.x = e.clientX; cross.y = e.clientY; cross.gun = true; }
});

// --------------------------------------------------------- hand tracking ---
const video = $('cam');
let tracker = null, finder = null, trigger = null, fX = null, fY = null, H_ = null;
let lastVideoTime = -1, lastHandAt = 0, handDraw = null;
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
// Where a video-normalised point lands on screen (video is mirrored + cover).
function videoToScreen(p) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(W / vw, H / vh), dx = (W - vw * s) / 2, dy = (H - vh * s) / 2;
  return { x: W - (p.x * vw * s + dx), y: p.y * vh * s + dy };
}
function drawHand(lm) {
  const pts = lm.map(videoToScreen);
  ctx.strokeStyle = cross.gun ? 'rgba(255,70,60,.75)' : 'rgba(255,255,255,.45)'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of H_.HAND_EDGES) { ctx.moveTo(pts[a].x, pts[a].y); ctx.lineTo(pts[b].x, pts[b].y); }
  ctx.stroke();
  const tip = pts[8];
  ctx.fillStyle = cross.gun ? '#ff3b3b' : '#fff'; ctx.shadowColor = '#ff3b3b'; ctx.shadowBlur = cross.gun ? 16 : 0;
  ctx.beginPath(); ctx.arc(tip.x, tip.y, 6, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
}

let statusKey = '';
function status(key, text, cls = '') {
  if (key === statusKey) return;
  statusKey = key; const el = $('status');
  el.textContent = text; el.className = 'chip on ' + cls;
}

function aimAt(t) { for (let i = aimHist.length - 1; i >= 0; i--) if (aimHist[i].t <= t) return aimHist[i]; return aimHist[0]; }

function trackHand(now) {
  if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let hand; try { hand = finder.detect(video); } catch { return; }
  if (!hand) {
    trigger.update(null, now);
    if (now - lastHandAt > 500) { cross.on = false; handDraw = null; fX.reset(); fY.reset(); aimHist.length = 0; beamFrom = null; }
    if (now - lastHandAt > 1200) zone.set = false;
    if (state === 'play' && now - lastHandAt > 600) status('none', '✋ Show a finger gun to the camera', 'warn');
    return;
  }
  lastHandAt = now;
  const a = H_.analyze(hand.world, trigger.isGun);
  const fired = trigger.update(a, now);
  cross.gun = trigger.isGun;
  handDraw = hand.landmarks;
  const lm = hand.landmarks;
  beamFrom = videoToScreen(lm[8]);
  const ax = (lm[5].x + lm[6].x + lm[7].x + lm[8].x) / 4;
  const ay = (lm[5].y + lm[6].y + lm[7].y + lm[8].y) / 4;
  const [nx, ny] = handToScreen(1 - ax, ay);
  let x = fX.filter(nx, now / 1000) * W, y = fY.filter(ny, now / 1000) * H;
  // aim assist: pull toward the nearest unmasked attacker
  let best = null, bd = U * 1.1;
  for (const at of attackers) {
    if (at.state !== 'unmasked') continue;
    const d = Math.hypot(at.x - x, at.y - y);
    if (d < bd) { bd = d; best = at; }
  }
  if (best) { x += (best.x - x) * 0.5; y += (best.y - y) * 0.5; }
  cross.on = true; cross.x = x; cross.y = y;
  aimHist.push({ t: now, x, y });
  while (aimHist.length > 1 && now - aimHist[0].t > 500) aimHist.shift();
  if (fired) {
    const p = aimAt(now - H_.TUNING.aimLagMs);
    // re-check the target at fire time so a lagged point still hits a moving attacker
    shoot(p.x, p.y);
  }
  if (state === 'play') {
    if (trigger.isGun) status('gun', '🎯 Aiming. Drop your thumb to fire', 'gun');
    else status('hand', '👉 Point your index finger, thumb up', 'live');
  }
}

async function startCamera() {
  const btn = $('bCam'); btn.disabled = true; $('err').textContent = '';
  try {
    btn.textContent = 'Starting camera…';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nocam');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    video.srcObject = stream; await video.play().catch(() => {});
    video.classList.add('on');
    btn.textContent = 'Loading hand tracking…';
    H_ = await import('./hand.js');
    tracker = await H_.createTracker('GPU');
    finder = new H_.HandFinder(tracker);
    trigger = new H_.GunTrigger(); fX = new H_.OneEuro(); fY = new H_.OneEuro();
    mode = 'cam';
    btn.textContent = '👉 Play with finger gun'; btn.disabled = false;
    return true;
  } catch (e) {
    btn.textContent = '👉 Play with finger gun'; btn.disabled = false;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    $('err').textContent = denied
      ? 'Camera is blocked. Allow it from the address bar and try again, or play with tap.'
      : e && e.message === 'nocam' ? 'This browser has no camera access. Play with tap instead.' : 'Hand tracking could not start on this device. Play with tap instead.';
    return false;
  }
}
function stopCamera() {
  const s = video.srcObject; if (s) s.getTracks().forEach((t) => t.stop());
  video.srcObject = null; video.classList.remove('on');
  tracker = null; mode = 'tap'; cross.on = false; handDraw = null; beamFrom = null;
}

// ------------------------------------------------------------ screens -----
function show(id) { for (const o of document.querySelectorAll('.ov')) o.classList.toggle('on', o.id === id); }
function startGame() {
  reset(); state = 'play'; show(null);
  $('hud').classList.add('on');
  statusKey = '';
  if (mode === 'cam') status('none', '✋ Show a finger gun to the camera', 'warn');
  else { status('tap', 'Tap an attacker once a decoy unmasks it', 'live'); setTimeout(() => { if (statusKey === 'tap') $('status').classList.remove('on'); }, 3500); }
  say('DECOYS ARMED', W / 2, H * 0.32, '#7fd8ff', 26, 1.6);
}
function gameOver() {
  state = 'over';
  if (score > best) { best = score; try { localStorage.setItem('trapshot.best', best); } catch {} }
  setTimeout(() => {
    $('overWhy').textContent = `An attacker reached the ${titleCase(lastBreach)}.`;
    $('overScore').textContent = score;
    $('overNeed').textContent = score >= GOAL ? 'comic already unlocked' : `${GOAL - score} more to unlock the comic`;
    $('stBest').textContent = best; $('stTrip').textContent = tripped; $('stPlant').textContent = ownGoals;
    $('lesson').innerHTML = pick(LESSONS);
    $('bSwitch').textContent = mode === 'cam' ? 'Switch to tap' : '👉 Try the finger gun';
    show('ovOver'); $('status').classList.remove('on');
  }, 900);
}
const LESSONS = [
  'Most OT intruders look like normal traffic. <b>Decoys</b> change that: real operators never touch them, so anyone who does is an attacker. That is how <b>ZeroHack TRACE</b> exposes them early.',
  'You could not shoot what you could not see. In a real plant, <b>deception</b> gives the SOC that moment of visibility, before an attacker reaches a PLC.',
  'Burning your own decoys or tripping your own plant hurts as much as the attacker. Good OT defence is <b>precise</b>: alert on the decoy, never break the process.',
];
const titleCase = (s) => (s || 'plant').toLowerCase().replace(/\b(plc|hmi|rtu)\b/g, (m) => m.toUpperCase()).replace(/(^|\s)\w/g, (m) => m.toUpperCase());

let cdTimer = null;
function win() {
  wonOnce = true; state = 'won'; SFX.win();
  if (score > best) { best = score; try { localStorage.setItem('trapshot.best', best); } catch {} }
  for (const a of attackers) if (a.state !== 'dead') { a.state = 'dead'; fx.push({ kind: 'ring', x: a.x, y: a.y, t: 0, life: 0.5, r: a.size * 0.5 }); }
  say('PLANT SECURED', W / 2, H * 0.35, '#a6f0d9', 34, 2);
  setTimeout(() => {
    $('winScore').textContent = score; show('ovWin'); $('status').classList.remove('on');
    let left = 5; const total = 5, t0 = performance.now();
    $('cdN').textContent = left;
    const bar = $('cdBar');
    cdTimer = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      bar.style.width = Math.min(100, (el / total) * 100) + '%';
      const n = Math.max(0, Math.ceil(total - el)); $('cdN').textContent = n;
      if (el >= total) { clearInterval(cdTimer); cdTimer = null; location.href = COMIC_URL; }
    }, 100);
  }, 1100);
}

$('bCam').onclick = async () => { audio(); if (mode !== 'cam' && !(await startCamera())) return; startGame(); };
$('bTap').onclick = () => { audio(); if (mode === 'cam') stopCamera(); startGame(); };
$('bAgain').onclick = () => { audio(); startGame(); };
$('bSwitch').onclick = async () => {
  audio();
  if (mode === 'cam') { stopCamera(); startGame(); }
  else { show('ovStart'); state = 'menu'; $('hud').classList.remove('on'); $('bCam').click(); }
};
$('bStay').onclick = () => { if (cdTimer) clearInterval(cdTimer); cdTimer = null; show(null); state = 'play'; statusKey = ''; };

// debug / testing hooks
window.__trap = { get state() { return state; }, get score() { return score; }, set score(v) { score = v; updateHud(); }, get attackers() { return attackers; }, assets: () => assets, shoot, kill, win };

resize(); buildAssets();
requestAnimationFrame(frame);
