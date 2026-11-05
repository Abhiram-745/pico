# Titanium action icons

30 original action silhouettes, transparent RGBA PNGs: `name.png` is 24×24,
`name@2x.png` is 48×48, and `name@4x.png` is a 96×96 review master.
Neutral cool titanium, directional studio reflections and distance-derived
bevels give the silhouettes depth without tiles, logos or background shadows.
Check/shield have restrained cool accents; bolt/alert have warm accents.
These are fixed-color assets; `currentColor` affects only SVG fallbacks.

## Inventory (pico-ui/react)

`inventory.json` records names by calling file, including literal names,
conditional expressions, IconButton/Empty wrappers and `icon:` configs.
The complete union (also the original PATHS coverage) is:

activity, alert, ask, bolt, bookmark, brain, chat, check, chevron, expand,
file, gear, hand, mic, monitor, paperclip, pause, pencil, play, plus, power,
search, send, shield, skip, stop, trash, update, volume, x.

Dynamic sources reviewed: app sidebar `s.icon`, app Empty `icon`, decision
`look.icon` (ask/alert/hand), IconButton's forwarded `icon`, paused controls
(play/pause), plan/run status (check/skip/x), workspace event tone
(hand/check/alert/activity), and attention filter (check/activity).
Comparison values such as `attention` are state values, not icon names.
The existing separate app-logo and CSS status-glyph systems are unchanged.

## Regenerate and check locally

From the repository root (existing Python 3 + Pillow and npm dependencies):

```
python3 pico-ui/react/icons/actions/generate.py
node pico-ui/react/icons/actions/check.mjs
npm run ui
npm run check:composio
```

The generator contains the geometry masters (polygons, rounded solids, rings,
and swept tubes), supersamples at 192px, computes an inset distance bevel,
lights that surface and downsamples with Lanczos. No SVG PATHS are copied;
no downloads, services, installs, fonts or random values are used. Results
are deterministic with the same Pillow version. SVG masters are unnecessary
for this raster geometry renderer. Edit generator geometry, not PNGs.

The shared Icon reserves explicit width/height, retains h-icon/className and
uses explicit 1x/2x srcSet. Images are decorative (empty alt, aria-hidden).
Names absent from the asset registry and failed images use the original SVG
paths. Unknown names without an original path remain empty, as before.
Sizes below 12px deliberately retain the monochrome SVG for clarity.
Error state is tied to the failed asset so another name can load normally.
CSS uses individual scale only on enabled buttons, preserving transform-based
rotations; reduced-motion users receive no added motion.

The offline check validates all 90 PNG sizes/alpha, known call/config names,
and the actual extracted Icon component with simulated image errors. It also
checks size/classes, density descriptors and tiny/missing fallbacks. The
inventory scanner covers the current JSX syntax; new computed config builders
need human review. Browser/device appearance and real image decode/network
failure delivery have not been automated.
