/*
 * ZOMBIE NIGHT
 * A small top-down zombie survival game. Plain JavaScript + Canvas, no build step.
 *
 * Sections, in order:
 *   1. Utilities & config     6. Bullets            11. Camera
 *   2. Save system            7. Zombies            12. Rendering
 *   3. Audio                  8. Effects            13. UI (screens + HUD)
 *   4. Input                  9. Pickups            14. Game state & loop
 *   5. World & player        10. Waves & upgrades
 */
'use strict';

/* =========================================================================
 * 1. UTILITIES & CONFIG
 * ========================================================================= */

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const pad2 = (n) => String(n).padStart(2, '0');
// Frame-rate independent smoothing: fraction to move toward a target this frame.
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

// Small seeded RNG so the baked map looks identical on every load.
function seededRandom(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORLD = { w: 2400, h: 1600 };
const MARGIN = 220;          // dark border drawn around the playable area
const VIEW = { w: 1200, h: 710 }; // world units visible at the reference size

const PLAYER_BASE = {
  hp: 100,
  speed: 225,
  damage: 34,
  magSize: 12,
  reserve: 60,
  reloadTime: 1.5,
  fireDelay: 0.16,
};

const ZOMBIE_TYPES = {
  normal: { hp: 100, speed: 85, damage: 10, coins: 25, r: 16, attackDelay: 1.0, turn: 5, knock: 210 },
  runner: { hp: 60, speed: 172, damage: 8, coins: 35, r: 13, attackDelay: 0.75, turn: 8, knock: 260 },
  tank:   { hp: 300, speed: 50, damage: 25, coins: 100, r: 26, attackDelay: 1.45, turn: 3, knock: 45 },
};

/* =========================================================================
 * 2. SAVE SYSTEM (localStorage, guarded: private mode or file:// may block it)
 * ========================================================================= */

const Save = {
  SETTINGS: 'zombieNight.settings',
  BEST: 'zombieNight.bestWave',

  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },

  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  },

  loadSettings() {
    const s = this.read(this.SETTINGS, {}) || {};
    return { sound: s.sound !== false, music: s.music !== false, shake: s.shake !== false };
  },

  saveSettings(settings) { this.write(this.SETTINGS, settings); },

  bestWave() {
    const n = Number(this.read(this.BEST, 0));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  },

  // Returns true when this is a new record.
  submitWave(wave) {
    if (wave > this.bestWave()) {
      this.write(this.BEST, wave);
      return true;
    }
    return false;
  },
};

/* =========================================================================
 * 3. AUDIO — every sound is synthesized with the Web Audio API, no files.
 * ========================================================================= */

const Sound = {
  ctx: null,
  sfx: null,
  musicBus: null,
  noise: null,
  soundOn: true,
  musicOn: true,

  // Browsers only allow audio after a user gesture, so this runs on the first click.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    limiter.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.connect(limiter);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(limiter);

    // One second of white noise shared by every noisy sound.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.startMusic();
    this.apply();
  },

  apply() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfx.gain.setTargetAtTime(this.soundOn ? 0.9 : 0, t, 0.02);
    this.musicBus.gain.setTargetAtTime(this.musicOn ? 0.5 : 0, t, 0.5);
  },

  play(name, volume = 1) {
    if (!this.ctx || !this.soundOn) return;
    const fn = this.sounds[name];
    if (fn) fn.call(this, this.ctx.currentTime + 0.005, volume);
  },

  // --- building blocks ---
  env(peak, attack, length, t) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + length);
    return g;
  },
  noiseSrc(t, length, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * 0.5, length + 0.05);
    return s;
  },
  osc(type, f0, f1, t, length) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + length);
    o.start(t);
    o.stop(t + length + 0.05);
    return o;
  },
  filter(type, freq, q = 0.8) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  },
  // noise -> filter -> envelope -> sfx
  burst(t, length, filterType, freq, peak, rate = 1, q = 0.8) {
    this.noiseSrc(t, length, rate)
      .connect(this.filter(filterType, freq, q))
      .connect(this.env(peak, 0.002, length, t))
      .connect(this.sfx);
  },
  // oscillator sweep -> envelope -> sfx (optionally through a lowpass)
  tone(t, type, f0, f1, length, peak, lowpass) {
    let node = this.osc(type, f0, f1, t, length);
    if (lowpass) node = node.connect(this.filter('lowpass', lowpass));
    node.connect(this.env(peak, 0.004, length, t)).connect(this.sfx);
  },

  sounds: {
    shoot(t, v) {
      const p = rand(0.94, 1.06);
      this.burst(t, 0.09, 'highpass', 1400 * p, 0.55 * v);
      this.tone(t, 'triangle', 170 * p, 42, 0.13, 0.85 * v);
      this.burst(t, 0.32, 'lowpass', 900, 0.16 * v, 0.6);
    },
    empty(t, v) {
      this.burst(t, 0.03, 'bandpass', 3200, 0.35 * v, 1, 3);
    },
    hit(t, v) {
      this.burst(t, 0.07, 'bandpass', 520 * rand(0.85, 1.2), 0.5 * v, 1, 1.5);
      this.tone(t, 'sine', 140, 60, 0.08, 0.35 * v);
    },
    death(t, v) {
      const p = rand(0.85, 1.15);
      this.tone(t, 'sawtooth', 150 * p, 48, 0.55, 0.32 * v, 700);
      this.burst(t, 0.28, 'lowpass', 500, 0.3 * v, 0.7);
    },
    reloadOut(t, v) {
      this.burst(t, 0.04, 'bandpass', 2400, 0.4 * v, 1, 4);
      this.burst(t + 0.07, 0.05, 'bandpass', 900, 0.3 * v, 1, 3);
    },
    reloadIn(t, v) {
      this.burst(t, 0.05, 'bandpass', 1500, 0.5 * v, 1, 4);
      this.burst(t + 0.12, 0.06, 'bandpass', 2800, 0.45 * v, 1, 5);
    },
    hurt(t, v) {
      this.tone(t, 'sine', 95, 45, 0.25, 0.9 * v);
      this.burst(t, 0.18, 'lowpass', 380, 0.5 * v, 0.8);
      this.tone(t, 'square', 210, 120, 0.12, 0.08 * v, 900);
    },
    wave(t, v) {
      [220, 261.6, 329.6, 440].forEach((f, i) => {
        this.tone(t + i * 0.13, 'triangle', f, f, 0.9, 0.22 * v, 2400);
      });
    },
    waveStart(t, v) {
      this.tone(t, 'sawtooth', 55, 52, 1.6, 0.25 * v, 240);
      this.tone(t, 'sine', 110, 104, 1.4, 0.18 * v);
    },
    click(t, v) {
      this.tone(t, 'square', 1400, 900, 0.035, 0.08 * v, 3000);
    },
    buy(t, v) {
      this.tone(t, 'triangle', 523, 523, 0.12, 0.2 * v);
      this.tone(t + 0.08, 'triangle', 784, 784, 0.2, 0.2 * v);
    },
    pickup(t, v) {
      this.tone(t, 'sine', 660, 660, 0.08, 0.2 * v);
      this.tone(t + 0.06, 'sine', 990, 990, 0.12, 0.18 * v);
    },
    groan(t, v) {
      const f = rand(62, 96);
      const len = rand(0.7, 1.2);
      const o = this.osc('sawtooth', f, f * 0.7, t, len);
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      lfo.frequency.value = rand(5, 9);
      lfoGain.gain.value = f * 0.12;
      lfo.connect(lfoGain).connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + len + 0.05);
      o.connect(this.filter('lowpass', 420, 4)).connect(this.env(0.22 * v, 0.15, len, t)).connect(this.sfx);
    },
  },

  // Ambient score: a low detuned drone with a slowly breathing filter and sparse bell notes.
  startMusic() {
    const ctx = this.ctx;
    const lp = this.filter('lowpass', 380, 0.7);
    lp.connect(this.musicBus);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    [[55, 'sawtooth', 0.07], [55.35, 'sawtooth', 0.07], [82.4, 'triangle', 0.05], [110.4, 'triangle', 0.035]].forEach(([f, type, gain]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      g.gain.value = gain;
      o.connect(g).connect(lp);
      o.start();
    });
    setInterval(() => {
      if (!this.musicOn || Math.random() < 0.4) return;
      const t = ctx.currentTime + 0.01;
      const f = pick([220, 246.9, 261.6, 329.6, 349.2, 440]);
      this.osc('sine', f, f, t, 3).connect(this.env(0.05, 0.03, 3, t)).connect(this.musicBus);
    }, 3400);
  },
};

/* =========================================================================
 * 4. INPUT — keyboard, mouse, and a simple twin-stick for touch screens
 * ========================================================================= */

const Input = {
  keys: new Set(),
  mouse: { x: 0, y: 0, down: false },
  touch: {
    enabled: false,
    move: { id: null, ox: 0, oy: 0, x: 0, y: 0 },
    aim: { id: null, ox: 0, oy: 0, x: 0, y: 0 },
  },
  onKey: null, // set by Game: receives one-shot key presses (Escape, R)
  capture: false, // true while playing

  init(canvas) {
    this.mouse.x = window.innerWidth / 2;
    this.mouse.y = window.innerHeight / 2;

    window.addEventListener('keydown', (e) => {
      // only swallow these during play, so Space/Enter still press focused menu buttons
      if (this.capture && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat && this.onKey) this.onKey(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());

    window.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouse.down = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch: left half of the screen moves, right half aims and fires.
    const t = this.touch;
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      t.enabled = true;
      for (const p of e.changedTouches) {
        const stick = p.clientX < window.innerWidth / 2 ? t.move : t.aim;
        if (stick.id !== null) continue;
        stick.id = p.identifier;
        stick.ox = stick.x = p.clientX;
        stick.oy = stick.y = p.clientY;
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const p of e.changedTouches) {
        for (const stick of [t.move, t.aim]) {
          if (stick.id === p.identifier) {
            stick.x = p.clientX;
            stick.y = p.clientY;
          }
        }
      }
    }, { passive: false });
    const end = (e) => {
      for (const p of e.changedTouches) {
        for (const stick of [t.move, t.aim]) if (stick.id === p.identifier) stick.id = null;
      }
    };
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('touchcancel', end);
  },

  reset() {
    this.keys.clear();
    this.mouse.down = false;
    this.touch.move.id = null;
    this.touch.aim.id = null;
  },

  // Normalized movement vector from WASD / arrows / left stick.
  moveVector() {
    let x = 0;
    let y = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) y -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) y += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) x += 1;
    const m = this.touch.move;
    if (m.id !== null) {
      const dx = m.x - m.ox;
      const dy = m.y - m.oy;
      const len = Math.hypot(dx, dy);
      if (len > 8) {
        const s = Math.min(1, len / 60);
        x = (dx / len) * s;
        y = (dy / len) * s;
        return { x, y };
      }
    }
    const len = Math.hypot(x, y);
    return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
  },

  // Touch aim direction (or null when the right stick is idle).
  touchAim() {
    const a = this.touch.aim;
    if (a.id === null) return null;
    const dx = a.x - a.ox;
    const dy = a.y - a.oy;
    return Math.hypot(dx, dy) > 14 ? Math.atan2(dy, dx) : null;
  },

  firing() {
    return this.mouse.down || this.touchAim() !== null;
  },
};

/* =========================================================================
 * 5. WORLD & PLAYER
 * ========================================================================= */

// Two roads crossing at the center, sidewalks along them, four concrete lots.
const ROAD_H = { y0: 640, y1: 960 };
const ROAD_V = { x0: 1040, x1: 1360 };
const WALK = 64; // sidewalk width

// Solid props. Rects use x/y/w/h (top-left), round props use x/y/r.
const OBSTACLES = [
  // abandoned cars on the roads
  { kind: 'car', x: 420, y: 676, w: 132, h: 62, color: '#4b5560' },
  { kind: 'car', x: 1790, y: 858, w: 132, h: 62, color: '#6b3a32' },
  { kind: 'car', x: 1262, y: 230, w: 62, h: 132, color: '#5d5a4c' },
  { kind: 'car', x: 1078, y: 1250, w: 62, h: 132, color: '#33475a' },
  // parked cars
  { kind: 'car', x: 139, y: 144, w: 62, h: 132, color: '#5a5f63' },
  { kind: 'car', x: 299, y: 144, w: 62, h: 132, color: '#3d4e43' },
  { kind: 'car', x: 1649, y: 1324, w: 62, h: 132, color: '#6a6458' },
  { kind: 'car', x: 1889, y: 1324, w: 62, h: 132, color: '#4a3c4c' },
  // dumpsters
  { kind: 'dumpster', x: 720, y: 60, w: 96, h: 52, color: '#2f4a3a' },
  { kind: 'dumpster', x: 260, y: 1500, w: 96, h: 52, color: '#3a4250' },
  { kind: 'dumpster', x: 2230, y: 470, w: 96, h: 52, color: '#4a3a2a' },
  // concrete barriers
  { kind: 'barrier', x: 1580, y: 400, w: 150, h: 24 },
  { kind: 'barrier', x: 1920, y: 140, w: 24, h: 150 },
  { kind: 'barrier', x: 640, y: 1180, w: 150, h: 24 },
  { kind: 'barrier', x: 640, y: 884, w: 120, h: 22 },
  { kind: 'barrier', x: 2120, y: 1100, w: 24, h: 140 },
  // crates
  { kind: 'crate', x: 2120, y: 120, w: 48, h: 48 },
  { kind: 'crate', x: 2172, y: 132, w: 42, h: 42 },
  { kind: 'crate', x: 820, y: 1380, w: 46, h: 46 },
  // barrels
  { kind: 'barrel', x: 1690, y: 190, r: 17 },
  { kind: 'barrel', x: 1727, y: 214, r: 17 },
  { kind: 'barrel', x: 520, y: 1290, r: 17 },
  { kind: 'barrel', x: 880, y: 1500, r: 17 },
  { kind: 'barrel', x: 2280, y: 1460, r: 17 },
  { kind: 'barrel', x: 900, y: 470, r: 17 },
  { kind: 'barrel', x: 1500, y: 700, r: 17 },
];

