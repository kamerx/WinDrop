'use strict';
// Çalıştırma: node --test   (geçici klasör ve ayrı port kullanır; İndirilenler'e yazmaz)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const dgram = require('node:dgram');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const lib = require('../src/server.js');
const qr = require('../src/qr.js');
const mdns = require('../src/mdns.js');
const toast = require('../src/toast.js');

const TOKEN = 'a1b2c3d4e5f60718';
const PORT = 20000 + Math.floor(Math.random() * 20000);
const MB = 1024 * 1024;
let tmpRoot, dataDir, destDir, child;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const crcHex = (b) => (zlib.crc32(b) >>> 0).toString(16).padStart(8, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lanAddr = () => (mdns.lanInterfaces()[0] || {}).address || null;

function request(method, urlPath, { body = null, headers = {}, host = '127.0.0.1', hostHeader } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (hostHeader) h.Host = hostHeader;
    if (body != null && h['content-length'] === undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host, port: PORT, method, path: urlPath, headers: h, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json });
      });
    });
    req.on('error', reject);
    req.end(body == null ? undefined : body);
  });
}
const post = (p, obj) => request('POST', `/${TOKEN}${p}`, { body: JSON.stringify(obj), headers: { 'content-type': 'application/json' } });
const chunk = (id, offset, buf, crc) => request('POST', `/${TOKEN}/api/chunk?id=${id}&offset=${offset}`, { body: buf, headers: { 'content-type': 'application/octet-stream', 'x-crc32': crc || crcHex(buf) } });
const finish = (id) => request('POST', `/${TOKEN}/api/finish?id=${id}`);
const raw = (buf, name, headers = {}) => request('POST', `/${TOKEN}/api/raw`, { body: buf, headers: { ...(name != null ? { filename: name } : {}), 'content-type': 'application/octet-stream', ...headers } });

async function uploadPage(name, buf, { lastModified = 0, key = 'k', size = 8 * MB } = {}) {
  const b = await post('/api/begin', { name, size: buf.length, lastModified, key });
  assert.equal(b.status, 200, b.text);
  if (b.json.done) return b.json;
  let off = b.json.offset;
  while (off < buf.length) {
    const part = buf.subarray(off, Math.min(buf.length, off + size));
    const r = await chunk(b.json.id, off, part);
    assert.equal(r.status, 200, r.text);
    off = r.json.offset;
  }
  const f = await finish(b.json.id);
  assert.equal(f.status, 200, f.text);
  return f.json;
}

function waitReady(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      request('GET', `/${TOKEN}/api/info`).then((r) => (r.status === 200 ? resolve() : retry()), retry);
    };
    const retry = () => (Date.now() - start > timeoutMs ? reject(new Error('sunucu açılmadı')) : setTimeout(tryOnce, 100));
    tryOnce();
  });
}

// WINDROP_SERVER_EXE verilirse testler derlenmiş exe'ye karşı çalışır.
const SERVER_EXE = process.env.WINDROP_SERVER_EXE ? path.resolve(process.env.WINDROP_SERVER_EXE) : null;
async function startServer() {
  child = spawn(SERVER_EXE || process.execPath, SERVER_EXE ? [] : [SERVER], {
    // Testlerde silinen dosyalar Geri Dönüşüm Kutusu'na değil doğrudan silinir (geçici klasör).
    env: { ...process.env, WINDROP_DATA: dataDir, WINDROP_NO_MDNS: '1', WINDROP_NO_TOAST: '1', WINDROP_TEST_PERMANENT_DELETE: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  await waitReady();
}
async function killServer() {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL'); // ani kapanma (Windows'ta TerminateProcess)
  await done;
}

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'windrop-test-'));
  dataDir = path.join(tmpRoot, 'data');
  destDir = path.join(tmpRoot, 'gelenler');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT, token: TOKEN, dest: destDir }));
  // 7 günden eski geçici dosya: açılışta silinmeli
  const tmp = path.join(destDir, lib.TMP_DIR_NAME);
  fs.mkdirSync(tmp, { recursive: true });
  const old = path.join(tmp, 'eski.part');
  fs.writeFileSync(old, 'x');
  const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(old, t, t);
  fs.writeFileSync(path.join(tmp, 'yeni.part'), 'y');
  await startServer();
});

after(async () => {
  await killServer();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5 }); } catch {}
});

// ------------------------------------------------------------------ testler
test('İndirilenler yolu bulunur ve testler oraya yazmaz', () => {
  const dl = lib.findDownloads();
  assert.ok(path.isAbsolute(dl));
  assert.ok(!destDir.toLowerCase().startsWith(dl.toLowerCase()));
});

test('7 günden eski geçici dosyalar açılışta silinir, yenileri kalır', async () => {
  await sleep(300);
  const tmp = path.join(destDir, lib.TMP_DIR_NAME);
  assert.equal(fs.existsSync(path.join(tmp, 'eski.part')), false);
  assert.equal(fs.existsSync(path.join(tmp, 'yeni.part')), true);
});

