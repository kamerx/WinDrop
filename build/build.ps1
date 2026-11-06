# WinDrop derleme betiği: dist\WinDrop-Kurulum-<sürüm>.exe üretir.
#   powershell -ExecutionPolicy Bypass -File build\build.ps1          (derle)
#   powershell -ExecutionPolicy Bypass -File build\build.ps1 -TestEt  (derle + testleri exe'ye karşı çalıştır)
# Gerekenler (yalnızca derlemede): Node.js 22+, npm (postject, rcedit), Inno Setup 6,
# Microsoft WebView2 SDK (NuGet'ten otomatik indirilir), Windows'taki .NET Framework derleyicisi.
param([switch]$TestEt)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'dist\build'
$tools = Join-Path $root 'dist\tools'
$wv2Version = '1.0.4258.31'
function Adim([string]$m) { Write-Host ('==> ' + $m) -ForegroundColor Cyan }
function Kontrol([string]$ne) { if ($LASTEXITCODE -ne 0) { throw ($ne + ' başarısız (çıkış kodu ' + $LASTEXITCODE + ')') } }
# Dış programları çalıştırır; stderr'e yazılan bilgi satırları hata sayılmaz, karar çıkış kodundan verilir.
function Calistir([scriptblock]$komut) {
  $eski = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $komut 2>&1 | ForEach-Object { Write-Host ('    ' + $_) } } finally { $ErrorActionPreference = $eski }
}

New-Item -ItemType Directory -Force $build, $tools | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
$server = Join-Path $build 'windrop-server.exe'
$ico = Join-Path $build 'windrop.ico'

Adim 'Simgeler'
& $node (Join-Path $root 'src\server.js') --icons $build | Out-Null
Kontrol 'Simge üretimi'

