/* ==========================================================================
   Pico — mascot rig

   The shipped pico.png draws a navy body with a *glowing screen* for a face.
   That screen is the whole opportunity: we repaint it with our own SVG, so
   the character can change colour and expression per phase without needing
   a single new frame of artwork.

   Geometry below is measured from the real asset (1254x1254):
     screen rect  x 415-840, y 458-739     -> local viewBox 0 0 426 282
     left  eye    x  77-139, y  89-201     -> capsule ~63 x 113
     right eye    x 276-342, y  76-192     -> capsule ~67 x 117
   The shipped eyes sit slightly off-axis (the art is rendered in 3/4
   perspective). We centre them, because a symmetric rig animates cleanly and
   the difference is sub-pixel at companion size.
   ========================================================================== */

const VB_W = 426;
const VB_H = 282;
const CX = VB_W / 2;   // 213
const CY = VB_H / 2;   // 141

/* The screen is a superellipse, not a rounded rect. Fitting |x/a|^n+|y/b|^n=1
   against the measured edge profile gives n ≈ 2.35 with a=213, b=141. */
const SUPERELLIPSE_N = 2.35;

function superellipsePath(a, b, n, steps = 128) {
  const p = 2 / n;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const x = CX + a * Math.sign(ct) * Math.abs(ct) ** p;
    const y = CY + b * Math.sign(st) * Math.abs(st) ** p;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

const SCREEN_PATH = superellipsePath(213, 141, SUPERELLIPSE_N);

/* --------------------------------------------------------------------------
   Expressions

   Eyes are rects so that width/height/rx/y can be CSS-transitioned (SVG2
   geometry properties, supported in Chromium and therefore in WebView2).
   The mouth is always `M x y Q cx cy x y` so its `d` can morph too.
   -------------------------------------------------------------------------- */
const EYE_X_OFFSET = 101;  // eye centre distance from screen centre

const expressions = {
  Idle:             { w: 64, h: 114, rx: 32, dy:   0, mouth: 'smile',  look: [0, 0] },
  Starting:         { w: 60, h: 100, rx: 30, dy:   0, mouth: 'smile',  look: [0, 0] },
  Observing:        { w: 48, h: 118, rx: 24, dy:   0, mouth: 'flat',   look: [0, 6] },
  Thinking:         { w: 58, h:  74, rx: 29, dy:  10, mouth: 'flat',   look: [0, 0] },
  Acting:           { w: 56, h:  98, rx: 28, dy:   0, mouth: 'smile',  look: [0, 2] },
  Paused:           { w: 66, h:  22, rx: 11, dy:  16, mouth: 'flat',   look: [0, 0] },
  AwaitingApproval: { w: 82, h:  82, rx: 41, dy:  -4, mouth: 'open',   look: [0, 0] },
  AwaitingTakeover: { w: 74, h:  96, rx: 37, dy:  -2, mouth: 'smile',  look: [0, 0] },
  Completed:        { w: 64, h:  64, rx: 32, dy:   4, mouth: 'grin',   look: [0, 0], happy: true },
  Stopped:          { w: 64, h:  40, rx: 20, dy:  12, mouth: 'flat',   look: [0, 0] },
  Failed:           { w: 62, h:  52, rx: 26, dy:  14, mouth: 'frown',  look: [0, 0], sad: true },
};

const MOUTHS = {
  smile: 'M190 189 Q213 209 236 189',
  flat:  'M190 196 Q213 196 236 196',
  open:  'M196 190 Q213 210 230 190',
  grin:  'M180 184 Q213 218 246 184',
  frown: 'M190 205 Q213 185 236 205',
};

const svg = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

let uid = 0;

export class Mascot {
  /**
   * @param {object}  opts
   * @param {string}  opts.src   path to pico.png
   * @param {number}  opts.size  rendered px
   */
  constructor({ src = 'assets/pico.png', size = 190 } = {}) {
    this.id = `pico-${++uid}`;
    this.el = document.createElement('div');
    this.el.className = 'pet';
    this.el.style.setProperty('--pet-size', `${size}px`);
    this.el.dataset.phase = 'Idle';

    this.el.append(this._buildHalo(), this._buildRig(src));
    this._scheduleBlink();
  }

  // --- halo ----------------------------------------------------------------
  _buildHalo() {
    const s = svg('svg', { class: 'pet__halo', viewBox: '0 0 100 100', 'aria-hidden': 'true' });

    this.haloBase = svg('circle', { class: 'halo__ring halo__base', cx: 50, cy: 50, r: 44 });

    // circumference at r=44 is ~276; a 40u dash reads as a moving arc
    this.haloSweep = svg('circle', {
      class: 'halo__ring halo__sweep', cx: 50, cy: 50, r: 44,
      'stroke-dasharray': '40 236',
    });

    this.haloPulse = svg('circle', { class: 'halo__ring halo__pulse', cx: 50, cy: 50, r: 40 });

    s.append(this.haloBase, this.haloSweep, this.haloPulse);
    return s;
  }

  // --- body + face ---------------------------------------------------------
  _buildRig(src) {
    const rig = document.createElement('div');
    rig.className = 'pet__rig';

    const body = document.createElement('img');
    body.className = 'pet__body';
    body.src = src;
    body.alt = '';
    body.draggable = false;

    const dot = document.createElement('div');
    dot.className = 'pet__dot';

    rig.append(body, this._buildFace(), dot);
    return rig;
  }

  _buildFace() {
    const gradId = `${this.id}-grad`;
    const s = svg('svg', {
      class: 'pet__face',
      viewBox: `0 0 ${VB_W} ${VB_H}`,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
    });

    const defs = svg('defs');
    const grad = svg('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.append(
      svg('stop', { offset: '0',   'stop-color': 'var(--screen-a)' }),
      svg('stop', { offset: '1',   'stop-color': 'var(--screen-b)' }),
    );

    // Clip so the scanline and glow stay inside the physical screen bezel
    const clip = svg('clipPath', { id: `${this.id}-clip` });
    clip.append(svg('path', { d: SCREEN_PATH }));
    defs.append(grad, clip);

    // Soft bloom behind the screen
    const glow = svg('path', { class: 'face__glow', d: SCREEN_PATH, fill: `url(#${gradId})` });

    const screen = svg('path', { class: 'face__screen', d: SCREEN_PATH, fill: `url(#${gradId})` });
    screen.style.fill = `url(#${gradId})`;

    // Everything from here up is clipped to the screen
    const inner = svg('g', { 'clip-path': `url(#${this.id}-clip)` });

    this.scan = svg('rect', {
      class: 'face__scan', x: 0, y: CY - 3, width: VB_W, height: 6, fill: '#ffffff',
    });

    this.eyes = svg('g', { class: 'face__eyes' });
    this.eyeL = svg('rect', { class: 'face__feature face__eye' });
    this.eyeR = svg('rect', { class: 'face__feature face__eye' });

    // Alternate eye shapes that a rect cannot express
    this.eyeHappyL = svg('path', { class: 'face__feature face__eye-alt', fill: 'none', 'stroke-width': 16, 'stroke-linecap': 'round', opacity: 0 });
    this.eyeHappyR = svg('path', { class: 'face__feature face__eye-alt', fill: 'none', 'stroke-width': 16, 'stroke-linecap': 'round', opacity: 0 });
    for (const e of [this.eyeHappyL, this.eyeHappyR]) e.style.stroke = '#fdfff5';

    this.eyeHappyL.setAttribute('d', `M${CX - EYE_X_OFFSET - 30} ${CY + 14} Q${CX - EYE_X_OFFSET} ${CY - 26} ${CX - EYE_X_OFFSET + 30} ${CY + 14}`);
    this.eyeHappyR.setAttribute('d', `M${CX + EYE_X_OFFSET - 30} ${CY + 14} Q${CX + EYE_X_OFFSET} ${CY - 26} ${CX + EYE_X_OFFSET + 30} ${CY + 14}`);

    this.eyes.append(this.eyeL, this.eyeR, this.eyeHappyL, this.eyeHappyR);

    this.mouth = svg('path', {
      class: 'face__feature face__mouth', d: MOUTHS.smile,
      fill: 'none', 'stroke-width': 11, 'stroke-linecap': 'round',
    });
    this.mouth.style.stroke = '#fdfff5';

    inner.append(this.scan, this.eyes, this.mouth);
    s.append(defs, glow, screen, inner);

    this.applyExpression('Idle');
    return s;
  }

  // --- expression ----------------------------------------------------------
  applyExpression(phase) {
    const e = expressions[phase] || expressions.Idle;

    const place = (el, cx) => {
      el.setAttribute('x', cx - e.w / 2);
      el.setAttribute('y', CY - e.h / 2 + e.dy);
      el.setAttribute('width', e.w);
      el.setAttribute('height', e.h);
      el.setAttribute('rx', e.rx);
      el.setAttribute('ry', Math.min(e.rx, e.h / 2));
    };
    place(this.eyeL, CX - EYE_X_OFFSET);
    place(this.eyeR, CX + EYE_X_OFFSET);

    // Happy arcs replace the rect eyes on completion
    const happy = !!e.happy;
    this.eyeHappyL.setAttribute('opacity', happy ? 1 : 0);
    this.eyeHappyR.setAttribute('opacity', happy ? 1 : 0);
    this.eyeL.setAttribute('opacity', happy ? 0 : 1);
    this.eyeR.setAttribute('opacity', happy ? 0 : 1);

    // A slumped brow angle sells the failure state
    const tilt = e.sad ? 8 : 0;
    this.eyeL.style.transform = tilt ? `rotate(${tilt}deg)` : '';
    this.eyeR.style.transform = tilt ? `rotate(${-tilt}deg)` : '';

    this.mouth.setAttribute('d', MOUTHS[e.mouth] || MOUTHS.smile);
    this.eyes.style.transform = `translate(${e.look[0]}px, ${e.look[1]}px)`;

    this._blinkable = !happy && !e.sad && e.h > 40;
  }

  setPhase(phase) {
    this.el.dataset.phase = phase;
    this.applyExpression(phase);
  }

  /** Fire a single expanding ring — one per executed action. */
  pulse() {
    const r = this.haloPulse;
    r.classList.remove('is-pulsing');
    void r.getBoundingClientRect(); // force reflow so the animation restarts
    r.classList.add('is-pulsing');
  }

  // --- idle blinking -------------------------------------------------------
  _scheduleBlink() {
    const next = 2600 + Math.random() * 4200;
    this._blinkTimer = setTimeout(() => {
      this._blink();
      this._scheduleBlink();
    }, next);
  }

  _blink() {
    if (!this._blinkable) return;
    for (const eye of [this.eyeL, this.eyeR]) {
      eye.classList.remove('is-blinking');
      void eye.getBoundingClientRect();
      eye.classList.add('is-blinking');
    }
    // occasional double blink reads as alive rather than mechanical
    if (Math.random() < 0.22) setTimeout(() => this._blink(), 260);
  }

  destroy() {
    clearTimeout(this._blinkTimer);
    this.el.remove();
  }
}