test('yanlış token 404 alır', async () => {
  assert.equal((await request('GET', '/0000000000000000/')).status, 404);
  assert.equal((await request('POST', '/deadbeefdeadbeef/api/begin', { body: '{}' })).status, 404);
  assert.equal((await request('POST', '/deadbeefdeadbeef/api/raw', { body: 'x' })).status, 404);
  assert.equal((await request('GET', `/${TOKEN}x/`)).status, 404);
  const ok = await request('GET', `/${TOKEN}/`);
  assert.equal(ok.status, 200);
  assert.match(ok.text, /apple-mobile-web-app-capable/);
  const redirect = await request('GET', `/${TOKEN}`);
  assert.equal(redirect.status, 301);
  const icon = await request('GET', `/${TOKEN}/icon.png`);
  assert.equal(icon.status, 200);
  assert.equal(icon.body.subarray(1, 4).toString(), 'PNG');
});

test('50 MB dosya: SHA-256 eşleşir ve tarih uygulanır', async () => {
  const buf = crypto.randomBytes(50 * MB);
  const lastModified = Date.UTC(2021, 4, 4, 3, 2, 1, 250);
  const r = await uploadPage('büyük video.mov', buf, { lastModified, key: 'k50' });
  assert.equal(r.done, true);
  assert.equal(r.savedAs, 'büyük video.mov');
  const p = path.join(destDir, r.savedAs);
  assert.equal(sha(fs.readFileSync(p)), sha(buf));
  assert.ok(Math.abs(fs.statSync(p).mtimeMs - lastModified) < 2, `mtime ${fs.statSync(p).mtimeMs} != ${lastModified}`);
});

test('bozuk CRC 422 döner ve offset ilerlemez', async () => {
  const buf = crypto.randomBytes(MB);
  const b = await post('/api/begin', { name: 'crc.bin', size: buf.length, key: 'crc' });
  const bad = await chunk(b.json.id, 0, buf, '00000000');
  assert.equal(bad.status, 422);
  const again = await post('/api/begin', { name: 'crc.bin', size: buf.length, key: 'crc' });
  assert.equal(again.json.offset, 0);
  assert.equal((await chunk(b.json.id, 0, buf)).status, 200);
  assert.equal((await finish(b.json.id)).status, 200);
});

test('yanlış offset ve meşgul parça 409 döner', async () => {
  const buf = crypto.randomBytes(4 * MB);
  const b = await post('/api/begin', { name: 'offset.bin', size: buf.length, key: 'off' });
  const id = b.json.id;
  const wrong = await chunk(id, 1000, buf.subarray(0, 1000));
  assert.equal(wrong.status, 409);
  assert.deepEqual(wrong.json, { offset: 0, busy: false });

  // Yavaş bir parça işlenirken ikinci parça "busy" almalı
  const part = buf.subarray(0, 2 * MB);
  const slow = new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path: `/${TOKEN}/api/chunk?id=${id}&offset=0`, agent: false,
      headers: { 'content-length': part.length, 'x-crc32': crcHex(part) } }, (res) => {
      const ps = []; res.on('data', (c) => ps.push(c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ps)) }));
    });
    req.on('error', reject);
    req.write(part.subarray(0, MB));
    setTimeout(() => req.end(part.subarray(MB)), 600);
  });
  await sleep(250);
  const busy = await chunk(id, 0, part);
  assert.equal(busy.status, 409);
  assert.equal(busy.json.busy, true);
  const s = await slow;
  assert.equal(s.status, 200);
  assert.equal(s.json.offset, 2 * MB);
  const rest = await chunk(id, 2 * MB, buf.subarray(2 * MB));
  assert.equal(rest.status, 200);
  const f = await finish(id);
  assert.equal(sha(fs.readFileSync(path.join(destDir, f.json.savedAs))), sha(buf));
});

test('16 MB üstü parça reddedilir', async () => {
  const b = await post('/api/begin', { name: 'iri.bin', size: 40 * MB, key: 'iri' });
  const r = await request('POST', `/${TOKEN}/api/chunk?id=${b.json.id}&offset=0`, { body: Buffer.alloc(16 * MB + 1), headers: { 'x-crc32': '0' } }).catch((e) => ({ status: 'kesildi', e }));
  assert.ok(r.status === 413 || r.status === 'kesildi', String(r.status));
});

test('sunucu yeniden başladıktan sonra kaldığı yerden devam eder', async () => {
  const buf = crypto.randomBytes(20 * MB);
  const b = await post('/api/begin', { name: 'devam.mp4', size: buf.length, key: 'resume' });
  const id = b.json.id;
  assert.equal((await chunk(id, 0, buf.subarray(0, 8 * MB))).status, 200);
  assert.equal((await chunk(id, 8 * MB, buf.subarray(8 * MB, 16 * MB))).status, 200);
  await killServer();
  await startServer();
  const again = await post('/api/begin', { name: 'devam.mp4', size: buf.length, key: 'resume' });
  assert.equal(again.json.id, id);
  assert.equal(again.json.offset, 16 * MB);
  assert.equal((await chunk(id, 16 * MB, buf.subarray(16 * MB))).status, 200);
  const f = await finish(id);
  assert.equal(f.status, 200);
  assert.equal(sha(fs.readFileSync(path.join(destDir, f.json.savedAs))), sha(buf));
});

test('aynı dosya ikinci kez kopyalanmaz', async () => {
  const buf = crypto.randomBytes(300 * 1024);
  const a = await uploadPage('tekrar.jpg', buf, { key: 'same' });
  const b = await post('/api/begin', { name: 'tekrar.jpg', size: buf.length, key: 'same' });
  assert.equal(b.json.done, true);
  assert.equal(b.json.savedAs, a.savedAs);
  // Kestirme yolu da içerik aynıysa kopya üretmez
  const r1 = await raw(buf, 'tekrar-k.jpg');
  const r2 = await raw(buf, 'tekrar-k.jpg');
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.match(r2.text, /Zaten alınmış/);
  const names = fs.readdirSync(destDir).filter((n) => n.startsWith('tekrar'));
  assert.deepEqual(names.sort(), ['tekrar-k.jpg', 'tekrar.jpg']);
});

