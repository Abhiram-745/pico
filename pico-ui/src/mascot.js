/* ==========================================================================
   Pico — the mascot rig

   The character is the 2D Pico: a blue body with a pair of antennae, two
   arms, four feet and two dark eyes. It is drawn here rather than loaded as
   artwork, because a drawing that is *generated* can be posed, and a posed
   character is the difference between a logo and something that looks like
   it is listening to you.

   WHY THE SHAPES ARE PARAMETRIC
   Every solid part of Pico — body, arms, feet, eyes — is the same kind of
   shape: a box with rounded corners whose edges may bow outward. So each one
   is emitted by a single generator as eight cubic segments, always in the
   same order, always the same command structure. Two poses of the same part
   therefore differ only in their numbers, and the way between them is a
   straight interpolation of those numbers.

   That is deliberate. The usual way to move between two SVG shapes is a
   morph library, which samples both outlines into polygons and slides the
   points around; it wrecks bezier curves, flattens round corners, and turns
   small circles into triangles halfway through. None of that happens here,
   because nothing is ever sampled: the shape is rebuilt from lerped
   parameters on each frame and is a true rounded box at every instant.

   WHAT MOVES, AND WHAT MORPHS
   Only the eyes change shape — they are the whole face, so they carry the
   expression. Everything else is rigid and moves by transform: antennae
   rotate about their base, arms about the shoulder, feet about where they
   meet the body, and the whole character about the point it stands on.
   Rigid parts that rotate about their own joint read as anatomy; the same
   parts squashed by a whole-body scale read as jelly.

   THE TWO LAYERS
   A morph layer — the change from one pose to the next, deliberate, eased.
   An idle layer — breathing, blinking, glancing about; ambient, always
   running, never restarted. The idle animator is created once and lives for
   as long as the mascot does. It is not stopped during a pose change, only
   turned down to a tenth and brought back up afterwards, because a character
   that freezes for the length of every transition reads as a machine.
   ========================================================================== */

/* The character is drawn in a 1024 grid, which is how the artwork is
   authored. The view is cropped to what Pico actually occupies plus room
   above and below to jump into. */
const VIEW = { x: 82, y: 29, w: 860, h: 860 };

/* Where Pico touches the ground. Rotations and scales of the whole body
   pivot here — characters stand on a floor, and turning one about its middle
   reads as spinning in space rather than leaning. */
const FOOT_Y = 788;
const MID_X = 512;

/* Joints, in artwork coordinates. */
const JOINT = {
  antL: [392, 207],
  antR: [632, 207],
  /* The shoulders sit on the body's own edge rather than in the middle of
     the arm. Pivoting there swings the arm out from under the body, which is
     what a raised arm looks like; pivoting mid-arm just rocks the stub. */
  armL: [218, 372],
  armR: [806, 372],
};

const EYE = { l: [387, 356], r: [637, 356] };

/* Antennae are drawn once and only ever rotated, so their outline is the
   artwork's own. */
const ANT_L = 'M392 207 C386 183 371 163 349 151 C329 140 305 136 281 142';
const ANT_R = 'M632 207 C638 183 653 163 675 151 C695 140 719 136 743 142';
const TIP_L = [269, 145];
const TIP_R = [755, 145];

const FEET_X = [266, 389, 555, 678];
const FOOT = { w: 80, top: 650, h: 138, r: 29 };

const ARM = { w: 118, top: 340, h: 142, r: 44 };
const BODY = { x: 218, y: 205, w: 588, h: 490, r: 58 };

/* ==========================================================================
   Geometry
   ========================================================================== */

/* The circle-from-cubics constant. Every rounded corner below is the same
   quarter-circle approximation the artwork itself was drawn with, so at rest
   the generated outline is the original path to the decimal. */
const K = 0.5523;

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * A rounded box, as eight cubic segments: four edges and four corners, always
 * in that order, always cubics — a corner of radius zero is emitted as a
 * degenerate cubic rather than skipped, so the command structure never
 * changes and any two of these interpolate segment for segment.
 *
 * `bow` displaces an edge's control points, which bends the edge without
 * touching its ends. A little of it on the top and bottom of an eye is the
 * difference between a slot and a smile.
 *
 * @param {number[]|number} radii  one radius, or [topLeft, topRight, bottomRight, bottomLeft]
 * @param {object} bow   { t, b, l, r } in user units; y is positive downward
 */
function box(x, y, w, h, radii, bow = {}) {
  const [tl0, tr0, br0, bl0] = Array.isArray(radii) ? radii : [radii, radii, radii, radii];
  const lim = Math.min(w, h) / 2;
  const cl = (v) => Math.max(0, Math.min(lim, v));
  const tl = cl(tl0), tr = cl(tr0), br = cl(br0), bl = cl(bl0);

  const bt = bow.t || 0, bb = bow.b || 0, bl_ = bow.l || 0, br_ = bow.r || 0;
  /* A cubic whose two controls are offset by c passes 3/4 c from the chord,
     so ask for 4/3 of the bow to get the bow. */
  const f = 4 / 3;

  const x0 = x, x1 = x + w, y0 = y, y1 = y + h;
  const seg = [];
  const p = (a, b) => `${r2(a)} ${r2(b)}`;

  // top edge, left to right
  const ax = x0 + tl, bx = x1 - tr;
  seg.push(`M${p(ax, y0)}`);
  seg.push(`C${p(ax + (bx - ax) / 3, y0 + bt * f)} ${p(ax + 2 * (bx - ax) / 3, y0 + bt * f)} ${p(bx, y0)}`);
  // top-right corner
  seg.push(`C${p(bx + tr * K, y0)} ${p(x1, y0 + tr - tr * K)} ${p(x1, y0 + tr)}`);
  // right edge, top to bottom
  const ay = y0 + tr, by = y1 - br;
  seg.push(`C${p(x1 + br_ * f, ay + (by - ay) / 3)} ${p(x1 + br_ * f, ay + 2 * (by - ay) / 3)} ${p(x1, by)}`);
  // bottom-right corner
  seg.push(`C${p(x1, by + br * K)} ${p(x1 - br + br * K, y1)} ${p(x1 - br, y1)}`);
  // bottom edge, right to left
  const cx0 = x1 - br, cx1 = x0 + bl;
  seg.push(`C${p(cx0 - (cx0 - cx1) / 3, y1 + bb * f)} ${p(cx0 - 2 * (cx0 - cx1) / 3, y1 + bb * f)} ${p(cx1, y1)}`);
  // bottom-left corner
  seg.push(`C${p(cx1 - bl * K, y1)} ${p(x0, y1 - bl + bl * K)} ${p(x0, y1 - bl)}`);
  // left edge, bottom to top
  const dy0 = y1 - bl, dy1 = y0 + tl;
  seg.push(`C${p(x0 + bl_ * f, dy0 - (dy0 - dy1) / 3)} ${p(x0 + bl_ * f, dy0 - 2 * (dy0 - dy1) / 3)} ${p(x0, dy1)}`);
  // top-left corner
  seg.push(`C${p(x0, dy1 - tl * K)} ${p(x0 + tl - tl * K, y0)} ${p(x0 + tl, y0)}`);
  seg.push('Z');
  return seg.join('');
}

