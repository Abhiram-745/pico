#!/usr/bin/env node
/* ==========================================================================
   Build the interface.

   The island and the app window are React, for the effects they are made of
   — the thinking orb, the liquid-metal buttons, the beam round the island —
   which are React components. React needs bundling before a browser can
   load it, and esbuild does that in a few hundred milliseconds with no
   configuration file to keep in step.

   What is bundled:
     pico-ui/react/island.jsx  ->  pico-ui/build/island.js   (notch.html)
     pico-ui/react/app.jsx     ->  pico-ui/build/app.js      (app.html)

   The shared state (store.js, bridge.js, chats.js, permissions.js) stays as
   plain modules and is bundled in with each, so the phone — which is not
   React and never will be — keeps loading them as it always has.

   The bridge calls buildUI() on start, and it only builds when a source file
   is newer than the bundle. `node scripts/build-ui.mjs` forces a build;
   `--watch` rebuilds as you edit.
   ========================================================================== */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI = join(ROOT, 'pico-ui');
const OUT = join(UI, 'build');
const ENTRIES = {
  island: join(UI, 'react', 'island.jsx'),
  app: join(UI, 'react', 'app.jsx'),
};

/** The newest modification time among the files a bundle is built from. */
function newestSource() {
  let newest = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(?:jsx?|mjs|css)$/.test(name)) newest = Math.max(newest, st.mtimeMs);
    }
  };
  walk(join(UI, 'react'));
  walk(join(UI, 'src'));
  return newest;
}

function oldestBundle() {
  let oldest = Infinity;
  for (const name of Object.keys(ENTRIES)) {
    const file = join(OUT, `${name}.js`);
    if (!existsSync(file)) return 0;
    oldest = Math.min(oldest, statSync(file).mtimeMs);
  }
  return oldest;
}

function options() {
  return {
    entryPoints: ENTRIES,
    outdir: OUT,
    bundle: true,
    format: 'esm',
    target: ['chrome110', 'edge110'],
    jsx: 'automatic',
    loader: { '.js': 'jsx' },
    minify: true,
    sourcemap: 'linked',
    legalComments: 'linked',        // the libraries' MIT notices travel with the bundle
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  };
}

/**
 * Build if anything changed. Resolves to { rebuilt, ms }.
 * Throws with esbuild's own message when the source does not compile.
 */
export async function buildUI({ force = false } = {}) {
  if (!force && oldestBundle() >= newestSource()) return { rebuilt: false, ms: 0 };
  const esbuild = await import('esbuild');
  const t0 = Date.now();
  const result = await esbuild.build(options());
  if (result.errors.length) throw new Error(result.errors.map((e) => e.text).join('\n'));
  return { rebuilt: true, ms: Date.now() - t0 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--watch')) {
    const esbuild = await import('esbuild');
    const ctx = await esbuild.context({ ...options(), logLevel: 'info', minify: false });
    await ctx.watch();
    console.log('  watching pico-ui/react and pico-ui/src');
  } else {
    try {
      const { ms } = await buildUI({ force: true });
      console.log(`  interface built in ${ms}ms -> pico-ui/build/`);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
}