test('aynı adlı farklı dosya üstüne yazılmaz: "ad (2).uzantı"', async () => {
  const a = crypto.randomBytes(1000), b = crypto.randomBytes(2000), c = crypto.randomBytes(3000);
  const r1 = await uploadPage('ayni ad.JPG', a, { key: 'a' });
  const r2 = await uploadPage('ayni ad.JPG', b, { key: 'b' });
  const r3 = await raw(c, 'ayni ad.JPG');
  assert.equal(r1.savedAs, 'ayni ad.JPG');
  assert.equal(r2.savedAs, 'ayni ad (2).JPG');
  assert.match(r3.text, /ayni ad \(3\)\.JPG/);
  assert.equal(sha(fs.readFileSync(path.join(destDir, 'ayni ad.JPG'))), sha(a));
  assert.equal(sha(fs.readFileSync(path.join(destDir, 'ayni ad (2).JPG'))), sha(b));
  assert.equal(sha(fs.readFileSync(path.join(destDir, 'ayni ad (3).JPG'))), sha(c));
});

test('eşzamanlı aynı adlı taşımalar sıraya alınır', async () => {
  const bufs = [1, 2, 3, 4, 5].map(() => crypto.randomBytes(5000));
  const rs = await Promise.all(bufs.map((b) => raw(b, 'esz.png')));
  const saved = rs.map((r) => /Alındı: (.*) \(/.exec(r.text)[1]).sort();
  assert.deepEqual(saved, ['esz (2).png', 'esz (3).png', 'esz (4).png', 'esz (5).png', 'esz.png']);
});

test('zararlı dosya adları güvenli hale gelir', async () => {
  const cases = {
    '../../kacak.txt': 'kacak.txt',
    '..\\..\\Windows\\system32\\evil.dll': 'evil.dll',
    'C:\\Users\\x\\a.txt': 'a.txt',
    'CON': '_CON',
    'con.txt': '_con.txt',
    'nul': '_nul',
    'COM1.jpg': '_COM1.jpg',
    'LPT9': '_LPT9',
    'a<b>c:d"e|f?g*h.txt': 'a_b_c_d_e_f_g_h.txt',
    '...gizli': 'gizli',
    '   boşluk.txt': 'boşluk.txt',
    'kontrol\u0001\u001fkarakter.txt': 'kontrol__karakter.txt',
    'sonda nokta. . .': 'sonda nokta',
    'resim\u202Egpj.exe': 'resim_gpj.exe',
    '': 'dosya',
    '..': 'dosya',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(lib.sanitizeName(input), expected, JSON.stringify(input));
  const long = 'ş'.repeat(400) + '.jpeg';
  const s = lib.sanitizeName(long);
  assert.ok(Array.from(s).length <= 150);
  assert.ok(s.endsWith('.jpeg'));

  const parent = path.dirname(destDir);
  for (const input of ['../../kacak.txt', '..\\..\\evil2.dll', 'CON', 'aux.png', 'a<b>.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
    const r = await uploadPage(input, Buffer.from('zarar ' + input), { key: input });
    assert.ok(!/[\\/]/.test(r.savedAs), r.savedAs);
    assert.ok(fs.existsSync(path.join(destDir, r.savedAs)), r.savedAs);
  }
  const k = await raw(Buffer.from('kestirme kaçak'), '..%2F..%2Fkestirme-kacak.txt');
  assert.match(k.text, /Alındı: kestirme-kacak\.txt/);
  assert.equal(fs.existsSync(path.join(parent, 'kacak.txt')), false);
  assert.equal(fs.existsSync(path.join(parent, 'evil2.dll')), false);
  assert.equal(fs.existsSync(path.join(parent, 'kestirme-kacak.txt')), false);
  assert.equal(fs.existsSync(path.join(destDir, '_CON')), true);
});

test('Türkçe dosya adı korunur (sayfa, yüzde kodlu ve ham UTF-8 başlık)', async () => {
  const name = "Çiğdem'in Doğum Günü — ışık ÖŞÜĞİ.jpg";
  const r1 = await uploadPage(name, Buffer.from('a1'), { key: 'tr1' });
  assert.equal(r1.savedAs, name);
  const name2 = 'Şükrü ığdır çay.heic';
  const r2 = await raw(Buffer.from('a2'), encodeURIComponent(name2));
  assert.match(r2.text, new RegExp(`Alındı: ${name2.replace('.', '\\.')}`));
  const name3 = 'Gölcük ğüşiöç.png';
  const r3 = await raw(Buffer.from('a3'), Buffer.from(name3, 'utf8').toString('latin1'));
  assert.match(r3.text, /Alındı: Gölcük ğüşiöç\.png/);
  const nfd = 'Ağaç.jpg'.normalize('NFD');
  const r4 = await uploadPage(nfd, Buffer.from('a4'), { key: 'nfd' });
  assert.equal(r4.savedAs, 'Ağaç.jpg'.normalize('NFC'));
  for (const n of [name, name2, name3, 'Ağaç.jpg']) assert.ok(fs.existsSync(path.join(destDir, n)), n);
});

test('boş dosya sayfa yoluyla kaydedilir, kestirmede boş gövde reddedilir', async () => {
  const r = await uploadPage('bos.txt', Buffer.alloc(0), { key: 'bos' });
  assert.equal(r.done, true);
  assert.equal(fs.statSync(path.join(destDir, 'bos.txt')).size, 0);
  const k = await raw(Buffer.alloc(0), 'bos2.txt');
  assert.equal(k.status, 400);
  assert.equal(fs.existsSync(path.join(destDir, 'bos2.txt')), false);
});

test('kestirme yolu: ad başlığı, uzantı tahmini ve multipart reddi', async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), crypto.randomBytes(100)]);
  const r1 = await raw(heic, 'IMG_0001.HEIC');
  assert.equal(r1.status, 200);
  assert.match(r1.text, /Alındı: IMG_0001\.HEIC/);
  const types = [
    [Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(50)]), '.jpg'],
    [Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(50)]), '.png'],
    [Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(50)]), '.gif'],
    [Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), crypto.randomBytes(50)]), '.webp'],
    [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), crypto.randomBytes(50)]), '.heic'],
    [Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), crypto.randomBytes(50)]), '.mov'],
    [Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), crypto.randomBytes(50)]), '.mp4'],
  ];
  for (const [i, [buf, ext]] of types.entries()) {
    const r = await raw(buf, `uzantisiz${i}`);
    assert.match(r.text, new RegExp(`Alındı: uzantisiz${i}\\${ext} `), r.text);
  }
  const noName = await raw(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(30)]), null);
  assert.match(noName.text, /Alındı: WinDrop .*\.jpg/);
  const dotted = await raw(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(30)]), 'Ekran 2024-01-01 10.30.15');
  assert.match(dotted.text, /Alındı: Ekran 2024-01-01 10\.30\.15\.jpg /);
  assert.deepEqual(lib.splitExt('video.3gp'), { base: 'video', ext: '.3gp' });
  const multipart = await raw(Buffer.from('--x\r\nContent-Disposition: form-data; name="f"\r\n\r\nabc\r\n--x--'), 'a.jpg', { 'content-type': 'multipart/form-data; boundary=x' });
  assert.equal(multipart.status, 415);
  assert.match(multipart.text, /İstek gövdesi Dosya olmalı/);
});