/** An eye, given its centre and a shape description. */
function eyePath([cx, cy], e) {
  const w = Math.max(6, e.w);
  const h = Math.max(4, e.h);
  return box(cx - w / 2 + (e.dx || 0), cy - h / 2 + (e.dy || 0), w, h,
    e.r, { t: e.bt || 0, b: e.bb || 0 });
}

/**
 * Translate, then rotate and scale about a pivot. Written as an SVG
 * transform attribute rather than a CSS one: CSS transforms on SVG children
 * need a reference box to resolve their origin against, and every way of
 * choosing that box has a different idea of where the artwork's own
 * coordinates are. A transform attribute has no such ambiguity.
 */
function tf({ x = 0, y = 0, rot = 0, sx = 1, sy = 1, px = MID_X, py = FOOT_Y }) {
  const parts = [];
  if (x || y) parts.push(`translate(${r2(x)} ${r2(y)})`);
  if (rot || sx !== 1 || sy !== 1) {
    parts.push(`translate(${r2(px)} ${r2(py)})`);
    if (rot) parts.push(`rotate(${r2(rot)})`);
    if (sx !== 1 || sy !== 1) parts.push(`scale(${r2(sx)} ${r2(sy)})`);
    parts.push(`translate(${r2(-px)} ${r2(-py)})`);
  }
  return parts.join(' ') || 'translate(0 0)';
}

/* ==========================================================================
   Poses

   Numbers, not paths. A pose says how open the eyes are, how the antennae
   are held and where the arms hang; the rig turns that into geometry. Moving
   between two poses is moving between two sets of numbers, which is why
   nothing ever has to be sampled or matched up.

   eye:  w/h/r     size and corner rounding
         bt/bb     bow of the top and bottom edge — negative arches upward,
                   which is how a rectangle becomes a smiling eye
         dy        nudge within the socket
   ant:  degrees, positive leans the antenna outward and up
   arm:  degrees, positive swings the arm forward and up
   ========================================================================== */
const POSES = {
  /* Neutral. The artwork's own numbers. */
  idle: {
    eye: { w: 72, h: 72, r: 16, bt: 0, bb: 0, dy: 0 },
    ant: [0, 0], arm: [0, 0], lift: 0, tilt: 0, sx: 1, sy: 1,
  },
  /* Looking at the desktop: eyes narrowed tall, leaning in a touch. */
  watch: {
    eye: { w: 58, h: 84, r: 20, bt: 0, bb: 0, dy: 0 },
    ant: [7, 7], arm: [-4, -4], lift: -6, tilt: 0, sx: 1, sy: 1,
  },
  /* Working out what to do: eyes squeezed to a thoughtful line, antennae
     curled in, one arm up near where a chin would be. */
  think: {
    eye: { w: 78, h: 34, r: 15, bt: -5, bb: 0, dy: -6 },
    ant: [-15, -15], arm: [30, -8], lift: -3, tilt: 0, sx: 1, sy: 1,
  },
  /* Doing it. Businesslike: eyes a little narrowed, arms ready. */
  work: {
    eye: { w: 68, h: 60, r: 16, bt: 0, bb: 0, dy: 0 },
    ant: [5, 5], arm: [10, 10], lift: -2, tilt: 0, sx: 1, sy: 1,
  },
  /* Writing a reply. Eyes down on the line being written. */
  write: {
    eye: { w: 72, h: 44, r: 16, bt: -3, bb: 0, dy: 5 },
    ant: [3, 3], arm: [18, 18], lift: 0, tilt: 0, sx: 1, sy: 1,
  },
  /* Something needs a person: eyes wide open and round. */
  alert: {
    eye: { w: 90, h: 90, r: 45, bt: 0, bb: 0, dy: -3 },
    ant: [17, 17], arm: [4, 4], lift: -8, tilt: 0, sx: 1, sy: 1,
  },
  /* Waiting for you to take over — attentive, one arm already up. */
  ask: {
    eye: { w: 80, h: 84, r: 34, bt: 0, bb: 0, dy: -2 },
    ant: [12, 12], arm: [2, 34], lift: -5, tilt: 0, sx: 1, sy: 1,
  },
  /* Done. The bowed top and bottom edges turn the eye into a crescent. */
  happy: {
    eye: { w: 92, h: 40, r: 20, bt: -34, bb: -24, dy: 4 },
    ant: [22, 22], arm: [38, 38], lift: -6, tilt: 0, sx: 1, sy: 1,
  },
  /* It did not work. Eyes bowed the other way, antennae wilted. */
  sad: {
    eye: { w: 74, h: 48, r: 18, bt: 18, bb: 8, dy: 6 },
    ant: [-30, -30], arm: [-12, -12], lift: 5, tilt: 0, sx: 1.03, sy: 0.97,
  },
  /* On the move. Upright, eyes forward, leaning very slightly into it. */
  walk: {
    eye: { w: 66, h: 68, r: 18, bt: 0, bb: 0, dy: 0 },
    ant: [4, 4], arm: [6, 6], lift: -2, tilt: 0, sx: 1, sy: 1,
  },
  /* Paused, or stopped. Eyes shut down to a pair of slits. */
  rest: {
    eye: { w: 78, h: 14, r: 7, bt: 0, bb: 0, dy: 6 },
    ant: [-12, -12], arm: [-6, -6], lift: 3, tilt: 0, sx: 1.02, sy: 0.98,
  },
};