// Street lamps: (px, py) is the pole, (x, y) the center of its light pool.
const LAMPS = [
  { px: 960, py: 604, x: 1010, y: 680, r: 300 },
  { px: 1440, py: 996, x: 1390, y: 920, r: 300 },
  { px: 420, py: 604, x: 420, y: 690, r: 270, flicker: true },
  { px: 1980, py: 996, x: 1980, y: 910, r: 290 },
  { px: 1004, py: 1330, x: 1090, y: 1330, r: 250 },
  { px: 1396, py: 280, x: 1310, y: 280, r: 260, flicker: true },
  { px: 1960, py: 604, x: 1960, y: 690, r: 270 },
];
for (const l of LAMPS) {
  OBSTACLES.push({ kind: 'pole', x: l.px, y: l.py, r: 7 });
  l.level = 1; // current brightness, changed by flicker
}

// Where zombies come from: road mouths and alley gaps, all outside the fence.
// Each entry walks the zombie to (ex, ey) before it starts chasing.
const ENTRIES = [
  { x: -80, y: 800, ex: 70, ey: 800, spread: 120, axis: 'y' },
  { x: WORLD.w + 80, y: 800, ex: WORLD.w - 70, ey: 800, spread: 120, axis: 'y' },
  { x: 1200, y: -80, ex: 1200, ey: 70, spread: 120, axis: 'x' },
  { x: 1200, y: WORLD.h + 80, ex: 1200, ey: WORLD.h - 70, spread: 120, axis: 'x' },
  { x: 520, y: -80, ex: 520, ey: 70, spread: 40, axis: 'x' },
  { x: 1910, y: WORLD.h + 80, ex: 1910, ey: WORLD.h - 70, spread: 40, axis: 'x' },
  { x: -80, y: 1310, ex: 70, ey: 1310, spread: 40, axis: 'y' },
  { x: WORLD.w + 80, y: 290, ex: WORLD.w - 70, ey: 290, spread: 40, axis: 'y' },
];

const World = {
  ground: null, // baked canvas: floor, markings, shadows, plus blood stains added during play
  gctx: null,
  dirty: false,

  // Paints the whole floor once. Re-run on a new game to wipe the blood.
  bake() {
    if (!this.ground) {
      this.ground = document.createElement('canvas');
      this.ground.width = WORLD.w + MARGIN * 2;
      this.ground.height = WORLD.h + MARGIN * 2;
      this.gctx = this.ground.getContext('2d');
    }
    const g = this.gctx;
    const R = seededRandom(1987);
    const noise = makeNoisePattern(g, R);
    g.setTransform(1, 0, 0, 1, MARGIN, MARGIN);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    // outside the fence: dark rooftops
    g.fillStyle = '#0c0e11';
    g.fillRect(-MARGIN, -MARGIN, this.ground.width, this.ground.height);
    for (let i = 0; i < 70; i++) {
      const side = i % 4;
      const along = R() * (side < 2 ? WORLD.w : WORLD.h);
      const depth = 60 + R() * 120;
      const len = 120 + R() * 260;
      let x, y, w, h;
      if (side === 0) { x = along - len / 2; y = -40 - depth; w = len; h = depth; }
      else if (side === 1) { x = along - len / 2; y = WORLD.h + 40; w = len; h = depth; }
      else if (side === 2) { x = -40 - depth; y = along - len / 2; w = depth; h = len; }
      else { x = WORLD.w + 40; y = along - len / 2; w = depth; h = len; }
      const shade = 16 + Math.floor(R() * 8);
      g.fillStyle = `rgb(${shade},${shade + 2},${shade + 5})`;
      g.fillRect(x, y, w, h);
      g.strokeStyle = 'rgba(255,255,255,0.04)';
      g.strokeRect(x + 3, y + 3, w - 6, h - 6);
      if (R() < 0.5) {
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(x + w * R() * 0.6 + 10, y + h * R() * 0.5 + 10, 22, 16);
      }
    }

    // lots
    g.fillStyle = '#2a2d30';
    g.fillRect(0, 0, WORLD.w, WORLD.h);
    fillNoise(g, noise, 0, 0, WORLD.w, WORLD.h, 0.5);
    g.strokeStyle = 'rgba(0,0,0,0.28)';
    g.lineWidth = 2;
    gridLines(g, 0, 0, WORLD.w, WORLD.h, 120);

    // sidewalks
    g.fillStyle = '#383a3c';
    g.fillRect(0, ROAD_H.y0 - WALK, WORLD.w, ROAD_H.y1 - ROAD_H.y0 + WALK * 2);
    g.fillRect(ROAD_V.x0 - WALK, 0, ROAD_V.x1 - ROAD_V.x0 + WALK * 2, WORLD.h);
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = 1.5;
    for (let x = 0; x < WORLD.w; x += 64) {
      line(g, x, ROAD_H.y0 - WALK, x, ROAD_H.y0);
      line(g, x, ROAD_H.y1, x, ROAD_H.y1 + WALK);
    }
    for (let y = 0; y < WORLD.h; y += 64) {
      line(g, ROAD_V.x0 - WALK, y, ROAD_V.x0, y);
      line(g, ROAD_V.x1, y, ROAD_V.x1 + WALK, y);
    }

    // roads (extend into the margin so they fade into the dark)
    g.fillStyle = '#1f2225';
    g.fillRect(-MARGIN, ROAD_H.y0, WORLD.w + MARGIN * 2, ROAD_H.y1 - ROAD_H.y0);
    g.fillRect(ROAD_V.x0, -MARGIN, ROAD_V.x1 - ROAD_V.x0, WORLD.h + MARGIN * 2);
    // alleys
    g.fillRect(460, -MARGIN, 120, MARGIN + 6);
    g.fillRect(1850, WORLD.h - 6, 120, MARGIN + 6);
    g.fillRect(-MARGIN, 1250, MARGIN + 6, 120);
    g.fillRect(WORLD.w - 6, 230, MARGIN + 6, 120);
    fillNoise(g, noise, -MARGIN, ROAD_H.y0, WORLD.w + MARGIN * 2, ROAD_H.y1 - ROAD_H.y0, 0.7);
    fillNoise(g, noise, ROAD_V.x0, -MARGIN, ROAD_V.x1 - ROAD_V.x0, WORLD.h + MARGIN * 2, 0.7);
    // asphalt patches
    for (let i = 0; i < 14; i++) {
      const horiz = i % 2 === 0;
      const x = horiz ? R() * WORLD.w : ROAD_V.x0 + R() * 220;
      const y = horiz ? ROAD_H.y0 + R() * 220 : R() * WORLD.h;
      g.fillStyle = R() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.12)';
      g.fillRect(x, y, 40 + R() * 90, 30 + R() * 70);
    }
    // curbs
    g.fillStyle = '#4a4c4d';
    g.fillRect(-MARGIN, ROAD_H.y0 - 4, WORLD.w + MARGIN * 2, 4);
    g.fillRect(-MARGIN, ROAD_H.y1, WORLD.w + MARGIN * 2, 4);
    g.fillRect(ROAD_V.x0 - 4, -MARGIN, 4, WORLD.h + MARGIN * 2);
    g.fillRect(ROAD_V.x1, -MARGIN, 4, WORLD.h + MARGIN * 2);
    // clear the curbs out of the intersection itself
    g.fillStyle = '#1f2225';
    g.fillRect(ROAD_V.x0, ROAD_H.y0 - 4, ROAD_V.x1 - ROAD_V.x0, ROAD_H.y1 - ROAD_H.y0 + 8);
    g.fillRect(ROAD_V.x0 - 4, ROAD_H.y0, ROAD_V.x1 - ROAD_V.x0 + 8, ROAD_H.y1 - ROAD_H.y0);
    fillNoise(g, noise, ROAD_V.x0 - 4, ROAD_H.y0 - 4, ROAD_V.x1 - ROAD_V.x0 + 8, ROAD_H.y1 - ROAD_H.y0 + 8, 0.7);

    // road markings
    const cy = (ROAD_H.y0 + ROAD_H.y1) / 2;
    const cx = (ROAD_V.x0 + ROAD_V.x1) / 2;
    g.fillStyle = 'rgba(176,150,70,0.45)';
    for (const [a, b] of [[-MARGIN, ROAD_V.x0 - 70], [ROAD_V.x1 + 70, WORLD.w + MARGIN]]) {
      g.fillRect(a, cy - 5, b - a, 3);
      g.fillRect(a, cy + 2, b - a, 3);
    }
    for (const [a, b] of [[-MARGIN, ROAD_H.y0 - 70], [ROAD_H.y1 + 70, WORLD.h + MARGIN]]) {
      g.fillRect(cx - 5, a, 3, b - a);
      g.fillRect(cx + 2, a, 3, b - a);
    }
    g.fillStyle = 'rgba(200,200,190,0.28)';
    for (let x = -MARGIN; x < WORLD.w + MARGIN; x += 90) {
      if (x > ROAD_V.x0 - 110 && x < ROAD_V.x1 + 70) continue;
      g.fillRect(x, ROAD_H.y0 + 78, 44, 3);
      g.fillRect(x, ROAD_H.y1 - 81, 44, 3);
    }
    for (let y = -MARGIN; y < WORLD.h + MARGIN; y += 90) {
      if (y > ROAD_H.y0 - 110 && y < ROAD_H.y1 + 70) continue;
      g.fillRect(ROAD_V.x0 + 78, y, 3, 44);
      g.fillRect(ROAD_V.x1 - 81, y, 3, 44);
    }
    // crosswalks
    g.fillStyle = 'rgba(205,205,195,0.32)';
    for (let i = 0; i < 9; i++) {
      const o = 20 + i * 33;
      g.fillRect(ROAD_V.x0 + o, ROAD_H.y0 - 60, 18, 48);
      g.fillRect(ROAD_V.x0 + o, ROAD_H.y1 + 12, 18, 48);
      g.fillRect(ROAD_V.x0 - 60, ROAD_H.y0 + o, 48, 18);
      g.fillRect(ROAD_V.x1 + 12, ROAD_H.y0 + o, 48, 18);
    }
    // wear on the paint: dark noise over the markings
    fillNoise(g, noise, ROAD_V.x0 - 70, ROAD_H.y0 - 70, ROAD_V.x1 - ROAD_V.x0 + 140, ROAD_H.y1 - ROAD_H.y0 + 140, 0.4);

    // parking stalls
    g.fillStyle = 'rgba(200,200,190,0.22)';
    for (let i = 0; i <= 6; i++) {
      g.fillRect(130 + i * 80, 120, 3, 170);
      g.fillRect(1560 + i * 80, 1300, 3, 170);
    }
    g.fillRect(130, 288, 483, 3);
    g.fillRect(1560, 1300, 483, 3);

    // manholes and drains
    for (const [x, y] of [[700, 760], [1700, 820], [1150, 420], [1250, 1180], [2150, 760]]) {
      g.fillStyle = '#17191b';
      g.beginPath();
      g.arc(x, y, 19, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.lineWidth = 2;
      g.stroke();
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 1;
      for (let k = -12; k <= 12; k += 6) line(g, x - 12, y + k, x + 12, y + k);
    }

    // cracks
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1.3;
    for (let i = 0; i < 46; i++) {
      let x = R() * WORLD.w;
      let y = R() * WORLD.h;
      let a = R() * TAU;
      g.beginPath();
      g.moveTo(x, y);
      const n = 4 + Math.floor(R() * 8);
      for (let k = 0; k < n; k++) {
        a += (R() - 0.5) * 1.4;
        x += Math.cos(a) * (8 + R() * 18);
        y += Math.sin(a) * (8 + R() * 18);
        g.lineTo(x, y);
      }
      g.stroke();
    }

    // puddles
    for (let i = 0; i < 16; i++) {
      const onRoad = i < 10;
      const x = onRoad ? (i % 2 ? R() * WORLD.w : ROAD_V.x0 + 30 + R() * 260) : R() * WORLD.w;
      const y = onRoad ? (i % 2 ? ROAD_H.y0 + 30 + R() * 260 : R() * WORLD.h) : R() * WORLD.h;
      const rx = 12 + R() * 26;
      const ry = rx * (0.4 + R() * 0.4);
      g.fillStyle = 'rgba(14,20,30,0.38)';
      g.beginPath();
      g.ellipse(x, y, rx, ry, R() * Math.PI, 0, TAU);
      g.fill();
      g.strokeStyle = 'rgba(140,160,190,0.07)';
      g.lineWidth = 1.5;
      g.stroke();
    }

    // oil stains, leaves, paper
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.beginPath();
      g.ellipse(R() * WORLD.w, R() * WORLD.h, 8 + R() * 22, 6 + R() * 14, R() * 3, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 260; i++) {
      const x = R() * WORLD.w;
      const y = R() * WORLD.h;
      g.save();
      g.translate(x, y);
      g.rotate(R() * TAU);
      if (R() < 0.75) {
        g.fillStyle = pick2(R, ['#4a3b25', '#3e3320', '#57452a', '#2f3322']);
        g.fillRect(-3, -1.5, 6, 3);
      } else {
        g.fillStyle = 'rgba(190,185,170,0.35)';
        g.fillRect(-5, -4, 10, 8);
      }
      g.restore();
    }

    // prop shadows (moonlight from the upper left)
    g.fillStyle = 'rgba(0,0,0,0.42)';
    for (const o of OBSTACLES) {
      if (o.r) {
        g.beginPath();
        g.arc(o.x + 6, o.y + 9, o.r + 1, 0, TAU);
        g.fill();
      } else {
        roundRect(g, o.x + 7, o.y + 10, o.w, o.h, 6);
        g.fill();
      }
    }

    // warm light pools under the street lamps
    for (const l of LAMPS) {
      const grad = g.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      grad.addColorStop(0, 'rgba(255,176,90,0.13)');
      grad.addColorStop(1, 'rgba(255,176,90,0)');
      g.fillStyle = grad;
      g.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }

    // fence along the playable edge, with gaps at the roads and alleys
    const gapsX = [[ROAD_V.x0, ROAD_V.x1], [460, 580], [1850, 1970]];
    const gapsY = [[ROAD_H.y0, ROAD_H.y1], [1250, 1370], [230, 350]];
    drawFence(g, 0, true, gapsX);
    drawFence(g, WORLD.h, true, gapsX);
    drawFence(g, 0, false, gapsY);
    drawFence(g, WORLD.w, false, gapsY);

    // fade everything outside the fence into the night
    const fade = (x0, y0, x1, y1, rx, ry, rw, rh) => {
      const grad = g.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, 'rgba(5,6,8,0)');
      grad.addColorStop(1, 'rgba(5,6,8,0.92)');
      g.fillStyle = grad;
      g.fillRect(rx, ry, rw, rh);
    };
    fade(0, 0, 0, -MARGIN, -MARGIN, -MARGIN, WORLD.w + MARGIN * 2, MARGIN);
    fade(0, WORLD.h, 0, WORLD.h + MARGIN, -MARGIN, WORLD.h, WORLD.w + MARGIN * 2, MARGIN);
    fade(0, 0, -MARGIN, 0, -MARGIN, 0, MARGIN, WORLD.h);
    fade(WORLD.w, 0, WORLD.w + MARGIN, 0, WORLD.w, 0, MARGIN, WORLD.h);

    g.setTransform(1, 0, 0, 1, 0, 0);
    this.dirty = false;
  },

  // Permanent blood stain painted into the floor.
  stain(x, y, size, alpha = 0.55) {
    const g = this.gctx;
    g.setTransform(1, 0, 0, 1, MARGIN, MARGIN);
    g.fillStyle = `rgba(88,14,12,${alpha})`;
    const blobs = 3 + Math.floor(size / 6);
    for (let i = 0; i < blobs; i++) {
      const a = Math.random() * TAU;
      const d = Math.random() * size * 0.7;
      g.beginPath();
      g.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, size * rand(0.25, 0.6), size * rand(0.2, 0.45), a, 0, TAU);
      g.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.dirty = true;
  },

  // Is a circle at (x, y) free of props and inside the fence?
  isFree(x, y, r) {
    if (x < r || y < r || x > WORLD.w - r || y > WORLD.h - r) return false;
    for (const o of OBSTACLES) {
      if (o.r) {
        if (Math.hypot(x - o.x, y - o.y) < r + o.r) return false;
      } else {
        const cx = clamp(x, o.x, o.x + o.w);
        const cy = clamp(y, o.y, o.y + o.h);
        if (Math.hypot(x - cx, y - cy) < r) return false;
      }
    }
    return true;
  },
};

