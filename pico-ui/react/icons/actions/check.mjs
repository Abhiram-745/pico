// Offline coverage and actual component render/error checks. No application imports.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { build } from 'esbuild';
import Jimp from 'jimp';
const dir = path.dirname(fileURLToPath(import.meta.url));
const reactDir = path.resolve(dir, '../..');
const source = await readFile(path.join(reactDir, 'parts.jsx'), 'utf8');
const paths = source.slice(source.indexOf('const PATHS ='), source.indexOf('import { actionIcons }'));
const required = [...paths.matchAll(/^  (\w+):/gm)].map(m => m[1]).sort();
const inventory = {};
for (const file of (await readdir(reactDir)).filter(f => /\.(jsx|js)$/.test(f))) {
  const text = await readFile(path.join(reactDir, file), 'utf8');
  const found = new Set();
  for (const m of text.matchAll(/\bicon:\s*['"]([^'"]+)['"]|<(?:Icon|IconButton|Empty)\b[^>]*?\b(?:name|icon)=(?:"([^"]+)"|'([^']+)'|\{([^}]+)\})/g)) {
    if (m[1] || m[2] || m[3]) found.add(m[1] || m[2] || m[3]);
    else for (const v of m[4].replace(/===?\s*['"][^'"]+['"]/g, '').matchAll(/['"]([^'"]+)['"]/g)) found.add(v[1]);
  }
  if (found.size) inventory[file] = [...found].sort();
}
for (const [file, names] of Object.entries(inventory)) for (const name of names) assert(required.includes(name), `${file}: uncovered ${name}`);
for (const name of required) {
  for (const [suffix, size] of [['',24],['@2x',48],['@4x',96]]) {
    const image = await Jimp.read(path.join(dir, `${name}${suffix}.png`));
    assert.equal(image.bitmap.width, size); assert.equal(image.bitmap.height, size);
    const alpha = [...image.bitmap.data].filter((_, i) => i % 4 === 3);
    assert(alpha.some(a => a === 0) && alpha.some(a => a === 255), `${name}: transparency/solid core`);
    assert.equal(image.bitmap.data[3], 0, `${name}: transparent corner`);
  }
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'pico-actions-'));
try {
  const component = source.slice(source.indexOf('export function Icon({'), source.indexOf('export function IconButton'));
  const result = await build({ stdin: { contents: `import React from 'react'; import { actionIcons } from './icons/actions/index.js';
    let state = null; function useState() { return [state, value => { state = value; }]; }
    export function reset() { state = null; }
    ${paths}\n${component}`, resolveDir: reactDir, loader: 'jsx' },
    bundle: true, format: 'esm', platform: 'node', outfile: path.join(temp,'test.mjs'),
    loader: { '.png':'file' }, write: false, logLevel:'silent' });
  await writeFile(path.join(temp,'test.mjs'), result.outputFiles.find(f => f.path.endsWith('.mjs')).contents);
  const { Icon, reset } = await import(path.join(temp,'test.mjs'));
  for (const name of required) {
    reset(); const image = Icon({ name, size:24, className:'rotation-contract' });
    assert.equal(image.type,'img'); assert.equal(image.props.alt,''); assert.equal(image.props['aria-hidden'],'true');
    assert.equal(image.props.width,24); assert.equal(image.props.height,24);
    assert(image.props.className.includes('rotation-contract'));
    assert.match(image.props.srcSet, /\.png 1x, .*@2x.*\.png 2x$/);
    image.props.onError(); const fallback = Icon({name,size:24});
    assert.equal(fallback.type,'svg'); assert(fallback.props.children.props.d);
    const other = required.find(value => value !== name);
    assert.equal(Icon({name:other,size:24}).type,'img');
    assert.equal(Icon({name:'missing',size:24}).type,'svg');
    reset(); assert.equal(Icon({name,size:11}).type,'svg');
  }
} finally { await rm(temp,{recursive:true,force:true}); }
const snapshot = JSON.parse(await readFile(path.join(dir,'inventory.json'),'utf8'));
assert.deepEqual(inventory,snapshot,'Update documented inventory after reviewing new names/configs');
const css = await readFile(path.join(dir,'actions.css'),'utf8');
assert(css.includes('prefers-reduced-motion: no-preference')); assert(css.includes('button:enabled:not([aria-disabled="true"])')); assert(!/\btransform\s*:/.test(css));
console.log(`PASS: ${required.length} names, 90 RGBA PNGs, inventory, real Icon render/error/tiny/missing fallback, motion contracts`);
