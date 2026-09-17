/* ==========================================================================
   Updates

   Checks the rolling "latest" release, downloads it, and swaps it in.

   Two things it deliberately never touches:
     .env        your key
     *.exe       the Windows binaries, which are large and released separately

   The swap happens into a staging folder first, so a failed download or a
   half-written file can never leave a broken install behind.
   ========================================================================== */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, cp, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_FILE = join(ROOT, 'build.json');

const REPO = 'Abhiram-745/pico';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Files and folders an update must never overwrite. */
const PRESERVE = new Set(['.env', 'settings.json', 'audit.jsonl']);

/** Read the build stamp shipped with this copy. */
export async function localBuild() {
  try {
    return JSON.parse(await readFile(BUILD_FILE, 'utf8'));
  } catch {
    return { sha: 'dev', date: null, tag: 'dev' };
  }
}

/**
 * Is there a newer build than the one running?
 * @returns {{current, latest, available, url, size, notes}}
 */
export async function check() {
  const current = await localBuild();

  const res = await fetch(RELEASE_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'halo-updater' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Could not reach GitHub (HTTP ${res.status}).`);
  const rel = await res.json();

  const zip = (rel.assets || []).find((a) => /^Halo-latest\.zip$/i.test(a.name));
  if (!zip) throw new Error('That release has no downloadable build attached.');

  // The workflow stamps the short SHA into the release body.
  const m = /build\s+`?([0-9a-f]{7,40})`?/i.exec(rel.body || '');
  const latestSha = m ? m[1] : rel.target_commitish?.slice(0, 7) || null;

  return {
    current,
    latest: { sha: latestSha, tag: rel.tag_name, published: rel.published_at },
    available: Boolean(latestSha) && latestSha !== current.sha,
    url: zip.browser_download_url,
    size: zip.size,
    notes: rel.body || '',
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
  });
}

/** PowerShell ships on every supported Windows; Node has no unzip built in. */
async function unzip(zipPath, destDir) {
  await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' ` +
    `-DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ]);
}

/**
 * Download and install the latest build.
 * @param {(stage: string, pct?: number) => void} onProgress
 */
export async function install(onProgress = () => {}) {
  const info = await check();
  if (!info.available) return { installed: false, reason: 'Already up to date.' };

  const work = await mkdtemp(join(tmpdir(), 'halo-update-'));
  const zipPath = join(work, 'update.zip');

  try {
    onProgress('downloading', 0);
    const res = await fetch(info.url, {
      headers: { 'User-Agent': 'halo-updater' },
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}).`);

    const total = Number(res.headers.get('content-length')) || info.size || 0;
    let seen = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      seen += chunk.length;
      if (total) onProgress('downloading', Math.min(99, Math.round((seen / total) * 100)));
    });
    await pipeline(body, createWriteStream(zipPath));

    onProgress('extracting');
    const staged = join(work, 'staged');
    await unzip(zipPath, staged);

    // The zip contains a single top-level "Halo" folder.
    let source = join(staged, 'Halo');
    try { await stat(source); } catch { source = staged; }

    onProgress('installing');
    // cp with force overwrites in place; PRESERVE keeps local state.
    await cp(source, ROOT, {
      recursive: true,
      force: true,
      filter: (src) => {
        const name = src.slice(source.length + 1);
        if (!name) return true;
        const top = name.split(/[\\/]/)[0];
        return !PRESERVE.has(top) && !top.endsWith('.exe');
      },
    });

    /* A build can need packages the last one did not — the interface moving
       to React did — and copying files over does not install anything. An
       update that restarts into a missing module is a Halo that will not
       start, so the dependencies are brought up to date before it is called
       installed. */
    onProgress('dependencies');
    await installDependencies();

    onProgress('done', 100);
    return { installed: true, from: info.current.sha, to: info.latest.sha };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** `npm install --omit=dev` in the install folder. Rejects with npm's own words. */
function installDependencies() {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const p = spawn(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: ROOT, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.once('error', reject);
    p.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Installing packages failed: ${err.trim().split('\n').pop() || `npm exited ${code}`}`))));
  });
}

/** Used by the dev flow to stamp a build locally. */
export async function writeBuild(stamp) {
  await writeFile(BUILD_FILE, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8');
}
