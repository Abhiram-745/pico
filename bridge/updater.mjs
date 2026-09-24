/* ==========================================================================
   Updates

   Checks the rolling "latest" release, downloads it, and swaps it in.

   Two things it deliberately never touches:
     .env        your key
     *.exe       the Windows binaries, which are large and released separately

   The swap happens into a staging folder first, so a failed download or a
   half-written file can never leave a broken install behind.
   ========================================================================== */

import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

/* --- a copy that is a git checkout ------------------------------------------
   Run from a clone, a build.json is whatever was last stamped into the
   folder — measured here: a checkout at a2ca393 still calling itself
   2fce8cf, a fortnight stale, so the app said it was out of date and offered
   an update that would have unpacked a release zip over the working tree
   and every uncommitted change in it. A checkout is what git says it is,
   and it is brought up to date the way git brings things up to date. */
const IS_CHECKOUT = existsSync(join(ROOT, '.git'));

function git(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: ROOT, windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').pop()));
      else resolve(String(stdout).trim());
    });
  });
}

/** Read the build stamp shipped with this copy. */
export async function localBuild() {
  if (IS_CHECKOUT) {
    try {
      const [sha, date, changes] = await Promise.all([
        git(['rev-parse', '--short=7', 'HEAD']),
        git(['log', '-1', '--format=%cs']),
        git(['status', '--porcelain', '--untracked-files=no']),
      ]);
      return { sha, date, tag: 'checkout', checkout: true, dirty: Boolean(changes) };
    } catch { /* no git on the PATH: the stamp is the best there is */ }
  }
  try {
    return JSON.parse(await readFile(BUILD_FILE, 'utf8'));
  } catch {
    return { sha: 'dev', date: null, tag: 'dev' };
  }
}

/* The repository is private, and GitHub answers a private repository's
   release with 404 to anyone it does not know — which the app reported as
   "could not reach GitHub" forever. On a machine signed in to the GitHub CLI
   the same sign-in is used, and only ever sent to api.github.com. Asked once
   per run. */
let tokenAsked = null;
function githubToken() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return Promise.resolve(process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  tokenAsked ??= new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const t = String(stdout ?? '').trim();
      resolve(!err && /^[A-Za-z0-9_]{20,}$/.test(t) ? t : null);
    });
  });
  return tokenAsked;
}

async function githubHeaders(accept = 'application/vnd.github+json') {
  const token = await githubToken();
  return { Accept: accept, 'User-Agent': 'halo-updater', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/** A checkout: how far behind main it is, fetched with the person's own git. */
async function checkCheckout(current) {
  await git(['fetch', '--quiet', 'origin', 'main'], 60_000);
  const [latest, behind, published] = await Promise.all([
    git(['rev-parse', '--short=7', 'origin/main']),
    git(['rev-list', '--count', 'HEAD..origin/main']),
    git(['log', '-1', '--format=%cI', 'origin/main']),
  ]);
  const n = Number(behind) || 0;
  return {
    current,
    latest: { sha: latest, tag: 'main', published },
    available: n > 0,
    checkout: true,
    behind: n,
    url: null,
    size: 0,
    notes: n ? `${n} new change${n === 1 ? '' : 's'} on main` : '',
  };
}

/**
 * Is there a newer build than the one running?
 * @returns {{current, latest, available, url, size, notes}}
 */
export async function check() {
  const current = await localBuild();
  if (current.checkout) return checkCheckout(current);

  const res = await fetch(RELEASE_API, {
    headers: await githubHeaders(),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    throw new Error('GitHub did not show the release: the repository is private. Sign in with the GitHub CLI (gh auth login) on this computer, or make the repository public.');
  }
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
    api: zip.url,
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

  /* A checkout moves forward with git, which stops rather than overwrite a
     file changed here and not yet committed — work in progress survives. */
  if (info.checkout) {
    onProgress('downloading', 10);
    const before = await git(['rev-parse', 'HEAD']);
    try {
      await git(['pull', '--ff-only', '--quiet', 'origin', 'main'], 120_000);
    } catch (err) {
      throw new Error(`This copy is a git checkout and git would not update it (${err.message}). Commit or put aside the local changes, then try again.`);
    }
    const changed = await git(['diff', '--name-only', before, 'HEAD']).catch(() => '');
    if (/(^|\n)package(-lock)?\.json$/m.test(changed)) {
      onProgress('dependencies');
      await installDependencies();
    }
    onProgress('done', 100);
    return { installed: true, from: info.current.sha, to: info.latest.sha };
  }

  const work = await mkdtemp(join(tmpdir(), 'halo-update-'));
  const zipPath = join(work, 'update.zip');

  try {
    onProgress('downloading', 0);
    /* Signed in, the file comes through the API, which is the only way to
       a private repository's download; GitHub hands back a signed link to
       the file itself and the sign-in does not travel with it. */
    const signedIn = Boolean(await githubToken()) && info.api;
    const res = await fetch(signedIn ? info.api : info.url, {
      headers: signedIn ? await githubHeaders('application/octet-stream') : { 'User-Agent': 'halo-updater' },
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
    /* npm is a .cmd on Windows, which only starts through a shell — and Node
       warns (DEP0190) about a shell handed an argument list, since it joins
       them unescaped. So on Windows it is one fixed command line, with
       nothing in it from outside. */
    const args = ['install', '--omit=dev', '--no-audit', '--no-fund'];
    const options = { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] };
    const p = process.platform === 'win32'
      ? spawn(`npm ${args.join(' ')}`, { ...options, shell: true })
      : spawn('npm', args, options);
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