// --- bake helpers ---
function makeNoisePattern(g, R) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const n = c.getContext('2d');
  const img = n.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = R() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.floor(R() * 26);
  }
  n.putImageData(img, 0, 0);
  return g.createPattern(c, 'repeat');
}
function fillNoise(g, pattern, x, y, w, h, alpha) {
  g.globalAlpha = alpha;
  g.fillStyle = pattern;
  g.fillRect(x, y, w, h);
  g.globalAlpha = 1;
}
function gridLines(g, x0, y0, w, h, step) {
  for (let x = x0; x <= x0 + w; x += step) line(g, x, y0, x, y0 + h);
  for (let y = y0; y <= y0 + h; y += step) line(g, x0, y, x0 + w, y);
}
function line(g, x0, y0, x1, y1) {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}
function pick2(R, arr) {
  return arr[Math.floor(R() * arr.length)];
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function drawFence(g, at, horizontal, gaps) {
  const len = horizontal ? WORLD.w : WORLD.h;
  let start = 0;
  const segments = [];
  for (const [a, b] of gaps.slice().sort((p, q) => p[0] - q[0])) {
    segments.push([start, a]);
    start = b;
  }
  segments.push([start, len]);
  for (const [a, b] of segments) {
    if (b - a < 4) continue;
    g.strokeStyle = 'rgba(150,155,160,0.35)';
    g.lineWidth = 2;
    if (horizontal) line(g, a, at, b, at);
    else line(g, at, a, at, b);
    g.strokeStyle = 'rgba(150,155,160,0.12)';
    g.lineWidth = 6;
    if (horizontal) line(g, a, at, b, at);
    else line(g, at, a, at, b);
    g.fillStyle = '#5c6064';
    for (let p = a; p <= b; p += 48) {
      if (horizontal) g.fillRect(p - 3, at - 3, 6, 6);
      else g.fillRect(at - 3, p - 3, 6, 6);
    }
  }
}

// Push a circle entity out of every prop and keep it inside the fence.
// Returns the last prop it touched (or null), used by zombies to detect being stuck.
function collideWorld(e, keepInside = true) {
  let touched = null;
  for (const o of OBSTACLES) {
    if (o.r) {
      const dx = e.x - o.x;
      const dy = e.y - o.y;
      const min = e.r + o.r;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min) {
        const d = Math.sqrt(d2) || 0.001;
        e.x = o.x + (dx / d) * min;
        e.y = o.y + (dy / d) * min;
        touched = o;
      }
    } else {
      const cx = clamp(e.x, o.x, o.x + o.w);
      const cy = clamp(e.y, o.y, o.y + o.h);
      const dx = e.x - cx;
      const dy = e.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < e.r * e.r) {
        if (d2 > 0.0001) {
          const d = Math.sqrt(d2);
          e.x = cx + (dx / d) * e.r;
          e.y = cy + (dy / d) * e.r;
        } else {
          // center ended up inside the rect: leave through the nearest side
          const left = e.x - o.x;
          const right = o.x + o.w - e.x;
          const top = e.y - o.y;
          const bottom = o.y + o.h - e.y;
          const m = Math.min(left, right, top, bottom);
          if (m === left) e.x = o.x - e.r;
          else if (m === right) e.x = o.x + o.w + e.r;
          else if (m === top) e.y = o.y - e.r;
          else e.y = o.y + o.h + e.r;
        }
        touched = o;
      }
    }
  }
  if (keepInside) {
    e.x = clamp(e.x, e.r, WORLD.w - e.r);
    e.y = clamp(e.y, e.r, WORLD.h - e.r);
  }
  return touched;
}

/* ---------------------------- player ---------------------------- */

const Player = {
  x: WORLD.w / 2, y: WORLD.h / 2, r: 15,
  vx: 0, vy: 0, angle: 0,
  hp: 100, maxHp: 100, mag: 12, reserve: 60,
  reloadLeft: 0, reloadTotal: 1,
  fireCooldown: 0, dryCooldown: 0,
  recoil: 0, bloom: 0, step: 0,
  invuln: 0, hurtFlash: 0, alive: true,

  reset() {
    const s = Upgrades.stats();
    Object.assign(this, {
      x: WORLD.w / 2, y: WORLD.h / 2, vx: 0, vy: 0, angle: -Math.PI / 2,
      hp: s.maxHp, maxHp: s.maxHp, mag: PLAYER_BASE.magSize, reserve: s.maxReserve,
      reloadLeft: 0, fireCooldown: 0, dryCooldown: 0, recoil: 0, bloom: 0, step: 0,
      invuln: 0, hurtFlash: 0, alive: true,
    });
  },

  update(dt) {
    const s = Upgrades.stats();

    // smooth acceleration toward the input direction
    const mv = Input.moveVector();
    const k = damp(14, dt);
    this.vx = lerp(this.vx, mv.x * s.speed, k);
    this.vy = lerp(this.vy, mv.y * s.speed, k);
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    collideWorld(this);
    const moving = Math.hypot(this.vx, this.vy);
    this.step += (moving / 40) * dt * TAU * 0.5;

    // aim at the mouse (or the right touch stick)
    const touchAngle = Input.touchAim();
    if (touchAngle !== null) {
      this.angle = touchAngle;
    } else if (!Input.touch.enabled) {
      const m = Camera.screenToWorld(Input.mouse.x, Input.mouse.y);
      this.angle = Math.atan2(m.y - this.y, m.x - this.x);
    }

    this.fireCooldown -= dt;
    this.dryCooldown -= dt;
    this.invuln -= dt;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.bloom = Math.max(0, this.bloom - dt * 0.15);

    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) this.finishReload();
    }

    if (Input.firing() && this.fireCooldown <= 0 && this.reloadLeft <= 0) {
      if (this.mag > 0) {
        this.shoot(s);
      } else if (this.reserve > 0) {
        this.startReload();
      } else if (this.dryCooldown <= 0) {
        Sound.play('empty');
        this.dryCooldown = 0.35;
      }
    }
  },

  muzzle() {
    const a = this.angle;
    const back = this.recoil * 4;
    return { x: this.x + Math.cos(a) * (30 - back), y: this.y + Math.sin(a) * (30 - back) };
  },

  shoot(s) {
    this.mag--;
    this.fireCooldown = PLAYER_BASE.fireDelay;
    const spread = 0.02 + this.bloom;
    const a = this.angle + rand(-spread, spread);
    const m = this.muzzle();
    Bullets.fire(m.x, m.y, a, s.damage);
    this.recoil = 1;
    this.bloom = Math.min(0.085, this.bloom + 0.028);
    Effects.muzzleFlash(m.x, m.y, this.angle);
    Effects.shell(this.x, this.y, this.angle);
    Camera.kick(-Math.cos(a) * 5, -Math.sin(a) * 5);
    Camera.shake(0.14);
    Sound.play('shoot');
    if (this.mag === 0 && this.reserve > 0) this.startReload();
  },

  startReload() {
    if (this.reloadLeft > 0 || this.mag >= PLAYER_BASE.magSize || this.reserve <= 0) return;
    this.reloadTotal = this.reloadLeft = Upgrades.stats().reloadTime;
    Sound.play('reloadOut');
  },

  finishReload() {
    this.reloadLeft = 0;
    const take = Math.min(PLAYER_BASE.magSize - this.mag, this.reserve);
    this.mag += take;
    this.reserve -= take;
    Sound.play('reloadIn');
  },

  hurt(amount, fromX, fromY) {
    if (this.invuln > 0 || !this.alive) return;
    this.hp = Math.max(0, this.hp - amount);
    this.invuln = 0.18;
    this.hurtFlash = 1;
    const a = Math.atan2(this.y - fromY, this.x - fromX);
    this.vx += Math.cos(a) * 160;
    this.vy += Math.sin(a) * 160;
    Camera.shake(0.45);
    Sound.play('hurt');
    Effects.blood(this.x, this.y, a, 7, 1);
    Effects.text(this.x, this.y - 26, '-' + amount, '#e05545');
    Game.damageFlash = 1;
    if (this.hp <= 0) Game.playerDied();
  },
};

/* =========================================================================
 * 6. BULLETS — fast projectiles tested as swept segments so they never tunnel
 * ========================================================================= */

// Segment (x0,y0)->(x1,y1) vs circle: fraction 0..1 of the first hit, or -1.
function segCircle(x0, y0, x1, y1, cx, cy, r) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const fx = x0 - cx;
  const fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a === 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

