'use strict';
// Yalnızca standart kütüphaneyle küçük bir mDNS yanıtlayıcı: "windrop.local" için A kaydı döner.
const dgram = require('node:dgram');
const os = require('node:os');

const MDNS_GROUP = '224.0.0.251';
const TYPE_A = 1, TYPE_AAAA = 28, TYPE_ANY = 255, TYPE_NSEC = 47;

// VPN ve sanal bağdaştırıcılar atlanır.
const SKIP_NAMES = /(vethernet|virtualbox|vbox|vmware|vmnet|hyper-?v|wsl|docker|tailscale|zerotier|wireguard|wintun|openvpn|\btap\b|tap-|\btun\b|vpn|npcap|loopback|bluetooth|hamachi|radmin|nordlynx|proton|mullvad|warp|cloudflare|forti|anyconnect|cisco|globalprotect|pangp|juniper|sophos|parallels|utun)/i;

function isLanIPv4(addr) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr || '');
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function lanInterfaces() {
  const out = [];
  let all = {};
  try { all = os.networkInterfaces(); } catch { return out; }
  for (const [name, list] of Object.entries(all)) {
    if (SKIP_NAMES.test(name)) continue;
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (!isLanIPv4(a.address)) continue;
      out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

// --- DNS paketleri ---
function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  for (;;) {
    if (off >= buf.length || guard++ > 128) throw new Error('bozuk ad');
    const len = buf[off];
    if (len === 0) { off++; if (!jumped) end = off; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) throw new Error('bozuk işaretçi');
      const ptr = ((len & 0x3f) << 8) | buf[off + 1];
      if (!jumped) end = off + 2;
      jumped = true;
      off = ptr;
      continue;
    }
    if (len & 0xc0) throw new Error('bozuk etiket');
    off++;
    labels.push(buf.toString('utf8', off, off + len));
    off += len;
  }
  return { name: labels.join('.'), end };
}

function parseQuery(buf) {
  if (buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null; // yanıt, sorgu değil
  if (((flags >> 11) & 0xf) !== 0) return null; // standart sorgu değil
  const qd = buf.readUInt16BE(4);
  let off = 12;
  const questions = [];
  for (let i = 0; i < qd; i++) {
    const { name, end } = readName(buf, off);
    off = end;
    if (off + 4 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const cls = buf.readUInt16BE(off + 2);
    off += 4;
    questions.push({ name, type, unicast: (cls & 0x8000) !== 0, cls: cls & 0x7fff });
  }
  return { id, questions };
}

function encodeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const b = Buffer.from(label, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function rr(nameBuf, type, cls, ttl, rdata) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(cls, 2);
  h.writeUInt32BE(ttl, 4);
  h.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, h, rdata]);
}

