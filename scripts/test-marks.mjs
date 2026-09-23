#!/usr/bin/env node
/* Numbered marks and the zoomed second look: the arithmetic that decides
   where the pointer goes, checked without a screen or a model.
   Run with: node scripts/test-marks.mjs */
import assert from 'node:assert/strict';
import { buildMarks, describeMarks, resolveMarks, drawMarks, markPoint } from '../bridge/marks.mjs';
import { cropBox, fromZoom, zoomImage, SHOWN, shapesIn } from '../bridge/zoom.mjs';

/* A 2256x1504 screen shown to the model 1280 wide — the laptop's numbers. */
const physical = { width: 2256, height: 1504 };
const shot = {
  width: 1280, height: Math.round((1504 * 1280) / 2256), physical,
  raw: { data: Buffer.alloc(2256 * 1504 * 4, 200), width: 2256, height: 1504, scale: 1.5 },
};

const seen = {
  elements: [
    { type: 'Button', name: 'Save project', rect: [400, 900, 180, 44], operable: true },
    { type: 'Edit', name: 'Project name', rect: [300, 300, 900, 50], value: 'Halo', operable: true },
    { type: 'CheckBox', name: 'Enable notifications', rect: [300, 700, 24, 24], checked: false, operable: true },
    { type: 'Button', name: 'Close', id: 'Close', rect: [2200, 0, 56, 40], operable: true },
    { type: 'Button', name: 'Offscreen', rect: [10, 10, 40, 40], offscreen: true },
    { type: 'Button', name: 'Save project', rect: [401, 901, 180, 44], operable: true },   // a duplicate row
  ],
  texts: [{ name: 'Write report', rect: [1000, 400, 200, 30] }],
  places: [{ type: 'Group', name: 'Done', rect: [1500, 200, 500, 800] }],
};

const marks = buildMarks(seen);
assert.deepEqual(marks.map((m) => m.name), ['Save project', 'Project name', 'Enable notifications', 'Write report', 'Done'],
  'title-bar buttons, offscreen rows and duplicates are dropped; controls, then text, then places');
assert.deepEqual(marks.map((m) => m.n), [1, 2, 3, 4, 5]);
assert.equal(marks[0].kind, 'control');
assert.equal(marks[3].kind, 'text');
assert.equal(marks[4].kind, 'place');

const listed = describeMarks(marks);
assert.match(listed, /\[2\] Edit "Project name" value "Halo"/);
assert.match(listed, /\[3\] CheckBox "Enable notifications" not checked/);

/* A click by number lands on the exact middle of the control's rectangle. */
const click = resolveMarks({ type: 'click', mark: 1 }, marks, shot);
const back = { x: (click.x + 0.5) * (physical.width / shot.width), y: (click.y + 0.5) * (physical.height / shot.height) };
assert.ok(Math.abs(back.x - 490) < 2 && Math.abs(back.y - 922) < 2, `click centre ${JSON.stringify(back)}`);
assert.equal(click.exact, true, 'a control needs no aiming');
assert.equal(click.target, 'Button "Save project"');

/* A tiny checkbox: still its middle, which a pixel guess would miss. */
const box = resolveMarks({ type: 'click', mark: 3 }, marks, shot);
const boxPhys = { x: box.x * (physical.width / shot.width), y: box.y * (physical.height / shot.height) };
assert.ok(boxPhys.x >= 300 && boxPhys.x <= 324 && boxPhys.y >= 700 && boxPhys.y <= 724, `checkbox ${JSON.stringify(boxPhys)}`);

/* A drag from a text mark to a place mark: both ends resolved, not exact. */
const drag = resolveMarks({ type: 'drag', mark: 4, to_mark: 5 }, marks, shot);
assert.ok(Number.isFinite(drag.to_x) && Number.isFinite(drag.to_y));
assert.notEqual(drag.exact, true, 'text keeps its point');
assert.equal(drag.toMarkedAs.name, 'Done');

/* Selecting one run of text by its number: first character to last. */
const sel = resolveMarks({ type: 'select_text', mark: 4 }, marks, shot);
assert.ok(sel.x < sel.to_x, 'selection runs left to right');
assert.equal(sel.y, sel.to_y);

/* A number nobody drew is left alone for the checks to complain about. */
const wrong = resolveMarks({ type: 'click', mark: 99 }, marks, shot);
assert.equal(wrong.x, undefined);

/* Drawing produces a picture of the model's size. */
const drawn = drawMarks(shot, marks);
assert.ok(drawn && drawn.b64.length > 1000, 'marks are drawn');
assert.equal(markPoint(marks[0], shot).x, click.x);

/* A browser: the page's own things get the low numbers, Chrome's frame
   buttons get none, and the browser's controls follow the page. */
const browser = buildMarks({
  elements: [
    { type: 'Button', name: 'Minimize', rect: [2050, 0, 60, 40] },
    { type: 'Button', name: 'Close', rect: [2190, 0, 60, 40] },
    { type: 'Edit', name: 'Address and search bar', rect: [200, 50, 1200, 40] },
    { type: 'Document', name: 'QA Board', rect: [0, 130, 2256, 1300] },
    { type: 'Pane', name: 'QA Board - Google Chrome', rect: [0, 0, 2256, 1432] },
  ],
  texts: [{ name: 'Write report', rect: [300, 400, 200, 30] }],
  places: [{ type: 'Group', name: 'Done', rect: [1500, 300, 500, 800] }],
}, { within: [0, 0, 2256, 1432] });
assert.deepEqual(browser.map((m) => m.name), ['Write report', 'Done', 'Address and search bar']);

/* --- zoom ------------------------------------------------------------------ */
const c1 = cropBox({ x: 5, y: 5 }, physical);
assert.deepEqual([c1.x, c1.y], [0, 0], 'a crop stays on the screen at the corner');
const c2 = cropBox({ x: 2250, y: 1500 }, physical);
assert.equal(c2.x + c2.width, physical.width);
assert.equal(c2.y + c2.height, physical.height);

const mid = cropBox({ x: 1000, y: 700 }, physical);
const centre = fromZoom({ x: SHOWN / 2, y: SHOWN / 2 }, mid);
assert.ok(Math.abs(centre.x - 1000) <= 1 && Math.abs(centre.y - 700) <= 1, `zoom centre maps back ${JSON.stringify(centre)}`);
const corner = fromZoom({ x: 0, y: 0 }, mid);
assert.ok(Math.abs(corner.x - mid.x) < 1 && Math.abs(corner.y - mid.y) < 1);

const zi = zoomImage(shot.raw, mid);
assert.ok(zi && zi.width === SHOWN, 'the zoomed picture is the promised size');

/* Shapes in a drawing: found by colour against the background, neighbours
   kept apart, and the frame's place on the desktop respected. */
{
  const W = 600; const H = 300; const d = Buffer.alloc(W * H * 4, 255);
  const paint = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = ((y * W) + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; } };
  paint(50, 50, 40, 40, [220, 40, 40]); paint(300, 200, 30, 30, [40, 170, 70]); paint(340, 200, 30, 30, [40, 170, 70]);
  const found = shapesIn({ data: d, width: W, height: H, originX: 2560, originY: -63 }, { x: 2560, y: -63, width: W, height: H });
  assert.equal(found.length, 3, 'three shapes, the two green ones apart');
  assert.ok(found.every((s) => s.rect[0] >= 2560), 'rectangles are in desktop pixels');
}

console.log('Marks and zoom: numbering, filtering, click/drag/select resolution, drawing and zoom mapping passed.');
