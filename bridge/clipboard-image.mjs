/* ==========================================================================
   Halo — a picture, put on the Windows clipboard as a picture.

   WHY THIS EXISTS
   The person attaches a picture and asks for it to go somewhere: "paste
   this into ChatGPT and ask what's in it". A person does that with ctrl+v,
   and so does Halo — but the clipboard in computer.mjs is nut-js's, which
   carries text and nothing else. Until this file the driver had to tell
   the model pictures could not be pasted, and refuse a plain paste while
   one was attached, because the only thing ctrl+v could have put there was
   whatever the person happened to have copied themselves.

   HOW
   Node has no clipboard of its own, and nothing already loaded in the
   bridge can put an image on it, so a short PowerShell script does, with
   the same .NET classes any Windows program would use: System.Drawing to
   read the picture, System.Windows.Forms.Clipboard to place it. It goes on
   in more than one form at once, because the programs that read it
   disagree about which they want:

     Bitmap   CF_BITMAP, which Windows hands out as CF_DIB to anyone who
              asks — the form everything understands: Paint, Word, Slack,
              every browser. A bitmap has no transparency, so the picture is
              laid on white first: how it looks against any light page,
              rather than on the grey GDI would otherwise choose.
     PNG      Only when the picture is a PNG, and then its own bytes,
              untouched. Chrome and Edge read this form first when it is
              there, and it keeps what the bitmap cannot: transparency.

   Plus one marker, ExcludeClipboardContentFromMonitorProcessing, which asks
   Windows' clipboard history and cloud clipboard to leave the picture out.
   Halo put it there to carry it, not for the person to keep; without the
   marker every attached picture would also turn up in their Win+V history
   and on their other devices.

   Three details decide whether this works, and each one failed quietly
   before it was right somewhere:
     - the clipboard can only be used from a single-threaded apartment, so
       the script runs with -STA;
     - SetDataObject(data, true) copies the data onto the clipboard itself,
       where it outlives the script. Left false, the picture belongs to
       the PowerShell process and vanishes when it exits — before the
       ctrl+v that was meant to paste it;
     - and it retries. Another program holding the clipboard open for a
       moment — clipboard managers do it constantly — is not a reason to
       give up on the first try.

   THE PICTURE NEVER BECOMES PART OF THE SCRIPT
   It is decoded here, checked for what it really is, and written to a
   temporary file with a random name. The script is a constant and learns
   where that file is from an environment variable, never from text built
   into it, so nothing in a data URL can ever be read as PowerShell. The
   file is deleted afterwards whatever happened: written, refused, failed,
   or timed out.

   The process that runs the script is a parameter (`run`), so the tests can
   see exactly what would be launched, and with what, without launching it:
   the real clipboard belongs to the person, and a test has no business on
   it. See scripts/test-clipboard-image.mjs.
   ========================================================================== */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The largest picture put on the clipboard, decoded. The bridge already
    refuses an attached picture over 8MB (attachments.mjs); this is the outer
    bound for anything else that calls here, and a bitmap of anything bigger
    is not something to hand a chat box anyway. */
export const MAX_CLIPBOARD_IMAGE_BYTES = 12 * 1024 * 1024;

/** How long the script may take. PowerShell starts in well under a second,
    and a 2048px picture is read and placed in a few hundred milliseconds
    more. A script still going after eight seconds is stuck — usually on a
    clipboard another program will not let go of — and a paste that late
    would land after the run has moved on from where it was aimed. */
export const CLIPBOARD_TIMEOUT_MS = 8000;

/* The four kinds the bridge lets in as a picture (IMAGE_DATA_URL_RE in
   attachments.mjs), base64 only. */
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** What the bytes really are, from their first few — whatever was claimed. */
function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 8) === 'PNG\r\n\x1a\n') return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'gif';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/**
 * A picture's data URL, taken apart and checked: `{ type, mime, bytes }`, or
 * null for anything that is not a PNG, JPEG, WebP or GIF, whole and within
 * the size limit, that really is what its data URL says it is.
 *
 * Sized before it is decoded, so a string built to be enormous is refused
 * without first being turned into a buffer as big as itself. Checked for
 * stray characters before decoding too: Buffer.from skips anything that is
 * not base64 rather than failing, and what it quietly made of the rest
 * would be a different picture from the one that was sent.
 *
 * @param {unknown} dataUrl
 * @returns {{ type: 'png'|'jpeg'|'webp'|'gif', mime: string, bytes: Buffer } | null}
 */
export function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const head = DATA_URL.exec(dataUrl);
  if (!head) return null;
  const b64 = dataUrl.slice(head[0].length);
  if (!b64) return null;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if (Math.floor((b64.length * 3) / 4) - padding > MAX_CLIPBOARD_IMAGE_BYTES) return null;
  if (b64.length % 4 === 1 || !BASE64.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) return null;
  // A data URL that says PNG over the bytes of something else is not a
  // picture to trust with the "PNG" form: refused, not guessed at.
  if (sniff(bytes) !== head[1]) return null;
  return { type: head[1], mime: `image/${head[1]}`, bytes };
}

/* The script. A constant: nothing in it comes from the picture, the file
   name or anywhere else, and the two things it needs to know it reads from
   its environment — HALO_CLIP_FILE, where the picture is, and HALO_CLIP_PNG,
   whether it is a PNG. Single quotes only, and every try on the line its
   catch is on, so the command line carries it to PowerShell unchanged.

   GDI+ reads PNG, JPEG and GIF (a GIF's first frame) but not WebP; WIC,
   through WPF, reads WebP wherever Windows has the codec, and the picture
   it makes of one is offered as a PNG, so its transparency survives too.

   The clipboard itself is touched on exactly one line, the SetDataObject
   call; the tests read the script without it to check everything else on a
   real PowerShell, and rely on it staying that way. */
