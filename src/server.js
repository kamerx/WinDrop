'use strict';
// WinDrop sunucusu – yalnızca Node.js standart kütüphanesi.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const dgram = require('node:dgram');
const { spawn, spawnSync } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const qr = require('./qr');
const mdnsLib = require('./mdns');
const toastLib = require('./toast');

// Tek exe (Node SEA) içinde mi çalışıyoruz? Öyleyse sayfalar exe'ye gömülüdür.
let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { sea = null; }
const VERSION = '1.3.1';
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
function defaultDataDir() {
  if (sea) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WinDrop', 'data');
  return path.join(ROOT, 'data');
}

const assetCache = new Map();
function readAsset(name) {
  if (sea) {
    if (!assetCache.has(name)) {
      try { assetCache.set(name, Buffer.from(sea.getAsset(name))); } catch { assetCache.set(name, null); }
    }
    return assetCache.get(name);
  }
  try { return fs.readFileSync(path.join(PUBLIC_DIR, name)); } catch { return null; }
}
function hasAsset(name) {
  return sea ? !!readAsset(name) : fs.existsSync(path.join(PUBLIC_DIR, name));
}

function slugHost(h) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', i: 'i', ö: 'o', ş: 's', ü: 'u' };
  return String(h || '').toLocaleLowerCase('tr-TR').replace(/[çğıiöşü]/g, (c) => map[c] || c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}
const DEFAULT_PORT = 8765;
const MAX_CHUNK = 16 * 1024 * 1024;
const TMP_DIR_NAME = '.windrop-tmp';
const TMP_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SPACE_MARGIN = 64 * 1024 * 1024;
const MDNS_NAME = 'windrop.local';
const BUSY_TAKEOVER_MS = 4000;

// ---------------------------------------------------------------- yardımcılar
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// OneDrive gibi araçlar dosyayı kısa süre kilitleyebilir: birkaç kez dene.
function writeJsonSafe(file, obj, log = () => {}) {
  const data = JSON.stringify(obj, null, 2);
  const tmp = `${file}.${process.pid}.tmp`;
  for (let i = 0; i < 6; i++) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      if (i === 5) {
        try { fs.writeFileSync(file, data); try { fs.rmSync(tmp, { force: true }); } catch {} return true; } catch (e2) {
          log('error', `Yazılamadı: ${file}: ${e2.message}`);
          return false;
        }
      }
      sleepSync(60);
    }
  }
  return false;
}

function localStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Ayar klasörüne yazılamazsa olaylar geçici klasördeki bu dosyaya düşer; sorunun izi kaybolmaz.
function fallbackLog(line) {
  try { fs.appendFileSync(path.join(os.tmpdir(), 'WinDrop-hata.log'), line); } catch { /* yapacak başka bir şey yok */ }
}

function createLogger(file, toStdout) {
  return function log(level, ...parts) {
    let line = '';
    try {
      const msg = parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
      line = `${localStamp()} [${level}] ${msg}\n`;
      try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1'); } catch {}
      fs.appendFileSync(file, line);
      if (toStdout) process.stdout.write(line);
    } catch (e) {
      if (line) fallbackLog(`${line.trimEnd()}  [günlük yazılamadı: ${file}: ${e.code || e.message}]\n`);
    }
  };
}

// ------------------------------------------------------------- eşleşme kodu
// Kod üç yerde tutulur: config.json, config.json.bak ve (kurulu programda) kayıt defteri.
// Okunamayan bir ayar dosyası yüzünden kod asla sessizce değişmez.
const REG_KEY = 'HKCU\\Software\\WinDrop';

