'use strict';
// src/*.js dosyalarını Node'un tek exe (SEA) özelliği için tek bir dosyada toplar
// ve sea-config.json üretir. Kullanım: node build/bundle.js <çıktı klasörü>
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'build'));
fs.mkdirSync(out, { recursive: true });

const modules = ['qr', 'mdns', 'toast', 'server'];
let code = `'use strict';
// WinDrop sunucusu – tek dosya paketi. build/bundle.js üretir; elle düzenlemeyin.
const __defs = Object.create(null);
const __cache = Object.create(null);
const __nodeRequire = require;
function __require(id) {
  const key = String(id).replace(/^\\.\\//, '').replace(/\\.js$/, '');
  if (__defs[key]) {
    if (!__cache[key]) {
      const module = { exports: {} };
      __cache[key] = module;
      __defs[key].call(module.exports, module, module.exports, __require);
    }
    return __cache[key].exports;
  }
  return __nodeRequire(id); // yalnızca Node'un kendi modülleri
}
`;
for (const m of modules) {
  const src = fs.readFileSync(path.join(root, 'src', `${m}.js`), 'utf8');
  for (const dep of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const id = dep[1];
    if (!id.startsWith('node:') && !modules.includes(id.replace(/^\.\//, ''))) {
      throw new Error(`${m}.js izin verilmeyen bir modül istiyor: ${id}`);
    }
  }
  code += `__defs[${JSON.stringify(m)}] = function (module, exports, require) {\n${src}\n};\n`;
}
code += `__require('./server').main();\n`;
fs.writeFileSync(path.join(out, 'windrop-server.js'), code);

const config = {
  main: path.join(out, 'windrop-server.js'),
  output: path.join(out, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {},
};
for (const a of ['send.html', 'panel.html', 'awake.mp4']) {
  const p = path.join(root, 'public', a);
  if (fs.existsSync(p)) config.assets[a] = p;
  else console.warn(`Uyarı: public/${a} yok, pakete eklenmedi.`);
}
fs.writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify(config, null, 2));
console.log(`Paket hazır: ${path.join(out, 'windrop-server.js')} (${Object.keys(config.assets).join(', ')})`);
