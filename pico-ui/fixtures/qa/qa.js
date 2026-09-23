/* Shared by every Halo QA page.

   Each page sets `qa.task` (what Halo is asked to do) and `qa.check()` (whether
   the page now shows it done). This file counts every press of the pointer and
   whether it landed on something operable, which is how aim is measured
   separately from judgement: a miss here is a click on bare page. */
window.qa = {
  task: '',
  check: () => ({ pass: false, detail: 'no check' }),
  /* What the person "sent with the words" for this task, in the same shape
     the bridge passes to the job runner — see bridge/job.mjs and
     pico-ui/src/attachments.js's toBridgeAttachment. Empty on every page
     that doesn't need one, which is most of them. */
  attachments: [],
  /* Whitespace-collapsed and trimmed, so a typed or pasted paragraph still
     compares equal despite different line-wrapping or trailing spaces.
     Shared so every page that checks pasted text (chat.html, notes.html)
     applies the same rule rather than each rolling its own. */
  normalize: (s) => String(s ?? '').replace(/\s+/g, ' ').trim(),
  presses: [],
  result() {
    let verdict;
    try { verdict = this.check(); } catch (err) { verdict = { pass: false, detail: String(err) }; }
    const misses = this.presses.filter((p) => !p.on).length;
    return { ...verdict, presses: this.presses.length, misses, log: this.presses.slice(-40) };
  },
};

const OPERABLE = 'button, input, select, textarea, a, label, summary, [draggable="true"], [role], [data-qa], canvas, li[data-item], .card';

document.addEventListener('pointerdown', (e) => {
  const on = e.target.closest?.(OPERABLE);
  qa.presses.push({
    x: Math.round(e.clientX),
    y: Math.round(e.clientY),
    on: on ? (on.id || on.dataset.qa || on.getAttribute('aria-label') || on.textContent.trim().slice(0, 30) || on.tagName) : null,
    at: Math.round(performance.now()),
  });
}, true);
