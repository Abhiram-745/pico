#!/usr/bin/env node
/* ==========================================================================
   A picture put on the clipboard (bridge/clipboard-image.mjs) — without the
   clipboard. The process that would put it there is a stand-in that records
   what it was given, so nothing here goes near the person's clipboard.

     - a data URL is decoded to exactly its bytes, and anything that is not
       a PNG, JPEG, WebP or GIF — or says it is one and is not, is too big,
       or carries stray characters — is refused before anything is launched
     - the picture reaches the script only as a temporary file, named in an
       environment variable, and the file is gone afterwards whatever
       happened: success, failure, a runner that throws, one that never
       answers
     - the script is one constant, run with -STA, that puts the picture on
       as a bitmap, as PNG too when it is one, and copies it onto the
       clipboard so it outlives the script
     - on Windows, the script really parses, and — with its one clipboard
       line taken out, and checked to be out — really reads a PNG and a
       JPEG and builds everything it would have put there

   Run with: node scripts/test-clipboard-image.mjs
   ========================================================================== */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  decodeImageDataUrl, writeImageToClipboard, runProcess, launchArgs, SCRIPT, MAX_CLIPBOARD_IMAGE_BYTES, CLIPBOARD_TIMEOUT_MS,
} from '../bridge/clipboard-image.mjs';

/* --- real pictures, small ------------------------------------------------- */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** A real PNG with an alpha channel: orange, every other pixel see-through. */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;                    // bits per channel
  head[9] = 6;                    // RGBA
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + (w * 4));
    for (let x = 0; x < w; x++) row.set([230, 120, 40, (x + y) % 2 ? 255 : 0], 1 + (x * 4));
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = png(16, 12);
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;
// An 8x8 JPEG made by System.Drawing: orange with a white square.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3X/i3f/CmP+p//wC3n/n5/wC/X+p/zmiiiv5rr1/b8nuKPKktFa9ur7t9Wf03h8P7Dn9+UuaTl7zva/Rdoroj/9k=';
const JPEG = Buffer.from(JPEG_B64, 'base64');
const JPEG_URL = `data:image/jpeg;base64,${JPEG_B64}`;
const GIF_B64 = 'R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';
const WEBP_B64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

/** The temp files this process has made, by their name pattern. */
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`halo-clip-${process.pid}-`));

/* --- taking a data URL apart ---------------------------------------------- */
{
  const d = decodeImageDataUrl(PNG_URL);
  assert.equal(d.type, 'png');
  assert.equal(d.mime, 'image/png');
  assert.ok(d.bytes.equals(PNG), 'a PNG decodes to exactly its bytes');
  assert.ok(decodeImageDataUrl(JPEG_URL).bytes.equals(JPEG), 'and a JPEG');
  assert.equal(decodeImageDataUrl(`data:image/gif;base64,${GIF_B64}`)?.type, 'gif');
  assert.equal(decodeImageDataUrl(`data:image/webp;base64,${WEBP_B64}`)?.type, 'webp');

  const b64 = PNG.toString('base64');
  const refused = [
    ['not a string', 42],
    ['an address, not data', 'https://example.com/fox.png'],
    ['not a picture', 'data:text/html;base64,PGI+aGk8L2I+'],
    ['a kind of picture Halo does not take', `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`],
    ['not base64', `data:image/png,${encodeURIComponent('<b>')}`],
    ['nothing in it', 'data:image/png;base64,'],
    ['stray characters', `data:image/png;base64,${b64.slice(0, 16)}*${b64.slice(16)}`],
    ['PowerShell where the picture should be', `data:image/png;base64,${b64.slice(0, 8)}'; Remove-Item -Recurse C:\\; '`],
    ['says PNG, is a JPEG', `data:image/png;base64,${JPEG_B64}`],
    ['says JPEG, is a PNG', `data:image/jpeg;base64,${b64}`],
    ['a PNG signature and nothing after', `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e]).toString('base64')}`],
    ['over the limit, refused without decoding it', `data:image/png;base64,${'A'.repeat(Math.ceil(((MAX_CLIPBOARD_IMAGE_BYTES + 3) * 4) / 3))}`],
  ];
  for (const [label, url] of refused) assert.equal(decodeImageDataUrl(url), null, label);
}

