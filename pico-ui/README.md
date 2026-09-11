# Pico UI

A redesign of Pico's interface: a glass command palette on `Ctrl+Shift+P`, an
expressive animated companion, and real approval / takeover / activity surfaces.

Framework-free ES modules and CSS. No build step, no dependencies.

## Run it

```bash
node pico-ui/dev-server.mjs
```

Then open <http://localhost:4173>.

ES modules need `http://` — opening `index.html` from disk will not work.

| Page | What it is |
| --- | --- |
| `/` | Development harness: fake desktop, companion, palette, and a control deck that can drive every state |
| `/companion.html` | The companion surface on its own (WebView2 target #1) |
| `/palette.html` | The palette on its own (WebView2 target #2) |

## Try these

- Press **`Ctrl+Shift+P`**, type `send the weekly email`, press `Enter` — routes
  into the approval flow.
- Type `log in to my account` — routes into the takeover flow.
- Hit **Replay the real held-modifier bug** in the control deck. This replays the
  logged 11:24:37–11:24:43 session where three resume presses were silently
  re-paused. Hold `Ctrl+Shift` yourself during a run to reproduce it live.
- With a run active, press `Esc`. The palette stays open and flashes the hint,
  because `Esc` is the Guardian's emergency stop and must not be swallowed.
- Toggle **Guardian: ready** off to see task submission gated with a reason.

## Shape

```
companion.html   palette.html   index.html (harness)
                      │
        ┌─────────────┴─────────────┐
   src/bridge.js  ←──────────────→  mock/agent.js   (or WebView2 in production)
        │
   src/store.js          phase machine + the app's real copy
        ├── mascot.js    SVG face rig over the shipped pico.png
        ├── companion.js overlay surface
        ├── palette.js   command palette
        ├── cards.js     approval / takeover / error
        ├── settings.js  model, safety, API key
        ├── timeline.js  live audit events (+ redaction guard)
        └── hotkeys.js   chord handling
```

`src/bridge.js` is the only file that knows how the UI is driven. Swap
`LocalTransport` for `WebView2Transport` and nothing above it changes — see
[INTEGRATION.md](INTEGRATION.md).

## Design notes

**Phase is colour.** One `--accent` token per phase re-tints the halo, the
mascot's face screen, the palette edge and the timeline dots together, so state
is legible from peripheral vision. Idle slate → Observing cyan → Thinking violet
→ Acting green → Paused amber → Approval orange → Takeover blue → Failed red.

**The mascot's face is a screen, so we repaint it.** The shipped `pico.png`
draws a glowing display for a face. `src/mascot.js` overlays an SVG at the
measured screen rect (33.09% / 36.52% / 33.97% / 22.49% of the asset) and draws
its own eyes and mouth, which means expression and colour are fully animatable
without any new artwork. Eyes are rects so `width`/`height`/`rx` can be
CSS-transitioned; the mouth is a single `Q` curve so its `d` can morph.

**Paused freezes the loop mid-pose** rather than swapping to a "paused" look —
the strongest available signal that nothing is moving.

**The timeline renders an allowlist**, never the raw event. Typed text,
coordinates and screenshots cannot reach the DOM even if a host sends them;
`assertSafeEvent` enforces this in tests.

**Reduced motion is a first-class path.** States that normally rely on an
animation loop hold a static equivalent under `prefers-reduced-motion: reduce`,
so no phase becomes ambiguous.

## Not shipped

`index.html`, `src/harness.css` and `mock/` are development only.

`mock/audit-sample.jsonl` is a copy of a real 106-event log with session,
response and call identifiers replaced by stable pseudonyms.

`assets/pico.png` was extracted from `Pico.exe` so this runs standalone; replace
it with the project's own asset when integrating.