Adim 'Kurulum sihirbazı görselleri'
Add-Type -AssemblyName System.Drawing
function Draw-Logo($g, [single]$cx, [single]$cy, [single]$s) {
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]($s * 0.05))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  foreach ($k in 0.175, 0.275, 0.375) { $r = $s * $k; $g.DrawArc($pen, [single]($cx - $r), [single]($cy - $r), [single](2 * $r), [single](2 * $r), [single]130, [single]280) }
  $d = $s * 0.068; $g.FillEllipse([System.Drawing.Brushes]::White, [single]($cx - $d), [single]($cy - $d), [single](2 * $d), [single](2 * $d))
  $pen.Dispose()
}
foreach ($pct in 100, 150, 200) {
  $f = $pct / 100.0
  # büyük görsel (karşılama ve bitiş sayfası)
  $w = [int](164 * $f); $h = [int](314 * $f)
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Rectangle(0, 0, $w, $h)), [System.Drawing.Color]::FromArgb(0x50, 0x95, 0xFB), [System.Drawing.Color]::FromArgb(0x2F, 0x67, 0xE0), [single]90)
  $g.FillRectangle($br, 0, 0, $w, $h)
  Draw-Logo $g ($w / 2) ($h * 0.36) ($w * 0.78)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'
  $font = New-Object System.Drawing.Font('Segoe UI Semibold', [single](17 * $f), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString('WinDrop', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF([single]0, [single]($h * 0.62), [single]$w, [single](40 * $f))), $sf)
  $font2 = New-Object System.Drawing.Font('Segoe UI', [single](11 * $f), [System.Drawing.GraphicsUnit]::Pixel)
  $soft = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(225, 255, 255, 255))
  $g.DrawString("iPhone'dan bilgisayara", $font2, $soft, (New-Object System.Drawing.RectangleF([single]0, [single]($h * 0.62 + 26 * $f), [single]$w, [single](30 * $f))), $sf)
  $g.Dispose(); $bmp.Save((Join-Path $build "wizard-$pct.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp); $bmp.Dispose()
  # küçük görsel (sayfa başlıkları)
  $s = [int](55 * $f)
  $sm = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($sm); $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::White)
  $rad = $s * 0.225; $p = New-Object System.Drawing.Drawing2D.GraphicsPath; $d2 = $rad * 2
  $p.AddArc(0, 0, $d2, $d2, 180, 90); $p.AddArc($s - $d2 - 1, 0, $d2, $d2, 270, 90); $p.AddArc($s - $d2 - 1, $s - $d2 - 1, $d2, $d2, 0, 90); $p.AddArc(0, $s - $d2 - 1, $d2, $d2, 90, 90); $p.CloseFigure()
  $br2 = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Rectangle(0, 0, $s, $s)), [System.Drawing.Color]::FromArgb(0x50, 0x95, 0xFB), [System.Drawing.Color]::FromArgb(0x3A, 0x7B, 0xF5), [single]90)
  $g.FillPath($br2, $p)
  Draw-Logo $g ($s / 2) ($s * 0.535) $s
  $g.Dispose(); $sm.Save((Join-Path $build "small-$pct.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp); $sm.Dispose()
}

Adim 'Sunucu tek dosyada toplanıyor'
& $node (Join-Path $PSScriptRoot 'bundle.js') $build
Kontrol 'Paketleme'
Calistir { & $node --experimental-sea-config (Join-Path $build 'sea-config.json') }
Kontrol 'SEA blob'

Adim 'windrop-server.exe hazırlanıyor (Node.js gömülü)'
Copy-Item -LiteralPath $node -Destination $server -Force
& $node (Join-Path $PSScriptRoot 'strip-signature.js') $server
Kontrol 'İmza kaldırma'
$rcedit = Join-Path $tools 'node_modules\rcedit\bin\rcedit-x64.exe'
if (-not (Test-Path $rcedit)) {
  Calistir { & npm install rcedit@4.0.1 --prefix $tools --no-save --no-audit --no-fund --loglevel=error }
  Kontrol 'rcedit kurulumu'
}
& $rcedit $server --set-icon $ico `
  --set-version-string FileDescription 'WinDrop sunucusu' `
  --set-version-string ProductName 'WinDrop' `
  --set-version-string CompanyName 'Kamer EKENEL' `
  --set-version-string InternalName 'windrop-server' `
  --set-version-string OriginalFilename 'windrop-server.exe' `
  --set-version-string LegalCopyright '© 2026 Kamer EKENEL · Node.js gömülü (MIT lisansı)' `
  --set-file-version '1.3.2.0' --set-product-version '1.3.2'
Kontrol 'rcedit'
Calistir { & npx --yes postject@1.0.0-alpha.6 $server NODE_SEA_BLOB (Join-Path $build 'sea-prep.blob') --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 }
Kontrol 'postject'

Adim 'WebView2 bileşeni (Microsoft, NuGet)'
$wv2 = Join-Path $tools 'webview2'
New-Item -ItemType Directory -Force $wv2 | Out-Null
$need = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
if (@($need | Where-Object { -not (Test-Path (Join-Path $wv2 $_)) }).Count -gt 0) {
  $pkg = Join-Path $wv2 "microsoft.web.webview2.$wv2Version.nupkg"
  Invoke-WebRequest -UseBasicParsing "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$wv2Version/microsoft.web.webview2.$wv2Version.nupkg" -OutFile $pkg
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($pkg)
  try {
    $zip.Entries | Where-Object { $_.FullName -match '^(lib/net462/Microsoft\.Web\.WebView2\.(Core|WinForms)\.dll|runtimes/win-x64/native/WebView2Loader\.dll)$' } |
      ForEach-Object { [IO.Compression.ZipFileExtensions]::ExtractToFile($_, (Join-Path $wv2 $_.Name), $true) }
  } finally { $zip.Dispose() }
}
foreach ($d in $need) { Copy-Item (Join-Path $wv2 $d) $build -Force }

Adim 'Lisans metinleri (Node.js, WebView2)'
$lic = Join-Path $build 'licenses'
New-Item -ItemType Directory -Force $lic | Out-Null
$nodeVer = (& $node --version).Trim()
$nodeLic = Join-Path $tools "node-LICENSE-$nodeVer.txt"
if (-not (Test-Path $nodeLic)) { Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/nodejs/node/$nodeVer/LICENSE" -OutFile $nodeLic }
Copy-Item $nodeLic (Join-Path $lic "Node.js-$nodeVer-LICENSE.txt") -Force
$wvLic = Join-Path $wv2 'LICENSE.txt'; $wvNot = Join-Path $wv2 'NOTICE.txt'
if (-not (Test-Path $wvLic) -or -not (Test-Path $wvNot)) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead((Get-ChildItem $wv2 -Filter *.nupkg | Select-Object -First 1).FullName)
  try { $zip.Entries | Where-Object { $_.FullName -in 'LICENSE.txt', 'NOTICE.txt' } | ForEach-Object { [IO.Compression.ZipFileExtensions]::ExtractToFile($_, (Join-Path $wv2 $_.Name), $true) } } finally { $zip.Dispose() }
}
Copy-Item $wvLic (Join-Path $lic 'Microsoft-WebView2-LICENSE.txt') -Force
Copy-Item $wvNot (Join-Path $lic 'Microsoft-WebView2-NOTICE.txt') -Force
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $lic 'WinDrop-LICENSE.txt') -Force

Adim 'WinDrop.exe (program penceresi ve bildirim alanı) derleniyor'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /codepage:65001 /target:winexe /platform:x64 /optimize+ ('/out:' + (Join-Path $build 'WinDrop.exe')) ('/win32icon:' + $ico) `
  ('/win32manifest:' + (Join-Path $root 'app\app.manifest')) /r:System.Windows.Forms.dll /r:System.Drawing.dll `
  ('/r:' + (Join-Path $wv2 'Microsoft.Web.WebView2.Core.dll')) ('/r:' + (Join-Path $wv2 'Microsoft.Web.WebView2.WinForms.dll')) `
  (Join-Path $root 'app\WinDrop.cs')
Kontrol 'C# derlemesi'

if ($TestEt) {
  Adim 'Testler windrop-server.exe ile çalışıyor'
  $env:WINDROP_SERVER_EXE = $server
  try { Calistir { & $node --test (Join-Path $root 'test\server.test.js') }; Kontrol 'Testler' } finally { Remove-Item Env:WINDROP_SERVER_EXE -ErrorAction SilentlyContinue }
}

Adim 'Kurulum sihirbazı derleniyor'
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 bulunamadı (winget install JRSoftware.InnoSetup)' }
& $iscc /Q (Join-Path $root 'installer\windrop.iss')
Kontrol 'Inno Setup'

Get-ChildItem (Join-Path $root 'dist') -Filter 'WinDrop-Kurulum-*.exe' | Sort-Object LastWriteTime | Select-Object -Last 1 | ForEach-Object {
  Write-Host ('Hazır: {0} ({1:N1} MB)' -f $_.FullName, ($_.Length / 1MB)) -ForegroundColor Green
}