test('kestirmede başlık adı boşsa bağlantı sessizce kopmaz, açıklamalı 400 döner', async () => {
  const reply = await new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`POST /${TOKEN}/api/raw HTTP/1.1\r\nHost: x\r\n: filename\r\nContent-Length: 3\r\n\r\nabc`);
    });
    let out = '';
    sock.on('data', (d) => { out += d; });
    sock.on('close', () => resolve(out));
    sock.on('error', () => resolve(out));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.match(reply, /Anahtar kutusuna filename/);
  assert.equal((await request('GET', `/${TOKEN}/api/info`)).status, 200); // sunucu ayakta
});

test('https ile gelen istek (TLS) ayırt edilip kayda yazılır', async () => {
  await new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0xa5, 0x01, 0x00, 0x00, 0xa1, 0x03, 0x03])));
    sock.on('close', resolve);
    sock.on('error', resolve);
    setTimeout(() => { sock.destroy(); resolve(); }, 3000);
  });
  await sleep(200);
  const logText = fs.readFileSync(path.join(dataDir, 'windrop.log'), 'utf8');
  assert.match(logText, /HTTPS isteği reddedildi 127\.0\.0\.1: adres http:\/\/ ile başlamalı/);
  assert.equal((await request('GET', `/${TOKEN}/api/info`)).status, 200);
});

test('çok büyük dosya için yer yoksa 507', async () => {
  const r = await post('/api/begin', { name: 'dev.bin', size: 2 ** 50, key: 'dev' });
  assert.equal(r.status, 507);
});

test('yarım kalan yükleme hedefe dosya bırakmaz', async () => {
  const before = new Set(fs.readdirSync(destDir));
  const tmp = path.join(destDir, lib.TMP_DIR_NAME);
  await new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`POST /${TOKEN}/api/raw HTTP/1.1\r\nHost: x\r\nfilename: yarim.mov\r\nContent-Length: ${5 * MB}\r\n\r\n`);
      sock.write(crypto.randomBytes(MB));
      setTimeout(() => { sock.destroy(); resolve(); }, 300);
    });
    sock.on('error', () => resolve());
  });
  await sleep(1200);
  const after = fs.readdirSync(destDir).filter((n) => !before.has(n));
  assert.deepEqual(after, []);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('raw-')), []);
  // Sayfa yolunda yarım dosya yalnızca gizli geçici klasörde durur
  const b = await post('/api/begin', { name: 'yarim-sayfa.mov', size: 3 * MB, key: 'yarim' });
  await chunk(b.json.id, 0, crypto.randomBytes(MB));
  assert.equal(fs.existsSync(path.join(destDir, 'yarim-sayfa.mov')), false);
  assert.equal(fs.statSync(path.join(tmp, `${b.json.id}.part`)).size, MB);
  const attr = spawnSync('attrib.exe', [tmp], { encoding: 'utf8' }).stdout;
  assert.match(attr.split(tmp)[0], /H/);
});