// Segment vs axis-aligned rect (slab test): fraction of the first hit, or -1.
function segRect(x0, y0, x1, y1, o) {
  let tmin = 0;
  let tmax = 1;
  const d = [x1 - x0, y1 - y0];
  const p = [x0, y0];
  const lo = [o.x, o.y];
  const hi = [o.x + o.w, o.y + o.h];
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (p[i] < lo[i] || p[i] > hi[i]) return -1;
    } else {
      let t1 = (lo[i] - p[i]) / d[i];
      let t2 = (hi[i] - p[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

const Bullets = {
  list: [],
  SPEED: 1700,

  fire(x, y, angle, damage) {
    this.list.push({
      x, y, sx: x, sy: y, angle, damage, life: 0.7,
      vx: Math.cos(angle) * this.SPEED,
      vy: Math.sin(angle) * this.SPEED,
    });
  },

  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const b = this.list[i];
      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;

      // find the closest thing this bullet crosses during the frame
      let best = 2;
      let hitZombie = null;
      for (const o of OBSTACLES) {
        if (o.kind === 'pole') continue; // too thin to block
        const t = o.r ? segCircle(b.x, b.y, nx, ny, o.x, o.y, o.r) : segRect(b.x, b.y, nx, ny, o);
        if (t >= 0 && t < best) best = t;
      }
      for (const z of Zombies.list) {
        if (z.dead) continue;
        const t = segCircle(b.x, b.y, nx, ny, z.x, z.y, z.r + 3);
        if (t >= 0 && t < best) {
          best = t;
          hitZombie = z;
        }
      }

      if (best <= 1) {
        const hx = lerp(b.x, nx, best);
        const hy = lerp(b.y, ny, best);
        if (hitZombie) Zombies.damage(hitZombie, b.damage, b.angle, hx, hy);
        else Effects.sparks(hx, hy, b.angle + Math.PI);
        b.x = hx;
        b.y = hy;
        Effects.tracer(b);
        this.list.splice(i, 1);
        continue;
      }

      b.x = nx;
      b.y = ny;
      b.life -= dt;
      if (b.life <= 0 || b.x < -MARGIN || b.y < -MARGIN || b.x > WORLD.w + MARGIN || b.y > WORLD.h + MARGIN) {
        this.list.splice(i, 1);
      }
    }
  },
};

/* =========================================================================
 * 7. ZOMBIES — chase the player, spread out from each other, attack up close
 * ========================================================================= */

const Zombies = {
  list: [],

  spawn(type, x, y, entry) {
    const t = ZOMBIE_TYPES[type];
    const wave = Waves.number;
    const hpScale = 1 + Math.max(0, wave - 5) * 0.06;
    const speedScale = 1 + Math.min(0.3, (wave - 1) * 0.02);
    const hp = Math.round(t.hp * hpScale);
    this.list.push({
      type, x, y, r: t.r, hp, maxHp: hp,
      speed: t.speed * speedScale * rand(0.9, 1.1),
      vx: 0, vy: 0, kx: 0, ky: 0,
      angle: Math.atan2(Player.y - y, Player.x - x),
      attackCd: rand(0.2, 0.5), attackT: 0,
      flash: 0, stagger: 0, fade: 0,
      wobble: rand(0, TAU), stuck: 0, detour: 0, detourSign: 1,
      entering: !!entry,
      wx: entry ? entry.wx : x, wy: entry ? entry.wy : y,
      sepX: 0, sepY: 0, dead: false,
    });
  },

  update(dt) {
    const list = this.list;

    // separation: nearby zombies steer away from each other, overlapping ones get pushed apart
    for (const z of list) z.sepX = z.sepY = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const rr = a.r + b.r;
        const range = rr * 1.7;
        const d2 = dx * dx + dy * dy;
        if (d2 >= range * range) continue;
        let d = Math.sqrt(d2);
        if (d < 0.01) {
          dx = rand(-1, 1);
          dy = rand(-1, 1);
          d = Math.hypot(dx, dy) || 1;
        }
        const nx = dx / d;
        const ny = dy / d;
        const s = (range - d) / range;
        a.sepX -= nx * s;
        a.sepY -= ny * s;
        b.sepX += nx * s;
        b.sepY += ny * s;
        if (d < rr) {
          const overlap = rr - d;
          const ma = a.r * a.r;
          const mb = b.r * b.r;
          const wa = mb / (ma + mb); // the lighter zombie gets moved more
          a.x -= nx * overlap * wa;
          a.y -= ny * overlap * wa;
          b.x += nx * overlap * (1 - wa);
          b.y += ny * overlap * (1 - wa);
        }
      }
    }

    for (const z of list) this.think(z, dt);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].dead) list.splice(i, 1);
  },

  think(z, dt) {
    const t = ZOMBIE_TYPES[z.type];
    const p = Player;
    z.fade = Math.min(1, z.fade + dt * 1.5);
    z.flash -= dt;
    z.stagger -= dt;
    z.attackCd -= dt;
    z.wobble += dt * (z.type === 'runner' ? 10 : z.type === 'tank' ? 3 : 4.5);

    // pick a target: the entry waypoint first, then the player
    let tx = p.x;
    let ty = p.y;
    if (z.entering) {
      tx = z.wx;
      ty = z.wy;
      const inside = z.x > z.r && z.y > z.r && z.x < WORLD.w - z.r && z.y < WORLD.h - z.r;
      if (inside && Math.hypot(tx - z.x, ty - z.y) < 40) z.entering = false;
    } else if (!p.alive) {
      tx = z.x + Math.cos(z.wobble * 0.2) * 80;
      ty = z.y + Math.sin(z.wobble * 0.2) * 80;
    }
    const dx = tx - z.x;
    const dy = ty - z.y;
    const dist = Math.hypot(dx, dy) || 1;
    const seekX = dx / dist;
    const seekY = dy / dist;
    let sx = seekX;
    let sy = seekY;

    // stuck behind a prop: walk sideways along it for a moment
    if (z.detour > 0) {
      z.detour -= dt;
      sx = seekX * 0.25 - seekY * z.detourSign;
      sy = seekY * 0.25 + seekX * z.detourSign;
    }

    // shambling sway + separation
    const sway = Math.sin(z.wobble * 0.5) * (z.type === 'normal' ? 0.35 : 0.12);
    sx += -seekY * sway + z.sepX * 1.6;
    sy += seekX * sway + z.sepY * 1.6;
    const len = Math.hypot(sx, sy) || 1;
    sx /= len;
    sy /= len;

    const reach = z.r + p.r + 6;
    let speed = z.speed;
    if (z.entering) speed *= 1.8; // hurry in from the dark so waves open quickly
    if (z.stagger > 0) speed *= 0.2;
    if (z.attackT > 0) speed *= 0.35;
    if (!z.entering && p.alive && dist < reach) speed *= 0.25;

    const k = damp(t.turn, dt);
    z.vx = lerp(z.vx, sx * speed, k);
    z.vy = lerp(z.vy, sy * speed, k);
    const ox = z.x;
    const oy = z.y;
    z.x += (z.vx + z.kx) * dt;
    z.y += (z.vy + z.ky) * dt;
    const kd = Math.exp(-9 * dt);
    z.kx *= kd;
    z.ky *= kd;

    // turn to face the target
    let da = Math.atan2(dy, dx) - z.angle;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    z.angle += da * damp(t.turn * 1.5, dt);

    // never overlap the player
    if (p.alive) {
      const pdx = z.x - p.x;
      const pdy = z.y - p.y;
      const min = z.r + p.r;
      const pd = Math.hypot(pdx, pdy);
      if (pd < min) {
        const d = pd || 0.01;
        z.x = p.x + (pdx / d) * min;
        z.y = p.y + (pdy / d) * min;
      }
    }

    const touched = collideWorld(z, !z.entering);

    // detect being pinned against a prop and pick the shorter way around it
    const moved = Math.hypot(z.x - ox, z.y - oy);
    const expected = speed * dt;
    if (touched && z.detour <= 0 && moved < expected * 0.3) {
      z.stuck += dt;
      if (z.stuck > 0.3) {
        const ocx = touched.r ? touched.x : touched.x + touched.w / 2;
        const ocy = touched.r ? touched.y : touched.y + touched.h / 2;
        const cross = seekX * (ocy - z.y) - seekY * (ocx - z.x);
        z.detourSign = cross > 0 ? -1 : 1;
        z.detour = rand(0.6, 1.0);
        z.stuck = 0;
      }
    } else {
      z.stuck = Math.max(0, z.stuck - dt);
    }

    // attack: short wind-up, then the hit lands if the player is still close
    if (!z.entering && p.alive) {
      if (z.attackT > 0) {
        z.attackT -= dt;
        if (z.attackT <= 0) {
          if (Math.hypot(p.x - z.x, p.y - z.y) < reach + 10) p.hurt(t.damage, z.x, z.y);
          z.attackCd = t.attackDelay;
        }
      } else if (z.attackCd <= 0 && dist < reach) {
        z.attackT = 0.25;
      }
    }
  },

  damage(z, amount, angle, hx, hy) {
    if (z.dead) return;
    const t = ZOMBIE_TYPES[z.type];
    z.hp -= amount;
    z.flash = 0.09;
    z.stagger = z.type === 'tank' ? 0.05 : 0.14;
    z.kx += Math.cos(angle) * t.knock;
    z.ky += Math.sin(angle) * t.knock;
    Effects.blood(hx, hy, angle, 6, 1);
    Sound.play('hit', 0.7);
    if (z.hp <= 0) this.kill(z, angle);
  },

  kill(z, angle) {
    z.dead = true;
    World.stain(z.x, z.y, z.r * 1.4);
    Effects.blood(z.x, z.y, angle, 16, 1.4);
    Effects.corpse(z, angle);
    Sound.play('death', z.type === 'tank' ? 1 : 0.7);
    Game.onZombieKilled(z);
  },

};

/* =========================================================================
 * 8. EFFECTS — particles, muzzle flashes, tracers, corpses, floating text
 * ========================================================================= */

const Effects = {
  particles: [],
  flashes: [],
  tracers: [],
  corpses: [],
  texts: [],
  muzzleLight: 0,

  clear() {
    this.particles.length = 0;
    this.flashes.length = 0;
    this.tracers.length = 0;
    this.corpses.length = 0;
    this.texts.length = 0;
    this.muzzleLight = 0;
  },

  add(p) {
    if (this.particles.length > 700) this.particles.shift();
    this.particles.push(p);
  },

  // Droplets fly up and land as small stains.
  blood(x, y, angle, count, force) {
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-0.7, 0.7);
      const sp = rand(60, 260) * force;
      this.add({
        kind: 'blood', x, y, z: rand(4, 12),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(40, 140),
        size: rand(1.5, 3.5), life: 1.5, max: 1.5,
      });
    }
  },

  sparks(x, y, angle) {
    for (let i = 0; i < 7; i++) {
      const a = angle + rand(-1.1, 1.1);
      const sp = rand(120, 380);
      this.add({ kind: 'spark', x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: rand(1, 2), life: rand(0.12, 0.3), max: 0.3 });
    }
    this.add({ kind: 'smoke', x, y, vx: Math.cos(angle) * 20, vy: Math.sin(angle) * 20, size: 6, life: 0.6, max: 0.6 });
  },

  muzzleFlash(x, y, angle) {
    this.flashes.push({ x, y, angle, life: 0.05, max: 0.05, scale: rand(0.85, 1.15) });
    this.muzzleLight = 1;
    this.add({ kind: 'smoke', x, y, vx: Math.cos(angle) * 40, vy: Math.sin(angle) * 40, size: 5, life: 0.5, max: 0.5 });
  },

  // Brass casing ejected to the right of the gun.
  shell(x, y, angle) {
    const a = angle + Math.PI / 2 + rand(-0.3, 0.3);
    const sp = rand(90, 150);
    this.add({
      kind: 'shell', x: x + Math.cos(angle) * 14, y: y + Math.sin(angle) * 14, z: 10,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(60, 110),
      rot: rand(0, TAU), vr: rand(-20, 20), size: 1, life: 2.4, max: 2.4, bounced: false,
    });
  },

  // Remember where a bullet ended so its streak can be drawn for a frame or two.
  tracer(b) {
    this.tracers.push({ x0: b.sx, y0: b.sy, x1: b.x, y1: b.y, life: 0.05 });
  },

  corpse(z, angle) {
    this.corpses.push({ x: z.x, y: z.y, r: z.r, type: z.type, angle, t: 0, kx: Math.cos(angle) * 60, ky: Math.sin(angle) * 60 });
  },

  text(x, y, str, color, size = 15) {
    this.texts.push({ x, y, str, color, size, life: 1, max: 1 });
  },

  update(dt) {
    this.muzzleLight = Math.max(0, this.muzzleLight - dt * 16);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.kind === 'blood' || p.kind === 'shell') {
        if (p.z > 0) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.z += p.vz * dt;
          p.vz -= 520 * dt;
          if (p.rot !== undefined) p.rot += p.vr * dt;
          if (p.z <= 0) {
            p.z = 0;
            if (p.kind === 'blood') {
              if (Math.random() < 0.5) World.stain(p.x, p.y, p.size * 1.6, 0.4);
              p.life = 0;
            } else if (!p.bounced) {
              p.bounced = true;
              p.z = 0.01;
              p.vz = 45;
              p.vx *= 0.4;
              p.vy *= 0.4;
              p.vr *= 0.5;
            } else {
              p.vx = p.vy = 0;
            }
          }
        }
      } else {
        const drag = Math.exp(-(p.kind === 'smoke' ? 3 : 7) * dt);
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.kind === 'smoke') p.size += dt * 22;
      }
      if (p.life <= 0) this.particles.splice(i, 1);
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      if ((this.flashes[i].life -= dt) <= 0) this.flashes.splice(i, 1);
    }
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      if ((this.tracers[i].life -= dt) <= 0) this.tracers.splice(i, 1);
    }
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.t += dt;
      const k = Math.exp(-8 * dt);
      c.x += c.kx * dt;
      c.y += c.ky * dt;
      c.kx *= k;
      c.ky *= k;
      if (c.t > 2.6) this.corpses.splice(i, 1);
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      t.y -= 34 * dt;
      if (t.life <= 0) this.texts.splice(i, 1);
    }
  },
};

/* =========================================================================
 * 9. PICKUPS — ammo boxes and medkits dropped by zombies
 * ========================================================================= */

const Pickups = {
  list: [],
  supplyTimer: 0,

  clear() {
    this.list.length = 0;
    this.supplyTimer = 0;
  },

  drop(x, y, kind, amount) {
    this.list.push({ x, y, kind, amount, life: 18, bob: rand(0, TAU) });
  },

  wanted(p) {
    return p.kind === 'ammo' ? Player.reserve < Upgrades.stats().maxReserve : Player.hp < Player.maxHp;
  },

  collect(p) {
    if (p.kind === 'ammo') {
      const max = Upgrades.stats().maxReserve;
      const got = Math.min(p.amount, max - Player.reserve);
      Player.reserve += got;
      Effects.text(p.x, p.y - 14, '+' + got + ' AMMO', '#d9c27a', 13);
    } else {
      const got = Math.min(p.amount, Player.maxHp - Player.hp);
      Player.hp += got;
      Effects.text(p.x, p.y - 14, '+' + got + ' HP', '#7fcf7a', 13);
    }
    Sound.play('pickup');
  },

  update(dt) {
    const pl = Player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      p.bob += dt * 4;
      const d = Math.hypot(pl.x - p.x, pl.y - p.y);
      if (pl.alive && this.wanted(p)) {
        if (d < pl.r + 14) {
          this.collect(p);
          this.list.splice(i, 1);
          continue;
        }
        if (d < 90) { // gentle magnet
          p.x += ((pl.x - p.x) / d) * 260 * dt;
          p.y += ((pl.y - p.y) / d) * 260 * dt;
        }
      }
      if (p.life <= 0) this.list.splice(i, 1);
    }

    // Out of bullets with nothing to pick up? Drop a supply box nearby so the run can't soft-lock.
    const dry = pl.mag + pl.reserve === 0 && pl.reloadLeft <= 0;
    if (dry && !this.list.some((p) => p.kind === 'ammo')) {
      this.supplyTimer += dt;
      if (this.supplyTimer > 2.5) {
        this.supplyTimer = 0;
        for (let tries = 0; tries < 40; tries++) {
          const a = rand(0, TAU);
          const r = rand(160, 320);
          const x = pl.x + Math.cos(a) * r;
          const y = pl.y + Math.sin(a) * r;
          if (World.isFree(x, y, 20)) {
            this.drop(x, y, 'ammo', 24);
            Effects.text(x, y - 20, 'SUPPLY DROP', '#d9c27a', 14);
            break;
          }
        }
      }
    } else {
      this.supplyTimer = 0;
    }
  },

  // At the end of a wave, anything still lying around is picked up.
  sweep() {
    for (const p of this.list) if (this.wanted(p)) this.collect(p);
    this.list.length = 0;
  },
};

/* =========================================================================
 * 10. WAVES & UPGRADES
 * ========================================================================= */

