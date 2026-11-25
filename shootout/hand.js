// Hand tracking + finger-gun gesture logic, shared by the range page and the
// raise-to-draw background watcher.
import { FilesetResolver, HandLandmarker } from './vendor/vision_bundle.mjs';

const here = (p) => new URL(p, import.meta.url).href;

// Stateless (IMAGE mode) on purpose: HandFinder below feeds it a moving,
// zoomed-in crop, which a frame-to-frame tracker would not follow.
export async function createTracker(preferred = 'GPU') {
  const fileset = await FilesetResolver.forVisionTasks(here('./vendor/wasm'));
  const make = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: here('./models/hand_landmarker.task'), delegate },
      runningMode: 'IMAGE',
      numHands: 1,
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
    });
  try {
    return await make(preferred);
  } catch (err) {
    if (preferred === 'CPU') throw err;
    return make('CPU');
  }
}

// Finds a hand even when it is small in the frame. The detector misses hands
// under roughly a fifth of the frame height, so: while searching, sweep
// zoomed-in windows across the frame; once found, keep a zoomed square
// following the hand so it always looks big to the model.
export class HandFinder {
  constructor(tracker, size = 384) {
    this.tracker = tracker;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d');
    this.roi = null; // { x, y, s } in video pixels
    this.misses = 0;
    this.searchIndex = 0;
    this.windowsKey = '';
    this.windows = [];
  }

  buildWindows(vw, vh) {
    const key = `${vw}x${vh}`;
    if (key === this.windowsKey) return;
    this.windowsKey = key;
    const list = [];
    const grid = (s, overlap) => {
      const step = s * (1 - overlap);
      const cols = Math.max(1, Math.ceil((vw - s) / step) + 1);
      const rows = Math.max(1, Math.ceil((vh - s) / step) + 1);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          list.push({
            x: cols === 1 ? (vw - s) / 2 : ((vw - s) * c) / (cols - 1),
            y: rows === 1 ? (vh - s) / 2 : ((vh - s) * r) / (rows - 1),
            s,
          });
        }
      }
    };
    const full = Math.min(vw, vh);
    grid(full, 0.2); // big hands, close to the camera
    grid(full / 1.9, 0.25); // small or distant hands
    this.windows = list;
  }

  // Returns { landmarks, world, roi } with landmarks normalised to the whole
  // video frame, or null when no hand was found this frame.
  detect(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    this.buildWindows(vw, vh);
    const win = this.roi || this.windows[this.searchIndex++ % this.windows.length];
    const size = this.canvas.width;
    this.ctx.drawImage(video, win.x, win.y, win.s, win.s, 0, 0, size, size);
    const result = this.tracker.detect(this.canvas);
    const local = result.landmarks && result.landmarks[0];
    const world = result.worldLandmarks && result.worldLandmarks[0];

    if (!local || !world) {
      this.misses += 1;
      if (this.roi && this.misses > 4) {
        if (this.misses <= 9) {
          // widen the view a little before giving up on this spot
          const cx = this.roi.x + this.roi.s / 2;
          const cy = this.roi.y + this.roi.s / 2;
          this.roi = this.clampRoi(cx, cy, this.roi.s * 1.25, vw, vh);
        } else {
          this.roi = null;
        }
      }
      return null;
    }

    this.misses = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const landmarks = local.map((p) => {
      const px = win.x + p.x * win.s;
      const py = win.y + p.y * win.s;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      return { x: px / vw, y: py / vh, z: p.z };
    });
    const extent = Math.max(maxX - minX, maxY - minY);
    const wantS = extent * 2.8;
    const wantX = (minX + maxX) / 2;
    const wantY = (minY + maxY) / 2;
    if (this.roi) {
      const cx = this.roi.x + this.roi.s / 2;
      const cy = this.roi.y + this.roi.s / 2;
      this.roi = this.clampRoi(
        cx + (wantX - cx) * 0.5,
        cy + (wantY - cy) * 0.5,
        this.roi.s + (wantS - this.roi.s) * 0.2,
        vw,
        vh,
      );
    } else {
      this.roi = this.clampRoi(wantX, wantY, wantS, vw, vh);
    }
    return { landmarks, world, roi: win, extent };
  }

  clampRoi(cx, cy, s, vw, vh) {
    const full = Math.min(vw, vh);
    s = Math.max(full * 0.22, Math.min(full, s));
    return {
      x: Math.max(0, Math.min(vw - s, cx - s / 2)),
      y: Math.max(0, Math.min(vh - s, cy - s / 2)),
      s,
    };
  }
}

