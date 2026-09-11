/* ==========================================================================
   Pico — agent cursors

   WHY THESE ARE DRAWN, NOT REAL
   Windows has exactly one system pointer. Software cannot add a second OS
   mouse that existing apps treat as real — so "multiple cursors" can only mean
   multiple *drawn* cursors, each backed by an agent that dispatches input
   without moving the physical pointer.

   That is not a compromise, it is the better design:
     - the physical mouse stays yours while agents work
     - several agents can act at once, because none of them owns the pointer
     - movement is interpolated here at display rate, so it is smooth and
       readable instead of teleporting between coordinates

   For a browser target this maps onto CDP `Input.dispatchMouseEvent`, which
   delivers real events to the page without touching the OS cursor. For native
   windows only one agent can hold the real pointer at a time; the rest stay
   queued. See bridge/README.md.
   ========================================================================== */

/* Distinct hues, ordered so the first few are maximally distinguishable. */
export const AGENT_COLORS = [
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#4ade80', // green
  '#fb7185', // rose
  '#60a5fa', // blue
];

export const AGENT_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];

const svgNS = 'http://www.w3.org/2000/svg';

/** Ease that starts fast and settles — reads as intent, not a linear slide. */
const easeOutQuint = (t) => 1 - (1 - t) ** 5;

/**
 * One drawn cursor. Owns its own DOM node and animation loop.
 */
export class AgentCursor {
  constructor({ id, index, label, color, layer }) {
    this.id = id;
    this.index = index;
    this.label = label ?? AGENT_NAMES[index % AGENT_NAMES.length];
    this.color = color ?? AGENT_COLORS[index % AGENT_COLORS.length];

    this.x = window.innerWidth / 2;
    this.y = window.innerHeight / 2;
    this.visible = false;
    this._raf = null;

    this.el = this._build();
    layer.append(this.el);
    this._apply();
  }

  _build() {
    const wrap = document.createElement('div');
    wrap.className = 'cursor';
    wrap.style.setProperty('--cursor-color', this.color);
    wrap.dataset.agent = this.id;

    // A pointer that reads as software, not the OS arrow.
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'cursor__glyph');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    const shadow = document.createElementNS(svgNS, 'path');
    shadow.setAttribute('class', 'cursor__shadow');
    shadow.setAttribute('d', 'M5 2.5 19 11.2l-6.1 1.4-3.1 5.7z');

    const body = document.createElementNS(svgNS, 'path');
    body.setAttribute('class', 'cursor__body');
    body.setAttribute('d', 'M5 2.5 19 11.2l-6.1 1.4-3.1 5.7z');

    svg.append(shadow, body);

    const tag = document.createElement('span');
    tag.className = 'cursor__tag';
    tag.textContent = this.label;

    const ring = document.createElement('span');
    ring.className = 'cursor__ring';

    wrap.append(ring, svg, tag);
    this.ring = ring;
    return wrap;
  }

  _apply() {
    // translate3d keeps this on the compositor — no layout on every frame.
    this.el.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
  }

  show(on = true) {
    this.visible = on;
    this.el.dataset.visible = String(on);
  }

  setState(state) { this.el.dataset.state = state; }

  setLabel(label) {
    this.label = label;
    this.el.querySelector('.cursor__tag').textContent = label;
  }

  /**
   * Glide to a point over `duration` ms, animating every frame.
   * Resolves when it arrives. Cancels any move already running.
   */
  moveTo(x, y, duration = 520) {
    cancelAnimationFrame(this._raf);
    const fromX = this.x;
    const fromY = this.y;
    const dx = x - fromX;
    const dy = y - fromY;
    const dist = Math.hypot(dx, dy);

    // Scale time with distance so short hops don't crawl and long ones don't blur.
    const ms = Math.max(160, Math.min(duration, 180 + dist * 0.9));

    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / ms);
        const e = easeOutQuint(p);
        this.x = fromX + dx * e;
        this.y = fromY + dy * e;
        this._apply();
        if (p < 1) { this._raf = requestAnimationFrame(tick); return; }
        resolve();
      };
      this._raf = requestAnimationFrame(tick);
    });
  }

  /** Visual click: a ring pulse at the current point. */
  click() {
    this.ring.classList.remove('is-clicking');
    void this.ring.getBoundingClientRect();
    this.ring.classList.add('is-clicking');
    this.setState('click');
    setTimeout(() => this.setState('idle'), 220);
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this.el.remove();
  }
}

/**
 * Holds the set of cursors and the layer they draw into.
 */
export class CursorLayer {
  constructor(host = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'cursor-layer';
    host.append(this.el);
    this.cursors = new Map();
  }

  ensure(count) {
    // add
    for (let i = this.cursors.size; i < count; i++) {
      const id = `agent-${i}`;
      this.cursors.set(id, new AgentCursor({ id, index: i, layer: this.el }));
    }
    // remove from the end
    for (let i = this.cursors.size - 1; i >= count; i--) {
      const id = `agent-${i}`;
      this.cursors.get(id)?.destroy();
      this.cursors.delete(id);
    }
    return [...this.cursors.values()];
  }

  get(id) { return this.cursors.get(id); }
  all() { return [...this.cursors.values()]; }

  showAll(on) { for (const c of this.cursors.values()) c.show(on); }

  destroy() {
    for (const c of this.cursors.values()) c.destroy();
    this.cursors.clear();
    this.el.remove();
  }
}
