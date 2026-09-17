#!/usr/bin/env node
/* ==========================================================================
   Assemble the public site into dist/.

   The layout deliberately mirrors the repo:

     dist/index.html, phone.html, site.css, ...   <- docs/
     dist/pico-ui/...                             <- pico-ui/
     dist/phone/...                               <- phone/

   Mirroring matters. pico-ui/app.html reaches for ../phone/icons/... and
   phone/index.html reaches for ../pico-ui/src/... — keeping the same shape
   means every existing relative path resolves without rewriting a single
   reference.

   GitHub Pages keeps serving docs/ directly and is unaffected; this only
   builds the richer version for a host that can run a build step.
   ========================================================================== */

import { cp, mkdir, rm, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUI } from './build-ui.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

/* Never publish these: dev-only harnesses, or files that belong on the
   user's machine rather than a web server. */
const EXCLUDE = new Set([
  'index.html',          // pico-ui/index.html is the dev control deck
  'harness.css',
  'dev-server.mjs',
  'mock',                // kept — see below
]);

async function copyDir(from, to, { skip = new Set() } = {}) {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    if (skip.has(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if ((await stat(src)).isDirectory()) await copyDir(src, dst, { skip });
    else await cp(src, dst);
  }
}

// The island and the app window are bundled React; the preview needs the
// bundle as much as the installed app does.
await buildUI({ force: true });

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

// 1. the marketing site sits at the root
await copyDir(join(ROOT, 'docs'), DIST);

// 2. the app, minus the dev harness. mock/ is kept on purpose: it is what
//    makes the web demo work without a bridge behind it.
await copyDir(join(ROOT, 'pico-ui'), join(DIST, 'pico-ui'), {
  skip: new Set(['index.html', 'mascot.html', 'harness.css', 'dev-server.mjs', 'audit-sample.jsonl']),
});

// 3. the phone app, so its shared imports resolve
await copyDir(join(ROOT, 'phone'), join(DIST, 'phone'));

// 4. the intent router. The preview's stand-in agent makes the same
//    chat-or-work decision as the real host, using the same rules, rather
//    than a second copy that could drift. It is pure logic with no Node
//    imports and no secrets, so it runs unchanged in a browser.
await mkdir(join(DIST, 'bridge'), { recursive: true });
await cp(join(ROOT, 'bridge', 'intent.mjs'), join(DIST, 'bridge', 'intent.mjs'));

// A service worker scoped to /phone/ would try to cache the demo offline and
// serve stale files; the hosted copy is a preview, not an install.
await rm(join(DIST, 'phone', 'sw.js'), { force: true });

await writeFile(
  join(DIST, 'build.json'),
  `${JSON.stringify({
    built: new Date().toISOString(),
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
  })}\n`,
  'utf8',
);

/* --------------------------------------------------------------------------
   Report, and fail loudly if something the pages depend on is missing.
   -------------------------------------------------------------------------- */
const required = [
  'index.html',
  'phone.html',
  'site.css',
  'pico-ui/app.html',
  'pico-ui/build/app.js',
  'pico-ui/build/island.js',
  'pico-ui/src/theme.css',
  'pico-ui/assets/pico.png',
  'pico-ui/mock/agent.js',
  'bridge/intent.mjs',
  'phone/icons/icon-192.png',
];

const missing = [];
for (const r of required) {
  try { await stat(join(DIST, r)); } catch { missing.push(r); }
}

if (missing.length) {
  console.error('\n  build incomplete, missing:\n' + missing.map((m) => `    ${m}`).join('\n') + '\n');
  process.exit(1);
}

let count = 0;
const tally = async (dir) => {
  for (const n of await readdir(dir)) {
    const p = join(dir, n);
    if ((await stat(p)).isDirectory()) await tally(p);
    else count += 1;
  }
};
await tally(DIST);

console.log(`  site built into dist/ (${count} files)`);