function buildResponse({ id = 0, name, ip, ttl = 120, question = null, legacy = false, wantA = true }) {
  const nameBuf = encodeName(name);
  const cls = legacy ? 0x0001 : 0x8001; // önbellek temizleme biti yalnızca çok noktaya yayında
  const t = legacy ? Math.min(ttl, 10) : ttl;
  const a = rr(nameBuf, TYPE_A, cls, t, Buffer.from(ip.split('.').map(Number)));
  // NSEC: bu adın yalnızca A kaydı olduğunu (AAAA olmadığını) bildirir.
  const nsec = rr(nameBuf, TYPE_NSEC, cls, t, Buffer.concat([nameBuf, Buffer.from([0x00, 0x01, 0x40])]));
  const answers = wantA ? [a] : [nsec];
  const additional = wantA ? [nsec] : [a];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(legacy ? id : 0, 0);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(question ? 1 : 0, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(additional.length, 10);
  const parts = [header];
  if (question) {
    const q = Buffer.alloc(4);
    q.writeUInt16BE(question.type, 0);
    q.writeUInt16BE(1, 2);
    parts.push(encodeName(question.name), q);
  }
  return Buffer.concat([...parts, ...answers, ...additional]);
}

function createResponder(opts = {}) {
  const name = String(opts.name || 'windrop.local').replace(/\.$/, '');
  const lname = name.toLowerCase();
  const port = opts.port || 5353;
  const ttl = opts.ttl || 120;
  const log = opts.log || (() => {});
  const getInterfaces = opts.interfaces || lanInterfaces;
  const refreshMs = opts.refreshMs || 30000;
  const sockets = new Map(); // adres -> kayıt
  let timer = null, closed = false, lastError = null;

  function send(entry, buf, address, p) {
    try {
      entry.sock.send(buf, p, address, (err) => { if (err) log('warn', `mDNS gönderilemedi (${entry.iface.address}): ${err.message}`); });
    } catch (e) { log('warn', `mDNS gönderim hatası: ${e.message}`); }
  }

  function onMessage(entry, msg, rinfo) {
    const q = parseQuery(msg);
    if (!q) return;
    for (const question of q.questions) {
      if (question.name.toLowerCase() !== lname) continue;
      if (question.cls !== 1 && question.cls !== 255) continue;
      const wantA = question.type === TYPE_A || question.type === TYPE_ANY;
      if (!wantA && question.type !== TYPE_AAAA) continue;
      const ip = entry.iface.address;
      if (rinfo.port !== port) {
        // Eski tip (tek seferlik) sorgu: kaynak porta tek yönlü yanıt.
        send(entry, buildResponse({ id: q.id, name, ip, ttl, question, legacy: true, wantA }), rinfo.address, rinfo.port);
      } else if (question.unicast) {
        send(entry, buildResponse({ name, ip, ttl, wantA }), rinfo.address, port);
      } else {
        send(entry, buildResponse({ name, ip, ttl, wantA }), MDNS_GROUP, port);
      }
      entry.answered++;
      return;
    }
  }

  function open(iface) {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { lastError = e.message; return; }
    const entry = { sock, iface, ready: false, answered: 0 };
    sockets.set(iface.address, entry);
    const drop = () => {
      try { sock.close(); } catch {}
      if (sockets.get(iface.address) === entry) sockets.delete(iface.address);
    };
    sock.on('error', (err) => {
      lastError = `${iface.address}: ${err.message}`;
      log('warn', `mDNS soketi hatası (${iface.name} ${iface.address}): ${err.message}`);
      drop();
    });
    sock.on('message', (msg, rinfo) => {
      try { onMessage(entry, msg, rinfo); } catch (e) { /* bozuk paket */ }
    });
    try {
      sock.bind({ port, address: iface.address, exclusive: false }, () => {
        try {
          sock.addMembership(MDNS_GROUP, iface.address);
          sock.setMulticastInterface(iface.address);
          sock.setMulticastTTL(255);
          sock.setMulticastLoopback(true);
          entry.ready = true;
          log('info', `mDNS dinliyor: ${name} -> ${iface.address} (${iface.name}), port ${port}`);
          // Duyuru (iki kez, bir saniye arayla)
          const ann = buildResponse({ name, ip: iface.address, ttl });
          send(entry, ann, MDNS_GROUP, port);
          setTimeout(() => { if (entry.ready && !closed) send(entry, ann, MDNS_GROUP, port); }, 1000).unref();
        } catch (e) {
          lastError = `${iface.address}: ${e.message}`;
          log('warn', `mDNS grubuna katılamadı (${iface.address}): ${e.message}`);
          drop();
        }
      });
    } catch (e) {
      lastError = `${iface.address}: ${e.message}`;
      log('warn', `mDNS bağlanamadı (${iface.address}): ${e.message}`);
      drop();
    }
  }

  function refresh() {
    if (closed) return;
    let wanted = [];
    try { wanted = getInterfaces(); } catch (e) { lastError = e.message; }
    const keys = new Set(wanted.map((i) => i.address));
    for (const [addr, entry] of sockets) {
      if (!keys.has(addr)) {
        log('info', `mDNS arayüzü kaldırıldı: ${addr}`);
        entry.ready = false;
        try { entry.sock.close(); } catch {}
        sockets.delete(addr);
      }
    }
    for (const iface of wanted) if (!sockets.has(iface.address)) open(iface);
  }

  refresh();
  timer = setInterval(refresh, refreshMs);
  timer.unref();

  return {
    name,
    port,
    status() {
      return {
        name,
        interfaces: [...sockets.values()].filter((e) => e.ready).map((e) => ({ name: e.iface.name, address: e.iface.address, answered: e.answered })),
        lastError,
      };
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const entry of sockets.values()) { entry.ready = false; try { entry.sock.close(); } catch {} }
      sockets.clear();
    },
  };
}

// Bir yanıttaki, verilen ada ait A kayıtlarının IP adresleri.
function answersFor(buf, name) {
  const out = [];
  if (buf.length < 12) return out;
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000)) return out;
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = readName(buf, off).end + 4;
  for (let i = 0; i < total; i++) {
    const r = readName(buf, off);
    off = r.end;
    if (off + 10 > buf.length) break;
    const type = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 8);
    if (type === TYPE_A && len === 4 && r.name.toLowerCase() === name.toLowerCase()) out.push([...buf.subarray(off + 10, off + 14)].join('.'));
    off += 10 + len;
  }
  return out;
}

// Ad başka bir cihazda kullanılıyor mu? (Bu bilgisayarın kendi adreslerinden gelen yanıtlar sayılmaz.)
function probeName(name, opts = {}) {
  const timeoutMs = opts.timeoutMs || 800;
  const port = opts.port || 5353;
  const ifaces = (opts.interfaces || lanInterfaces)();
  const own = opts.ownAddresses || new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map((a) => a.address));
  return new Promise((resolve) => {
    if (!ifaces.length) return resolve(false);
    const socks = [];
    let finished = false;
    const finish = (conflict) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const s of socks) { try { s.close(); } catch {} }
      resolve(conflict);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const q = Buffer.concat([Buffer.from([Math.random() * 256 | 0, Math.random() * 256 | 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), encodeName(name), Buffer.from([0, TYPE_A, 0, 1])]);
    for (const iface of ifaces) {
      let s;
      try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { continue; }
      socks.push(s);
      s.on('error', () => {});
      s.on('message', (msg) => {
        try { if (answersFor(msg, name).some((ip) => !own.has(ip))) finish(true); } catch {}
      });
      try {
        s.bind({ port: 0, address: iface.address }, () => {
          try { s.setMulticastInterface(iface.address); s.send(q, port, MDNS_GROUP); } catch {}
        });
      } catch {}
    }
  });
}

module.exports = { createResponder, probeName, answersFor, lanInterfaces, isLanIPv4, parseQuery, buildResponse, encodeName, readName };
