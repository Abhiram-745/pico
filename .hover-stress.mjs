/* Hover on, hover off, N times. Does it expand every single time? */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nut = await import('@nut-tree-fork/nut-js');
const m = require('@nut-tree-fork/libnut-win32');

const rounds = Number(process.argv[2] || 8);
const settle = Number(process.argv[3] || 750);
const find = () => {
  for (const h of m.getWindows()) {
    try { if (String(m.getWindowTitle(h) || '').includes('Pico Notch')) return h; } catch { /* gone */ }
  }
  return null;
};
const h = find();
if (!h) { console.log('no island'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
for (let i = 1; i <= rounds; i++) {
  const r0 = m.getWindowRect(h);
  // Come at it from a different place each time, at a different speed.
  const from = [[300, 600], [1700, 400], [1024, 900], [120, 120]][i % 4];
  await nut.mouse.setPosition(new nut.Point(from[0], from[1]));
  await sleep(250);
  await nut.mouse.setPosition(new nut.Point(Math.round(r0.x + r0.width / 2), 10 + (i % 3)));
  await sleep(settle);
  const on = m.getWindowRect(h);

  await nut.mouse.setPosition(new nut.Point(from[0], from[1]));
  await sleep(settle);
  const off = m.getWindowRect(h);

  const grew = on.width > 380;
  const shrank = off.width < 300;
  if (grew && shrank) pass++; else fail++;
  console.log(`${String(i).padStart(2)}  hover ${on.width}x${on.height}  ${grew ? 'grew' : 'DID NOT GROW'}   away ${off.width}x${off.height}  ${shrank ? 'settled' : 'STUCK'}`);
}
console.log(`\n${pass} of ${rounds} clean, ${fail} bad`);
