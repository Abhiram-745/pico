/* ==========================================================================
   Compact QR encoder — byte mode, EC level L, versions 1-5.

   Scoped deliberately: a pairing URL is ~40-60 characters, and versions 1-5 at
   EC level L are all single-block, which removes the interleaving table that
   makes general QR encoders long. Capacity here tops out at 108 bytes.

   Returns a boolean matrix so the same code can render to a terminal (Node)
   and to SVG (browser).
   ========================================================================== */

/* total codewords, data codewords (EC-L), EC codewords, alignment centre */
const VERSIONS = {
  1: { total: 26,  data: 19,  ec: 7,  align: [] },
  2: { total: 44,  data: 34,  ec: 10, align: [6, 18] },
  3: { total: 70,  data: 55,  ec: 15, align: [6, 22] },
  4: { total: 100, data: 80,  ec: 20, align: [6, 26] },
  5: { total: 134, data: 108, ec: 26, align: [6, 30] },
};

/* ---- GF(256), primitive polynomial 0x11d ------------------------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` EC codewords. */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= mul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function reedSolomon(data, ecCount) {
  const gen = generator(ecCount);
  const res = new Array(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecCount; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

/* ---- bit stream --------------------------------------------------------- */
class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() { return this.bits.length; }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      out.push(b);
    }
    return out;
  }
}

/* ---- matrix ------------------------------------------------------------- */
function finder(m, reserved, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const y = row + r, x = col + c;
      if (y < 0 || y >= m.length || x < 0 || x >= m.length) continue;
      const edge = r === -1 || r === 7 || c === -1 || c === 7;
      const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[y][x] = !edge && (ring || core);
      reserved[y][x] = true;
    }
  }
}

function buildMatrix(version, codewords, mask) {
  const size = 21 + (version - 1) * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  finder(m, reserved, 0, 0);
  finder(m, reserved, 0, size - 7);
  finder(m, reserved, size - 7, 0);

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i] = m[i][6] = i % 2 === 0;
    reserved[6][i] = reserved[i][6] = true;
  }

  // alignment patterns
  const centres = VERSIONS[version].align;
  for (const r of centres) {
    for (const c of centres) {
      // skip the three finder corners
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          reserved[r + dr][c + dc] = true;
        }
      }
    }
  }

  // format-info areas + the always-dark module
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  m[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // --- data placement: upward/downward columns, right to left ---
  const maskFn = MASKS[mask];
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                 // skip the vertical timing column
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        if (reserved[y][x]) continue;
        let bit = false;
        if (bitIndex < totalBits) {
          bit = ((codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        m[y][x] = bit !== maskFn(y, x);        // XOR the mask
      }
    }
    upward = !upward;
  }

  placeFormat(m, size, mask);
  return m;
}

/* EC level L = 01; 15-bit format string with BCH(15,5) + 0x5412 mask */
function placeFormat(m, size, mask) {
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const at = (i) => ((bits >> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) m[8][i] = at(i);
  m[8][7] = at(6);
  m[8][8] = at(7);
  m[7][8] = at(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = at(i);

  // Second copy: bits 0-6 run up the left column, bits 7-14 run along row 8.
  // Bit 7 must NOT land on (size-8, 8) — that module is the permanent dark
  // module, and writing it here silently corrupts the format information.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = at(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = at(i);
}

const MASKS = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

/** Standard penalty scoring, used to pick the most scannable mask. */
function penalty(m) {
  const n = m.length;
  let score = 0;

  // rule 1: runs of 5+ same-colour modules
  for (let i = 0; i < n; i++) {
    for (const line of [m[i], m.map((r) => r[i])]) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // rule 2: 2x2 blocks
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
  }

  // rule 3: finder-like 1:1:3:1:1 patterns
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  const hit = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
  for (let i = 0; i < n; i++) {
    const row = m[i], col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= n; j++) {
      if (hit(row, j, P1) || hit(row, j, P2)) score += 40;
      if (hit(col, j, P1) || hit(col, j, P2)) score += 40;
    }
  }

  // rule 4: deviation from 50% dark
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;

  return score;
}

/**
 * Encode text as a QR matrix.
 * @returns {boolean[][]} true = dark module
 */
export function encode(text) {
  const bytes = Array.from(new TextEncoder().encode(text));

  const version = Number(Object.keys(VERSIONS).find((v) => {
    // 4 mode bits + 8 count bits + payload must fit the data capacity
    return bytes.length + 2 <= VERSIONS[v].data;
  }));

  if (!version) {
    throw new Error(`QR payload too long: ${bytes.length} bytes (max 106)`);
  }

  const { data: dataCount, ec: ecCount } = VERSIONS[version];

  const bits = new Bits();
  bits.push(0b0100, 4);           // byte mode
  bits.push(bytes.length, 8);     // count indicator is 8 bits for v1-9
  for (const b of bytes) bits.push(b, 8);

  // terminator, then pad to a byte boundary
  const capacity = dataCount * 8;
  bits.push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0, 1);

  const words = bits.toBytes();
  const PADS = [0xec, 0x11];
  for (let i = 0; words.length < dataCount; i++) words.push(PADS[i % 2]);

  const codewords = [...words, ...reedSolomon(words, ecCount)];

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(version, codewords, mask);
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = m; }
  }
  return best;
}

/** Render to block characters for a terminal. */
export function toTerminal(matrix, quiet = 2) {
  const n = matrix.length;
  const get = (y, x) =>
    y < 0 || x < 0 || y >= n || x >= n ? false : matrix[y][x];

  const lines = [];
  for (let y = -quiet; y < n + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < n + quiet; x++) {
      const top = get(y, x);
      const bottom = get(y + 1, x);
      // dark module -> filled; terminals render this correctly in both themes
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Render to a standalone SVG string. */
export function toSVG(matrix, { quiet = 2, size = 240 } = {}) {
  const n = matrix.length;
  const total = n + quiet * 2;
  let path = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