const lerp = (a, b, t) => a + (b - a) * t;

function lerpPose(a, b, t) {
  const ke = ['w', 'h', 'r', 'bt', 'bb', 'dy'];
  const eye = {};
  for (const k of ke) eye[k] = lerp(a.eye[k] ?? 0, b.eye[k] ?? 0, t);
  return {
    eye,
    ant: [lerp(a.ant[0], b.ant[0], t), lerp(a.ant[1], b.ant[1], t)],
    arm: [lerp(a.arm[0], b.arm[0], t), lerp(a.arm[1], b.arm[1], t)],
    lift: lerp(a.lift, b.lift, t),
    tilt: lerp(a.tilt, b.tilt, t),
    sx: lerp(a.sx, b.sx, t),
    sy: lerp(a.sy, b.sy, t),
  };
}

/* ==========================================================================
   Easing
   ========================================================================== */
const ease = {
  linear: (t) => t,
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  outBack: (t) => { const c = 1.62; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
  outQuint: (t) => 1 - (1 - t) ** 5,
};

const TAU = Math.PI * 2;
const wave = (t, period, phase = 0) => Math.sin((t / period) * TAU + phase);
/* A wave that never goes below zero — for motion that should only ever lift,
   never dip below where the character is standing. */
const up = (t, period, phase = 0) => 0.5 + 0.5 * Math.sin((t / period) * TAU + phase);

/* ==========================================================================
   Idle behaviours

   Each one writes into the frame it is handed. They are additive: a pose
   already set the antennae to +17°, an idle adds a two-degree sway on top.
   Amplitude `a` is the blend the morph layer is holding them at.
   ========================================================================== */
const IDLES = {
  /* Standing there, alive. Vertical-only breathing, full sine — a symmetric
     wave reads as breath, a half wave reads as a heartbeat. */
  breathe(t, a, f) {
    f.sy += 0.014 * a * wave(t, 4.2);
    f.sx -= 0.008 * a * wave(t, 4.2);
    f.y += -1.5 * a * up(t, 4.2);
    f.antL.rot += 1.6 * a * wave(t, 5.1);
    f.antR.rot += 1.6 * a * wave(t, 5.1, 0.7);
    f.armL.rot += 1.2 * a * wave(t, 5.6);
    f.armR.rot += 1.2 * a * wave(t, 5.6, 1.1);
  },

  /* Just arrived at a job: alert, upright, a faster breath. */
  perk(t, a, f) {
    f.y += -4 * a * up(t, 1.4);
    f.sy += 0.012 * a * wave(t, 1.4);
    f.antL.rot += 3 * a * wave(t, 1.1);
    f.antR.rot += 3 * a * wave(t, 1.1, 0.5);
  },

  /* Reading the screen. The gaze sweeps across, antennae trailing it — the
     eyes move, then the antennae catch up a beat later, which is what makes
     it look like the head turned rather than the eyes slid. */
  scan(t, a, f) {
    const s = wave(t, 3.4);
    f.gaze.x += 9 * a * s;
    f.gaze.y += 2 * a * wave(t, 2.1);
    f.antL.rot += 4 * a * wave(t, 3.4, -0.5);
    f.antR.rot += 4 * a * wave(t, 3.4, -0.5);
    f.rot += 0.9 * a * s;
    f.sy += 0.008 * a * wave(t, 3.0);
  },

  /* Thinking. The gaze wanders up and off to one side the way a person's
     does when they are working something out, the antennae droop and sweep,
     and three dots run above its head. */
  think(t, a, f) {
    f.gaze.x += 11 * a * wave(t, 5.2);
    f.gaze.y += -6 * a * up(t, 3.9);
    f.rot += 1.6 * a * wave(t, 5.2);
    f.antL.rot += 5 * a * wave(t, 2.6);
    f.antR.rot += 5 * a * wave(t, 2.6, Math.PI);
    f.sy += 0.01 * a * wave(t, 3.4);
    for (let i = 0; i < 3; i++) {
      const p = (t / 1.35 + i * 0.22) % 1;
      f.dots[i] = a * Math.max(0, Math.sin(p * Math.PI)) ** 1.6;
    }
  },

  /* Working on the desktop. A walk cycle in the feet — they are in two pairs
     and the pairs alternate, which at this size reads as purposeful bustle
     rather than as four independent legs. */
  work(t, a, f) {
    const p = 0.62;
    f.y += -3.5 * a * up(t, p / 2);
    f.sy += 0.012 * a * wave(t, p / 2);
    for (let i = 0; i < 4; i++) {
      const lead = i % 2 === 0 ? 0 : Math.PI;
      f.feet[i].y += -9 * a * Math.max(0, wave(t, p, lead));
      f.feet[i].rot += 3 * a * wave(t, p, lead);
    }
    f.armL.rot += 9 * a * wave(t, p, Math.PI);
    f.armR.rot += 9 * a * wave(t, p);
    f.antL.rot += 3 * a * wave(t, p * 2);
    f.antR.rot += 3 * a * wave(t, p * 2, 0.6);
  },

  /* Writing. Both arms tap out of phase like hands on a keyboard, the body
     ticks along with them, and the gaze runs left to right and snaps back —
     a line of text being written, at the speed a line gets written. */
  write(t, a, f) {
    const beat = 0.34;
    f.armL.rot += 13 * a * Math.max(0, wave(t, beat));
    f.armR.rot += 13 * a * Math.max(0, wave(t, beat, Math.PI));
    f.armL.y += 4 * a * Math.max(0, wave(t, beat));
    f.armR.y += 4 * a * Math.max(0, wave(t, beat, Math.PI));
    f.y += -1.6 * a * up(t, beat);
    f.sy += 0.008 * a * wave(t, beat * 2);

    const line = (t / 2.3) % 1;
    const sweep = line < 0.82 ? line / 0.82 : 1 - (line - 0.82) / 0.18;
    f.gaze.x += a * (-8 + 16 * sweep);
    f.gaze.y += 3 * a;
    f.antL.rot += 2.5 * a * wave(t, 2.3);
    f.antR.rot += 2.5 * a * wave(t, 2.3, 0.4);
  },

  /* Something needs a person. It holds still and looks at you, then gives a
     small double shake every few seconds — steady attention, punctuated,
     rather than a constant wobble you would learn to ignore. */
  alert(t, a, f) {
    f.y += -2.5 * a * up(t, 2.0);
    const cycle = 3.2;
    const p = (t % cycle) / cycle;
    if (p > 0.72) {
      const q = (p - 0.72) / 0.28;
      const damp = 1 - q;
      f.rot += 6 * a * damp * Math.sin(q * TAU * 2.2);
    }
    f.antL.rot += 2.5 * a * wave(t, 1.5);
    f.antR.rot += 2.5 * a * wave(t, 1.5, Math.PI);
  },

  /* Waving — for the moment Pico is waiting on you to say something. The
     right arm goes up and waves about the shoulder; the body leans very
     slightly away from it, as an arm that heavy would make it. */
  wave(t, a, f) {
    const swing = wave(t, 0.62);
    f.armR.rot += 46 * a + 26 * a * swing;
    f.armR.y += -10 * a;
    /* The body leans away from the raised arm, because an arm that size
       held up would in fact pull it that way. */
    f.rot += -2 * a - 1 * a * swing;
    f.y += -2.5 * a * up(t, 1.24);
    f.antR.rot += 5 * a * swing;
    f.antL.rot += 2 * a * wave(t, 1.24);
    f.sy += 0.01 * a * wave(t, 1.24);
  },

  /* A stroll.

     The difference between this and `work` is the difference between going
     somewhere and being busy: a longer stride, a deeper bob, arms swinging
     opposite the legs the way they do when nobody is carrying anything. The
     feet are two pairs and the pairs alternate — at this size four
     independent legs read as a scribble, two pairs read as walking.

     The antennae trail a beat behind the body. That lag is most of what makes
     it look like one object moving rather than several moving together. */
  stroll(t, a, f) {
    const p = 0.72;                       // one full stride
    const step = wave(t, p);
    f.y += -4.5 * a * Math.abs(wave(t, p / 2));
    f.sy += 0.016 * a * wave(t, p / 2, Math.PI);
    f.rot += 1.4 * a * step;
    for (let i = 0; i < 4; i++) {
      const lead = i % 2 === 0 ? 0 : Math.PI;
      f.feet[i].y += -13 * a * Math.max(0, wave(t, p, lead));
      f.feet[i].rot += 5 * a * wave(t, p, lead);
    }
    f.armL.rot += 15 * a * step;
    f.armR.rot += -15 * a * step;
    f.antL.rot += 6 * a * wave(t, p, -0.9);
    f.antR.rot += 6 * a * wave(t, p, -0.9);
    f.gaze.x += 3 * a * step;
  },

  /* Stopped, or paused. Barely moving — the point is that nothing is
     happening, so the idle has to look like nothing happening without
     looking like a frozen frame. */
  rest(t, a, f) {
    f.sy += 0.006 * a * wave(t, 6.5);
    f.y += 0.8 * a * up(t, 6.5);
    f.antL.rot += 0.8 * a * wave(t, 7.1);
    f.antR.rot += 0.8 * a * wave(t, 7.1, 1.3);
  },

  /* It failed. Slumped, with a slow sag that never quite recovers. */
  sink(t, a, f) {
    f.y += 2 * a * up(t, 5.0);
    f.sy -= 0.006 * a * up(t, 5.0);
    f.antL.rot += 1.2 * a * wave(t, 6.0);
    f.antR.rot += 1.2 * a * wave(t, 6.0, 1.0);
  },

  /* Pleased with itself. A light bounce that settles into breathing. */
  bounce(t, a, f) {
    f.y += -5 * a * Math.abs(wave(t, 1.1));
    f.sy += 0.02 * a * wave(t, 1.1);
    f.antL.rot += 4 * a * wave(t, 1.1);
    f.antR.rot += 4 * a * wave(t, 1.1, 0.35);
  },
};

/* ==========================================================================
   One-shots

   Layered on top of whatever idle is running. Each returns its contribution
   for a normalised time p, and is dropped when p passes 1.
   ========================================================================== */
const SHOTS = {
  /* A jump, with the crouch before it. Anticipation is what sells weight:
     without the dip first, the character does not jump, it teleports up. */
  jump(p, f) {
    if (p < 0.18) {                       // crouch
      const q = ease.sineInOut(p / 0.18);
      f.sy -= 0.11 * q; f.sx += 0.09 * q; f.y += 5 * q;
    } else if (p < 0.34) {                // push off
      const q = (p - 0.18) / 0.16;
      f.sy += 0.1 * q; f.sx -= 0.07 * q; f.y += 5 - 11 * q;
    } else if (p < 0.78) {                // in the air
      const q = (p - 0.34) / 0.44;
      const h = Math.sin(q * Math.PI);
      f.y += -6 - 62 * h;
      f.sy += 0.06 * h; f.sx -= 0.05 * h;
      f.armL.rot += 20 * h; f.armR.rot += 20 * h;
      f.antL.rot += -16 * h; f.antR.rot += -16 * h;   // antennae trail behind
    } else {                              // land
      const q = (p - 0.78) / 0.22;
      const d = (1 - q) * Math.cos(q * TAU * 1.1);
      f.sy -= 0.1 * d; f.sx += 0.08 * d; f.y += 4 * d;
    }
  },

  /* The celebration on a finished job: a bigger jump with the arms thrown up
     and a spring landing. */
  cheer(p, f) {
    const h = Math.sin(Math.min(1, p / 0.72) * Math.PI);
    if (p < 0.14) {
      const q = p / 0.14;
      f.sy -= 0.12 * q; f.sx += 0.1 * q; f.y += 6 * q;
    } else if (p < 0.82) {
      f.y += -78 * h;
      f.sy += 0.09 * h; f.sx -= 0.07 * h;
      f.armL.rot += 52 * h; f.armR.rot += 52 * h;
      f.antL.rot += 20 * h; f.antR.rot += 20 * h;
      f.rot += 4 * Math.sin(p * TAU * 1.4);
    } else {
      const q = (p - 0.82) / 0.18;
      const d = (1 - q) * Math.cos(q * TAU);
      f.sy -= 0.12 * d; f.sx += 0.1 * d;
    }
  },

  /* A refusal, or a blocked action: two quick shakes, damped. */
  nudge(p, f) {
    const d = (1 - p) ** 2;
    f.rot += 7 * d * Math.sin(p * TAU * 2.6);
    f.x += 3 * d * Math.sin(p * TAU * 2.6);
  },

  /* Acknowledgement — a small nod, used when an action lands. */
  nod(p, f) {
    const d = (1 - p);
    f.y += 5 * d * Math.sin(p * TAU * 1.5);
    f.sy -= 0.03 * d * Math.sin(p * TAU * 1.5);
  },
};

/* ==========================================================================
   Phase -> how Pico holds itself
   ========================================================================== */
const PHASE_LOOK = {
  Idle:             { pose: 'idle',  idle: 'breathe' },
  Starting:         { pose: 'watch', idle: 'perk' },
  Observing:        { pose: 'watch', idle: 'scan' },
  Thinking:         { pose: 'think', idle: 'think' },
  Acting:           { pose: 'work',  idle: 'work' },
  Paused:           { pose: 'rest',  idle: 'rest' },
  AwaitingApproval: { pose: 'alert', idle: 'alert' },
  AwaitingTakeover: { pose: 'ask',   idle: 'wave' },
  Completed:        { pose: 'happy', idle: 'bounce', shot: 'cheer' },
  Stopped:          { pose: 'rest',  idle: 'sink' },
  Failed:           { pose: 'sad',   idle: 'sink' },
};

/* Activities are what Pico is doing inside a phase — they outrank the phase's
   own idle when set. Writing a reply is not a phase; it happens while idle. */
const ACTIVITY = {
  writing:   { pose: 'write', idle: 'write' },
  waving:    { pose: 'ask',   idle: 'wave' },
  listening: { pose: 'watch', idle: 'perk' },
  walking:   { pose: 'walk',  idle: 'stroll' },
};

const MORPH_MS = 420;

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

let uid = 0;

export class Mascot {
  /**
   * @param {object} opts
   * @param {number} opts.size   rendered px
   */
  constructor({ size = 190 } = {}) {
    this.id = `pico-${++uid}`;
    this.el = document.createElement('div');
    this.el.className = 'pet';
    this.el.style.setProperty('--pet-size', `${size}px`);
    this.el.dataset.phase = 'Idle';

    this.phase = 'Idle';
    this.activity = null;
    this.hovered = false;

    // morph layer
    this.poseFrom = POSES.idle;
    this.poseTo = POSES.idle;
    this.morphStart = 0;
    this.morphMs = 0;
    this.amp = 1;            // idle amplitude, tweened by the morph
    this.ampFrom = 1;
    this.ampTo = 1;
    this.ampStart = 0;
    this.ampMs = 0;

    this.idleKind = 'breathe';
    /* Which way it is pointing, and the turn between the two.
       A turn is played through zero rather than snapped: at the halfway point
       the character is edge-on, which is what makes it read as turning round
       rather than as being replaced by its own mirror image. */
    this.facing = 1;
    this.faceFrom = 1;
    this.faceTo = 1;
    this.faceStart = 0;
    this.faceMs = 0;
    this.shots = [];
    this.blink = null;
    this.t0 = performance.now();
    this.hopAt = 0;

    this.el.append(this._halo(), this._rig());

    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this._onReduced = () => (this.reduced.matches ? this._still() : this._start());
    this.reduced.addEventListener?.('change', this._onReduced);

    this._onVisible = () => (document.hidden ? this._stop() : this._start());
    document.addEventListener('visibilitychange', this._onVisible);

    /* Being given a box is what being put into the document amounts to, as
       far as this element is concerned — so this is the wake signal for a rig
       that parked itself. It also covers the ordinary case of a mascot built
       and appended a moment later. */
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => {
        if (this.el.isConnected) { this._start(); this._scheduleBlink(); }
      });
      this._ro.observe(this.el);
    }

    this._scheduleBlink();
    if (this.reduced.matches) this._still(); else this._start();
  }

  /* --- halo --------------------------------------------------------------
     Three rings behind the character: one always breathing, one sweeping
     while a job runs, one fired per action. Unchanged in spirit from the
     first rig — it is the part that says *something is happening* at sizes
     where the character itself is only twenty pixels tall. */
  _halo() {
    const s = svg('svg', { class: 'pet__halo', viewBox: '0 0 100 100', 'aria-hidden': 'true' });
    this.haloBase = svg('circle', { class: 'halo__ring halo__base', cx: 50, cy: 50, r: 44 });
    this.haloSweep = svg('circle', {
      class: 'halo__ring halo__sweep', cx: 50, cy: 50, r: 44, 'stroke-dasharray': '40 236',
    });
    this.haloPulse = svg('circle', { class: 'halo__ring halo__pulse', cx: 50, cy: 50, r: 40 });
    s.append(this.haloBase, this.haloSweep, this.haloPulse);
    return s;
  }

  /* --- the character ----------------------------------------------------- */
  _rig() {
    const rig = document.createElement('div');
    rig.className = 'pet__rig';

    const s = svg('svg', {
      class: 'pet__char',
      viewBox: `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`,
      'aria-hidden': 'true',
    });

    const defs = svg('defs');
    /* One gradient, in the artwork's own coordinates, shared by every part.
       A gradient per part would light each one from its own top and the
       character would come apart into pieces; one gradient across the whole
       body means an arm and the shoulder it joins are the same colour where
       they meet, and Pico reads as a single moulded object. */
    const gid = `${this.id}-skin`;
    const g = svg('linearGradient', {
      id: gid, gradientUnits: 'userSpaceOnUse', x1: MID_X, y1: 120, x2: MID_X, y2: 810,
    });
    g.append(
      svg('stop', { offset: '0', 'stop-color': 'var(--pico-skin-hi, #5C9AFA)' }),
      svg('stop', { offset: '.46', 'stop-color': 'var(--pico-skin, #3B82F6)' }),
      svg('stop', { offset: '1', 'stop-color': 'var(--pico-skin-lo, #2A6AD8)' }),
    );
    defs.append(g);
    s.append(defs);

    const paint = `url(#${gid})`;
    const world = svg('g', { class: 'char' });
    this.world = world;

    // --- antennae, behind the body
    const mkAnt = (d, tip, side) => {
      const grp = svg('g', { class: 'char__ant', 'data-side': side });
      grp.append(
        svg('path', {
          class: 'ant__stem', d, fill: 'none', stroke: paint,
          'stroke-width': 15, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }),
        svg('circle', { class: 'ant__tip', cx: tip[0], cy: tip[1], r: 15, fill: paint }),
      );
      return grp;
    };
    this.antL = mkAnt(ANT_L, TIP_L, 'l');
    this.antR = mkAnt(ANT_R, TIP_R, 'r');

    // --- the three thinking dots, above the head and off unless thinking
    this.dots = [0, 1, 2].map((i) => svg('circle', {
      class: 'char__dot', cx: 462 + i * 50, cy: 118, r: 15, fill: paint, opacity: 0,
    }));
    const dotWrap = svg('g', { class: 'char__dots' });
    dotWrap.append(...this.dots);

    // --- arms
    const mkArm = (x, side) => {
      const grp = svg('g', { class: 'char__arm', 'data-side': side });
      grp.append(svg('path', { d: box(x, ARM.top, ARM.w, ARM.h, ARM.r), fill: paint }));
      return grp;
    };
    this.armL = mkArm(137, 'l');
    this.armR = mkArm(769, 'r');

    // --- body
    this.body = svg('path', {
      class: 'char__body', d: box(BODY.x, BODY.y, BODY.w, BODY.h, BODY.r), fill: paint,
    });

    // --- eyes, each in its own group so a blink can squash the eye and its
    //     highlight together without disturbing the shared gaze offset
    const mkEye = (centre, side) => {
      const grp = svg('g', { class: 'char__eye', 'data-side': side });
      const p = svg('path', { class: 'eye__iris', fill: 'var(--pico-eye, #0F172A)' });
      const spec = svg('circle', {
        class: 'eye__spec', cx: centre[0] - 15, cy: centre[1] - 16, r: 10,
        fill: '#ffffff', opacity: 0.16,
      });
      grp.append(p, spec);
      return { grp, p, spec };
    };
    this.eyeL = mkEye(EYE.l, 'l');
    this.eyeR = mkEye(EYE.r, 'r');
    this.face = svg('g', { class: 'char__face' });
    this.face.append(this.eyeL.grp, this.eyeR.grp);

    // --- feet
    this.feet = FEET_X.map((x, i) => {
      const grp = svg('g', { class: 'char__foot', 'data-i': i });
      grp.append(svg('path', {
        d: box(x, FOOT.top, FOOT.w, FOOT.h, [0, 0, FOOT.r, FOOT.r]), fill: paint,
      }));
      return grp;
    });
    const feetWrap = svg('g', { class: 'char__feet' });
    feetWrap.append(...this.feet);

    world.append(dotWrap, this.antL, this.antR, this.armL, this.armR,
      this.body, feetWrap, this.face);
    s.append(world);
    rig.append(s);

    this.paint(0);
    return rig;
  }

  /* ==========================================================================
     The loop
     ========================================================================== */
  _start() {
    if (this.raf || this.dead || this.reduced.matches || document.hidden) return;
    const tick = (now) => {
      /* A rig whose element has left the document is a rig nobody can see,
         and a frame loop nobody can see is a leak that grows: app.js builds a
         whole empty state, mascot included, every time a section re-renders,
         and drops the previous one on the floor. The loop parks itself here;
         the observer below wakes it if the element is ever put back. */
      /* Off the page, or on it inside something hidden — a panel that is
         display:none is every bit as invisible as a detached node, and the
         island keeps its whole panel that way whenever it is not open. */
      const seen = this.el.isConnected
        && (typeof this.el.checkVisibility === 'function' ? this.el.checkVisibility() : true);
      if (!seen) { this._stop(); return; }
      this.raf = requestAnimationFrame(tick);
      this.paint((now - this.t0) / 1000);
    };
    this.raf = requestAnimationFrame(tick);
  }

  _stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Reduced motion: the pose still reads, it simply does not move. */
  _still() {
    this._stop();
    this.poseFrom = this.poseTo;
    this.morphMs = 0;
    this.shots.length = 0;
    this.blink = null;
    this.paint(0, 0);
  }

  /**
   * One frame. Everything the rig does converges here: the pose is resolved,
   * the idle adds to it, one-shots add to that, and the result is written
   * out. Nothing else in the class touches the DOM.
   *
   * @param {number} t     seconds since the rig started
   * @param {number} [amp] override the idle amplitude (0 for a static paint)
   */
  paint(t, amp) {
    const now = t * 1000 + this.t0;

    // --- morph layer
    let pose = this.poseTo;
    if (this.morphMs > 0) {
      const p = Math.max(0, Math.min(1, (now - this.morphStart) / this.morphMs));
      pose = lerpPose(this.poseFrom, this.poseTo, ease.outQuint(p));
      if (p >= 1) { this.morphMs = 0; this.poseFrom = this.poseTo; }
    }

    // --- idle amplitude, tweened rather than the timeline being restarted
    if (this.ampMs > 0) {
      const p = Math.max(0, Math.min(1, (now - this.ampStart) / this.ampMs));
      this.amp = lerp(this.ampFrom, this.ampTo, ease.sineInOut(p));
      if (p >= 1) this.ampMs = 0;
    }
    const a = amp === undefined ? this.amp : amp;

    // --- which way round it is
    if (this.faceMs > 0) {
      const p = Math.max(0, Math.min(1, (now - this.faceStart) / this.faceMs));
      this.facing = lerp(this.faceFrom, this.faceTo, ease.inOutQuad(p));
      if (p >= 1) { this.faceMs = 0; this.facing = this.faceTo; }
    }

    // --- the frame every layer writes into
    const f = {
      x: 0, y: pose.lift, rot: pose.tilt, sx: pose.sx, sy: pose.sy,
      /* Every limb's `rot` is a *lift*: positive raises it, whichever side
         it is on. The mirroring into screen rotation happens once, in
         _write. Without that, the left arm and the right arm need opposite
         signs for the same gesture and every idle below has to remember
         which is which — which is exactly how a wave ends up waving
         downward. */
      antL: { rot: pose.ant[0], y: 0 },
      antR: { rot: pose.ant[1], y: 0 },
      armL: { rot: pose.arm[0], y: 0 },
      armR: { rot: pose.arm[1], y: 0 },
      feet: [0, 1, 2, 3].map(() => ({ y: 0, rot: 0 })),
      gaze: { x: 0, y: 0 },
      dots: [0, 0, 0],
      eyeSquash: 1,
    };

    const idle = IDLES[this.idleKind] || IDLES.breathe;
    if (a > 0.001) idle(t, a, f);

    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const p = (now - s.start) / s.ms;
      if (p >= 1) { this.shots.splice(i, 1); continue; }
      SHOTS[s.kind]?.(Math.max(0, p), f);
    }

    if (this.blink) {
      const p = (now - this.blink.start) / this.blink.ms;
      if (p >= 1) this.blink = null;
      else {
        // down fast, up a little slower — a real eyelid is not symmetric
        const q = p < 0.42 ? p / 0.42 : 1 - (p - 0.42) / 0.58;
        f.eyeSquash = 1 - 0.94 * ease.sineInOut(Math.max(0, Math.min(1, q)));
      }
    }

    this._write(pose, f);
  }

  _write(pose, f) {
    /* Facing is a horizontal flip of the whole character about its own
       centre line, so it composes with everything else rather than being a
       separate concept any of the idles have to know about. A walk cycle
       looks identical in both directions; only the direction changes. */
    this.world.setAttribute('transform', tf({
      x: f.x * this.facing, y: f.y, rot: f.rot * this.facing,
      sx: f.sx * this.facing, sy: f.sy, px: MID_X, py: FOOT_Y,
    }));

    /* Lift becomes screen rotation here, and only here. On a left-hand limb
       a clockwise turn raises the far end; on a right-hand one it lowers it,
       so the right side takes the negative. */
    this.antL.setAttribute('transform', tf({
      y: f.antL.y, rot: f.antL.rot, px: JOINT.antL[0], py: JOINT.antL[1],
    }));
    this.antR.setAttribute('transform', tf({
      y: f.antR.y, rot: -f.antR.rot, px: JOINT.antR[0], py: JOINT.antR[1],
    }));

    this.armL.setAttribute('transform', tf({
      y: f.armL.y, rot: f.armL.rot, px: JOINT.armL[0], py: JOINT.armL[1],
    }));
    this.armR.setAttribute('transform', tf({
      y: f.armR.y, rot: -f.armR.rot, px: JOINT.armR[0], py: JOINT.armR[1],
    }));

    for (let i = 0; i < 4; i++) {
      const g = f.feet[i];
      this.feet[i].setAttribute('transform', tf({
        y: g.y, rot: g.rot, px: FEET_X[i] + FOOT.w / 2, py: FOOT.top,
      }));
    }

    /* Eyes travel together. Moving one without the other reads as the face
       coming apart, so the gaze offset is on the group and never on an eye. */
    this.face.setAttribute('transform', tf({ x: f.gaze.x, y: f.gaze.y }));

    const d = pose.eye;
    this.eyeL.p.setAttribute('d', eyePath(EYE.l, d));
    this.eyeR.p.setAttribute('d', eyePath(EYE.r, d));

    /* The highlight is a real specular: it belongs on a round eye and has no
       business on a slit, so it fades out as the eye closes. */
    const lit = Math.max(0, Math.min(1, (d.h - 18) / 44)) * f.eyeSquash;
    const specOp = 0.18 * lit;
    this.eyeL.spec.setAttribute('opacity', r2(specOp));
    this.eyeR.spec.setAttribute('opacity', r2(specOp));

    const sq = (eye, centre) => eye.grp.setAttribute('transform',
      tf({ sy: f.eyeSquash, px: centre[0], py: centre[1] + (d.dy || 0) }));
    sq(this.eyeL, EYE.l);
    sq(this.eyeR, EYE.r);

    for (let i = 0; i < 3; i++) this.dots[i].setAttribute('opacity', r2(f.dots[i]));
  }

  /* ==========================================================================
     What the rest of the interface says to it
     ========================================================================== */

  /** Move to a pose, and turn the idle down and back up around the move. */
  _to(poseName, idleKind, ms = MORPH_MS) {
    const next = POSES[poseName] || POSES.idle;
    if (next !== this.poseTo) {
      // Start from where it actually is, not from where the last morph was
      // headed — an interrupted move must hand over its current shape.
      const now = performance.now();
      if (this.morphMs > 0) {
        const p = Math.min(1, (now - this.morphStart) / this.morphMs);
        this.poseFrom = lerpPose(this.poseFrom, this.poseTo, ease.outQuint(p));
      } else {
        this.poseFrom = this.poseTo;
      }
      this.poseTo = next;
      this.morphStart = now;
      this.morphMs = ms;

      /* Down to a tenth over the first 40% of the move, back up over the
         last 40%. Not to zero: a character that stops dead mid-change reads
         as a dropped frame. Not to a third either — at a third the idle
         competes with the change it is supposed to be getting out of. */
      this._rampAmp(0.1, ms * 0.4);
      clearTimeout(this._ampUp);
      this._ampUp = setTimeout(() => this._rampAmp(1, ms * 0.4), ms * 0.6);
    }
    if (idleKind && idleKind !== this.idleKind) this.idleKind = idleKind;
  }

  _rampAmp(to, ms) {
    this.ampFrom = this.amp;
    this.ampTo = to;
    this.ampStart = performance.now();
    this.ampMs = Math.max(1, ms);
  }

  /** The current look, resolving activity over phase over hover. */
  _resolve() {
    const act = this.activity ? ACTIVITY[this.activity] : null;
    const look = act || PHASE_LOOK[this.phase] || PHASE_LOOK.Idle;
    this._to(look.pose, look.idle);
  }

  setPhase(phase) {
    if (phase === this.phase) return;
    const prev = this.phase;
    this.phase = phase;
    this.el.dataset.phase = phase;

    // A finished job earns a one-off celebration; a new job clears one.
    const look = PHASE_LOOK[phase];
    if (look?.shot && prev !== phase) this.fire(look.shot, 900);

    this._resolve();
  }

  /**
   * What Pico is doing inside the phase — 'writing' while a reply streams,
   * 'waving' while it waits on you, null to go back to the phase's own idle.
   */
  setActivity(name) {
    const next = name && ACTIVITY[name] ? name : null;
    if (next === this.activity) return;
    this.activity = next;
    this._resolve();
  }

  /**
   * The pointer is on the mascot itself.
   *
   * Only on the mascot: the island reacting to a pointer anywhere along its
   * width used to change what the character was doing, so passing over the
   * island on the way somewhere else interrupted whatever Pico was in the
   * middle of. Hovering Pico is a separate, smaller thing, and it is the
   * only thing that makes it hop.
   */
  setHover(on) {
    if (on === this.hovered) return;
    this.hovered = on;
    this.el.dataset.hover = String(on);
    if (on) {
      this.jump();
      this.blinkNow();
    }
  }

  /**
   * Turn to face left (-1) or right (1).
   *
   * Instant on the first call, so a character placed facing left does not
   * spin round on arrival; a turn after that is played through edge-on.
   */
  setFacing(dir) {
    const next = dir < 0 ? -1 : 1;
    if (next === this.faceTo) return;
    this.faceFrom = this.faceMs > 0 ? this.facing : this.faceTo;
    this.faceTo = next;
    this.faceStart = performance.now();
    this.faceMs = 190;
    this._start();
  }

  /** A jump. Hopping on a loop while hovered is handled by the caller's
      pointer events; this is one hop, with its crouch and its landing. */
  jump() { this.fire('jump', 760); }

  /** Thrown-up arms and a spring landing. */
  cheer() { this.fire('cheer', 980); }

  /** Two quick shakes — a refusal, or an action that could not be taken. */
  nudge() { this.fire('nudge', 460); }

  fire(kind, ms) {
    if (!SHOTS[kind] || this.reduced.matches) return;
    const now = performance.now();
    // A hop asked for while one is already running just restarts it, rather
    // than stacking two jumps into one enormous leap.
    const at = this.shots.findIndex((s) => s.kind === kind);
    if (at >= 0) this.shots.splice(at, 1);
    this.shots.push({ kind, ms, start: now });
    this._start();
  }

  /** A single expanding halo ring — one per executed action. */
  pulse() {
    const r = this.haloPulse;
    r.classList.remove('is-pulsing');
    void r.getBoundingClientRect();     // force reflow so the animation restarts
    r.classList.add('is-pulsing');
    this.fire('nod', 520);
  }

  // --- blinking ------------------------------------------------------------
  _scheduleBlink() {
    clearTimeout(this._blinkTimer);
    if (this.dead) return;
    this._blinkTimer = setTimeout(() => {
      // Parked along with the frame loop; see _start.
      if (!this.el.isConnected) return;
      this.blinkNow();
      this._scheduleBlink();
    }, 2400 + Math.random() * 4400);
  }

  blinkNow() {
    // Nothing to close when the eyes are already a crescent or a slit.
    if (this.dead || this.reduced.matches || this.poseTo.eye.h < 30) return;
    if (this.blink) return;
    this.blink = { start: performance.now(), ms: 170 };
    // Two in a row now and then, because a perfectly regular blink is the one
    // thing that reads as mechanical rather than alive.
    if (Math.random() < 0.22) {
      setTimeout(() => { if (this.dead) return; this.blink = null; this.blinkNow(); }, 250);
    }
  }

  destroy() {
    this.dead = true;
    this._stop();
    clearTimeout(this._blinkTimer);
    clearTimeout(this._ampUp);
    this._ro?.disconnect();
    this.reduced.removeEventListener?.('change', this._onReduced);
    document.removeEventListener('visibilitychange', this._onVisible);
    this.el.remove();
  }
}
