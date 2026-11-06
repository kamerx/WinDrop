'use strict';
// Bağımlılıksız QR kodlayıcı: bayt modu, hata düzeltme seviyesi M, sürüm 1-10.

// Seviye M için sürüm başına: blok başına EC kod sözcüğü ve [blok sayısı, blok başına veri] grupları.
const M_TABLE = {
  1: { ec: 10, groups: [[1, 16]] },
  2: { ec: 16, groups: [[1, 28]] },
  3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] },
  5: { ec: 24, groups: [[2, 43]] },
  6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] },
  8: { ec: 22, groups: [[2, 38], [2, 39]] },
  9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] },
};

// Hizalama deseni merkez koordinatları.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

function dataCodewords(v) {
  return M_TABLE[v].groups.reduce((s, [n, k]) => s + n * k, 0);
}

function capacityBytes(v) {
  const countBits = v <= 9 ? 8 : 16;
  return Math.floor((dataCodewords(v) * 8 - 4 - countBits) / 8);
}

// --- GF(256) Reed-Solomon ---
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// --- Veri kodlama ---
function buildCodewords(bytes, v) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, v <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = dataCodewords(v) * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  for (let pad = 0xec; data.length < dataCodewords(v); pad ^= 0xec ^ 0x11) data.push(pad);

  // Bloklara böl, EC hesapla, iç içe geçir.
  const { ec, groups } = M_TABLE[v];
  const divisor = rsDivisor(ec);
  const blocks = [];
  let k = 0;
  for (const [n, len] of groups) {
    for (let i = 0; i < n; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ d, e: rsRemainder(d, divisor) });
    }
  }
  const out = [];
  const maxLen = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// --- Matris ---
function makeMatrix(v) {
  const size = 17 + 4 * v;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  return { size, mod, fn, set };
}

function drawFunctionPatterns(m, v) {
  const { size, set } = m;
  // Zamanlama çizgileri
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Bulucu desenler (ayırıcılarla birlikte)
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Hizalama desenleri: YALNIZCA üç bulucu köşesindekiler atlanır.
  // Zamanlama çizgisinin üstündekiler (ör. sürüm 7'de (6,22)) çizilmelidir.
  const pos = ALIGN[v];
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormat(m, 0); // yer ayırmak için geçici
  if (v >= 7) {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }
}

function drawFormat(m, mask) {
  const { size, set } = m;
  const data = (0 << 3) | mask; // M seviyesi = 00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // karanlık modül
}

function drawCodewords(m, cw) {
  const { size, mod, fn } = m;
  let i = 0;
  const total = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) {
          mod[y][x] = i < total ? ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
          i++;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, k) {
  const { size, mod, fn } = m;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) mod[y][x] = !mod[y][x];
}

function penalty(mod) {
  const size = mod.length;
  let p = 0;
  const lineScore = (get) => {
    let s = 0;
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b <= size; b++) {
        if (b < size && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      // 1:1:3:1:1 deseni, iki yanında 4 açık modülle
      for (let b = 0; b + 10 < size + 0; b++) {
        const seq = [];
        for (let t = 0; t < 11; t++) seq.push(get(a, b + t) ? 1 : 0);
        const s1 = seq.join('');
        if (s1 === '10111010000' || s1 === '00001011101') s += 40;
      }
    }
    return s;
  };
  p += lineScore((a, b) => mod[a][b]);
  p += lineScore((a, b) => mod[b][a]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
    }
  }
  let dark = 0;
  for (const row of mod) for (const c of row) if (c) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  p += Math.max(0, k) * 10;
  return p;
}

function encode(text, opts = {}) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  const minV = opts.minVersion || 1;
  let v = minV;
  while (v <= 10 && capacityBytes(v) < bytes.length) v++;
  if (v > 10) throw new Error('QR için metin çok uzun (en çok ' + capacityBytes(10) + ' bayt)');
  const cw = buildCodewords(bytes, v);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = makeMatrix(v);
    drawFunctionPatterns(m, v);
    drawCodewords(m, cw);
    applyMask(m, mask);
    drawFormat(m, mask);
    const score = penalty(m.mod);
    if (!best || score < best.score) best = { score, mask, modules: m.mod };
  }
  return { version: v, size: 17 + 4 * v, mask: best.mask, modules: best.modules };
}

function toSvg(text, { margin = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = encode(text);
  const full = size + margin * 2;
  let d = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges">` +
    `<rect width="${full}" height="${full}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}

module.exports = { encode, toSvg, capacityBytes };