test('panel yalnızca bu bilgisayardan ve localhost adıyla açılır', async () => {
  assert.equal((await request('GET', '/', { hostHeader: `localhost:${PORT}` })).status, 200);
  assert.equal((await request('GET', '/', { hostHeader: `127.0.0.1:${PORT}` })).status, 200);
  assert.equal((await request('GET', '/api/state', { hostHeader: `localhost:${PORT}` })).status, 200);
  assert.equal((await request('GET', '/', { hostHeader: 'kotu.example' })).status, 404);
  assert.equal((await request('GET', '/api/state', { hostHeader: 'windrop.local' })).status, 404);
  // İzin başlığı olmayan panel eylemi reddedilir
  assert.equal((await request('POST', '/api/open-folder', { hostHeader: 'localhost', body: '{}' })).status, 403);
  assert.equal((await request('POST', '/api/open-folder', { hostHeader: 'localhost', body: '{}', headers: { 'x-windrop': '1', origin: 'http://kotu.example' } })).status, 403);
  const lan = lanAddr();
  if (lan) {
    assert.equal((await request('GET', '/', { host: lan, hostHeader: 'localhost' })).status, 404);
    assert.equal((await request('GET', '/api/state', { host: lan, hostHeader: '127.0.0.1' })).status, 404);
    assert.equal((await request('GET', `/${TOKEN}/api/info`, { host: lan })).status, 200);
  }
  // Özel ağ dışındaki adresler (ör. Tailscale 100.x) reddedilir
  const outside = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal && !lib.isPrivateAddress(a.address));
  if (outside) {
    const r = await request('GET', `/${TOKEN}/api/info`, { host: outside.address }).catch(() => ({ status: 'bağlanamadı' }));
    assert.ok(r.status === 403 || r.status === 'bağlanamadı', String(r.status));
  }
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '169.254.1.1', '::1', 'fe80::1', 'fd12::1', '::ffff:192.168.1.9']) assert.equal(lib.isPrivateAddress(a), true, a);
  for (const a of ['8.8.8.8', '100.64.0.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:db8::1', '::ffff:8.8.8.8']) assert.equal(lib.isPrivateAddress(a), false, a);
});

test('mDNS sorgusuna A kaydıyla yanıt verir', async (t) => {
  const ifaces = mdns.lanInterfaces();
  if (!ifaces.length) return t.skip('LAN arayüzü yok');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const responder = mdns.createResponder({ name: 'windrop-test.local', port, interfaces: () => ifaces.slice(0, 1) });
  try {
    await sleep(400);
    assert.equal(responder.status().interfaces.length, 1);
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((r) => client.bind(0, r));
    client.setMulticastInterface(ifaces[0].address);
    const q = Buffer.concat([Buffer.from([0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), mdns.encodeName('windrop-test.local'), Buffer.from([0, 1, 0, 1])]);
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mDNS yanıtı gelmedi')), 3000);
      client.on('message', (msg) => { clearTimeout(timer); resolve(msg); });
      client.send(q, port, '224.0.0.251');
    });
    client.close();
    assert.equal(answer.readUInt16BE(0), 0x1234); // tek seferlik sorguda kimlik geri döner
    assert.equal(answer.readUInt16BE(2) & 0x8400, 0x8400);
    assert.equal(answer.readUInt16BE(4), 1); // soru tekrar edilir
    let off = mdns.readName(answer, 12).end + 4;
    const rr = mdns.readName(answer, off);
    assert.equal(rr.name, 'windrop-test.local');
    off = rr.end;
    assert.equal(answer.readUInt16BE(off), 1); // A
    const ip = [...answer.subarray(off + 10, off + 14)].join('.');
    assert.equal(ip, ifaces[0].address);
  } finally {
    responder.close();
  }
});

test('QR kodu bağımsız çözücüyle (jsqr) doğru okunur: sürüm 1-10', async (t) => {
  // jsqr yalnızca geçici test klasörüne kurulur; uygulama çalışırken kullanılmaz.
  const dir = path.join(os.tmpdir(), 'windrop-test-jsqr');
  const mod = path.join(dir, 'node_modules', 'jsqr');
  if (!fs.existsSync(mod)) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(`npm install jsqr@1.4.0 --no-audit --no-fund --no-save --prefix "${dir}"`, { shell: true, encoding: 'utf8', timeout: 180000 });
    if (r.status !== 0 || !fs.existsSync(mod)) return t.skip('jsqr kurulamadı (internet yok?): ' + (r.stderr || '').slice(0, 200));
  }
  const m = require(mod);
  const jsQR = m.default || m;
  const render = (code, scale = 4, margin = 4) => {
    const n = (code.size + margin * 2) * scale;
    const px = new Uint8ClampedArray(n * n * 4).fill(255);
    for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((y + margin) * scale + dy) * n + (x + margin) * scale + dx) * 4;
        px[i] = px[i + 1] = px[i + 2] = 0;
      }
    }
    return { px, n };
  };
  const seen = new Set();
  for (let v = 1; v <= 10; v++) {
    const len = qr.capacityBytes(v);
    const text = ('http://192.168.1.20:8765/' + TOKEN + '/api/raw?' + 'xyz'.repeat(100)).slice(0, len);
    const code = qr.encode(text);
    assert.equal(code.version, v);
    const { px, n } = render(code);
    const res = jsQR(px, n, n);
    assert.ok(res, `sürüm ${v} çözülemedi`);
    assert.equal(res.data, text);
    assert.equal(res.version, v);
    seen.add(code.mask);
  }
  for (const s of ['http://windrop.local:8765/' + TOKEN + '/', 'Türkçe: çğıöşü ÇĞİÖŞÜ']) {
    const code = qr.encode(s);
    const { px, n } = render(code);
    const res = jsQR(px, n, n);
    assert.equal(Buffer.from(res.binaryData).toString('utf8'), s);
  }
  // Tüm maskeler çözülebilmeli (kodlayıcı en iyisini seçse de)
  assert.ok(seen.size >= 1);
});