/* --- putting it there, with a stand-in for PowerShell ----------------------- */
/** A runner that records what it was given, and what the file held then. */
function standIn(answer = { code: 0, stdout: 'HALO_CLIP_OK\r\n' }) {
  const calls = [];
  const run = async (file, args, options) => {
    const path = options?.env?.HALO_CLIP_FILE;
    calls.push({
      file, args, options, path,
      held: path && existsSync(path) ? readFileSync(path) : null,
      png: options?.env?.HALO_CLIP_PNG,
    });
    return typeof answer === 'function' ? answer() : answer;
  };
  return { run, calls };
}

{
  const { run, calls } = standIn();
  assert.equal(await writeImageToClipboard(PNG_URL, { run }), true, 'a PNG goes on');
  assert.equal(calls.length, 1, 'one process');
  const [c] = calls;
  assert.match(c.file, /powershell\.exe$/i, 'Windows PowerShell');
  assert.deepEqual(c.args, launchArgs(), 'launched exactly as launchArgs says');
  assert.ok(c.held?.equals(PNG), 'the file it is given holds exactly the picture');
  assert.equal(dirname(c.path), tmpdir(), 'in the temp folder');
  assert.match(basename(c.path), new RegExp(`^halo-clip-${process.pid}-[0-9a-f]{16}\\.png$`), 'under a random name');
  assert.equal(c.png, '1', 'told it is a PNG, so the PNG form goes on too');
  assert.equal(c.options.windowsHide, true, 'no console window flashes up');
  assert.equal(c.options.timeout, CLIPBOARD_TIMEOUT_MS, 'and it is given a timeout');
  assert.ok(!existsSync(c.path), 'the file is gone afterwards');
}
{
  const { run, calls } = standIn();
  assert.equal(await writeImageToClipboard(JPEG_URL, { run }), true, 'a JPEG goes on');
  assert.equal(calls[0].png, '0', 'as a bitmap only: it is not a PNG');
  assert.match(calls[0].path, /\.jpg$/);
  assert.ok(calls[0].held?.equals(JPEG));
  assert.ok(!existsSync(calls[0].path));
}
for (const [label, answer] of [
  ['PowerShell failing', { code: 1, stdout: '', stderr: 'OpenClipboard failed' }],
  ['a clean exit that never said it was done', { code: 0, stdout: '' }],
  ['a runner that throws', () => { throw new Error('spawn EACCES'); }],
]) {
  const { run, calls } = standIn(answer);
  assert.equal(await writeImageToClipboard(PNG_URL, { run }), false, label);
  assert.ok(calls[0]?.held, `${label}: it was tried`);
  assert.ok(!existsSync(calls[0].path), `${label}: and the file is gone`);
}
{
  // A runner that never answers is not waited on for ever.
  const { run, calls } = standIn(() => new Promise(() => {}));
  const t0 = Date.now();
  assert.equal(await writeImageToClipboard(PNG_URL, { run, timeoutMs: 50 }), false, 'no answer is a picture that did not go');
  assert.ok(Date.now() - t0 < 5000, 'given up on in time');
  assert.ok(!existsSync(calls[0].path), 'and the file is gone');
}
{
  // Refused before anything is written or launched.
  const { run, calls } = standIn();
  for (const url of ['data:text/plain;base64,aGk=', `data:image/png;base64,$(Start-Process calc)`, null]) {
    assert.equal(await writeImageToClipboard(url, { run }), false);
  }
  assert.equal(calls.length, 0, 'nothing launched for something that is not a picture');
}
assert.deepEqual(leftovers(), [], 'no picture left behind in the temp folder');