export const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Windows.Forms',
  '  Add-Type -AssemblyName System.Drawing',
  '  $bytes = [System.IO.File]::ReadAllBytes($env:HALO_CLIP_FILE)',
  "  $png = $env:HALO_CLIP_PNG -eq '1'",
  '  $source = $null',
  '  try { $held = [System.IO.MemoryStream]::new($bytes); $source = [System.Drawing.Image]::FromStream($held, $true, $true) } catch { $source = $null }',
  '  if ($null -eq $source) {',
  '    Add-Type -AssemblyName PresentationCore, WindowsBase',
  '    $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create([System.IO.MemoryStream]::new($bytes), [System.Windows.Media.Imaging.BitmapCreateOptions]::None, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)',
  '    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()',
  '    $encoder.Frames.Add($decoder.Frames[0])',
  '    $made = [System.IO.MemoryStream]::new()',
  '    $encoder.Save($made)',
  '    $bytes = $made.ToArray()',
  '    $png = $true',
  '    $held = [System.IO.MemoryStream]::new($bytes)',
  '    $source = [System.Drawing.Image]::FromStream($held, $true, $true)',
  '  }',
  '  $w = $source.Width',
  '  $h = $source.Height',
  '  $flat = [System.Drawing.Bitmap]::new($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)',
  '  $g = [System.Drawing.Graphics]::FromImage($flat)',
  '  $g.Clear([System.Drawing.Color]::White)',
  '  $all = [System.Drawing.Rectangle]::new(0, 0, $w, $h)',
  '  $g.DrawImage($source, $all, $all, [System.Drawing.GraphicsUnit]::Pixel)',
  '  $g.Dispose()',
  '  $data = [System.Windows.Forms.DataObject]::new()',
  '  $data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $false, $flat)',
  "  if ($png) { $data.SetData('PNG', $false, [System.IO.MemoryStream]::new($bytes)) }",
  "  $data.SetData('ExcludeClipboardContentFromMonitorProcessing', $false, [System.IO.MemoryStream]::new([byte[]](0, 0, 0, 0)))",
  '  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 100)',
  "  'HALO_CLIP_OK'",
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

/* Windows' own PowerShell, by its full path when Windows says where it is:
   a bare name is looked for in the working directory first, and nothing
   that happens to be called powershell.exe there should be what runs. */
const POWERSHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

/** Exactly what is launched, for the tests to read: -STA for the
    clipboard, no profile (the person's own startup script has no business
    running here, and costs time), never waiting for input. */
export function launchArgs() {
  return ['-STA', '-NoProfile', '-NonInteractive', '-Command', SCRIPT];
}

/**
 * The real runner: a hidden process, killed if it outlives its timeout.
 * Resolves `{ code, stdout, stderr }` and never rejects — a PowerShell that
 * will not start is a picture that did not go, not an exception.
 */
export function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, options, (err, stdout, stderr) => resolve({
        code: err ? (Number.isInteger(err.code) ? err.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: Boolean(err?.killed),
      }));
    } catch (err) {
      resolve({ code: 1, stdout: '', stderr: String(err?.message ?? err) });
    }
  });
}

/**
 * Put a picture on the clipboard, as a picture. True when it is there,
 * false otherwise — never a throw — and on false nothing should be pasted:
 * whatever the clipboard holds then is not the picture.
 *
 * @param {string} dataUrl   data:image/(png|jpeg|webp|gif);base64,...
 * @param {object} [opts]
 * @param {(file: string, args: string[], options: object) => Promise<{code: number, stdout?: string}>} [opts.run]
 *        what launches the script; the real PowerShell unless a test says otherwise
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<boolean>}
 */
export async function writeImageToClipboard(dataUrl, { run = runProcess, timeoutMs = CLIPBOARD_TIMEOUT_MS } = {}) {
  const picture = decodeImageDataUrl(dataUrl);
  if (!picture) return false;
  const file = join(tmpdir(), `halo-clip-${process.pid}-${randomBytes(8).toString('hex')}.${picture.type === 'jpeg' ? 'jpg' : picture.type}`);
  let timer = null;
  try {
    await writeFile(file, picture.bytes, { flag: 'wx', mode: 0o600 });
    /* The runner is given the timeout, and the real one kills the process
       at it. The race is for any runner that does not: a paste waits on
       this, and nothing that never answers may hold it up for ever. It
       gives the runner's own kill a head start — a second, or the timeout
       again when that is shorter — so the real one always answers first. */
    const launched = Promise.resolve().then(() => run(POWERSHELL, launchArgs(), {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      env: { ...process.env, HALO_CLIP_FILE: file, HALO_CLIP_PNG: picture.type === 'png' ? '1' : '0' },
    }));
    const gaveUp = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: 1, timedOut: true }), timeoutMs + Math.min(1000, timeoutMs));
    });
    const result = await Promise.race([launched, gaveUp]);
    return Boolean(result) && result.code === 0 && /\bHALO_CLIP_OK\b/.test(String(result.stdout ?? ''));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    // Removed whatever happened. A process killed at its timeout can hold
    // the file for a moment after, so the removal is retried rather than
    // left behind in the temp folder.
    await rm(file, { force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