test('bildirim XML kaçışı: dosya adı komut olarak çalışmaz', async () => {
  const cwd = path.join(tmpRoot, 'toast');
  fs.mkdirSync(cwd, { recursive: true });
  const evil = `kötü "ad" <b>&amp;'$(New-Item -Path pwned1.txt)'; New-Item pwned2.txt; \`calc\` & echo x>pwned3.txt.jpg`;
  const xml = toast.buildToastXml({ title: evil, lines: ['satır <2>'], launch: 'file:///C:/a%20b/', actions: [{ content: 'Aç', arguments: 'file:///C:/x/"y".jpg' }] });
  assert.ok(!xml.includes('<b>'));
  assert.ok(xml.includes('&lt;b&gt;&amp;amp;'));
  assert.ok(xml.includes('&quot;ad&quot;'));
  assert.equal(toast.xmlEscape('a\u0001b\u0008c'), 'abc');
  const r = await toast.runToastScript(xml, { WINDROP_TOAST_DRYRUN: '1', WINDROP_CWD: cwd });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split('\n')[0], evil);
  assert.equal(r.stdout.split('\n')[1], 'satır <2>');
  for (const f of ['pwned1.txt', 'pwned2.txt', 'pwned3.txt', 'pwned3.txt.jpg']) assert.equal(fs.existsSync(path.join(cwd, f)), false, f);
});

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

test('önizleme: ffmpeg ile video karesi ve büyük JPEG 640x480 içine küçülür', async (t) => {
  const ff = toast.findFfmpeg();
  if (!ff) return t.skip('ffmpeg yok');
  const dir = path.join(tmpRoot, 'onizleme');
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'IMG_0001.MOV');
  const photo = path.join(dir, 'IMG_0002.JPG');
  spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30', '-t', '2', '-c:v', 'libx265', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', video]);
  spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=4032x3024', '-frames:v', '1', photo]);
  assert.ok(fs.existsSync(video) && fs.existsSync(photo));
  const n = toast.createNotifier({ dataDir: path.join(tmpRoot, 'data-onizleme'), destDir: dir, destLabel: 'test', enabled: false });
  for (const f of [video, photo]) {
    const out = await n.makePreview({ path: f, name: path.basename(f), size: fs.statSync(f).size });
    assert.ok(out && out !== f && fs.existsSync(out), `önizleme yok: ${f}`);
    const s = jpegSize(fs.readFileSync(out));
    assert.ok(s && s.w <= 640 && s.h <= 480 && s.w >= 600, `boyut ${JSON.stringify(s)}`);
  }
});

