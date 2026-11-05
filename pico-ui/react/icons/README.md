# Halo static icons

Fourteen hand-drawn monochrome SVGs, each with a 24 × 24 viewBox. Line icons use rounded 1.6-unit strokes; silhouette icons retain their characteristic filled shapes. Sources: `claude`, `codex`, `chrome`, `lovable`, `grok`, `cursor`, `vscode`, `chatgpt`. Status glyphs: `busy`, `dot`, `tick`, `cross`, `attention`, `ready`. Busy is a static waveform; this library supplies no motion.

Import once through your stylesheet (before other rules):

```css
@import "./icons.css"; /* relative to pico-ui/react/*.css */

.my-icon {
  display: inline-block;
  width: 20px;
  height: 20px;
  color: #9adbc8;
  background: currentColor;
  -webkit-mask: var(--icon-grok) center / contain no-repeat;
  mask: var(--icon-grok) center / contain no-repeat;
}
```

Every name above exports `--icon-NAME` on `:root`. Masks use SVG alpha; apply `background: currentColor` at the use site to inherit the desired color. Standalone SVGs also use `currentColor` when inlined; an SVG loaded with `<img>` cannot inherit the surrounding page's text color. Give meaningful images accessible labels; mark decorative icon elements `aria-hidden="true"` and keep the visible text label.

Watch rows use the separate plush PNG family below. Other adopters can still import
`icons.css` and use the SVG masks; the SVG library and generator remain unchanged.

Edit the standalone SVGs, then regenerate the single shared data-URI definition for each icon:

```sh
node pico-ui/react/icons/generate.mjs
node pico-ui/react/icons/generate.mjs --check
npm run ui
```

The generator uses only Node built-ins and an explicit filename allowlist. It fully percent-encodes SVG markup, including quotes and hashes, and rejects active/external SVG content. `--check` verifies generated CSS is current. SVG source files remain the editable originals; do not edit the encoded CSS by hand. The assets are small optical interpretations for Halo's 16–20px UI, not official brand artwork.

## Plush watch icons

`3d/` contains eight transparent RGBA plush illustrations: `claude`, `codex`,
`chrome`, `lovable`, `grok`, `cursor`, `vscode`, and `chatgpt`. Full resolution
1254 × 1254 generator originals are preserved byte for byte in `3d/originals/`.
The runtime `<name>.png` (128 × 128) and `<name>@2x.png` (256 × 256) files use
Lanczos resampling and lossless PNG compression. Resize from the originals,
never from a previously resized file; preserve alpha and the complete canvas.

`watch.css` maps `.h-watch__row[data-src] .h-watch__icon` to CSS
`background-image`, with a plain PNG fallback followed by a 1x/2x `image-set`.
The decorative span remains `aria-hidden` beside its visible label. Artwork
fits a 36px square; status stays in the row's separate dot. Unknown sources use
Codex. Aliases: `claude-code`, `openai-codex`, `google-chrome`, `code`, `vs-code`,
`visual-studio-code`, and `chat-gpt` map to their corresponding canonical source.
Watch rows use no SVG library masks (the checkbox tick uses CSS borders).

`npm run ui` bundles CSS URLs through esbuild's PNG file loader, emitting hashed
files under `pico-ui/build/assets/` and relative URLs in `build/watch.css`.
Both `app.html` and `notch.html` load this explicit CSS build entry.
This works for both bridge and copied static-site builds without a fixed public
path. PNG modification times participate in automatic build freshness checks.
Only referenced runtime variants are bundled; full resolution originals stay
out of the bundle. Existing linked JS and CSS source maps remain enabled.