const Waves = {
  number: 0,
  queue: [],
  spawnTimer: 0,
  total: 0,
  kills: 0,
  coins: 0,
  active: false,
  clearTimer: -1,

  // Wave 1: 8 normal, 2: 10, 3: 12 + 2 runners, 4: 14 + 3, 5: 16 + 4 + 1 tank, and so on.
  compose(n) {
    return {
      normal: 8 + 2 * (n - 1),
      runner: n >= 3 ? n - 1 : 0,
      tank: n >= 5 ? 1 + Math.floor((n - 5) / 3) : 0,
    };
  },

  night(n = this.number) {
    return Math.ceil(n / 3);
  },

  start(n) {
    const c = this.compose(n);
    const q = [];
    for (let i = 0; i < c.normal; i++) q.push('normal');
    for (let i = 0; i < c.runner; i++) q.push('runner');
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    // open with a few normals: swap any early runner with a later normal
    for (let i = 0; i < Math.min(3, q.length); i++) {
      if (q[i] === 'normal') continue;
      const j = q.indexOf('normal', 3);
      if (j > 0) [q[i], q[j]] = [q[j], q[i]];
    }
    // hold tanks back until the middle of the wave
    for (let i = 0; i < c.tank; i++) {
      const at = Math.floor(q.length * rand(0.35, 0.75));
      q.splice(at, 0, 'tank');
    }
    this.number = n;
    this.queue = q;
    this.total = q.length;
    this.kills = 0;
    this.coins = 0;
    this.spawnTimer = 0.8;
    this.clearTimer = -1;
    this.active = true;
  },

  remaining() {
    return this.queue.length + Zombies.list.length;
  },

  update(dt) {
    if (!this.active) return;

    if (this.queue.length > 0) {
      this.spawnTimer -= dt;
      const cap = Math.min(42, 14 + this.number * 2);
      if (this.spawnTimer <= 0 && Zombies.list.length < cap) {
        const maxGroup = Math.min(5, 1 + Math.floor(this.number / 2));
        const group = Math.min(this.queue.length, 1 + Math.floor(Math.random() * maxGroup));
        // from wave 4 on, packs sometimes split across two entrances to flank the player
        if (this.number >= 4 && group >= 2 && Math.random() < 0.4) {
          const half = Math.ceil(group / 2);
          const first = this.spawnGroup(half);
          this.spawnGroup(group - half, first);
        } else {
          this.spawnGroup(group);
        }
        const interval = Math.max(0.35, 1.15 - this.number * 0.06);
        this.spawnTimer = interval * group * rand(0.7, 1.15);
      }
    } else if (Zombies.list.length === 0 && this.clearTimer < 0) {
      this.clearTimer = 1.4; // let the last kill breathe before the results screen
      Sound.play('wave');
      Game.banner('WAVE CLEARED', '');
    }

    if (this.clearTimer > 0) {
      this.clearTimer -= dt;
      if (this.clearTimer <= 0) {
        this.active = false;
        Game.waveCleared();
      }
    }
  },

  // Spawn a few zombies together at an entry far away from the player. Returns the entry used.
  spawnGroup(count, avoid) {
    const far = ENTRIES.filter((e) => e !== avoid && Math.hypot(e.ex - Player.x, e.ey - Player.y) > 550);
    const entry = pick(far.length ? far : ENTRIES);
    const out = entry.axis === 'y' ? Math.sign(entry.x - entry.ex) : Math.sign(entry.y - entry.ey);
    for (let i = 0; i < count; i++) {
      const type = this.queue.shift();
      const off = rand(-entry.spread, entry.spread);
      const back = i * 36 + rand(0, 20);
      let x, y, wx, wy;
      if (entry.axis === 'y') {
        x = entry.x + out * back;
        y = entry.y + off;
        wx = entry.ex;
        wy = entry.ey + off;
      } else {
        x = entry.x + off;
        y = entry.y + out * back;
        wx = entry.ex + off;
        wy = entry.ey;
      }
      Zombies.spawn(type, x, y, { wx, wy });
    }
    return entry;
  },
};

const UPGRADE_DEFS = [
  {
    id: 'damage', name: 'WEAPON DAMAGE', effect: '+10 DAMAGE', max: 6,
    costs: [150, 300, 500, 750, 1050, 1400],
    value: (l) => PLAYER_BASE.damage + 10 * l,
    format: (v) => String(v),
  },
  {
    id: 'health', name: 'MAX HEALTH', effect: '+20 MAX HEALTH', max: 6,
    costs: [120, 250, 400, 600, 850, 1150],
    value: (l) => PLAYER_BASE.hp + 20 * l,
    format: (v) => String(v),
  },
  {
    id: 'reload', name: 'RELOAD SPEED', effect: '12% FASTER RELOAD', max: 5,
    costs: [100, 220, 380, 580, 820],
    value: (l) => PLAYER_BASE.reloadTime * Math.pow(0.88, l),
    format: (v) => v.toFixed(2) + 's',
  },
  {
    id: 'speed', name: 'MOVEMENT SPEED', effect: '+6% MOVE SPEED', max: 5,
    costs: [120, 260, 420, 620, 860],
    value: (l) => PLAYER_BASE.speed * (1 + 0.06 * l),
    format: (v) => Math.round((v / PLAYER_BASE.speed) * 100) + '%',
  },
  {
    id: 'ammo', name: 'AMMO CAPACITY', effect: '+20 RESERVE AMMO', max: 6,
    costs: [80, 180, 300, 450, 640, 860],
    value: (l) => PLAYER_BASE.reserve + 20 * l,
    format: (v) => String(v),
  },
];

const Upgrades = {
  levels: {},
  cache: null,

  reset() {
    for (const d of UPGRADE_DEFS) this.levels[d.id] = 0;
    this.cache = null;
  },

  def(id) {
    return UPGRADE_DEFS.find((d) => d.id === id);
  },

  // Live player stats, derived from upgrade levels.
  stats() {
    if (!this.cache) {
      const v = (id) => this.def(id).value(this.levels[id] || 0);
      this.cache = {
        damage: v('damage'),
        maxHp: v('health'),
        reloadTime: v('reload'),
        speed: v('speed'),
        maxReserve: v('ammo'),
      };
    }
    return this.cache;
  },

  cost(id) {
    const d = this.def(id);
    const l = this.levels[id];
    return l < d.max ? d.costs[l] : null;
  },

  buy(id) {
    const cost = this.cost(id);
    if (cost === null || Game.coins < cost) return false;
    Game.coins -= cost;
    this.levels[id]++;
    this.cache = null;
    const s = this.stats();
    if (id === 'health') {
      Player.maxHp = s.maxHp;
      Player.hp = Math.min(s.maxHp, Player.hp + 20);
    } else if (id === 'ammo') {
      Player.reserve = Math.min(s.maxReserve, Player.reserve + 20);
    }
    return true;
  },
};

/* =========================================================================
 * 11. CAMERA — smooth follow, small look-ahead, subtle shake
 * ========================================================================= */

const Camera = {
  x: WORLD.w / 2,
  y: WORLD.h / 2,
  scale: 1,
  viewW: VIEW.w,
  viewH: VIEW.h,
  screenW: 0,
  screenH: 0,
  trauma: 0,
  kx: 0,
  ky: 0,
  sx: 0,
  sy: 0,
  time: 0,

  resize(w, h) {
    this.screenW = w;
    this.screenH = h;
    // same amount of world visible at every resolution, never stretched
    this.scale = Math.min(w / VIEW.w, h / VIEW.h);
    this.viewW = w / this.scale;
    this.viewH = h / this.scale;
    this.clamp();
  },

  clamp() {
    const pad = 110;
    const fit = (pos, view, size) =>
      view >= size + pad * 2 ? size / 2 : clamp(pos, view / 2 - pad, size - view / 2 + pad);
    this.x = fit(this.x, this.viewW, WORLD.w);
    this.y = fit(this.y, this.viewH, WORLD.h);
  },

  follow(tx, ty, dt, rate = 6) {
    const k = damp(rate, dt);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
    this.clamp();
  },

  snap(x, y) {
    this.x = x;
    this.y = y;
    this.clamp();
  },

  shake(amount) {
    if (Game.settings.shake) this.trauma = Math.min(1, this.trauma + amount);
  },

  kick(x, y) {
    if (!Game.settings.shake) return;
    this.kx += x;
    this.ky += y;
  },

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - dt * 2.8);
    const mag = this.trauma * 10;
    const t = this.time;
    this.sx = (Math.sin(t * 61) + Math.sin(t * 37.3)) * 0.5 * mag;
    this.sy = (Math.sin(t * 53 + 1) + Math.sin(t * 29.7 + 2)) * 0.5 * mag;
    const k = Math.exp(-16 * dt);
    this.kx *= k;
    this.ky *= k;
  },

  // Rendered position (includes shake). Aiming uses the steady position.
  renderX() { return this.x + this.sx + this.kx; },
  renderY() { return this.y + this.sy + this.ky; },

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.screenW / 2) / this.scale + this.x,
      y: (sy - this.screenH / 2) / this.scale + this.y,
    };
  },

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.renderX()) * this.scale + this.screenW / 2,
      y: (wy - this.renderY()) * this.scale + this.screenH / 2,
    };
  },
};

/* =========================================================================
 * 12. RENDERING
 * ========================================================================= */

const FONT_HEAD = '"Arial Narrow", "Roboto Condensed", "Liberation Sans Narrow", "DejaVu Sans Condensed", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';