test('awake.mp4 parça (Range) isteğiyle sunulur ve sürüm bildirilir', async () => {
  const info = await request('GET', `/${TOKEN}/api/info`);
  assert.equal(info.json.version, lib.VERSION);
  if (!info.json.awake) return;
  const r = await request('GET', `/${TOKEN}/awake.mp4`, { headers: { range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.equal(r.body.length, 10);
  assert.equal(r.body.subarray(4, 8).toString(), 'ftyp');
  assert.match(r.headers['content-range'], /^bytes 0-9\/\d+$/);
  const bad = await request('GET', `/${TOKEN}/awake.mp4`, { headers: { range: 'bytes=999999-' } });
  assert.equal(bad.status, 416);
  const ping = await request('GET', '/api/ping', { hostHeader: 'localhost' });
  assert.equal(ping.json.app, 'windrop');
  if (SERVER_EXE) assert.equal(ping.json.exe.toLowerCase(), SERVER_EXE.toLowerCase());
});

test('ağ adı: çakışma yoklaması ve bilgisayar adından güvenli ad', async (t) => {
  assert.equal(lib.slugHost('Kamer'), 'kamer');
  assert.equal(lib.slugHost('ŞÜKRÜ-Iğdır PC_2'), 'sukru-igdir-pc-2');
  assert.equal(lib.slugHost('çalışma ödev'), 'calisma-odev');
  const ifaces = mdns.lanInterfaces();
  if (!ifaces.length) return t.skip('LAN arayüzü yok');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const responder = mdns.createResponder({ name: 'windrop-yoklama.local', port, interfaces: () => ifaces.slice(0, 1) });
  try {
    await sleep(400);
    // Yanıt bu bilgisayardan geliyor: çakışma sayılmaz
    assert.equal(await mdns.probeName('windrop-yoklama.local', { port, interfaces: () => ifaces.slice(0, 1) }), false);
    // Aynı yanıt başka bir cihazdan gelmiş gibi: çakışma
    assert.equal(await mdns.probeName('windrop-yoklama.local', { port, interfaces: () => ifaces.slice(0, 1), ownAddresses: new Set() }), true);
    // Kimsenin kullanmadığı ad: çakışma yok
    assert.equal(await mdns.probeName('windrop-bos-ad.local', { port, interfaces: () => ifaces.slice(0, 1), ownAddresses: new Set(), timeoutMs: 400 }), false);
  } finally {
    responder.close();
  }
});

test('sayfa betikleri sözdizimi hatası içermez', () => {
  for (const f of ['panel.html', 'send.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    const m = /<script>([\s\S]*)<\/script>/.exec(html);
    assert.ok(m, f + ' betik yok');
    assert.doesNotThrow(() => new Function(m[1]), f);
  }
});

// Ayrı bir sunucu süreci (kendi klasörü ve portuyla) başlatır; çıkış kodunu bekleyebilmek için süreci döndürür.
function spawnExtra(dir) {
  return spawn(SERVER_EXE || process.execPath, SERVER_EXE ? [] : [SERVER], {
    env: { ...process.env, WINDROP_DATA: dir, WINDROP_NO_MDNS: '1', WINDROP_NO_TOAST: '1', WINDROP_NO_REGISTRY: '1', WINDROP_TEST_PERMANENT_DELETE: '1' },
    stdio: 'ignore', windowsHide: true,
  });
}
function getOn(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end();
  });
}

test('eşleşme kodu: ayar dosyası bozuksa yedekten geri gelir, kod değişmez', async () => {
  const dir = path.join(tmpRoot, 'yedekten');
  const port = PORT + 7;
  const code = '0f1e2d3c4b5a6978';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{bozuk');
  fs.writeFileSync(path.join(dir, 'config.json.bak'), JSON.stringify({ port, token: code, dest: destDir }));
  const p = spawnExtra(dir);
  try {
    let ok = 0;
    for (let i = 0; i < 80 && ok !== 200; i++) { await sleep(150); ok = await getOn(port, `/${code}/api/info`); }
    assert.equal(ok, 200, 'sunucu yedekteki kodla açılmadı');
    const repaired = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(repaired.token, code);
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('config.json.bozuk-')), 'bozuk dosyanın kopyası saklanmalı');
  } finally {
    p.kill('SIGKILL');
  }
});

test('eşleşme kodu: ayar okunamıyor ve yedek yoksa yeni kod üretmez, başlamaz', async () => {
  const dir = path.join(tmpRoot, 'yedeksiz');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{bozuk');
  const p = spawnExtra(dir);
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => { p.kill('SIGKILL'); resolve('zaman aşımı'); }, 20000);
    p.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 3);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{bozuk');
  assert.match(fs.readFileSync(path.join(dir, 'windrop.log'), 'utf8'), /Eşleşme kodunu değiştirmemek için WinDrop başlatılmadı/);
});

test('eşleşme kodu yedeklenir, panelde dörder haneli görünür', async () => {
  const bak = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json.bak'), 'utf8'));
  assert.equal(bak.token, TOKEN);
  const st = await request('GET', '/api/state', { hostHeader: 'localhost' });
  assert.equal(st.json.code, 'A1B2-C3D4-E5F6-0718');
  assert.equal(lib.formatCode('0123456789abcdef'), '0123-4567-89AB-CDEF');
});

test('eşleşme kodu uyuşmazsa telefon anlaşılır bir mesaj görür', async () => {
  const page = await request('GET', '/0123456789abcdef/', { headers: { accept: 'text/html' } });
  assert.equal(page.status, 404);
  assert.match(page.text, /Eşleşme kodu uyuşmuyor/);
  const raw = await request('POST', '/deadbeefdeadbeef/api/raw', { body: 'x' });
  assert.equal(raw.status, 404);
  assert.match(raw.text, /Eşleşme kodu uyuşmuyor/);
  const other = await request('GET', '/nebu-adres/');
  assert.equal(other.status, 404);
  assert.doesNotMatch(other.text, /Eşleşme/);
});

// ------------------------------------------------------------ Gelenler'den silme
const panelReq = (method, p, body, headers = { 'x-windrop': '1' }) =>
  request(method, p, { hostHeader: 'localhost', body: body == null ? null : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
async function receivedItem(savedAs) {
  const r = await panelReq('GET', '/api/received?limit=2000');
  assert.equal(r.status, 200);
  return r.json.items.find((x) => x.savedAs === savedAs) || null;
}
const savedRecords = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'received.json'), 'utf8'));

test('silme: dosya kaldırılır, kayıt listeden ve geçmiş dosyasından çıkar', async () => {
  const name = `silinecek-${Date.now()}.png`;
  assert.equal((await raw(Buffer.from('silinecek dosya'), name)).status, 200);
  const it = await receivedItem(name);
  assert.ok(it && it.exists, 'kayıt bulunmalı');
  const file = path.join(destDir, name);
  assert.ok(fs.existsSync(file));
  // izin başlığı olmadan, başka kaynaktan ve geçersiz kimlikle reddedilir
  assert.equal((await panelReq('POST', '/api/delete', { rid: it.rid }, {})).status, 403);
  assert.equal((await panelReq('POST', '/api/delete', { rid: it.rid }, { 'x-windrop': '1', origin: 'http://kotu.example' })).status, 403);
  assert.equal((await panelReq('POST', '/api/delete', {})).status, 400);
  assert.equal((await panelReq('POST', '/api/delete', { rid: '../../x' })).status, 400);
  assert.ok(fs.existsSync(file), 'reddedilen istekler dosyaya dokunmamalı');

  const d = await panelReq('POST', '/api/delete', { rid: it.rid });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.recycled, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await receivedItem(name), null);
  assert.equal(savedRecords().some((e) => e.rid === it.rid), false);
  assert.equal((await panelReq('POST', '/api/delete', { rid: it.rid })).status, 404);
  // telefondan aynı yol yetkisiz kullanılamaz
  assert.equal((await request('POST', `/${TOKEN}/api/delete`, { body: JSON.stringify({ rid: it.rid }) })).status, 404);
});