/* --- the script ------------------------------------------------------------ */
{
  const args = launchArgs();
  for (const flag of ['-STA', '-NoProfile', '-NonInteractive']) assert.ok(args.includes(flag), flag);
  assert.equal(args.at(-2), '-Command');
  assert.equal(args.at(-1), SCRIPT);
  assert.ok(!SCRIPT.includes('"'), 'single quotes only, so the command line carries it unchanged');
  assert.match(SCRIPT, /\$env:HALO_CLIP_FILE/, 'the file is read from the environment');
  assert.match(SCRIPT, /DataFormats\]::Bitmap/, 'a bitmap, which Windows hands out as CF_DIB');
  assert.match(SCRIPT, /SetData\('PNG'/, 'and the PNG form, for Chrome and Edge');
  assert.match(SCRIPT, /ExcludeClipboardContentFromMonitorProcessing/, 'kept out of clipboard history');
  assert.match(SCRIPT, /Clipboard\]::SetDataObject\(\$data, \$true, /, 'copied onto the clipboard, so it outlives the script');
  assert.equal(SCRIPT.split('\n').filter((l) => /Clipboard\]::/.test(l)).length, 1, 'the clipboard is touched on one line only');
  assert.match(SCRIPT, /HALO_CLIP_OK/);
}
{
  // Whatever the picture, the command line is the same constant: nothing of
  // it, nor of where it was put, reaches PowerShell as code.
  const seen = [];
  const run = async (file, args, options) => { seen.push({ args, env: options.env }); return { code: 0, stdout: 'HALO_CLIP_OK' }; };
  await writeImageToClipboard(PNG_URL, { run });
  await writeImageToClipboard(JPEG_URL, { run });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].args, seen[1].args, 'the same script for any picture');
  const line = seen.map((s) => s.args.join(' ')).join(' ');
  assert.ok(!line.includes(PNG.toString('base64').slice(0, 24)) && !line.includes(JPEG_B64.slice(0, 24)), 'no picture on the command line');
  assert.ok(!line.includes(seen[0].env.HALO_CLIP_FILE) && !line.includes('halo-clip-'), 'nor the file it was written to');
}

/* --- for real, on Windows: everything but the clipboard -------------------- */
if (process.platform === 'win32') {
  /* The script with its one clipboard line taken out — and checked to be
     out before anything runs — against a real PowerShell: the picture read
     from the temp file, laid on white, the PNG form and the marker built.
     Alongside, PowerShell's own parser reads the whole script, running
     none of it. All at once: each is a PowerShell starting up. */
  const DRY = SCRIPT.split('\n').map((l) => (/Clipboard\]::/.test(l) ? "  'clipboard left alone'" : l)).join('\n');
  assert.ok(!/Clipboard\]/.test(DRY), 'the dry script cannot reach the clipboard');
  const ran = [];
  const dry = async (file, args, options) => {
    assert.equal(args.at(-1), SCRIPT);
    const r = await runProcess(file, [...args.slice(0, -1), DRY], options);
    ran.push(r);
    return r;
  };
  const LIMIT = 20_000;
  const broken = Buffer.concat([PNG.subarray(0, 8), Buffer.from('the first eight bytes of a PNG, then nothing of one')]);
  const [parse, pngReady, jpegReady, brokenReady] = await Promise.all([
    runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      '$errors = $null',
      '$tokens = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseInput($env:HALO_PARSE_ME, [ref]$tokens, [ref]$errors)',
      'if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }',
      "'PARSED'",
    ].join('\n')], { windowsHide: true, timeout: LIMIT, env: { ...process.env, HALO_PARSE_ME: SCRIPT } }),
    writeImageToClipboard(PNG_URL, { run: dry, timeoutMs: LIMIT }),
    writeImageToClipboard(JPEG_URL, { run: dry, timeoutMs: LIMIT }),
    writeImageToClipboard(`data:image/png;base64,${broken.toString('base64')}`, { run: dry, timeoutMs: LIMIT }),
  ]);
  assert.deepEqual(leftovers(), [], 'no file is left behind by a real run either');
  /* A PowerShell that never answered says something about this machine at
     this moment — a busy disk, a virus scan of a new script — not about the
     script: said, and not counted. One that answered is held to it. */
  if (parse.timedOut || ran.some((r) => r.timedOut)) {
    console.warn(`  (PowerShell did not answer within ${LIMIT / 1000}s — the real-PowerShell checks were skipped this time)`);
  } else {
    assert.equal(parse.code, 0, `the whole script parses: ${parse.stdout} ${parse.stderr}`);
    assert.match(parse.stdout, /PARSED/);
    const why = ran.map((r) => r.stderr).filter(Boolean).join(' | ');
    assert.equal(pngReady, true, `a real PNG is read and made ready ${why}`);
    assert.equal(jpegReady, true, `and a real JPEG ${why}`);
    assert.equal(brokenReady, false, 'a PNG that is only a PNG for eight bytes is refused by the script, not pasted as nothing');
  }
}

console.log('clipboard-image: all passed');
process.exit(0);