function readRegistryToken() {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('reg.exe', ['query', REG_KEY, '/v', 'PairingCode'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = r.status === 0 && /PairingCode\s+REG_SZ\s+([0-9a-f]{16})/i.exec(r.stdout || '');
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

function writeRegistryToken(token, log) {
  try {
    const p = spawn('reg.exe', ['add', REG_KEY, '/v', 'PairingCode', '/t', 'REG_SZ', '/d', token, '/f'], { windowsHide: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.on('exit', (c) => { if (c !== 0) log('warn', 'Eşleşme kodunun kayıt defteri yedeği yazılamadı'); });
  } catch { /* yedek yazılamazsa ana dosya yine geçerli */ }
}

function loadConfig(configFile, log, useRegistry) {
  const exists = fs.existsSync(configFile);
  let cfg = null, lastErr = null, changed = false;
  if (exists) {
    // Windows açılırken dosya kısa süre erişilemez olabilir: birkaç kez dene.
    for (let i = 0; i < 10 && !cfg; i++) {
      try {
        const c = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (c && typeof c === 'object' && !Array.isArray(c)) cfg = c;
        else throw new Error('geçersiz içerik');
      } catch (e) { lastErr = e; if (i < 9) sleepSync(300); }
    }
    if (!cfg) {
      log('error', `Ayar dosyası okunamadı: ${lastErr && (lastErr.code || lastErr.message)}`);
      // Üzerine yazılmadan önce bozuk dosyanın bir kopyası saklanır (nedenini anlamak için).
      try { fs.copyFileSync(configFile, `${configFile}.bozuk-${Date.now()}`); } catch {}
      const bak = readJson(configFile + '.bak', null);
      if (bak && typeof bak === 'object' && /^[0-9a-f]{16}$/.test(String(bak.token || ''))) {
        cfg = bak;
        changed = true;
        log('warn', 'Ayarlar yedek dosyadan geri yüklendi, eşleşme kodu korundu');
      }
    }
  }
  const regToken = useRegistry ? readRegistryToken() : null;
  if (!cfg) {
    if (exists && !regToken) {
      const e = new Error('Ayar dosyası okunamıyor ve yedeği yok. Eşleşme kodunu değiştirmemek için WinDrop başlatılmadı.');
      e.code = 'CONFIG_UNREADABLE';
      throw e;
    }
    cfg = {};
    changed = true;
  }
  if (!/^[0-9a-f]{16}$/.test(String(cfg.token || ''))) {
    if (regToken) {
      cfg.token = regToken;
      log('warn', 'Eşleşme kodu kayıt defterindeki yedekten geri yüklendi');
    } else {
      cfg.token = crypto.randomBytes(8).toString('hex');
      log('info', 'Yeni eşleşme kodu üretildi');
    }
    changed = true;
  }
  return { cfg, changed, regToken };
}

function formatCode(token) {
  return String(token).toUpperCase().match(/.{1,4}/g).join('-');
}

// ----------------------------------------------------------- adres denetimi
function normalizeAddr(addr) {
  let a = String(addr || '').toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) a = a.slice(7);
  const pct = a.indexOf('%');
  if (pct !== -1) a = a.slice(0, pct);
  return a;
}

function isPrivateAddress(addr) {
  const a = normalizeAddr(addr);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (m) {
    const o1 = +m[1], o2 = +m[2];
    return o1 === 127 || o1 === 10 || (o1 === 172 && o2 >= 16 && o2 <= 31) ||
      (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  if (a === '::1') return true;
  if (/^fe[89ab][0-9a-f]?:/.test(a)) return true; // fe80::/10 bağlantı-yerel
  if (/^f[cd][0-9a-f]{0,2}:/.test(a)) return true; // fc00::/7 benzersiz yerel
  return false;
}

function isLoopback(addr) {
  const a = normalizeAddr(addr);
  return /^127\./.test(a) || a === '::1';
}

function hostIsLocal(host) {
  return /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i.test(String(host || ''));
}

// ------------------------------------------------------------- dosya adları
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

function splitExt(name) {
  // En az bir harf içermeli: "saat 11.34.16" gibi adlardaki ".16" uzantı sayılmaz.
  const m = /^(.*?)(\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10})$/.exec(name);
  if (!m || !m[1]) return { base: name, ext: '' };
  return { base: m[1], ext: m[2] };
}

function sanitizeName(input, maxLen = 150) {
  let s = String(input == null ? '' : input);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  s = s.normalize('NFC');
  s = s.split(/[\\/]/).pop();                                   // yol bölümlerini at
  s = s.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_');          // yasak ve kontrol karakterleri
  s = s.replace(/[‪-‮⁦-⁩‎‏]/g, '_'); // yön değiştirici karakterler (uzantı gizleme)
  s = s.replace(/^[.\s]+/, '');                                 // baştaki nokta ve boşluk
  s = s.replace(/[.\s]+$/, '');                                 // Windows sondaki nokta/boşluğu sessizce siler
  if (!s) s = 'dosya';
  const stem = s.split('.')[0].trim();
  if (RESERVED.test(stem)) s = '_' + s;
  const chars = Array.from(s);
  if (chars.length > maxLen) {
    const { base, ext } = splitExt(s);
    const keep = Math.max(1, maxLen - Array.from(ext).length);
    s = Array.from(base).slice(0, keep).join('').replace(/[.\s]+$/, '') + ext;
  }
  return s;
}

function sniffExt(b) {
  if (!b || b.length < 3) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return '.gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return '.heic';
    if (brand === 'qt  ') return '.mov';
    return '.mp4';
  }
  return '';
}

function decodeHeaderName(v) {
  if (v == null) return '';
  let s = Array.isArray(v) ? String(v[0]) : String(v);
  // Node başlık baytlarını latin1 okur; geçerli UTF-8 ise geri çevir.
  if (/[\u0080-ÿ]/.test(s) && !/[^\u0000-ÿ]/.test(s)) {
    const t = Buffer.from(s, 'latin1').toString('utf8');
    if (!t.includes('�')) s = t;
  }
  if (/%[0-9a-f]{2}/i.test(s)) { try { s = decodeURIComponent(s); } catch {} }
  return s.trim();
}

function filenameFromDisposition(v) {
  if (!v) return '';
  const s = String(v);
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(s);
  if (m) { try { return decodeURIComponent(m[1].trim()); } catch {} }
  m = /filename\s*=\s*"([^"]*)"/.exec(s) || /filename\s*=\s*([^;]+)/.exec(s);
  return m ? decodeHeaderName(m[1].trim()) : '';
}

// Aynı ada asla üstüne yazma: "ad (2).uzantı". Sabit bağlantı (link) varsa varolanı hata verir; atomiktir.
async function moveUnique(src, dir, name) {
  const { base, ext } = splitExt(name);
  for (let n = 1; n < 100000; n++) {
    const cand = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`);
    try {
      await fsp.link(src, cand);
      await fsp.rm(src, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      return cand;
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      if (['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS', 'EACCES'].includes(e.code)) {
        try { await fsp.access(cand); continue; } catch {}
        await fsp.rename(src, cand);
        return cand;
      }
      throw e;
    }
  }
  throw new Error('Benzersiz ad bulunamadı');
}

async function freeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

// ------------------------------------------------------------------ simge
function iconRgba(size, { rounded = false, gray = false } = {}) {
  const SS = size <= 64 ? 6 : 3;
  const px = Buffer.alloc(size * size * 4);
  const small = size < 24;
  const cx = 0.5, cy = small ? 0.53 : 0.535;
  const dotR = small ? 0.095 : 0.068;
  const rings = small ? [0.235, 0.385] : [0.175, 0.275, 0.375];
  const hw = (small ? 0.095 : 0.05) / 2;
  const gap = ((small ? 48 : 40) * Math.PI) / 180; // altta yarım açıklık açısı
  const corner = 0.225;
  const top = gray ? [0xa3, 0xa8, 0xb0] : [0x50, 0x95, 0xfb];
  const bot = gray ? [0x7f, 0x85, 0x8e] : [0x3a, 0x7b, 0xf5];
  const caps = rings.map((r) => [Math.PI / 2 - gap, Math.PI / 2 + gap].map((a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]));
  const isWhite = (u, v) => {
    const dx = u - cx, dy = v - cy;
    const d = Math.hypot(dx, dy);
    if (d <= dotR) return true;
    for (let k = 0; k < rings.length; k++) {
      if (Math.abs(d - rings[k]) <= hw && Math.abs(Math.atan2(dy, dx) - Math.PI / 2) > gap) return true;
      for (const [qx, qy] of caps[k]) if (Math.hypot(u - qx, v - qy) <= hw) return true;
    }
    return false;
  };
  const inShape = (u, v) => {
    if (!rounded) return true;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - corner), 0);
    const qy = Math.max(Math.abs(v - 0.5) - (0.5 - corner), 0);
    return Math.hypot(qx, qy) <= corner;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = 0, white = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (!inShape(u, v)) continue;
          inside++;
          if (isWhite(u, v)) white++;
        }
      }
      const i = (y * size + x) * 4;
      if (!inside) continue;
      const t = (y + 0.5) / size;
      const wf = white / inside;
      for (let c = 0; c < 3; c++) {
        const g = top[c] + (bot[c] - top[c]) * t;
        px[i + c] = Math.round(g + (255 - g) * wf);
      }
      px[i + 3] = Math.round((255 * inside) / (SS * SS));
    }
  }
  return px;
}

function encodePng(w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeIconPng(size, opts) { return encodePng(size, size, iconRgba(size, opts)); }

function makeIco(sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
  const pngs = sizes.map((s) => makeIconPng(s, { rounded: true }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    entries.push(e);
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

function writeIcons(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const png = path.join(dataDir, 'icon.png');
  const ico = path.join(dataDir, 'windrop.ico');
  fs.writeFileSync(png, makeIconPng(256, { rounded: true }));
  fs.writeFileSync(ico, makeIco());
  return { png, ico };
}

// ---------------------------------------------------------- İndirilenler yolu
function expandEnv(s) {
  return s.replace(/%([^%]+)%/g, (m, n) => {
    const k = Object.keys(process.env).find((x) => x.toLowerCase() === n.toLowerCase());
    return k ? process.env[k] : m;
  });
}

function findDownloads() {
  const fallback = path.join(process.env.USERPROFILE || os.homedir(), 'Downloads');
  if (process.platform !== 'win32') return fallback;
  try {
    const script = "$k = Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -ErrorAction Stop; " +
      "$v = [string]$k.GetValue('{374DE290-123F-4565-9140-6D6B6F0A5F2F}', '', 'DoNotExpandEnvironmentNames'); " +
      '$b = [Text.Encoding]::UTF8.GetBytes($v); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush()';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000 });
    const raw = r.status === 0 && r.stdout ? r.stdout.toString('utf8').trim() : '';
    if (raw) {
      const p = expandEnv(raw);
      if (!p.includes('%') && path.isAbsolute(p)) return p;
    }
  } catch {}
  return fallback;
}

// ------------------------------------------------------------- HTTP yanıtları
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function sendJson(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(String(text) + '\n', 'utf8');
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendBuffer(req, res, buf, type, cache = 'no-cache') {
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': cache });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

async function sendAsset(req, res, name, type, extra = {}) {
  const buf = readAsset(name);
  if (!buf) return sendText(res, 404, 'Bulunamadı');
  const size = buf.length;
  let start = 0, end = size - 1, status = 200;
  const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ...extra };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
    if (start > end || start >= size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  res.end(buf.subarray(start, end + 1));
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.3gp': 'video/3gpp',
};

// Diskteki bir dosyayı parça (Range) desteğiyle sunar; video ileri sarılabilsin diye.
async function sendFileRange(req, res, file, type) {
  let st;
  try { st = await fsp.stat(file); } catch { return sendText(res, 404, 'Dosya bulunamadı'); }
  const size = st.size;
  let start = 0, end = size - 1, status = 200;
  const headers = { ...BASE_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range).trim());
  if (req.headers.range) {
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const rs = fs.createReadStream(file, { start, end });
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > limit) { done = true; req.resume(); const e = new Error('Gövde çok büyük'); e.code = 'TOO_BIG'; return reject(e); }
      parts.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    req.on('close', () => { if (!done) { done = true; const e = new Error('Bağlantı kesildi'); e.code = 'ABORTED'; reject(e); } });
  });
}

// =================================================================== uygulama
function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.WINDROP_DATA || defaultDataDir());
  fs.mkdirSync(dataDir, { recursive: true });
  const log = createLogger(path.join(dataDir, 'windrop.log'), !!process.env.WINDROP_STDOUT);
  const configFile = path.join(dataDir, 'config.json');
  const receivedFile = path.join(dataDir, 'received.json');

  // Kayıt defteri yedeği yalnızca kurulu programın varsayılan ayar klasöründe kullanılır;
  // testler ve geliştirme sürümü gerçek kodu etkilemez.
  const useRegistry = !!sea && process.platform === 'win32' && !process.env.WINDROP_NO_REGISTRY &&
    path.resolve(defaultDataDir()).toLowerCase() === dataDir.toLowerCase();
  const loaded = loadConfig(configFile, log, useRegistry);
  const cfg = loaded.cfg;
  let cfgChanged = loaded.changed;
  if (!cfg.dest || typeof cfg.dest !== 'string') { cfg.dest = findDownloads(); cfgChanged = true; }
  cfg.dest = path.resolve(cfg.dest);
  const destLabel = path.basename(cfg.dest).toLowerCase() === 'downloads' ? 'İndirilenler' : path.basename(cfg.dest);

  let received = readJson(receivedFile, []);
  if (!Array.isArray(received)) received = [];

  const noToast = !!process.env.WINDROP_NO_TOAST || options.noToast;
  const noMdns = !!process.env.WINDROP_NO_MDNS || options.noMdns;
  const notifier = toastLib.createNotifier({ dataDir, destDir: cfg.dest, destLabel, log, enabled: !noToast });

  const icons = {
    touch: makeIconPng(180),
    favicon: makeIconPng(64, { rounded: true }),
  };

  const sessions = new Map();  // id -> sayfa yüklemesi
  const transfers = new Map(); // panel için canlı ilerleme
  const qrCache = new Map();
  let mdns = null;
  let routeIp = null;
  let lastReceivedAt = 0;
  let actualPort = null;
  let moveChain = Promise.resolve();
  let tmpReadyFor = null;

  const tmpDir = () => path.join(cfg.dest, TMP_DIR_NAME);
  const partPath = (id) => path.join(tmpDir(), `${id}.part`);
  const metaPath = (id) => path.join(tmpDir(), `${id}.json`);
  const safeUrl = (u) => String(u || '').split(cfg.token).join('<token>');

  function enqueueMove(fn) {
    const p = moveChain.then(fn, fn);
    moveChain = p.catch(() => {});
    return p;
  }

  async function ensureTmp() {
    const dir = tmpDir();
    if (tmpReadyFor === dir && fs.existsSync(dir)) return dir;
    await fsp.mkdir(dir, { recursive: true });
    if (process.platform === 'win32') {
      await new Promise((r) => {
        try {
          const p = spawn('attrib.exe', ['+h', dir], { windowsHide: true, stdio: 'ignore' });
          p.on('error', () => r()); p.on('exit', () => r());
        } catch { r(); }
      });
    }
    tmpReadyFor = dir;
    return dir;
  }

  async function cleanupTmp() {
    let names = [];
    try { names = await fsp.readdir(tmpDir()); } catch { return; }
    for (const n of names) {
      const p = path.join(tmpDir(), n);
      try {
        const st = await fsp.stat(p);
        if (Date.now() - st.mtimeMs > TMP_MAX_AGE_MS) {
          await fsp.rm(p, { force: true, recursive: true, maxRetries: 3 });
          sessions.delete(n.replace(/\.(part|json)$/, ''));
          log('info', `Eski geçici dosya silindi: ${n}`);
        }
      } catch {}
    }
  }

  function fileStill(e) {
    try { return fs.statSync(e.path).size === e.size; } catch { return false; }
  }
  function findDone(id) {
    for (let i = received.length - 1; i >= 0; i--) if (received[i].id === id && fileStill(received[i])) return received[i];
    return null;
  }
  function findDoneHash(sha, size) {
    for (let i = received.length - 1; i >= 0; i--) {
      const e = received[i];
      if (e.sha256 === sha && e.size === size && fileStill(e)) return e;
    }
    return null;
  }

  function record({ id = null, sha256 = null, name, finalPath, size, from, via }) {
    const entry = {
      rid: crypto.randomBytes(6).toString('hex'), id, sha256,
      name: name || path.basename(finalPath), savedAs: path.basename(finalPath), path: finalPath,
      size, time: Date.now(), from: normalizeAddr(from), via,
    };
    received.push(entry);
    if (received.length > 1000) received.splice(0, received.length - 1000);
    writeJsonSafe(receivedFile, received, log);
    lastReceivedAt = entry.time;
    log('info', `ALINDI "${entry.savedAs}" ${size} bayt (${via}, ${entry.from})`);
    try { notifier.add({ path: finalPath, name: entry.savedAs, size }); } catch (e) { log('warn', `Bildirim kuyruğu: ${e.message}`); }
    return entry;
  }

  function bump(t, n) {
    const now = Date.now();
    t.received += n;
    t.lastAt = now;
    if (!t.rateAt) { t.rateAt = now; t.rateBytes = t.received; return; }
    if (now - t.rateAt >= 700) {
      const inst = ((t.received - t.rateBytes) * 1000) / (now - t.rateAt);
      t.rate = t.rate ? t.rate * 0.6 + inst * 0.4 : inst;
      t.rateAt = now; t.rateBytes = t.received;
    }
  }

  async function loadSession(id) {
    let s = sessions.get(id);
    if (s) return s;
    const meta = readJson(metaPath(id), null);
    if (!meta) return null;
    let offset;
    try { offset = (await fsp.stat(partPath(id))).size; } catch { return null; }
    s = { id, name: meta.name, size: meta.size, lastModified: meta.lastModified || 0, key: meta.key || '', offset, busy: null, lastAt: Date.now() };
    sessions.set(id, s);
    return s;
  }

  function transferFor(s) {
    let t = transfers.get(s.id);
    if (!t) {
      t = { key: s.id, name: s.name, size: s.size, received: s.offset, started: Date.now(), lastAt: Date.now(), rate: 0, via: 'sayfa' };
      transfers.set(s.id, t);
    }
    return t;
  }

  // ------------------------------------------------------------ uç noktalar
  async function handleBegin(req, res, remote) {
    let body;
    try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch (e) {
      if (e.code === 'ABORTED') return;
      return sendJson(res, 400, { error: 'Geçersiz istek gövdesi' });
    }
    const name = typeof body.name === 'string' ? body.name : '';
    const size = Number(body.size);
    const lastModified = Number(body.lastModified) > 0 ? Number(body.lastModified) : 0;
    const key = body.key == null ? '' : String(body.key).slice(0, 500);
    if (!name || name.length > 2000 || !Number.isSafeInteger(size) || size < 0) return sendJson(res, 400, { error: 'Ad veya boyut geçersiz' });
    const id = crypto.createHash('sha256').update(`${name}\u0000${size}\u0000${key}`).digest('hex').slice(0, 32);

    const prev = findDone(id);
    if (prev) return sendJson(res, 200, { id, done: true, savedAs: prev.savedAs });

    let s = await loadSession(id);
    const have = s ? s.offset : 0;
    const need = size - Math.min(have, size);
    if (need > 0) {
      const free = await freeBytes(cfg.dest);
      if (free !== null && free < need + SPACE_MARGIN) {
        log('warn', `Yer yok: ${name} için ${need} bayt gerekli, boş ${free}`);
        return sendJson(res, 507, { error: 'Bilgisayarda yeterli boş alan yok', need, free });
      }
    }
    await ensureTmp();
    if (!s) {
      await fsp.writeFile(partPath(id), '', { flag: 'a' });
      const offset = (await fsp.stat(partPath(id))).size;
      writeJsonSafe(metaPath(id), { name, size, lastModified, key, created: Date.now() }, log);
      s = { id, name, size, lastModified, key, offset, busy: null, lastAt: Date.now() };
      sessions.set(id, s);
      log('info', offset > 0 ? `Devam: "${name}" ${offset}/${size} (${normalizeAddr(remote)})` : `Başladı: "${name}" ${size} bayt (${normalizeAddr(remote)})`);
    }
    if (s.offset > size && !s.busy) {
      await fsp.truncate(partPath(id), 0);
      s.offset = 0;
    }
    if (lastModified && !s.lastModified) s.lastModified = lastModified;
    return sendJson(res, 200, { id, done: false, offset: s.offset, busy: !!s.busy, maxChunk: MAX_CHUNK });
  }

  async function handleChunk(req, res, u) {
    const id = u.searchParams.get('id') || '';
    const offset = Number(u.searchParams.get('offset'));
    if (!/^[0-9a-f]{32}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0) {
      req.resume();
      return sendJson(res, 400, { error: 'Geçersiz id veya offset' });
    }
    const crcHeader = String(req.headers['x-crc32'] || '').trim();
    if (!/^(0x)?[0-9a-f]{1,8}$/i.test(crcHeader)) { req.resume(); return sendJson(res, 400, { error: 'X-CRC32 başlığı eksik veya bozuk' }); }
    const expected = parseInt(crcHeader.replace(/^0x/i, ''), 16) >>> 0;
    const declared = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (declared !== null && (!Number.isSafeInteger(declared) || declared > MAX_CHUNK)) {
      res.on('finish', () => req.destroy());
      return sendJson(res, 413, { error: `Parça en çok ${MAX_CHUNK} bayt olabilir` }, { Connection: 'close' });
    }
    const s = await loadSession(id);
    if (!s) { req.resume(); return sendJson(res, 404, { error: 'Oturum bulunamadı; begin ile yeniden başlayın' }); }

    if (s.busy) {
      if (s.busy.phase === 'recv' && Date.now() - s.busy.lastAt > BUSY_TAKEOVER_MS) {
        log('warn', `Takılı kalan parça isteği bırakıldı: "${s.name}"`);
        s.busy.superseded = true;
        try { s.busy.req.destroy(); } catch {}
        s.busy = null;
      } else {
        req.resume();
        return sendJson(res, 409, { offset: s.offset, busy: true });
      }
    }
    if (offset !== s.offset) { req.resume(); return sendJson(res, 409, { offset: s.offset, busy: false }); }
    const room = s.size - offset;
    if (declared !== null && declared > room) { req.resume(); return sendJson(res, 400, { error: 'Parça dosya boyutunu aşıyor', offset: s.offset }); }

    const busy = { req, phase: 'recv', lastAt: Date.now(), superseded: false };
    s.busy = busy;
    const t = transferFor(s);
    t.received = s.offset;
    let buf;
    try {
      buf = await new Promise((resolve, reject) => {
        const limit = Math.min(MAX_CHUNK, room);
        const parts = [];
        let total = 0, done = false;
        req.on('data', (c) => {
          if (done) return;
          total += c.length;
          busy.lastAt = Date.now();
          if (total > limit) { done = true; const e = new Error('Parça çok büyük'); e.code = 'TOO_BIG'; return reject(e); }
          parts.push(c);
          bump(t, c.length);
        });
        req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts, total)); } });
        req.on('error', (e) => { if (!done) { done = true; reject(e); } });
        req.on('close', () => { if (!done) { done = true; const e = new Error('Bağlantı kesildi'); e.code = 'ABORTED'; reject(e); } });
      });
    } catch (e) {
      if (s.busy === busy) s.busy = null;
      t.received = s.offset;
      if (e.code === 'TOO_BIG' && !res.headersSent) {
        res.on('finish', () => req.destroy());
        return sendJson(res, 413, { error: 'Parça izin verilenden büyük', offset: s.offset }, { Connection: 'close' });
      }
      if (!busy.superseded) log('warn', `Parça yarım kaldı: "${s.name}" offset ${offset} (${e.code || e.message})`);
      return;
    }
    if (busy.superseded) return;
    if (buf.length === 0 && room > 0) { s.busy = null; return sendJson(res, 400, { error: 'Boş parça', offset: s.offset }); }
    const crc = zlib.crc32(buf) >>> 0;
    if (crc !== expected) {
      s.busy = null;
      t.received = s.offset;
      log('warn', `CRC tutmadı: "${s.name}" offset ${offset}`);
      return sendJson(res, 422, { error: 'CRC tutmadı', offset: s.offset });
    }
    busy.phase = 'write';
    try {
      const fh = await fsp.open(partPath(id), 'r+');
      try { await fh.write(buf, 0, buf.length, offset); } finally { await fh.close(); }
    } catch (e) {
      s.busy = null;
      if (e.code === 'ENOENT') { sessions.delete(id); return sendJson(res, 404, { error: 'Geçici dosya yok; begin ile yeniden başlayın' }); }
      if (e.code === 'ENOSPC') return sendJson(res, 507, { error: 'Bilgisayarda yer kalmadı' });
      throw e;
    }
    s.offset = offset + buf.length;
    s.busy = null;
    s.lastAt = Date.now();
    t.received = s.offset;
    return sendJson(res, 200, { offset: s.offset });
  }

  async function handleFinish(req, res, u, remote) {
    req.resume();
    const id = u.searchParams.get('id') || '';
    if (!/^[0-9a-f]{32}$/.test(id)) return sendJson(res, 400, { error: 'Geçersiz id' });
    const s = await loadSession(id);
    if (!s) {
      const prev = findDone(id);
      if (prev) return sendJson(res, 200, { done: true, savedAs: prev.savedAs });
      return sendJson(res, 404, { error: 'Oturum bulunamadı' });
    }
    if (s.busy) return sendJson(res, 409, { offset: s.offset, busy: true });
    let size;
    try { size = (await fsp.stat(partPath(id))).size; } catch { sessions.delete(id); return sendJson(res, 404, { error: 'Geçici dosya yok' }); }
    if (size !== s.size) { s.offset = size; return sendJson(res, 409, { offset: size, busy: false }); }
    s.busy = { phase: 'finish', lastAt: Date.now() };
    try {
      let name = sanitizeName(s.name);
      if (!splitExt(name).ext) {
        const fh = await fsp.open(partPath(id), 'r');
        const head = Buffer.alloc(64);
        let n = 0;
        try { n = (await fh.read(head, 0, 64, 0)).bytesRead; } finally { await fh.close(); }
        name += sniffExt(head.subarray(0, n));
      }
      const finalPath = await enqueueMove(() => moveUnique(partPath(id), cfg.dest, name));
      if (s.lastModified > 0) {
        try { await fsp.utimes(finalPath, new Date(), new Date(s.lastModified)); } catch (e) { log('warn', `Tarih uygulanamadı: ${e.message}`); }
      }
      await fsp.rm(metaPath(id), { force: true, maxRetries: 3 }).catch(() => {});
      sessions.delete(id);
      transfers.delete(id);
      const entry = record({ id, name: s.name, finalPath, size: s.size, from: remote, via: 'sayfa' });
      return sendJson(res, 200, { done: true, savedAs: entry.savedAs });
    } catch (e) {
      s.busy = null;
      throw e;
    }
  }

  async function handleRaw(req, res, remote) {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('multipart/') || ct.startsWith('application/x-www-form-urlencoded')) {
      req.resume();
      log('warn', `Kestirme isteği reddedildi (${ct.split(';')[0]}): gövde Dosya değil`);
      return sendText(res, 415, 'İstek gövdesi Dosya olmalı');
    }
    const declaredName = decodeHeaderName(req.headers.filename) || filenameFromDisposition(req.headers['content-disposition']);
    const declared = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (declared === 0) { req.resume(); return sendText(res, 400, 'Gövde boş: İstek Gövdesi → Dosya = Yineleme Öğesi olmalı'); }
    if (declared) {
      const free = await freeBytes(cfg.dest);
      if (free !== null && free < declared + SPACE_MARGIN) { req.resume(); return sendText(res, 507, 'Bilgisayarda yeterli boş alan yok'); }
    }
    const dir = await ensureTmp();
    const tmpFile = path.join(dir, `raw-${crypto.randomBytes(8).toString('hex')}.tmp`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const key = 'raw-' + crypto.randomBytes(4).toString('hex');
    const t = { key, name: declaredName || 'dosya', size: Number.isSafeInteger(declared) ? declared : null, received: 0, started: Date.now(), lastAt: Date.now(), rate: 0, via: 'kestirme' };
    transfers.set(key, t);
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
        bump(t, chunk.length);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, tap, fs.createWriteStream(tmpFile, { flags: 'wx' }));
      if (declared !== null && size !== declared) { const e = new Error('Eksik gövde'); e.code = 'INCOMPLETE'; throw e; }
    } catch (e) {
      transfers.delete(key);
      await fsp.rm(tmpFile, { force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
      log('warn', `Kestirme yüklemesi yarım kaldı: "${t.name}" ${size} bayt (${e.code || e.message}); geçici dosya silindi`);
      if (!res.headersSent && !res.destroyed && e.code === 'ENOSPC') sendText(res, 507, 'Bilgisayarda yer kalmadı');
      else if (!res.headersSent && !res.destroyed && e.code === 'INCOMPLETE') sendText(res, 400, 'Dosya eksik geldi');
      return;
    }
    transfers.delete(key);
    if (size === 0) {
      await fsp.rm(tmpFile, { force: true, maxRetries: 5 }).catch(() => {});
      return sendText(res, 400, 'Gövde boş: İstek Gövdesi → Dosya = Yineleme Öğesi olmalı');
    }
    const sha256 = hash.digest('hex');
    const dup = findDoneHash(sha256, size);
    if (dup) {
      await fsp.rm(tmpFile, { force: true, maxRetries: 5 }).catch(() => {});
      log('info', `Zaten alınmıştı: "${dup.savedAs}" (kestirme, ${normalizeAddr(remote)})`);
      return sendText(res, 200, `Zaten alınmış: ${dup.savedAs}`);
    }
    let name = sanitizeName(declaredName || `WinDrop ${localStamp().slice(0, 19).replace(/:/g, '.')}`);
    if (!splitExt(name).ext) name += sniffExt(head);
    const finalPath = await enqueueMove(() => moveUnique(tmpFile, cfg.dest, name));
    const entry = record({ sha256, name: declaredName || null, finalPath, size, from: remote, via: 'kestirme' });
    return sendText(res, 200, `Alındı: ${entry.savedAs} (${toastLib.formatSize(size)})`);
  }

  // --------------------------------------------------------------- panel
  function primaryIp(ifaces) {
    if (routeIp && ifaces.some((i) => i.address === routeIp)) return routeIp;
    const pref = ifaces.find((i) => /wi-?fi|wlan|kablosuz|ethernet|eth/i.test(i.name));
    return (pref || ifaces[0] || {}).address || null;
  }

  function refreshRouteIp() {
    let s;
    try { s = dgram.createSocket('udp4'); } catch { return; }
    s.on('error', () => { try { s.close(); } catch {} });
    try {
      // UDP "connect" paket göndermez; yalnızca çıkış arayüzünü sorar.
      s.connect(53, '8.8.8.8', () => {
        try { routeIp = s.address().address; } catch {}
        try { s.close(); } catch {}
      });
    } catch { try { s.close(); } catch {} }
  }

  function qrCached(text) {
    if (!qrCache.has(text)) {
      if (qrCache.size > 20) qrCache.clear();
      qrCache.set(text, qr.toSvg(text, { margin: 2 }));
    }
    return qrCache.get(text);
  }

  const hasAwake = () => hasAsset('awake.mp4');
  const mdnsName = () => cfg.mdnsName || MDNS_NAME;

  // Ağ profili (Özel/Genel) – yalnızca panel açıkken, en çok 30 sn'de bir sorulur.
  const net = { at: 0, busy: false, list: [] };
  function refreshNetProfiles() {
    if (net.busy || process.platform !== 'win32') return;
    net.busy = true;
    const script = '$o = @(Get-NetConnectionProfile | ForEach-Object { [string]$_.InterfaceAlias + "`t" + [string]$_.NetworkCategory + "`t" + [string]$_.Name }); ' +
      '$b = [Text.Encoding]::UTF8.GetBytes(($o -join "`n")); $s = [Console]::OpenStandardOutput(); $s.Write($b, 0, $b.Length); $s.Flush()';
    let p;
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { net.busy = false; return; }
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', () => { net.busy = false; });
    p.on('close', () => {
      net.busy = false;
      net.at = Date.now();
      net.list = Buffer.concat(out).toString('utf8').split(/\r?\n/).filter(Boolean).map((l) => {
        const [alias, category, name] = l.split('\t');
        return { alias, category, name };
      });
    });
  }
  function networkInfo(ifaces, primary) {
    if (Date.now() - net.at > 30000) refreshNetProfiles();
    const iface = ifaces.find((i) => i.address === primary);
    if (!iface) return null;
    const prof = net.list.find((n) => n.alias === iface.name);
    return { alias: iface.name, name: prof ? prof.name : null, category: prof ? prof.category : null, wifi: /wi-?fi|wlan|kablosuz/i.test(iface.name) };
  }

  function entryJson(e) {
    return {
      rid: e.rid, savedAs: e.savedAs, size: e.size, time: e.time, via: e.via, from: e.from,
      kind: toastLib.kindOf(e.savedAs), ext: path.extname(e.savedAs).slice(1).toLowerCase(),
      exists: fs.existsSync(e.path), path: e.path,
    };
  }

  function stateJson() {
    const ifaces = mdnsLib.lanInterfaces();
    const primary = primaryIp(ifaces);
    const urls = {
      name: `http://${mdnsName()}:${actualPort}/${cfg.token}/`,
      ip: primary ? `http://${primary}:${actualPort}/${cfg.token}/` : null,
    };
    const now = Date.now();
    const active = [...transfers.values()]
      .filter((t) => now - t.lastAt < 15000 && (t.size == null || t.received < t.size))
      .map((t) => ({ name: t.name, size: t.size, received: t.received, rate: Math.round(t.rate || 0), via: t.via, stalled: now - t.lastAt > 4000 }));
    const recent = received.slice(-30).reverse().map(entryJson);
    return {
      app: 'windrop', port: actualPort, dest: cfg.dest, destLabel, urls,
      qr: { name: qrCached(urls.name), ip: urls.ip ? qrCached(urls.ip) : null },
      ips: ifaces.map((i) => ({ name: i.name, address: i.address })), primary,
      mdns: mdns ? mdns.status() : { disabled: true },
      active, recent, lastReceivedAt, awake: hasAwake(), ffmpeg: !!toastLib.findFfmpeg(), hostname: os.hostname(),
      network: networkInfo(ifaces, primary), version: VERSION, packaged: !!sea,
      onboarded: !!cfg.onboarded, total: received.length, code: formatCode(cfg.token),
    };
  }

  function openExplorer(target, select) {
    try {
      const args = select ? [`/select,"${target}"`] : [target];
      const p = spawn('explorer.exe', args, { windowsVerbatimArguments: !!select, detached: true, stdio: 'ignore' });
      p.on('error', (e) => log('warn', `Gezgin açılamadı: ${e.message}`));
      p.unref();
    } catch (e) { log('warn', `Gezgin açılamadı: ${e.message}`); }
  }

  function panelPostAllowed(req) {
    if (req.method !== 'POST') return false;
    if (req.headers['x-windrop'] !== '1') return false;
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
    return true;
  }

  async function handlePanel(req, res, u) {
    const p = u.pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html')) {
      return sendAsset(req, res, 'panel.html', 'text/html; charset=utf-8', { 'X-Frame-Options': 'DENY' });
    }
    if (p === '/icon.png') return sendBuffer(req, res, icons.touch, 'image/png');
    if (p === '/favicon.png' || p === '/favicon.ico') return sendBuffer(req, res, icons.favicon, 'image/png');
    if (p === '/api/state' && req.method === 'GET') return sendJson(res, 200, stateJson());
    if (p === '/api/ping') return sendJson(res, 200, { app: 'windrop', pid: process.pid, port: actualPort, version: VERSION, exe: process.execPath });
    if (p === '/api/received' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(2000, Number(u.searchParams.get('limit')) || 500));
      return sendJson(res, 200, { total: received.length, items: received.slice(-limit).reverse().map(entryJson) });
    }
    if (p === '/api/file' && (req.method === 'GET' || req.method === 'HEAD')) {
      const e = received.find((x) => x.rid === u.searchParams.get('rid'));
      if (!e) return sendText(res, 404, 'Bulunamadı');
      return sendFileRange(req, res, e.path, MIME[path.extname(e.path).toLowerCase()] || 'application/octet-stream');
    }
    if (p === '/api/open-folder' || p === '/api/reveal' || p === '/api/open' || p === '/api/open-network' || p === '/api/onboarded' || p === '/api/open-license') {
      if (!panelPostAllowed(req)) { req.resume(); return sendJson(res, 403, { error: 'İzin yok' }); }
      let body = {};
      try { body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}'); } catch {}
      if (p === '/api/open-folder') {
        await fsp.mkdir(cfg.dest, { recursive: true }).catch(() => {});
        openExplorer(cfg.dest, false);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/open-network') {
        // Ayarlar'da ağ sayfası açılır; profil türünü kullanıcı kendisi seçer.
        openExplorer(body.wifi === false ? 'ms-settings:network-ethernet' : 'ms-settings:network-wifi', false);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/open-license') {
        // Kurulu programda sözleşme exe'nin yanındadır; geliştirme sürümünde installer klasöründe.
        const f = sea ? path.join(path.dirname(process.execPath), 'Kullanım Sözleşmesi.txt') : path.join(ROOT, 'installer', 'sozlesme.txt');
        if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'Sözleşme dosyası bulunamadı' });
        openExplorer(f, false);
        return sendJson(res, 200, { ok: true });
      }
      if (p === '/api/onboarded') {
        cfg.onboarded = body.value !== false;
        saveConfig();
        return sendJson(res, 200, { ok: true, onboarded: cfg.onboarded });
      }
      const e = received.find((x) => x.rid === body.rid);
      if (!e || !fs.existsSync(e.path)) return sendJson(res, 404, { error: 'Dosya bulunamadı' });
      openExplorer(e.path, p === '/api/reveal'); // aç: varsayılan programla; göster: klasörde seçili
      return sendJson(res, 200, { ok: true });
    }
    req.resume();
    return sendText(res, 404, 'Bulunamadı');
  }

  async function handlePhone(req, res, u, rest, remote) {
    const sub = rest.join('/');
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (rest.length === 0) { req.resume(); res.writeHead(301, { Location: `/${cfg.token}/`, 'Cache-Control': 'no-store' }); return res.end(); }
    if (get && (sub === '' || sub === 'index.html')) {
      return sendAsset(req, res, 'send.html', 'text/html; charset=utf-8', { 'X-Frame-Options': 'DENY' });
    }
    if (get && (sub === 'icon.png' || sub === 'apple-touch-icon.png')) return sendBuffer(req, res, icons.touch, 'image/png');
    if (get && sub === 'favicon.png') return sendBuffer(req, res, icons.favicon, 'image/png');
    if (get && sub === 'awake.mp4') return sendAsset(req, res, 'awake.mp4', 'video/mp4');
    if (get && sub === 'api/info') return sendJson(res, 200, { app: 'windrop', awake: hasAwake(), destLabel, host: os.hostname(), maxChunk: MAX_CHUNK, version: VERSION });
    if (req.method === 'POST') {
      if (sub === 'api/begin') return handleBegin(req, res, remote);
      if (sub === 'api/chunk') return handleChunk(req, res, u);
      if (sub === 'api/finish') return handleFinish(req, res, u, remote);
      if (sub === 'api/raw') return handleRaw(req, res, remote);
    }
    req.resume();
    return sendText(res, 404, 'Bulunamadı');
  }

  function tokenMatches(seg) {
    const a = Buffer.from(String(seg));
    const b = Buffer.from(cfg.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Ayarlar config.json, config.json.bak ve (kurulu programda) kayıt defterine yazılır.
  function saveConfig() {
    writeJsonSafe(configFile, cfg, log);
    writeJsonSafe(configFile + '.bak', cfg, log);
    if (useRegistry && loaded.regToken !== cfg.token) {
      writeRegistryToken(cfg.token, log);
      loaded.regToken = cfg.token;
    }
  }

  // Kod biçimi doğru ama bu bilgisayarınki değil: telefondaki adres eskimiş olabilir.
  const wrongTokenSeen = new Map();
  function handleWrongToken(req, res, remote) {
    req.resume();
    const ip = normalizeAddr(remote);
    if (Date.now() - (wrongTokenSeen.get(ip) || 0) > 60000) {
      wrongTokenSeen.set(ip, Date.now());
      log('warn', `Eşleşme kodu uyuşmayan istek: ${ip} (telefondaki adres eski olabilir)`);
      if (!isLoopback(remote)) {
        notifier.message('wrong-token', 'Telefon eski bir adresle bağlandı',
          ['Telefondaki WinDrop adresi bu bilgisayarın eşleşme koduyla uyuşmuyor.', 'WinDrop\'ta Telefonu bağla bölümündeki QR kodu yeniden okutun.']);
      }
    }
    const text = 'Eşleşme kodu uyuşmuyor. Bilgisayardaki WinDrop\'ta Telefonu bağla bölümündeki QR kodu yeniden okutun; kestirme kullanıyorsanız oradaki adresi de yenileyin.';
    if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
      const html = '<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<meta name="color-scheme" content="light dark"><title>WinDrop</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;' +
        'font:17px/1.45 -apple-system,system-ui,sans-serif;background:#f2f2f7;color:#1c1c1e;padding:24px;box-sizing:border-box;text-align:center}' +
        '@media (prefers-color-scheme:dark){body{background:#000;color:#f2f2f7}p{color:#98989f}}h1{font-size:24px;margin:0 0 10px}p{color:#6e6e73;max-width:420px;margin:0 auto}' +
        '</style></head><body><div><h1>Eşleşme kodu uyuşmuyor</h1><p>Bu adres, bilgisayardaki WinDrop\'un eşleşme koduyla uyuşmuyor. ' +
        'Bilgisayarda WinDrop\'u açın, <b>Telefonu bağla</b> bölümündeki QR kodu okutun ve sayfayı ana ekrana yeniden ekleyin. ' +
        'Paylaş menüsünü kullanıyorsanız kestirmedeki adresi de yeni adresle değiştirin.</p></div></body></html>';
      const body = Buffer.from(html, 'utf8');
      res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': body.length });
      return res.end(body);
    }
    return sendText(res, 404, text);
  }

  async function handle(req, res) {
    const remote = req.socket.remoteAddress;
    if (!isPrivateAddress(remote)) {
      req.resume();
      log('warn', `Reddedildi (özel ağ değil): ${normalizeAddr(remote)}`);
      res.on('finish', () => req.socket.destroy());
      return sendText(res, 403, 'Erişim yok', { Connection: 'close' });
    }
    let u;
    try { u = new URL(req.url, 'http://windrop.invalid'); } catch { req.resume(); return sendText(res, 400, 'Geçersiz adres'); }
    const parts = u.pathname.split('/');
    if (parts[1] && tokenMatches(parts[1])) return handlePhone(req, res, u, parts.slice(2), remote);
    if (/^[0-9a-f]{16}$/i.test(parts[1] || '')) return handleWrongToken(req, res, remote);
    if (isLoopback(remote) && hostIsLocal(req.headers.host)) return handlePanel(req, res, u);
    req.resume();
    return sendText(res, 404, 'Bulunamadı');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', `İstek hatası ${req.method} ${safeUrl(req.url)}: ${e.stack || e.message}`);
      try { if (!res.headersSent) sendJson(res, 500, { error: 'Sunucu hatası' }); else res.destroy(); } catch {}
    });
  });
  server.requestTimeout = 0;      // büyük kestirme yüklemeleri kesilmesin
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 10000;
  server.timeout = 120000;        // 2 dakika hiç veri gelmezse soket kapanır
  // Ayrıştırılamayan istekler: sessizce kapatmak yerine kaydet, açıklamalı 400 dön.
  // En sık neden: kestirmede başlık adı (Anahtar) boş bırakılmış → "Invalid header token".
  server.on('clientError', (err, socket) => {
    try {
      const remote = socket.remoteAddress;
      if (err.code === 'ECONNRESET' || !socket.writable || !isPrivateAddress(remote)) { socket.destroy(); return; }
      // TLS el sıkışması (ilk bayt 0x16): telefon adresi https:// ile açmaya çalışıyor.
      if (err.rawPacket && err.rawPacket[0] === 0x16) {
        log('warn', `HTTPS isteği reddedildi ${normalizeAddr(remote)}: adres http:// ile başlamalı`);
        notifier.message('https', 'Adres https ile başlıyor',
          ['iPhone WinDrop\'a https:// ile bağlanmaya çalıştı.', 'Kestirmedeki ve Safari\'deki adres http:// ile başlamalı.']);
        socket.destroy();
        return;
      }
      const headerProblem = err.code === 'HPE_INVALID_HEADER_TOKEN';
      log('warn', `Bozuk istek reddedildi (${err.code || err.message}) ${normalizeAddr(remote)}${headerProblem ? ': başlık adı boş ya da geçersiz' : ''}`);
      const msg = headerProblem
        ? 'Kestirmede bir başlığın adı boş. URL İçeriğini Al → Başlıklar: soldaki Anahtar kutusuna filename yazın, sağdaki Metin kutusunda Yineleme Öğesi seçin.'
        : 'Geçersiz istek.';
      if (headerProblem) {
        notifier.message('bad-header', 'Kestirme yanlış ayarlanmış',
          ['iPhone\'dan gelen istekte başlık adı boş.', 'Başlıklar: Anahtar = filename, Metin = Yineleme Öğesi olmalı.']);
      }
      const body = Buffer.from(msg + '\n', 'utf8');
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: ' + body.length + '\r\n\r\n' + body.toString('utf8'));
    } catch { try { socket.destroy(); } catch {} }
  });
  server.on('error', (e) => log('error', `Sunucu hatası: ${e.message}`));

  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onErr = (e) => { server.off('listening', onOk); reject(e); };
      const onOk = () => { server.off('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen({ port, host: '0.0.0.0', exclusive: true });
    });
  }

  const timers = [];
  async function start() {
    if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port < 65536) {
      try { await listenOn(cfg.port); } catch (e) {
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
          log('info', `Port ${cfg.port} dolu (${e.code}); WinDrop zaten çalışıyor olabilir. Çıkılıyor.`);
          return { started: false, reason: 'busy' };
        }
        throw e;
      }
    } else {
      let chosen = null;
      const candidates = [DEFAULT_PORT];
      for (let p = 8766; p <= 8799; p++) candidates.push(p);
      for (const p of candidates) {
        try { await listenOn(p); chosen = p; break; } catch (e) { if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e; }
      }
      if (!chosen) { await listenOn(0); chosen = server.address().port; }
      cfg.port = chosen;
      cfgChanged = true;
      log('info', `Port seçildi: ${chosen}`);
    }
    actualPort = server.address().port;
    // Ağdaki ad ilk açılışta seçilir ve saklanır: "windrop.local" başka bir bilgisayarda
    // kullanılıyorsa "windrop-<bilgisayar-adı>.local" olur. Böylece adres sonradan değişmez.
    if (!noMdns && !cfg.mdnsName) {
      try {
        if (!(await mdnsLib.probeName(MDNS_NAME))) cfg.mdnsName = MDNS_NAME;
        else {
          const alt = `windrop-${slugHost(os.hostname()) || 'pc'}.local`;
          cfg.mdnsName = (await mdnsLib.probeName(alt)) ? `windrop-${slugHost(os.hostname()) || 'pc'}-${crypto.randomBytes(2).toString('hex')}.local` : alt;
        }
      } catch { cfg.mdnsName = MDNS_NAME; }
      cfgChanged = true;
      log('info', `Ağdaki ad: ${cfg.mdnsName}`);
    }
    if (cfgChanged || !fs.existsSync(configFile + '.bak') || (useRegistry && loaded.regToken !== cfg.token)) { saveConfig(); cfgChanged = false; }

    log('info', `WinDrop başladı (pid ${process.pid}) port ${actualPort}, hedef: ${cfg.dest}, ayarlar: ${dataDir}, eşleşme kodu: ${formatCode(cfg.token).slice(0, 4)}-…`);
    try { await ensureTmp(); } catch (e) { log('warn', `Geçici klasör hazırlanamadı: ${e.message}`); }
    cleanupTmp().catch(() => {});
    notifier.cleanupThumbs();
    timers.push(setInterval(() => { cleanupTmp().catch(() => {}); notifier.cleanupThumbs(); }, 6 * 3600 * 1000));
    refreshRouteIp();
    timers.push(setInterval(refreshRouteIp, 30000));
    timers.forEach((t) => t.unref());

    if (!noMdns) {
      try {
        mdns = mdnsLib.createResponder({ name: mdnsName(), log });
      } catch (e) { log('warn', `mDNS başlatılamadı: ${e.message}`); }
    }
    if (!noToast) {
      try {
        const { png } = writeIcons(dataDir);
        toastLib.registerAumid(png).then((ok) => { if (!ok) log('warn', 'Bildirim kimliği (AppUserModelId) yazılamadı'); });
      } catch (e) { log('warn', `Simge/bildirim kaydı: ${e.message}`); }
    }
    // Ekranı açık tutmak için küçük video (ffmpeg varsa).
    if (!sea && !hasAwake() && toastLib.findFfmpeg()) {
      const out = path.join(PUBLIC_DIR, 'awake.mp4');
      const p = spawn(toastLib.findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=5', '-t', '2',
        '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out], { windowsHide: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.on('exit', (c) => log(c === 0 ? 'info' : 'warn', c === 0 ? 'awake.mp4 üretildi' : `awake.mp4 üretilemedi (${c})`));
    }
    return { started: true, port: actualPort };
  }

  function stop() {
    timers.forEach(clearInterval);
    try { mdns && mdns.close(); } catch {}
    return new Promise((r) => server.close(() => r()));
  }

  return { start, stop, server, cfg, log, stateJson };
}