// Landmark indices: 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky.
export const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

// 1.0 = perfectly straight finger, ~0.4 = curled into a fist.
function straightness(w, mcp) {
  const chain = dist(w[mcp], w[mcp + 1]) + dist(w[mcp + 1], w[mcp + 2]) + dist(w[mcp + 2], w[mcp + 3]);
  return chain > 0 ? dist(w[mcp], w[mcp + 3]) / chain : 0;
}

export const TUNING = {
  indexStraight: 0.82, // index must be at least this straight to start aiming
  indexKeep: 0.7, // ...and this straight to keep aiming
  curled: 0.8, // other fingers count as curled below this
  curledKeep: 0.88,
  // Thumb height = distance from thumb tip to the middle finger's knuckle, in
  // palm lengths (so hand size does not matter). On sample photos: about 0.2
  // tucked down, about 1.05 raised.
  cock: 0.62, // above this counts as "hammer up"
  fireDrop: 0.68, // fire when the thumb falls below this fraction of its peak
  fireFloor: 0.45,
  holdMs: 150, // gun pose must be held this long before a shot counts
  graceMs: 300, // dropouts shorter than this do not break the pose
  cooldownMs: 300,
  aimLagMs: 130, // shoot where you were aiming just before the thumb moved
};

// Reduce one hand to the few numbers the gun logic needs.
export function analyze(world, wasGun = false) {
  const palm = dist(world[0], world[9]) || 1;
  const index = straightness(world, 5);
  const others = [9, 13, 17].map((i) => straightness(world, i));
  const curlLimit = wasGun ? TUNING.curledKeep : TUNING.curled;
  // Middle finger must be curled (otherwise a peace sign would count), plus
  // at least one of ring and pinky.
  const middleCurled = others[0] < curlLimit;
  const restCurled = others[1] < curlLimit || others[2] < curlLimit;
  const indexLimit = wasGun ? TUNING.indexKeep : TUNING.indexStraight;
  const thumb = dist(world[4], world[10]) / palm;
  return {
    index,
    others,
    thumb,
    isGun: index > indexLimit && middleCurled && restCurled,
  };
}

// Turns a stream of analyze() results into "fire" moments: thumb up, then down.
export class GunTrigger {
  constructor() {
    this.reset();
  }
  reset() {
    this.gunSince = null;
    this.lastGunAt = -1e9;
    this.armed = false;
    this.peak = 0;
    this.rearmAbove = TUNING.cock;
    this.lastFireAt = -1e9;
    this.isGun = false;
  }
  // Returns true on the frame a shot is fired.
  update(a, now) {
    if (a && a.isGun) {
      if (this.gunSince === null) this.gunSince = now;
      this.lastGunAt = now;
      this.isGun = true;
    } else if (now - this.lastGunAt > TUNING.graceMs) {
      this.gunSince = null;
      this.armed = false;
      this.peak = 0;
      this.rearmAbove = TUNING.cock;
      this.isGun = false;
      return false;
    }
    if (!a || !a.isGun) return false;
    const held = now - this.gunSince >= TUNING.holdMs;
    if (!this.armed) {
      if (held && a.thumb > this.rearmAbove && now - this.lastFireAt > TUNING.cooldownMs) {
        this.armed = true;
        this.peak = a.thumb;
      }
      return false;
    }
    this.peak = Math.max(this.peak, a.thumb);
    const fireBelow = Math.max(TUNING.fireFloor, this.peak * TUNING.fireDrop);
    if (a.thumb < fireBelow) {
      this.armed = false;
      this.lastFireAt = now;
      this.rearmAbove = Math.max(TUNING.cock, fireBelow * 1.1);
      this.peak = 0;
      return true;
    }
    return false;
  }
}

// One Euro filter: steady when the hand is still, responsive when it moves.
export class OneEuro {
  constructor(minCutoff = 0.7, beta = 3, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, tSeconds) {
    if (this.x === null) {
      this.x = value;
      this.t = tSeconds;
      return value;
    }
    const dt = Math.max(1e-3, tSeconds - this.t);
    this.t = tSeconds;
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}