const Render = {
  canvas: null,
  ctx: null,
  dpr: 1,
  w: 0,
  h: 0,
  light: null,      // darkness layer with light holes cut out, drawn at half resolution
  lctx: null,
  LIGHT_RES: 0.5,
  darkness: 0.8,
  vignette: null,
  redVignette: null,
  fogSprite: null,
  fog: [],
  motes: [],

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.light = document.createElement('canvas');
    this.lctx = this.light.getContext('2d');

    // soft white blob used for fog banks
    const f = (this.fogSprite = document.createElement('canvas'));
    f.width = f.height = 256;
    const fc = f.getContext('2d');
    const grad = fc.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(130,140,156,1)');
    grad.addColorStop(0.55, 'rgba(130,140,156,0.45)');
    grad.addColorStop(1, 'rgba(130,140,156,0)');
    fc.fillStyle = grad;
    fc.fillRect(0, 0, 256, 256);

    for (let i = 0; i < 11; i++) {
      this.fog.push({
        x: rand(-MARGIN, WORLD.w + MARGIN), y: rand(-MARGIN, WORLD.h + MARGIN),
        r: rand(260, 560), vx: rand(6, 16), vy: rand(-3, 3), a: rand(0.018, 0.035),
      });
    }
    for (let i = 0; i < 60; i++) {
      this.motes.push({ x: rand(0, WORLD.w), y: rand(0, WORLD.h), vx: rand(4, 14), vy: rand(-4, 6), s: rand(0.8, 2), a: rand(0.12, 0.35), p: rand(0, TAU) });
    }

    this.resize();
    window.addEventListener('resize', () => this.resize());
  },

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.light.width = Math.ceil(this.w * this.LIGHT_RES);
    this.light.height = Math.ceil(this.h * this.LIGHT_RES);
    this.vignette = this.makeVignette('0,0,0', 0.6);
    this.redVignette = this.makeVignette('150,10,8', 0.75);
    Camera.resize(this.w, this.h);
  },

  makeVignette(rgb, edge) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(this.w / 2));
    c.height = Math.max(1, Math.round(this.h / 2));
    const g = c.getContext('2d');
    const r = Math.hypot(c.width, c.height) / 2;
    const grad = g.createRadialGradient(c.width / 2, c.height / 2, r * 0.45, c.width / 2, c.height / 2, r);
    grad.addColorStop(0, `rgba(${rgb},0)`);
    grad.addColorStop(1, `rgba(${rgb},${edge})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  },

  // Ambient motion that keeps going on menus too: fog drift, dust, lamp flicker.
  updateAmbient(dt) {
    for (const f of this.fog) {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (f.x - f.r > WORLD.w + MARGIN) f.x = -MARGIN - f.r;
      if (f.y < -MARGIN - f.r) f.y = WORLD.h + MARGIN;
      if (f.y > WORLD.h + MARGIN + f.r) f.y = -MARGIN;
    }
    const x0 = Camera.x - Camera.viewW / 2;
    const y0 = Camera.y - Camera.viewH / 2;
    for (const m of this.motes) {
      m.p += dt;
      m.x += (m.vx + Math.sin(m.p * 0.7) * 6) * dt;
      m.y += (m.vy + Math.cos(m.p * 0.5) * 4) * dt;
      // keep the dust around the camera
      m.x = x0 + ((((m.x - x0) % Camera.viewW) + Camera.viewW) % Camera.viewW);
      m.y = y0 + ((((m.y - y0) % Camera.viewH) + Camera.viewH) % Camera.viewH);
    }
    for (const l of LAMPS) {
      if (!l.flicker) continue;
      l.next = (l.next === undefined ? rand(1, 4) : l.next) - dt;
      if (l.next <= 0) {
        l.burst = rand(0.2, 0.9);
        l.next = rand(2.5, 7);
      }
      if (l.burst > 0) {
        l.burst -= dt;
        l.tick = (l.tick || 0) - dt;
        if (l.tick <= 0) {
          l.level = Math.random() < 0.55 ? rand(0.05, 0.45) : 1;
          l.tick = rand(0.03, 0.09);
        }
      } else {
        l.level = 1;
      }
    }
  },

  frame(state) {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const s = Camera.scale;
    const camX = Camera.renderX();
    const camY = Camera.renderY();
    const showPlayer = state !== 'menu';

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // world space
    const worldTransform = () =>
      ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * (this.w / 2 - camX * s), dpr * (this.h / 2 - camY * s));
    worldTransform();
    const vx0 = camX - Camera.viewW / 2;
    const vy0 = camY - Camera.viewH / 2;
    const view = { x0: vx0 - 80, y0: vy0 - 80, x1: vx0 + Camera.viewW + 80, y1: vy0 + Camera.viewH + 80 };
    const inView = (x, y, r = 0) => x + r > view.x0 && x - r < view.x1 && y + r > view.y0 && y - r < view.y1;

    // floor: copy just the visible part of the baked ground
    const g = World.ground;
    const gx0 = Math.max(0, Math.floor(vx0 + MARGIN));
    const gy0 = Math.max(0, Math.floor(vy0 + MARGIN));
    const gx1 = Math.min(g.width, Math.ceil(vx0 + MARGIN + Camera.viewW) + 1);
    const gy1 = Math.min(g.height, Math.ceil(vy0 + MARGIN + Camera.viewH) + 1);
    if (gx1 > gx0 && gy1 > gy0) {
      ctx.drawImage(g, gx0, gy0, gx1 - gx0, gy1 - gy0, gx0 - MARGIN, gy0 - MARGIN, gx1 - gx0, gy1 - gy0);
    }

    for (const p of Effects.particles) if ((p.kind === 'shell' || p.kind === 'blood') && inView(p.x, p.y)) drawParticle(ctx, p);
    for (const p of Pickups.list) if (inView(p.x, p.y)) drawPickup(ctx, p);
    for (const o of OBSTACLES) {
      const r = o.r || Math.max(o.w, o.h);
      const cx = o.r ? o.x : o.x + o.w / 2;
      const cy = o.r ? o.y : o.y + o.h / 2;
      if (inView(cx, cy, r)) drawProp(ctx, o);
    }
    for (const c of Effects.corpses) if (inView(c.x, c.y, 40)) drawCorpse(ctx, c);
    for (const z of Zombies.list) if (inView(z.x, z.y, z.r * 2)) drawZombie(ctx, z);
    if (showPlayer && (Player.alive || Game.state === 'dying')) drawPlayer(ctx, Player);
    drawShots(ctx);
    for (const p of Effects.particles) if (p.kind !== 'shell' && p.kind !== 'blood' && inView(p.x, p.y)) drawParticle(ctx, p);
    for (const f of Effects.flashes) drawMuzzleFlash(ctx, f);
    for (const l of LAMPS) if (inView(l.px, l.py, 60)) drawLampHead(ctx, l);

    // darkness with light cut out of it
    this.buildLight(camX, camY, showPlayer);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.light, 0, 0, this.canvas.width, this.canvas.height);

    // things that should read even in the dark
    worldTransform();
    for (const z of Zombies.list) if (inView(z.x, z.y, z.r)) drawZombieEyes(ctx, z);
    for (const p of Pickups.list) if (inView(p.x, p.y)) drawPickupMarker(ctx, p);
    for (const l of LAMPS) if (inView(l.px, l.py, 60)) drawLampGlow(ctx, l);
    for (const f of this.fog) {
      if (!inView(f.x, f.y, f.r)) continue;
      ctx.globalAlpha = f.a;
      ctx.drawImage(this.fogSprite, f.x - f.r, f.y - f.r, f.r * 2, f.r * 2);
    }
    ctx.fillStyle = '#c9c3b5';
    for (const m of this.motes) {
      ctx.globalAlpha = m.a * (0.6 + 0.4 * Math.sin(m.p * 2));
      ctx.fillRect(m.x, m.y, m.s, m.s);
    }
    ctx.globalAlpha = 1;
    for (const t of Effects.texts) drawFloatingText(ctx, t);

    // screen space overlays
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.vignette, 0, 0, this.w, this.h);
    if (showPlayer) {
      const low = Player.hp / Player.maxHp < 0.3 && Player.alive ? 0.2 + Math.sin(Camera.time * 6) * 0.08 : 0;
      const hurt = Math.max(Game.damageFlash * 0.6, low);
      if (hurt > 0.01) {
        ctx.globalAlpha = Math.min(1, hurt);
        ctx.drawImage(this.redVignette, 0, 0, this.w, this.h);
        ctx.globalAlpha = 1;
      }
    }
    if (state === 'playing') {
      drawTouchSticks(ctx);
      drawCrosshair(ctx);
    }
    if (state === 'playing' || state === 'dying') drawBanner(ctx, this.w, this.h);
  },

  buildLight(camX, camY, withPlayer) {
    const L = this.lctx;
    const lw = this.light.width;
    const lh = this.light.height;
    const s = Camera.scale * this.LIGHT_RES;
    const toX = (wx) => (wx - camX) * s + lw / 2;
    const toY = (wy) => (wy - camY) * s + lh / 2;

    L.globalCompositeOperation = 'source-over';
    L.clearRect(0, 0, lw, lh);
    L.fillStyle = `rgba(4,6,13,${this.darkness})`;
    L.fillRect(0, 0, lw, lh);
    L.globalCompositeOperation = 'destination-out';

    for (const l of LAMPS) {
      const r = l.r * s;
      const x = toX(l.x);
      const y = toY(l.y);
      if (x + r < 0 || y + r < 0 || x - r > lw || y - r > lh) continue;
      cutLight(L, x, y, r, 0.92 * l.level);
    }

    if (withPlayer && (Player.alive || Game.state === 'dying')) {
      const px = toX(Player.x);
      const py = toY(Player.y);
      cutLight(L, px, py, 150 * s, 0.6);
      if (Player.alive) {
        // flashlight: a hard cone plus a wider soft one for feathered edges
        const len = 580 * s;
        const a = Player.angle;
        const cone = (half, strength) => {
          const grad = L.createRadialGradient(px, py, 0, px, py, len);
          grad.addColorStop(0, `rgba(0,0,0,${strength})`);
          grad.addColorStop(0.55, `rgba(0,0,0,${strength * 0.75})`);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          L.fillStyle = grad;
          L.beginPath();
          L.moveTo(px, py);
          L.arc(px, py, len, a - half, a + half);
          L.closePath();
          L.fill();
        };
        for (let i = 0; i < 5; i++) cone(0.26 + i * 0.08, 0.26);
      }
      if (Effects.muzzleLight > 0) {
        const m = Player.muzzle();
        cutLight(L, toX(m.x), toY(m.y), 300 * s, 0.85 * Effects.muzzleLight);
      }
    }
    L.globalCompositeOperation = 'source-over';
  },
};

function cutLight(L, x, y, r, strength) {
  const grad = L.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(0,0,0,${strength})`);
  grad.addColorStop(0.5, `rgba(0,0,0,${strength * 0.6})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  L.fillStyle = grad;
  L.fillRect(x - r, y - r, r * 2, r * 2);
}

// ---------- props ----------

function drawProp(ctx, o) {
  ctx.save();
  if (o.kind === 'car') drawCar(ctx, o);
  else if (o.kind === 'dumpster') {
    ctx.fillStyle = o.color;
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(o.x + 4, o.y + 4, o.w / 2 - 6, o.h - 8);
    ctx.fillRect(o.x + o.w / 2 + 2, o.y + 4, o.w / 2 - 6, o.h - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(o.x, o.y, o.w, 3);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
    ctx.fillStyle = 'rgba(120,70,40,0.35)'; // rust
    ctx.fillRect(o.x + o.w * 0.62, o.y + o.h * 0.55, 14, 8);
  } else if (o.kind === 'barrier') {
    ctx.fillStyle = '#5f605d';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.fillStyle = '#7a7b77';
    if (o.w > o.h) ctx.fillRect(o.x, o.y + o.h / 2 - 3, o.w, 6);
    else ctx.fillRect(o.x + o.w / 2 - 3, o.y, 6, o.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
    ctx.fillStyle = 'rgba(160,60,40,0.45)';
    if (o.w > o.h) {
      ctx.fillRect(o.x + 6, o.y + 2, 10, o.h - 4);
      ctx.fillRect(o.x + o.w - 16, o.y + 2, 10, o.h - 4);
    } else {
      ctx.fillRect(o.x + 2, o.y + 6, o.w - 4, 10);
      ctx.fillRect(o.x + 2, o.y + o.h - 16, o.w - 4, 10);
    }
  } else if (o.kind === 'crate') {
    ctx.fillStyle = '#5d4529';
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    ctx.strokeRect(o.x + 3, o.y + 3, o.w - 6, o.h - 6);
    line(ctx, o.x + 4, o.y + 4, o.x + o.w - 4, o.y + o.h - 4);
    ctx.fillStyle = 'rgba(255,230,180,0.07)';
    ctx.fillRect(o.x, o.y, o.w, 3);
  } else if (o.kind === 'barrel') {
    ctx.fillStyle = '#5e281e';
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,200,170,0.12)';
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r * 0.62, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.arc(o.x + o.r * 0.35, o.y - o.r * 0.2, 2.5, 0, TAU);
    ctx.fill();
  } else if (o.kind === 'pole') {
    ctx.fillStyle = '#2b2d30';
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(o.x - 2, o.y - 2, 2.5, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawCar(ctx, o) {
  const horizontal = o.w > o.h;
  const L = horizontal ? o.w : o.h;
  const W = horizontal ? o.h : o.w;
  ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
  if (!horizontal) ctx.rotate(Math.PI / 2);
  // body
  roundRect(ctx, -L / 2, -W / 2, L, W, 11);
  ctx.fillStyle = o.color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // hood/trunk creases and a dirty highlight
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(-L / 2 + 6, -W / 2 + 3, L - 12, 4);
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  line(ctx, L * 0.3, -W / 2 + 8, L * 0.3, W / 2 - 8);
  line(ctx, -L * 0.36, -W / 2 + 8, -L * 0.36, W / 2 - 8);
  // windshield, roof, rear window
  ctx.fillStyle = '#151b21';
  roundRect(ctx, L * 0.08, -W / 2 + 6, L * 0.2, W - 12, 4);
  ctx.fill();
  roundRect(ctx, -L * 0.33, -W / 2 + 7, L * 0.13, W - 14, 3);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  roundRect(ctx, -L * 0.2, -W / 2 + 6, L * 0.28, W - 12, 4);
  ctx.fill();
  // cracked glass
  ctx.strokeStyle = 'rgba(200,215,230,0.35)';
  ctx.lineWidth = 1;
  const gx = L * 0.17;
  line(ctx, gx, -4, gx + 6, -12);
  line(ctx, gx, -4, gx - 5, 8);
  line(ctx, gx, -4, gx + 8, 4);
  // lights
  ctx.fillStyle = 'rgba(230,225,200,0.5)';
  ctx.fillRect(L / 2 - 4, -W / 2 + 6, 3, 9);
  ctx.fillStyle = 'rgba(60,60,60,0.8)';
  ctx.fillRect(L / 2 - 4, W / 2 - 15, 3, 9); // broken headlight
  ctx.fillStyle = 'rgba(140,30,25,0.8)';
  ctx.fillRect(-L / 2 + 1, -W / 2 + 6, 3, 8);
  ctx.fillRect(-L / 2 + 1, W / 2 - 14, 3, 8);
  // mirrors
  ctx.fillStyle = o.color;
  ctx.fillRect(L * 0.05, -W / 2 - 3, 5, 4);
  ctx.fillRect(L * 0.05, W / 2 - 1, 5, 4);
  // rust spot
  ctx.fillStyle = 'rgba(110,60,30,0.35)';
  ctx.beginPath();
  ctx.ellipse(-L * 0.42, W * 0.2, 7, 4, 0.4, 0, TAU);
  ctx.fill();
}

function lampHead(l) {
  const dx = l.x - l.px;
  const dy = l.y - l.py;
  const d = Math.hypot(dx, dy) || 1;
  return { x: l.px + (dx / d) * 34, y: l.py + (dy / d) * 34, dx, dy };
}

function drawLampHead(ctx, l) {
  const { x: hx, y: hy, dx, dy } = lampHead(l);
  ctx.strokeStyle = '#2f3236';
  ctx.lineWidth = 4;
  line(ctx, l.px, l.py, hx, hy);
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = '#3a3d41';
  ctx.fillRect(-9, -6, 18, 12);
  const on = l.level;
  ctx.fillStyle = `rgba(255,${200 + on * 30},${130 + on * 60},${0.25 + on * 0.7})`;
  ctx.fillRect(-6, -3.5, 12, 7);
  ctx.restore();
}

// Small halo around a lit bulb, drawn above the darkness.
function drawLampGlow(ctx, l) {
  const { x, y } = lampHead(l);
  const grad = ctx.createRadialGradient(x, y, 0, x, y, 26);
  grad.addColorStop(0, `rgba(255,214,150,${0.32 * l.level})`);
  grad.addColorStop(1, 'rgba(255,214,150,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - 26, y - 26, 52, 52);
}

// ---------- characters ----------

const ZOMBIE_LOOK = {
  normal: { body: '#4e5940', skin: '#8b9b6b', dark: '#2a3122', patch: '#3a2b22' },
  runner: { body: '#5c2a24', skin: '#a8a884', dark: '#3a1a16', patch: '#2a1612' },
  tank: { body: '#3d3935', skin: '#748457', dark: '#24221f', patch: '#5a6446' },
};

function drawShadow(ctx, x, y, rx, ry) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + 3, y + 5, rx, ry, 0, 0, TAU);
  ctx.fill();
}

function drawZombie(ctx, z) {
  const look = ZOMBIE_LOOK[z.type];
  const r = z.r;
  ctx.save();
  ctx.globalAlpha = z.fade;
  drawShadow(ctx, z.x, z.y, r * 1.05, r * 0.85);
  ctx.translate(z.x, z.y);
  ctx.rotate(z.angle + Math.sin(z.wobble * 0.5) * (z.type === 'tank' ? 0.04 : 0.1));

  // arms: reaching forward, extend during the attack wind-up
  const lunge = z.attackT > 0 ? (1 - z.attackT / 0.25) * r * 0.5 : 0;
  ctx.strokeStyle = look.skin;
  ctx.lineCap = 'round';
  ctx.lineWidth = r * (z.type === 'tank' ? 0.5 : 0.36);
  for (const side of [-1, 1]) {
    let reach = r * 1.25 + lunge;
    let spread = r * 0.42;
    if (z.type === 'runner') {
      reach = r * (0.7 + 0.5 * Math.sin(z.wobble + (side > 0 ? 0 : Math.PI))) + lunge;
      spread = r * 0.7;
    } else {
      reach += Math.sin(z.wobble + (side > 0 ? 0 : Math.PI)) * r * 0.12;
    }
    ctx.beginPath();
    ctx.moveTo(0, side * r * 0.62);
    ctx.lineTo(reach, side * spread);
    ctx.stroke();
    ctx.fillStyle = look.dark;
    ctx.beginPath();
    ctx.arc(reach, side * spread, ctx.lineWidth * 0.55, 0, TAU);
    ctx.fill();
  }

  // torso
  ctx.fillStyle = look.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.68, r, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = look.patch;
  ctx.beginPath();
  ctx.ellipse(-r * 0.2, r * 0.35, r * 0.28, r * 0.22, 0.6, 0, TAU);
  ctx.fill();
  if (z.type === 'tank') {
    ctx.fillStyle = look.patch;
    ctx.beginPath();
    ctx.ellipse(r * 0.18, 0, r * 0.32, r * 0.55, 0, 0, TAU);
    ctx.fill();
  }

  // head
  const hr = r * (z.type === 'tank' ? 0.42 : 0.55);
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.arc(r * 0.12, 0, hr, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = look.dark;
  ctx.beginPath();
  ctx.arc(r * 0.02, -hr * 0.35, hr * 0.35, 0, TAU);
  ctx.fill();

  // hit flash
  if (z.flash > 0) {
    ctx.globalAlpha = z.fade * 0.5;
    ctx.fillStyle = '#ffe6d6';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.7, r, 0, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(r * 0.12, 0, hr, 0, TAU);
    ctx.fill();
  }
  ctx.restore();

  // health bar: tanks always, others once hurt
  if ((z.type === 'tank' || z.hp < z.maxHp) && z.fade > 0.5) {
    const w = r * 2;
    const x = z.x - r;
    const y = z.y - r - 12;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1, y - 1, w + 2, 5);
    ctx.fillStyle = z.type === 'tank' ? '#c9893a' : '#b8352a';
    ctx.fillRect(x, y, w * Math.max(0, z.hp / z.maxHp), 3);
  }
}

// Faint eyes drawn above the darkness so zombies stay readable outside the light.
function drawZombieEyes(ctx, z) {
  if (z.fade < 0.3) return;
  const r = z.r;
  const fx = Math.cos(z.angle);
  const fy = Math.sin(z.angle);
  const hx = z.x + fx * r * (z.type === 'tank' ? 0.4 : 0.45);
  const hy = z.y + fy * r * (z.type === 'tank' ? 0.4 : 0.45);
  const sp = r * 0.2;
  ctx.globalAlpha = 0.75 * z.fade;
  ctx.fillStyle = z.type === 'runner' ? '#e8b46a' : '#d9d48a';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(hx - fy * sp * side, hy + fx * sp * side, z.type === 'tank' ? 1.8 : 1.5, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawCorpse(ctx, c) {
  const look = ZOMBIE_LOOK[c.type];
  const fall = Math.min(1, c.t / 0.3);
  const alpha = c.t > 1.8 ? Math.max(0, 1 - (c.t - 1.8) / 0.8) : 1;
  const r = c.r;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(c.x, c.y);
  ctx.rotate(c.angle);
  ctx.scale(1 + fall * 0.25, 1 - fall * 0.15);
  ctx.strokeStyle = look.skin;
  ctx.lineCap = 'round';
  ctx.lineWidth = r * 0.34;
  line(ctx, 0, -r * 0.6, r * 0.9, -r * 1.1);
  line(ctx, 0, r * 0.6, r * 0.5, r * 1.15);
  ctx.fillStyle = look.body;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.75, r, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.arc(r * (0.2 + fall * 0.9), 0, r * 0.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, 0, r * 0.75, r, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(ctx, p) {
  const dead = !p.alive;
  ctx.save();
  drawShadow(ctx, p.x, p.y, 16, 13);
  ctx.translate(p.x, p.y);

  // feet swing in the direction of travel
  const speed = Math.hypot(p.vx, p.vy);
  const walk = Math.min(1, speed / 160);
  if (!dead) {
    ctx.save();
    ctx.rotate(speed > 10 ? Math.atan2(p.vy, p.vx) : p.angle);
    const sw = Math.sin(p.step) * 7 * walk;
    ctx.fillStyle = '#17181a';
    ctx.beginPath();
    ctx.ellipse(sw, -6, 5.5, 3.6, 0, 0, TAU);
    ctx.ellipse(-sw, 6, 5.5, 3.6, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  ctx.rotate(p.angle);
  if (dead) ctx.scale(1.15, 0.9);
  const kick = -p.recoil * 4;
  const jacket = '#857152';

  // arms out to the pistol
  ctx.strokeStyle = jacket;
  ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  line(ctx, 2, -10, 17 + kick, -2.5);
  line(ctx, 2, 10, 17 + kick, 2.5);
  // pistol
  ctx.fillStyle = '#141518';
  ctx.fillRect(15 + kick, -2.6, 16, 5.2);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(18 + kick, -2.6, 12, 1.3);
  // hands
  ctx.fillStyle = '#c99a76';
  ctx.beginPath();
  ctx.arc(18 + kick, -2.4, 3.3, 0, TAU);
  ctx.arc(18 + kick, 2.4, 3.3, 0, TAU);
  ctx.fill();

  // backpack + torso
  ctx.fillStyle = '#34352d';
  roundRect(ctx, -15, -8, 7, 16, 2);
  ctx.fill();
  ctx.fillStyle = jacket;
  ctx.beginPath();
  ctx.ellipse(0, 0, 10.5, 14.5, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  line(ctx, 3, -9, 3, 9); // zipper

  // head with a red beanie so the player is easy to find
  ctx.fillStyle = '#a8382a';
  ctx.beginPath();
  ctx.arc(1.5, 0, 8.3, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(1.5, 0, 5, -2.2, -0.9);
  ctx.stroke();

  if (p.hurtFlash > 0) {
    ctx.globalAlpha = p.hurtFlash * 0.6;
    ctx.fillStyle = '#ff4433';
    ctx.beginPath();
    ctx.ellipse(0, 0, 11, 15, 0, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------- effects ----------

function drawShots(ctx) {
  ctx.lineCap = 'round';
  for (const b of Bullets.list) {
    const back = Math.min(46, Math.hypot(b.x - b.sx, b.y - b.sy));
    const tx = b.x - Math.cos(b.angle) * back;
    const ty = b.y - Math.sin(b.angle) * back;
    const grad = ctx.createLinearGradient(tx, ty, b.x, b.y);
    grad.addColorStop(0, 'rgba(255,220,150,0)');
    grad.addColorStop(1, 'rgba(255,240,200,0.95)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.2;
    line(ctx, tx, ty, b.x, b.y);
  }
  for (const t of Effects.tracers) {
    const a = Math.atan2(t.y1 - t.y0, t.x1 - t.x0);
    const back = Math.min(46, Math.hypot(t.x1 - t.x0, t.y1 - t.y0));
    ctx.strokeStyle = `rgba(255,235,190,${t.life / 0.05 * 0.8})`;
    ctx.lineWidth = 2;
    line(ctx, t.x1 - Math.cos(a) * back, t.y1 - Math.sin(a) * back, t.x1, t.y1);
  }
}

function drawParticle(ctx, p) {
  const k = Math.max(0, p.life / p.max);
  if (p.kind === 'blood') {
    ctx.fillStyle = '#7d1510';
    ctx.beginPath();
    ctx.arc(p.x, p.y - p.z * 0.6, p.size, 0, TAU);
    ctx.fill();
  } else if (p.kind === 'shell') {
    ctx.save();
    ctx.globalAlpha = Math.min(1, p.life / 0.5);
    ctx.translate(p.x, p.y - p.z * 0.6);
    ctx.rotate(p.rot);
    ctx.fillStyle = '#c9a24a';
    ctx.fillRect(-2.2, -1, 4.4, 2);
    ctx.restore();
  } else if (p.kind === 'spark') {
    ctx.strokeStyle = `rgba(255,214,140,${k})`;
    ctx.lineWidth = p.size;
    line(ctx, p.x, p.y, p.x - p.vx * 0.02, p.y - p.vy * 0.02);
  } else if (p.kind === 'smoke') {
    ctx.fillStyle = `rgba(150,150,150,${0.16 * k})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
  }
}