// ---------------------------------------------------------------- çalıştır
function main() {
  const dataDir = path.resolve(process.env.WINDROP_DATA || defaultDataDir());
  const iconsArg = process.argv.indexOf('--icons');
  if (iconsArg !== -1) {
    const r = writeIcons(process.argv[iconsArg + 1] ? path.resolve(process.argv[iconsArg + 1]) : dataDir);
    console.log(`Simgeler yazıldı: ${r.png}, ${r.ico}`);
    process.exit(0);
  }
  let app;
  try { app = createApp({ dataDir }); } catch (e) {
    const line = `${localStamp()} [error] Başlatılamadı: ${e.stack || e.message}\n`;
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(path.join(dataDir, 'windrop.log'), line); } catch { fallbackLog(line); }
    // Bildirim alanındaki program birkaç saniye sonra yeniden dener (açılıştaki geçici erişim sorunları için).
    process.exit(e.code === 'CONFIG_UNREADABLE' ? 3 : 1);
  }
  process.on('uncaughtException', (e) => app.log('error', `Yakalanmamış hata: ${e && (e.stack || e.message)}`));
  process.on('unhandledRejection', (e) => app.log('error', `Yakalanmamış söz: ${e && (e.stack || e.message || e)}`));
  const quit = () => { app.log('info', 'WinDrop durduruluyor'); app.stop().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  app.start().then((r) => {
    if (!r.started) process.exit(0); // port doluysa sessizce çık
  }).catch((e) => {
    app.log('error', `Başlatma hatası: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  createApp, main, loadConfig, formatCode, sanitizeName, splitExt, sniffExt, decodeHeaderName, isPrivateAddress, isLoopback, hostIsLocal, slugHost,
  makeIconPng, makeIco, writeIcons, encodePng, iconRgba, findDownloads, MAX_CHUNK, TMP_DIR_NAME, VERSION,
};

if (require.main === module) main();
