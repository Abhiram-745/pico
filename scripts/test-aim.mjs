#!/usr/bin/env node
/* ==========================================================================
   Where a click lands, given where the model pointed and what the
   accessibility layer says is there. A fake helper stands in for Windows,
   so these run anywhere.

   Run with: node scripts/test-aim.mjs
   ========================================================================== */

import { settle, fit, placeIn } from '../bridge/aim.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${label}${ok ? '' : `  ${detail}`}`);
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const el = (type, name, rect, extra = {}) => ({ type, name, rect, enabled: true, offscreen: false, ...extra });

/** A pretend helper: `hit` and `near` answer from fixed data. */
const fake = ({ at, layers = [], controls = [], window = { title: 'Some App', process: 'app' } }) => ({
  hit: async () => ({ found: true, at, target: layers[0] ?? null, layers, window }),
  near: async () => ({ controls }),
});

console.log('fit');
check('quoted label in the description', fit('the "Send" button at the bottom', 'Send') === 1);
check('name inside a longer description', fit('the Inbox tab in the sidebar', 'Inbox') === 1);
check('unrelated name', fit('the "Send" button', 'Close') === 0);
check('empty name', fit('the send button', '') === 0);

console.log('settle');
{
  const button = el('Button', 'Send', [100, 200, 80, 30]);
  const r = await settle(fake({ at: el('Text', 'Send', [110, 205, 40, 20]), layers: [button] }), { x: 104, y: 222 }, { target: 'the Send button' });
  check('on a small button: its centre', near(r.x, 140) && near(r.y, 215) && r.how === 'centred', JSON.stringify(r));
}
{
  const row = el('ListItem', 'Receipts', [0, 300, 900, 34]);
  const r = await settle(fake({ at: row, layers: [row] }), { x: 60, y: 302 }, { target: 'Receipts in the list' });
  check('on a wide row: x kept, y centred', near(r.x, 60) && near(r.y, 317), JSON.stringify(r));
}
{
  const field = el('Edit', 'Search', [400, 50, 600, 36], { positional: true });
  const r = await settle(fake({ at: field, layers: [field] }), { x: 720, y: 60 }, { target: 'the search box' });
  check('in a text field: the point is kept', near(r.x, 720) && near(r.y, 60) && r.how === 'kept', JSON.stringify(r));
}
{
  const close = el('Button', 'Close', [290, 10, 20, 20]);
  const tab = el('TabItem', 'Inbox - Gmail', [100, 5, 220, 30]);
  const r = await settle(fake({ at: close, layers: [close, tab] }), { x: 296, y: 18 }, { target: 'the "Inbox" tab' });
  check('close button inside the tab that was meant: the tab', near(r.x, 210) && near(r.y, 20) && r.landed.name === 'Inbox - Gmail', JSON.stringify(r));
}
{
  const close = el('Button', 'Close', [290, 10, 20, 20]);
  const tab = el('TabItem', 'Inbox - Gmail', [100, 5, 220, 30]);
  const r = await settle(fake({ at: close, layers: [close, tab] }), { x: 296, y: 18 }, { target: 'the × close button on the Inbox tab' });
  check('the close button, when that is what was meant', near(r.x, 300) && near(r.y, 20) && r.landed.name === 'Close', JSON.stringify(r));
}
{
  const box = el('CheckBox', 'Email me weekly', [500, 400, 17, 17]);
  const r = await settle(fake({
    at: el('Text', 'Email me weekly', [522, 398, 110, 20]),
    controls: [{ ...box, distance: 6 }],
  }), { x: 523, y: 408 }, { target: 'the checkbox for "Email me weekly"' });
  check('just beside a checkbox it names: the checkbox', near(r.x, 508.5) && near(r.y, 408.5), JSON.stringify(r));
}
{
  const r = await settle(fake({
    at: el('Document', 'Page', [0, 0, 2000, 1300]),
    controls: [{ ...el('Button', 'Bold', [300, 90, 30, 30]), distance: 5 }],
  }), { x: 296, y: 95 }, { target: 'the empty line below the heading' });
  check('a click into a document is not pulled onto a button', near(r.x, 296) && near(r.y, 95) && r.how === 'model', JSON.stringify(r));
}
{
  const r = await settle(fake({
    at: el('Pane', '', [0, 0, 800, 600]),
    controls: [{ ...el('Button', 'Save', [300, 90, 60, 30]), distance: 14 }],
  }), { x: 286, y: 100 }, { target: 'the Delete button' });
  check('a far neighbour with a different name is not taken', r.how === 'model', JSON.stringify(r));
}
{
  const r = await settle(null, { x: 10, y: 20 }, { target: 'anything' });
  check('no helper: the model point, untouched', r.x === 10 && r.y === 20 && r.how === 'model');
}
{
  const giant = el('Button', 'Card', [0, 0, 1200, 900]);
  const r = await settle(fake({ at: giant, layers: [giant], controls: [] }), { x: 50, y: 60 }, { target: 'the card' });
  check('a window-sized "button" is not centred on', near(r.x, 50) && near(r.y, 60), JSON.stringify(r));
}
{
  const link = el('Hyperlink', 'privacy policy', [100, 100, 420, 44]);
  const p = placeIn(link, { x: 130, y: 112 });
  check('a link keeps the point on its text', near(p.x, 130) && near(p.y, 112));
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
