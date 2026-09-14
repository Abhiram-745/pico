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
        ├── mascot.js    the character — drawn, posed and animated in SVG
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
palette edge and the timeline dots together, so state is legible from
peripheral vision. Idle slate → Observing cyan → Thinking violet → Acting green
→ Paused amber → Approval orange → Takeover blue → Failed red.

**The mascot is generated, not loaded.** `src/mascot.js` draws Pico — body,
antennae, arms, four feet, two eyes — from geometry rather than from artwork.
Every solid part is emitted by one generator as eight cubic segments in a fixed
order, so two poses of the same part differ only in their numbers and the way
between them is a straight interpolation of those numbers. Nothing is ever
polygon-sampled, which is what a morph library would do and what wrecks bezier
curves and round corners halfway through a transition. The consequence worth
knowing: a new expression is a row of numbers in `POSES`, not a new file.

**Only the eyes change shape.** They are the entire face, so they carry the
expression: a bowed top and bottom edge turns a rounded box into a crescent for
*done*, and the other way for *failed*. Everything else is rigid and moves by
transform — antennae about their base, arms about the shoulder, feet about
where they meet the body, the whole character about the point it stands on.
Limbs that rotate about their own joint read as anatomy; the same limbs
squashed by a whole-body scale read as jelly.

**Two layers, and the idle layer never stops.** The morph layer is the change
from one pose to the next. The idle layer is breathing, blinking, glancing
about, the walk while it works, the typing while it writes, the wave while it
waits on you. During a pose change the idle is turned down to a tenth over 40%
of the transition and brought back over the last 40% — not killed, because a
character that freezes for the length of every transition reads as a machine,
and not left at full strength, because then it competes with the change it is
supposed to be getting out of the way of.

**Hovering Pico and hovering the thing Pico sits in are different gestures.**
The island widens when the pointer is anywhere on it; the character hops only
when the pointer is on the character. They used to be the same event, which
meant crossing the island on the way somewhere else set it bouncing — and,
because the hop was a CSS animation swapped in by the hovered state, arriving
on the island stopped whatever Pico was in the middle of.

**Paused drains the colour rather than stopping the motion.** A still frame is
indistinguishable from a hung interface; a character that is plainly alive and
plainly not working is not.

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

`mascot.html` is a harness for the character rig: every pose, activity and
one-shot, at every size the app renders the mascot at, against every background
it has to read on.

`assets/pico.png` is no longer the mascot — the rig draws it. The file stays
because `bridge/server.mjs` uses it as the art for the drawn cursors.
