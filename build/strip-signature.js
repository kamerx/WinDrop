'use strict';
// Bir Windows PE dosyasından Authenticode imzasını kaldırır.
// node.exe'ye kod eklendiğinde imzası zaten geçersiz kalır; bozuk imza bırakmamak için silinir.
// Kullanım: node build/strip-signature.js <dosya.exe>
const fs = require('node:fs');

const file = process.argv[2];
const buf = fs.readFileSync(file);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('PE dosyası değil: ' + file);
const opt = pe + 24;
const magic = buf.readUInt16LE(opt);
const dirs = opt + (magic === 0x20b ? 112 : 96); // PE32+ : PE32
const sec = dirs + 4 * 8; // 4 numaralı dizin: güvenlik (imza)
const off = buf.readUInt32LE(sec);
const size = buf.readUInt32LE(sec + 4);
if (!off || !size) {
  console.log('İmza yok: ' + file);
  process.exit(0);
}
let end = buf.length;
if (off + size >= buf.length - 8 && off < buf.length) end = off; // imza dosyanın sonundadır
const out = Buffer.from(buf.subarray(0, end));
out.writeUInt32LE(0, sec);
out.writeUInt32LE(0, sec + 4);
fs.writeFileSync(file, out);
console.log(`İmza kaldırıldı: ${file} (${size} bayt)`);
