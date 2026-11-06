'use strict';
// Windows bildirimi (WinRT toast) – PowerShell üzerinden, dosya adları yalnızca kaçışlı XML olarak geçer.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const AUMID = 'WinDrop';
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.tif', '.tiff', '.avif', '.dng']);
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm', '.3gp', '.hevc']);
const BATCH_MS = 2500;
const BATCH_MAX_MS = 15000;
const THUMB_MAX_AGE_MS = 24 * 3600 * 1000;

function kindOf(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

function xmlEscape(value) {
  let s = String(value == null ? '' : value);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  // XML 1.0'da izin verilmeyen kontrol karakterleri silinir.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function buildToastXml({ title, lines = [], image = null, launch, actions = [] }) {
  const texts = [title, ...lines.slice(0, 2)].map((t) => `<text>${xmlEscape(t)}</text>`).join('');
  const img = image ? `<image src="${xmlEscape(image)}"/>` : '';
  const acts = actions.length
    ? `<actions>${actions.map((a) => `<action content="${xmlEscape(a.content)}" activationType="protocol" arguments="${xmlEscape(a.arguments)}"/>`).join('')}</actions>`
    : '';
  return `<toast activationType="protocol" launch="${xmlEscape(launch)}"><visual><binding template="ToastGeneric">${texts}${img}</binding></visual>${acts}</toast>`;
}

// XML ortam değişkeninden okunur; komut satırına hiçbir dosya adı girmez.
const PS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml([Environment]::GetEnvironmentVariable('WINDROP_TOAST_XML'))
  if ([Environment]::GetEnvironmentVariable('WINDROP_TOAST_DRYRUN') -eq '1') {
    $list = New-Object System.Collections.Generic.List[string]
    $nodes = $doc.GetElementsByTagName('text')
    for ($i = 0; $i -lt $nodes.Length; $i++) { $list.Add($nodes.Item($i).InnerText) }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($list -join "\`n"))
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
    exit 0
  }
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $tag = [Environment]::GetEnvironmentVariable('WINDROP_TOAST_TAG')
  if ($tag) { $toast.Tag = $tag; $toast.Group = 'windrop' }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([Environment]::GetEnvironmentVariable('WINDROP_AUMID')).Show($toast)
  exit 0
} catch {
  exit 1
}
`;
const PS_ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

function runToastScript(xml, extraEnv = {}) {
  return new Promise((resolve) => {
    let p;
    const env = { ...process.env, WINDROP_TOAST_XML: xml, WINDROP_AUMID: AUMID, ...extraEnv };
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', PS_ENCODED], {
        env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: extraEnv.WINDROP_CWD || undefined,
      });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', error: e.message });
    }
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', () => {}); // stderr'e bakılmaz; karar çıkış kodundan verilir
    const killer = setTimeout(() => { try { p.kill(); } catch {} }, 30000);
    p.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, code: -1, stdout: '', error: e.message }); });
    p.on('close', (code) => { clearTimeout(killer); resolve({ ok: code === 0, code, stdout: Buffer.concat(out).toString('utf8') }); });
  });
}

function regAdd(args) {
  return new Promise((resolve) => {
    try {
      const p = spawn('reg.exe', ['add', ...args, '/f'], { windowsHide: true, stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (c) => resolve(c === 0));
    } catch { resolve(false); }
  });
}

// Bildirimde "Windows PowerShell" yerine "WinDrop" görünmesi için (yönetici gerekmez).
async function registerAumid(iconPath) {
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
  const a = await regAdd([key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'WinDrop']);
  const b = iconPath ? await regAdd([key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', iconPath]) : true;
  return a && b;
}

// ffmpeg'i önce PATH'te, sonra winget'in ve yaygın kurulumların klasörlerinde arar
// (winget PATH'i değiştirse de çalışan süreçler bunu ancak yeniden oturum açınca görür).
function ffmpegCandidates() {
  const out = ['ffmpeg'];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    out.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'));
    const pk = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter((n) => /ffmpeg/i.test(n))) {
        const dir = path.join(pk, d);
        for (const sub of fs.readdirSync(dir)) out.push(path.join(dir, sub, 'bin', 'ffmpeg.exe'));
      }
    } catch {}
  }
  out.push('C:\\ffmpeg\\bin\\ffmpeg.exe');
  if (process.env.ProgramFiles) out.push(path.join(process.env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'));
  return out;
}

let ffmpegCache;
function findFfmpeg() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  ffmpegCache = null;
  for (const c of ffmpegCandidates()) {
    if (c !== 'ffmpeg' && !fs.existsSync(c)) continue;
    try {
      const r = spawnSync(c, ['-hide_banner', '-version'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
      if (!r.error && r.status === 0) { ffmpegCache = c; break; }
    } catch {}
  }
  return ffmpegCache;
}

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(findFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: 'ignore' });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('exit', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('ffmpeg çıkış kodu ' + c)); });
  });
}

function formatSize(n) {
  const units = ['bayt', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

function createNotifier({ dataDir, destDir, destLabel, log = () => {}, enabled = true }) {
  const thumbs = path.join(dataDir, 'thumbs');
  let pending = [];
  let timer = null;
  let firstAt = 0;

  async function makePreview(f) {
    const ext = path.extname(f.path).toLowerCase();
    const kind = kindOf(f.path);
    if (kind === 'other') return null;
    if (findFfmpeg()) {
      try {
        fs.mkdirSync(thumbs, { recursive: true });
        const base = path.join(thumbs, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
        const out = base + '.jpg';
        const scale = 'scale=640:480:force_original_aspect_ratio=decrease';
        if (ext === '.heic' || ext === '.heif') {
          // iPhone HEIC dosyaları karo ızgarasıdır: önce filtresiz tam JPEG, sonra küçült.
          const full = base + '-full.jpg';
          await runFfmpeg(['-i', f.path, '-frames:v', '1', '-q:v', '3', full]);
          await runFfmpeg(['-i', full, '-vf', scale, '-q:v', '4', out]);
          fs.rmSync(full, { force: true });
        } else if (kind === 'video') {
          try { await runFfmpeg(['-ss', '0.5', '-i', f.path, '-frames:v', '1', '-vf', scale, '-q:v', '4', out]); }
          catch { await runFfmpeg(['-i', f.path, '-frames:v', '1', '-vf', scale, '-q:v', '4', out]); }
        } else {
          await runFfmpeg(['-i', f.path, '-frames:v', '1', '-vf', scale, '-q:v', '4', out]);
        }
        if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
      } catch (e) {
        log('warn', `Önizleme üretilemedi (${path.basename(f.path)}): ${e.message}`);
      }
    }
    // ffmpeg yoksa yalnızca küçük JPEG/PNG/GIF doğrudan önizlenir.
    if (['.jpg', '.jpeg', '.png', '.gif'].includes(ext) && f.size <= 2 * 1024 * 1024) return f.path;
    return null;
  }

  async function flush() {
    const files = pending;
    pending = [];
    firstAt = 0;
    timer = null;
    if (!files.length) return;
    const last = files[files.length - 1];
    let image = null;
    for (let i = files.length - 1; i >= 0 && !image; i--) image = await makePreview(files[i]);
    const folderUri = pathToFileURL(destDir).href;
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    let title, lines;
    if (files.length === 1) {
      const k = kindOf(last.name);
      title = k === 'image' ? 'Fotoğraf alındı' : k === 'video' ? 'Video alındı' : 'Dosya alındı';
      lines = [last.name, `${formatSize(total)} · ${destLabel}`];
    } else {
      const imgs = files.filter((f) => kindOf(f.name) === 'image').length;
      const vids = files.filter((f) => kindOf(f.name) === 'video').length;
      const other = files.length - imgs - vids;
      const parts = [];
      if (imgs) parts.push(`${imgs} fotoğraf`);
      if (vids) parts.push(`${vids} video`);
      if (other) parts.push(`${other} dosya`);
      title = `${parts.join(', ')} alındı`;
      const names = files.slice(0, 3).map((f) => f.name).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '');
      lines = [names, `${formatSize(total)} · ${destLabel}`];
    }
    const xml = buildToastXml({
      title,
      lines,
      image: image ? pathToFileURL(image).href : null,
      launch: folderUri,
      actions: [
        { content: 'Aç', arguments: pathToFileURL(last.path).href },
        { content: 'Klasörü göster', arguments: folderUri },
      ],
    });
    const r = await runToastScript(xml, { WINDROP_TOAST_TAG: 'w' + Date.now().toString(36) });
    if (r.ok) log('info', `Bildirim gösterildi: ${title}`);
    else log('warn', `Bildirim gösterilemedi (çıkış kodu ${r.code}${r.error ? ', ' + r.error : ''})`);
  }

  function add(file) {
    if (!enabled) return;
    pending.push(file);
    if (!firstAt) firstAt = Date.now();
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(BATCH_MS, firstAt + BATCH_MAX_MS - Date.now()));
    timer = setTimeout(() => { flush().catch((e) => log('warn', `Bildirim hatası: ${e.message}`)); }, wait);
  }

  function cleanupThumbs() {
    try {
      for (const n of fs.readdirSync(thumbs)) {
        const p = path.join(thumbs, n);
        try { if (Date.now() - fs.statSync(p).mtimeMs > THUMB_MAX_AGE_MS) fs.rmSync(p, { force: true }); } catch {}
      }
    } catch {}
  }

  // Dosya dışı uyarılar (ör. kestirme yanlış ayarlı). Aynı uyarı en çok 2 dakikada bir gösterilir.
  const lastMessage = new Map();
  function message(key, title, lines) {
    if (!enabled) return;
    const now = Date.now();
    if (now - (lastMessage.get(key) || 0) < 120000) return;
    lastMessage.set(key, now);
    const folderUri = pathToFileURL(destDir).href;
    const xml = buildToastXml({ title, lines, launch: folderUri });
    runToastScript(xml, { WINDROP_TOAST_TAG: 'm' + now.toString(36) }).then((r) => {
      log(r.ok ? 'info' : 'warn', r.ok ? `Uyarı bildirimi gösterildi: ${title}` : `Uyarı bildirimi gösterilemedi (çıkış kodu ${r.code})`);
    });
  }

  return { add, flush, cleanupThumbs, makePreview, message };
}

module.exports = { AUMID, kindOf, xmlEscape, buildToastXml, runToastScript, registerAumid, findFfmpeg, createNotifier, formatSize };

// Elle deneme: node src/toast.js --demo
if (require.main === module && process.argv.includes('--demo')) {
  (async () => {
    const root = path.resolve(__dirname, '..');
    const icon = path.join(root, 'data', 'icon.png');
    await registerAumid(fs.existsSync(icon) ? icon : null);
    let dest = path.join(require('node:os').homedir(), 'Downloads');
    try { dest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'config.json'), 'utf8')).dest || dest; } catch {}
    const folder = pathToFileURL(dest).href;
    const xml = buildToastXml({
      title: 'WinDrop hazır',
      lines: ['Bu bir deneme bildirimidir.', 'Tıklayınca İndirilenler klasörü açılır.'],
      image: fs.existsSync(icon) ? pathToFileURL(icon).href : null,
      launch: folder,
      actions: [{ content: 'Klasörü göster', arguments: folder }],
    });
    const r = await runToastScript(xml, { WINDROP_TOAST_TAG: 'demo' });
    console.log(r.ok ? 'Bildirim gönderildi (çıkış kodu 0).' : `Bildirim gönderilemedi (çıkış kodu ${r.code}).`);
    process.exitCode = r.ok ? 0 : 1;
  })();
}