function drawMuzzleFlash(ctx, f) {
  const k = f.life / f.max;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.angle);
  ctx.scale(f.scale, f.scale);
  ctx.globalAlpha = 0.6 + k * 0.4;
  ctx.fillStyle = '#ffb347';
  ctx.beginPath();
  ctx.moveTo(-2, -7);
  ctx.lineTo(24, 0);
  ctx.lineTo(-2, 7);
  ctx.lineTo(6, 0);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(8, -11);
  ctx.lineTo(11, 0);
  ctx.lineTo(8, 11);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff3d0';
  ctx.beginPath();
  ctx.arc(4, 0, 4.5, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawPickup(ctx, p) {
  if (p.life < 3 && Math.floor(p.life * 8) % 2 === 0) return; // blink before vanishing
  const bob = Math.sin(p.bob) * 1.5;
  ctx.save();
  drawShadow(ctx, p.x - 2, p.y - 2, 10, 6);
  ctx.translate(p.x, p.y + bob);
  if (p.kind === 'ammo') {
    ctx.fillStyle = '#4a4f33';
    ctx.fillRect(-10, -7, 20, 14);
    ctx.fillStyle = '#c9a24a';
    for (let i = -6; i <= 6; i += 4) ctx.fillRect(i - 1, -4, 2, 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-10, -7, 20, 14);
  } else {
    ctx.fillStyle = '#d9d4c8';
    ctx.fillRect(-9, -8, 18, 16);
    ctx.fillStyle = '#b8352a';
    ctx.fillRect(-2, -5.5, 4, 11);
    ctx.fillRect(-5.5, -2, 11, 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-9, -8, 18, 16);
  }
  ctx.restore();
}

// Thin pulsing ring above the darkness so drops can be found.
function drawPickupMarker(ctx, p) {
  if (p.life < 3 && Math.floor(p.life * 8) % 2 === 0) return;
  const pulse = (Math.sin(p.bob * 0.8) + 1) / 2;
  ctx.strokeStyle = p.kind === 'ammo' ? 'rgba(217,194,122,0.45)' : 'rgba(127,207,122,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 15 + pulse * 4, 0, TAU);
  ctx.stroke();
}

function drawFloatingText(ctx, t) {
  const k = t.life / t.max;
  ctx.globalAlpha = Math.min(1, k * 2);
  ctx.font = `700 ${t.size}px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText(t.str, t.x + 1, t.y + 1);
  ctx.fillStyle = t.color;
  ctx.fillText(t.str, t.x, t.y);
  ctx.globalAlpha = 1;
}

// ---------- screen overlays ----------

function drawCrosshair(ctx) {
  const p = Player;
  if (!p.alive) return;
  let x = Input.mouse.x;
  let y = Input.mouse.y;
  if (Input.touch.enabled) {
    const s = Camera.worldToScreen(p.x + Math.cos(p.angle) * 220, p.y + Math.sin(p.angle) * 220);
    x = s.x;
    y = s.y;
  }
  const gap = 6 + p.bloom * 110 + p.recoil * 5;
  const len = 7;
  ctx.lineCap = 'butt';
  for (const [w, color] of [[4, 'rgba(0,0,0,0.65)'], [2, '#ece6da']]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    line(ctx, x - gap - len, y, x - gap, y);
    line(ctx, x + gap, y, x + gap + len, y);
    line(ctx, x, y - gap - len, x, y - gap);
    line(ctx, x, y + gap, x, y + gap + len);
  }
  ctx.fillStyle = '#ece6da';
  ctx.fillRect(x - 1, y - 1, 2, 2);

  ctx.font = `700 11px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (p.reloadLeft > 0) {
    const k = 1 - p.reloadLeft / p.reloadTotal;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = '#d9a441';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 22, -Math.PI / 2, -Math.PI / 2 + k * TAU);
    ctx.stroke();
  } else if (p.mag === 0) {
    ctx.fillStyle = p.reserve > 0 ? '#d9a441' : '#d4473a';
    ctx.fillText(p.reserve > 0 ? 'RELOAD [R]' : 'NO AMMO', x, y + 26);
  } else if (p.mag <= 3 && p.reserve > 0) {
    ctx.fillStyle = 'rgba(217,164,65,0.8)';
    ctx.fillText('LOW', x, y + 26);
  }
}

function drawTouchSticks(ctx) {
  if (!Input.touch.enabled) return;
  for (const s of [Input.touch.move, Input.touch.aim]) {
    if (s.id === null) continue;
    ctx.strokeStyle = 'rgba(230,225,214,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.ox, s.oy, 60, 0, TAU);
    ctx.stroke();
    const dx = s.x - s.ox;
    const dy = s.y - s.oy;
    const d = Math.min(60, Math.hypot(dx, dy));
    const a = Math.atan2(dy, dx);
    ctx.fillStyle = 'rgba(230,225,214,0.3)';
    ctx.beginPath();
    ctx.arc(s.ox + Math.cos(a) * d, s.oy + Math.sin(a) * d, 22, 0, TAU);
    ctx.fill();
  }
}

function drawBanner(ctx, w, h) {
  const b = Game.bannerState;
  if (!b || b.t >= b.dur) return;
  const fadeIn = Math.min(1, b.t / 0.25);
  const fadeOut = Math.min(1, (b.dur - b.t) / 0.5);
  const a = Math.min(fadeIn, fadeOut);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const y = h * 0.3;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
  ctx.font = `700 ${Math.round(Math.min(64, w / 14))}px ${FONT_HEAD}`;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(b.title, w / 2 + 2, y + 2);
  ctx.fillStyle = '#ece6da';
  ctx.fillText(b.title, w / 2, y);
  if (b.sub) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = '5px';
    ctx.font = `600 15px ${FONT_MONO}`;
    ctx.fillStyle = '#9c978c';
    ctx.fillText(b.sub, w / 2, y + 44);
  }
  ctx.restore();
}

/* =========================================================================
 * 13. UI — DOM screens and HUD (HUD text is only touched when it changes)
 * ========================================================================= */