test('silme: taşınmış dosyanın yalnızca kaydı kalkar, dosyaya dokunulmaz', async () => {
  const name = `tasinan-${Date.now()}.jpg`;
  assert.equal((await raw(Buffer.from('taşınan dosya'), name)).status, 200);
  const moved = path.join(tmpRoot, name);
  fs.renameSync(path.join(destDir, name), moved);
  const it = await receivedItem(name);
  assert.equal(it.exists, false);
  const d = await panelReq('POST', '/api/delete', { rid: it.rid });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.recycled, false);
  assert.ok(fs.existsSync(moved), 'taşınan dosya yerinde kalmalı');
  assert.equal(await receivedItem(name), null);
});

test('silme: aynı ada sonradan gelen dosya eski kayıt yüzünden silinmez', async () => {
  const name = `ayni-ad-${Date.now()}.png`;
  assert.equal((await raw(Buffer.from('birinci'), name)).status, 200);
  const moved = path.join(tmpRoot, 'birinci-' + name);
  fs.renameSync(path.join(destDir, name), moved);
  assert.equal((await raw(Buffer.from('ikinci, farklı içerik'), name)).status, 200);
  const r = await panelReq('GET', '/api/received?limit=2000');
  const both = r.json.items.filter((x) => x.savedAs === name);
  assert.equal(both.length, 2);
  const [newer, older] = both; // en yeni önce gelir
  assert.equal(newer.exists, true);
  assert.equal(older.exists, false, 'eski kayıt yeni dosyayı kendi dosyası saymamalı');
  assert.equal((await request('GET', `/api/file?rid=${older.rid}`, { hostHeader: 'localhost' })).status, 404);
  assert.equal((await panelReq('POST', '/api/open', { rid: older.rid })).status, 404);
  const d = await panelReq('POST', '/api/delete', { rid: older.rid });
  assert.equal(d.json.recycled, false);
  assert.equal(fs.readFileSync(path.join(destDir, name), 'utf8'), 'ikinci, farklı içerik');
  const d2 = await panelReq('POST', '/api/delete', { rid: newer.rid });
  assert.equal(d2.json.recycled, true);
  assert.equal(fs.existsSync(path.join(destDir, name)), false);
  assert.ok(fs.existsSync(moved));
});

test('geçmiş listesi: kimliksiz ya da bozuk kayıtlar düzeltilir', () => {
  const f = path.join(tmpRoot, 'gecmis-birim.json');
  fs.writeFileSync(f, JSON.stringify([
    { savedAs: 'a.png', path: 'C:\\x\\a.png' },
    { rid: 'abcdefabcdef', savedAs: 'b.png', path: 'C:\\x\\b.png' },
    { rid: 'abcdefabcdef', savedAs: 'c.png', path: 'C:\\x\\c.png' },
    { rid: 'abcdefabcdef' }, null, 'metin',
  ]));
  const r = lib.loadReceived(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.list.map((e) => e.savedAs), ['a.png', 'b.png', 'c.png']);
  const rids = r.list.map((e) => e.rid);
  assert.ok(rids.every((x) => /^[0-9a-f]{12}$/.test(x)));
  assert.equal(new Set(rids).size, 3);
  assert.equal(rids[1], 'abcdefabcdef');
  fs.writeFileSync(f, '[{bozuk');
  assert.equal(lib.loadReceived(f, 1).ok, false);
  assert.deepEqual(lib.loadReceived(path.join(tmpRoot, 'yok.json')), { list: [], ok: true });
});

test('geçmiş listesi açılışta okunamazsa ezilmez; sonradan okununca birleşir', async () => {
  const dir = path.join(tmpRoot, 'gecmis-bozuk');
  const dest = path.join(tmpRoot, 'gecmis-bozuk-gelen');
  const port = PORT + 9;
  const code = '1122334455667788';
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, token: code, dest }));
  fs.writeFileSync(path.join(dir, 'received.json'), '[{"yarım');
  const p = spawnExtra(dir);
  try {
    let ok = 0;
    for (let i = 0; i < 80 && ok !== 200; i++) { await sleep(150); ok = await getOn(port, `/${code}/api/info`); }
    assert.equal(ok, 200, 'sunucu açılmadı');
    assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('received.json.bozuk-')), 'okunamayan geçmişin kopyası saklanmalı');
    // dosya sonradan okunabilir hale gelir (ör. OneDrive kilidi kalkar)
    const old = { rid: '0a0b0c0d0e0f', savedAs: 'eski.png', path: path.join(dest, 'eski.png'), size: 1, time: 1 };
    fs.writeFileSync(path.join(dir, 'received.json'), JSON.stringify([old]));
    const up = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: `/${code}/api/raw`, headers: { filename: 'yeni.png', 'content-type': 'application/octet-stream' }, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end('yeni dosya');
    });
    assert.equal(up, 200);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'received.json'), 'utf8'));
    assert.deepEqual(saved.map((e) => e.savedAs), ['eski.png', 'yeni.png']);
  } finally {
    p.kill('SIGKILL');
  }
});

test('simge PNG ve ICO geçerli', () => {
  const png = lib.makeIconPng(32, { rounded: true });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 32);
  const ico = lib.makeIco([16, 256]);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 2);
});
