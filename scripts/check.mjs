#!/usr/bin/env node
/* ==========================================================================
   Pre-publish checks.

   These exist because of bugs that actually shipped, not hypothetical ones:

     1. A literal newline ended up inside a quoted JS string. Node parsed the
        file anyway; the browser refused it, and the app rendered a blank page.
        Twice.
     2. The app used CSS classes defined in a stylesheet it does not load, so
        a button rendered as a bare grey box.

   Run with: node scripts/check.mjs
   ========================================================================== */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const fail = (msg) => failures.push(msg);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.agents', 'out', 'dist'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const scripts = files.filter((f) => ['.js', '.mjs'].includes(extname(f)));

/* --------------------------------------------------------------------------
   1. Every module parses
   -------------------------------------------------------------------------- */
for (const f of scripts) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    fail(`${relative(ROOT, f)}: does not parse\n    ${String(err.stderr).split('\n')[2] ?? ''}`);
  }
}

/* --------------------------------------------------------------------------
   2. No string literal runs past the end of its line

   Node tolerates some of these; browsers do not. Tracks block comments and
   template literals so apostrophes in prose don't register.
   -------------------------------------------------------------------------- */
function unclosedStrings(source) {
  const bad = [];
  let inBlockComment = false;
  let inTemplate = false;

  source.replace(/\r\n/g, '\n').split('\n').forEach((line, idx) => {
    let i = 0;
    let single = false;
    let dbl = false;

    while (i < line.length) {
      const c = line[i];
      const next = line[i + 1];

      if (inBlockComment) {
        if (c === '*' && next === '/') { inBlockComment = false; i += 2; continue; }
        i += 1; continue;
      }
      if (inTemplate) {
        if (c === '\\') { i += 2; continue; }
        if (c === '`') { inTemplate = false; }
        i += 1; continue;
      }
      if (c === '\\') { i += 2; continue; }

      if (!single && !dbl) {
        if (c === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
        if (c === '/' && next === '/') break;              // line comment
        if (c === '`') { inTemplate = true; i += 1; continue; }

        // A regex literal can contain quotes that are not string delimiters.
        // Distinguish it from division by what precedes it.
        if (c === '/') {
          const before = line.slice(0, i).trimEnd();
          const prev = before[before.length - 1] ?? '';
          const isRegex = prev === '' || '(,=:[!&|?{};+-*%~^'.includes(prev)
            || /\b(?:return|typeof|case|in|of|new|delete|void|throw)$/.test(before);
          if (isRegex) {
            let j = i + 1;
            let cls = false;
            while (j < line.length) {
              const d = line[j];
              if (d === '\\') { j += 2; continue; }
              if (d === '[') cls = true;
              else if (d === ']') cls = false;
              else if (d === '/' && !cls) break;
              j += 1;
            }
            if (j < line.length) { i = j + 1; continue; }   // consumed the regex
          }
        }
      }

      if (c === "'" && !dbl) single = !single;
      else if (c === '"' && !single) dbl = !dbl;
      i += 1;
    }

    if (single || dbl) bad.push({ line: idx + 1, text: line.trim().slice(0, 70) });
  });
  return bad;
}

for (const f of scripts) {
  for (const b of unclosedStrings(readFileSync(f, 'utf8'))) {
    fail(`${relative(ROOT, f)}:${b.line}: string never closes on its line — a browser will refuse this\n    ${b.text}`);
  }
}

/* --------------------------------------------------------------------------
   3. Every class a page uses is defined in a stylesheet that page loads
   -------------------------------------------------------------------------- */
const PAGES = [
  { html: 'pico-ui/app.html', js: ['pico-ui/src/app.js', 'pico-ui/src/setup.js'] },
  { html: 'pico-ui/desktop.html', js: ['pico-ui/src/notch.js', 'pico-ui/src/cursors.js'] },
  { html: 'pico-ui/notch.html', js: ['pico-ui/src/island.js'] },
];

for (const page of PAGES) {
  const html = readFileSync(join(ROOT, page.html), 'utf8');
  const sheets = [...html.matchAll(/href="([^"]+\.css)"/g)]
    .map((m) => m[1])
    .filter((h) => !h.startsWith('http'));

  const css = sheets
    .map((h) => {
      const p = join(ROOT, 'pico-ui', h.replace(/^\.\.\//, '').replace(/^src\//, 'src/'));
      try { return readFileSync(p, 'utf8'); } catch { return ''; }
    })
    .join('\n');

  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  for (const jsPath of page.js) {
    const js = readFileSync(join(ROOT, jsPath), 'utf8');
    const used = new Set();
    for (const m of js.matchAll(/el\(\s*['"`][a-z0-9]+['"`]\s*,\s*['"]([^'"$]+)['"]/g)) {
      for (const c of m[1].split(/\s+/)) if (c) used.add(c);
    }
    for (const c of used) {
      if (!defined.has(c)) {
        fail(`${jsPath}: uses ".${c}" but ${page.html} loads no stylesheet defining it`);
      }
    }
  }
}

/* --------------------------------------------------------------------------
   4. No secret ever reaches a tracked file
   -------------------------------------------------------------------------- */
for (const f of files) {
  if (f.includes('.env') && !f.endsWith('.env.example')) continue;
  const text = (() => { try { return readFileSync(f, 'utf8'); } catch { return ''; } })();
  if (/sk-(?:proj|bl)-[A-Za-z0-9_-]{24,}/.test(text)) {
    fail(`${relative(ROOT, f)}: contains something shaped like a live API key`);
  }
}

/* --------------------------------------------------------------------------
   5. The behaviours that have gone wrong in front of a user

   The intent router: a misrouted greeting means Pico takes over the desktop
   to type "hello".

   The driver: it asked a question, was answered, and replied that there was
   nothing to do — and it clicked Archived when it was told Locked chats.
   -------------------------------------------------------------------------- */
for (const suite of ['test-intent.mjs', 'test-shortcuts.mjs', 'test-driver.mjs']) {
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', suite)], { stdio: 'pipe' });
  } catch (err) {
    fail(`${suite}:\n${String(err.stdout ?? '')}${String(err.stderr ?? '')}`.trimEnd());
  }
}

/* -------------------------------------------------------------------------- */
if (failures.length) {
  console.error(`\n  ${failures.length} problem${failures.length > 1 ? 's' : ''}:\n`);
  for (const f of failures) console.error(`  • ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`  checks passed (${scripts.length} modules)`);