const UI = {
  el: {},
  cache: {},
  screens: ['menu', 'settings', 'prewave', 'cleared', 'upgrades', 'pause', 'gameover'],
  rows: {},

  init() {
    for (const node of document.querySelectorAll('[id]')) this.el[node.id] = node;

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      Sound.unlock();
      if (btn.dataset.action !== 'touch-reload') Sound.play('click');
      Game.action(btn.dataset.action, btn);
      btn.blur();
    });

    // upgrade rows are built once and refreshed in place
    for (const d of UPGRADE_DEFS) {
      const row = document.createElement('div');
      row.className = 'upg-row';
      row.innerHTML =
        `<div><div class="upg-name">${d.name}</div>` +
        `<div class="upg-level"><span class="lvl"></span><span class="pips">${'<i class="pip"></i>'.repeat(d.max)}</span></div>` +
        `<div class="upg-effect"></div></div>` +
        `<div class="upg-cost"></div>` +
        `<button class="btn" data-action="buy" data-id="${d.id}">UPGRADE</button>`;
      this.el['upg-list'].appendChild(row);
      this.rows[d.id] = {
        level: row.querySelector('.lvl'),
        pips: row.querySelectorAll('.pip'),
        effect: row.querySelector('.upg-effect'),
        cost: row.querySelector('.upg-cost'),
        button: row.querySelector('button'),
      };
    }
  },

  show(name) {
    for (const s of this.screens) this.el['screen-' + s].classList.toggle('active', s === name);
    const st = Game.state;
    const inRun = !['menu', 'gameover'].includes(st);
    this.el.hud.classList.toggle('hidden', !inRun);
    document.body.classList.toggle('in-play', st === 'playing');
    Input.capture = st === 'playing';
    if (name) {
      const first = this.el['screen-' + name].querySelector('.btn.primary:not(:disabled)') ||
        this.el['screen-' + name].querySelector('.btn');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
    }
  },

  text(id, value) {
    const v = String(value);
    if (this.cache[id] !== v) {
      this.cache[id] = v;
      this.el[id].textContent = v;
    }
  },

  flag(id, cls, on) {
    const key = id + '.' + cls;
    if (this.cache[key] !== on) {
      this.cache[key] = on;
      this.el[id].classList.toggle(cls, on);
    }
  },

  updateHud() {
    if (this.el.hud.classList.contains('hidden')) return;
    const p = Player;
    const remaining = Waves.active ? Waves.remaining() : Game.state === 'prewave' ? Game.upcoming : Zombies.list.length;
    this.text('hud-wave', pad2(Waves.number));
    this.text('hud-zombies', remaining);
    this.text('hud-coins', Game.coins);
    this.text('hud-hp', Math.ceil(p.hp));
    this.text('hud-hpmax', p.maxHp);
    const pct = Math.round((p.hp / p.maxHp) * 1000) / 10;
    if (this.cache.hpPct !== pct) {
      this.cache.hpPct = pct;
      this.el['hud-hpfill'].style.width = pct + '%';
    }
    this.flag('hud-hpfill', 'low', p.hp / p.maxHp < 0.3);
    this.text('hud-mag', p.mag);
    this.text('hud-reserve', p.reserve);
    this.flag('hud-mag', 'empty', p.mag === 0);
    this.flag('hud-reload', 'hidden', p.reloadLeft <= 0);
  },

  refreshSettings() {
    const s = Game.settings;
    for (const [key, id] of [['sound', 'set-sound'], ['music', 'set-music'], ['shake', 'set-shake']]) {
      this.el[id].textContent = s[key] ? 'ON' : 'OFF';
      this.el[id].classList.toggle('off', !s[key]);
    }
  },

  refreshUpgrades() {
    this.el['upg-coins'].textContent = Game.coins;
    for (const d of UPGRADE_DEFS) {
      const row = this.rows[d.id];
      const lvl = Upgrades.levels[d.id];
      const cost = Upgrades.cost(d.id);
      row.level.textContent = `LEVEL ${lvl} / ${d.max}`;
      row.pips.forEach((pip, i) => pip.classList.toggle('on', i < lvl));
      if (cost === null) {
        row.effect.innerHTML = `MAXED <i>(${d.format(d.value(lvl))})</i>`;
        row.cost.textContent = '—';
        row.cost.classList.remove('poor');
        row.button.disabled = true;
        row.button.textContent = 'MAXED';
      } else {
        const poor = Game.coins < cost;
        row.effect.innerHTML = `${d.effect} <i>${d.format(d.value(lvl))} &rarr; ${d.format(d.value(lvl + 1))}</i>`;
        row.cost.textContent = cost + ' COINS';
        row.cost.classList.toggle('poor', poor);
        row.button.disabled = poor;
        row.button.textContent = poor ? 'NOT ENOUGH COINS' : 'UPGRADE';
      }
    }
  },
};

/* =========================================================================
 * 14. GAME STATE & LOOP
 * ========================================================================= */

const Game = {
  state: 'menu',
  settings: null,
  settingsOpen: false,
  coins: 0,
  totalKills: 0,
  waveStarted: 0,
  upcoming: 0,
  damageFlash: 0,
  bannerState: null,
  deathTimer: 0,
  groanTimer: 3,
  menuTime: 0,

  init() {
    this.settings = Save.loadSettings();
    Sound.soundOn = this.settings.sound;
    Sound.musicOn = this.settings.music;

    const canvas = document.getElementById('game');
    Upgrades.reset();
    World.bake();
    Render.init(canvas);
    Input.init(canvas);
    Input.onKey = (code) => this.onKey(code);
    UI.init();
    UI.refreshSettings();

    window.addEventListener('blur', () => this.pause());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause();
    });

    this.toMenu();
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      this.update(dt);
      Render.frame(this.state);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  setState(state, screen) {
    this.state = state;
    this.settingsOpen = false;
    UI.show(screen);
  },

  // Main menu: the street at night with a few zombies shuffling around.
  toMenu() {
    if (World.dirty) World.bake();
    Zombies.list.length = 0;
    Bullets.list.length = 0;
    Effects.clear();
    Pickups.clear();
    this.bannerState = null;
    Player.alive = false;
    Waves.number = 0;
    Waves.active = false;
    for (let i = 0; i < 8; i++) {
      for (let tries = 0; tries < 30; tries++) {
        const x = rand(300, WORLD.w - 300);
        const y = rand(250, WORLD.h - 250);
        if (World.isFree(x, y, 30)) {
          Zombies.spawn(i === 3 ? 'tank' : i % 3 === 0 ? 'runner' : 'normal', x, y, null);
          break;
        }
      }
    }
    for (const z of Zombies.list) z.fade = 1;
    UI.el['menu-best'].textContent = Save.bestWave();
    this.setState('menu', 'menu');
  },

  newGame() {
    Upgrades.reset();
    this.coins = 0;
    this.totalKills = 0;
    this.waveStarted = 0;
    if (World.dirty) World.bake();
    Zombies.list.length = 0;
    Bullets.list.length = 0;
    Effects.clear();
    Pickups.clear();
    this.bannerState = null;
    this.damageFlash = 0;
    Player.reset();
    Camera.snap(Player.x, Player.y);
    this.prepareWave(1);
  },

  prepareWave(n) {
    Waves.number = n;
    Waves.active = false;
    const c = Waves.compose(n);
    this.upcoming = c.normal + c.runner + c.tank;
    UI.el['pre-night'].textContent = pad2(Waves.night(n));
    UI.el['pre-wave'].textContent = n;
    const parts = [`${c.normal} NORMAL`];
    if (c.runner) parts.push(`${c.runner} RUNNER${c.runner > 1 ? 'S' : ''}`);
    if (c.tank) parts.push(`${c.tank} TANK${c.tank > 1 ? 'S' : ''}`);
    UI.el['pre-note'].textContent = parts.join(' · ');
    this.setState('prewave', 'prewave');
  },

  beginWave() {
    const n = Waves.number;
    Waves.start(n);
    this.waveStarted = n;
    Player.reserve = Math.max(Player.reserve, Upgrades.stats().maxReserve); // resupply between waves
    Input.mouse.down = false;
    this.setState('playing', null);
    this.banner('WAVE ' + n, 'NIGHT ' + pad2(Waves.night(n)));
    Sound.play('waveStart');
  },

  onZombieKilled(z) {
    const t = ZOMBIE_TYPES[z.type];
    this.coins += t.coins;
    Waves.coins += t.coins;
    Waves.kills++;
    this.totalKills++;
    Effects.text(z.x, z.y - z.r - 10, '+' + t.coins, '#d9a441', 14);
    const lowAmmo = Player.reserve < 12;
    if (z.type === 'tank' || Math.random() < (lowAmmo ? 0.35 : 0.18)) {
      Pickups.drop(z.x, z.y, 'ammo', z.type === 'tank' ? 24 : 12);
    } else if (Math.random() < 0.05) {
      Pickups.drop(z.x, z.y, 'med', 25);
    }
  },

  waveCleared() {
    const bonus = 50 * Waves.number;
    this.coins += bonus;
    Waves.coins += bonus;
    Pickups.sweep();
    const heal = Math.min(25, Player.maxHp - Player.hp);
    Player.hp += heal;
    Bullets.list.length = 0;
    UI.el['clr-coins'].textContent = Waves.coins;
    UI.el['clr-kills'].textContent = Waves.kills;
    UI.el['clr-note'].textContent = `INCLUDES +${bonus} SURVIVAL BONUS` + (heal > 0 ? ` · PATCHED UP +${Math.round(heal)} HP` : '');
    this.setState('cleared', 'cleared');
  },

  playerDied() {
    Player.alive = false;
    Input.mouse.down = false;
    Effects.blood(Player.x, Player.y, rand(0, TAU), 24, 1.2);
    World.stain(Player.x, Player.y, 26, 0.6);
    Camera.shake(0.6);
    this.deathTimer = 1.8;
    this.setState('dying', null);
  },

  gameOver() {
    const wave = this.waveStarted;
    const isNew = Save.submitWave(wave);
    UI.el['go-night'].textContent = pad2(Waves.night(wave));
    UI.el['go-wave'].textContent = wave;
    UI.el['go-kills'].textContent = this.totalKills;
    UI.el['go-best'].textContent = Save.bestWave();
    UI.el['go-newbest'].classList.toggle('hidden', !isNew);
    this.setState('gameover', 'gameover');
  },

  pause() {
    if (this.state !== 'playing') return;
    Input.reset();
    this.setState('paused', 'pause');
  },

  resume() {
    if (this.state !== 'paused') return;
    Input.reset();
    this.setState('playing', null);
  },

  quitToMenu() {
    if (this.waveStarted > 0) Save.submitWave(this.waveStarted);
    this.toMenu();
  },

  openSettings() {
    UI.refreshSettings();
    UI.show('settings');
    this.settingsOpen = true;
  },

  closeSettings() {
    this.settingsOpen = false;
    UI.show(this.state === 'paused' ? 'pause' : 'menu');
  },

  toggleSetting(key) {
    this.settings[key] = !this.settings[key];
    Save.saveSettings(this.settings);
    Sound.soundOn = this.settings.sound;
    Sound.musicOn = this.settings.music;
    Sound.apply();
    if (!this.settings.shake) Camera.trauma = Camera.kx = Camera.ky = 0;
    UI.refreshSettings();
  },

  action(name, btn) {
    switch (name) {
      case 'start': this.newGame(); break;
      case 'retry': this.newGame(); break;
      case 'settings': this.openSettings(); break;
      case 'settings-back': this.closeSettings(); break;
      case 'toggle-sound': this.toggleSetting('sound'); break;
      case 'toggle-music': this.toggleSetting('music'); break;
      case 'toggle-shake': this.toggleSetting('shake'); break;
      case 'begin-wave': this.beginWave(); break;
      case 'next-wave': this.prepareWave(Waves.number + 1); break;
      case 'upgrades':
        UI.refreshUpgrades();
        this.setState('upgrades', 'upgrades');
        break;
      case 'upgrades-back': this.setState('cleared', 'cleared'); break;
      case 'buy':
        if (Upgrades.buy(btn.dataset.id)) Sound.play('buy');
        UI.refreshUpgrades();
        break;
      case 'pause': this.pause(); break;
      case 'resume': this.resume(); break;
      case 'quit': this.quitToMenu(); break;
      case 'touch-reload': if (this.state === 'playing') Player.startReload(); break;
    }
  },

  onKey(code) {
    Sound.unlock();
    if (code === 'Escape') {
      if (this.settingsOpen) this.closeSettings();
      else if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (this.state === 'upgrades') this.setState('cleared', 'cleared');
    } else if (code === 'KeyR' && this.state === 'playing') {
      Player.startReload();
    }
  },

  banner(title, sub, dur = 2.2) {
    this.bannerState = { title, sub, t: 0, dur };
  },

  update(dt) {
    Render.updateAmbient(dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.2);
    if (this.bannerState && this.state !== 'paused') this.bannerState.t += dt;

    if (this.state === 'menu') {
      this.menuTime += dt;
      Zombies.update(dt);
      Effects.update(dt);
      const t = this.menuTime;
      Camera.follow(WORLD.w / 2 + Math.cos(t * 0.05) * 520, WORLD.h / 2 + Math.sin(t * 0.08) * 300, dt, 0.8);
    } else if (this.state === 'playing') {
      this.simulate(dt);
    } else if (this.state === 'dying') {
      const slow = dt * 0.35; // brief slow motion on death
      Bullets.update(slow);
      Zombies.update(slow);
      Effects.update(slow);
      Camera.follow(Player.x, Player.y, dt, 3);
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this.gameOver();
    } else if (this.state === 'prewave') {
      Camera.follow(Player.x, Player.y, dt, 4);
    }

    Camera.update(dt);
    UI.updateHud();
  },

  simulate(dt) {
    Player.update(dt);
    Bullets.update(dt);
    Zombies.update(dt);
    Pickups.update(dt);
    Effects.update(dt);
    Waves.update(dt);

    // follow the player with a small lead toward where they aim
    let lx = Math.cos(Player.angle) * 60;
    let ly = Math.sin(Player.angle) * 60;
    if (!Input.touch.enabled) {
      const m = Camera.screenToWorld(Input.mouse.x, Input.mouse.y);
      lx = clamp((m.x - Player.x) * 0.2, -130, 130);
      ly = clamp((m.y - Player.y) * 0.2, -90, 90);
    }
    Camera.follow(Player.x + lx, Player.y + ly, dt, 5);

    // the occasional groan, louder when they're close
    this.groanTimer -= dt;
    if (this.groanTimer <= 0 && Zombies.list.length) {
      let nearest = Infinity;
      for (const z of Zombies.list) nearest = Math.min(nearest, Math.hypot(z.x - Player.x, z.y - Player.y));
      Sound.play('groan', clamp(1 - nearest / 900, 0.15, 1));
      this.groanTimer = rand(1.8, 4.5);
    }
  },
};

Game.init();
