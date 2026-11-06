# WinDrop bildirim alanı simgesi. WinDrop.vbs ile pencere açmadan başlatılır.
# Not: Bu dosya UTF-8 BOM ile kaydedilmelidir (Windows PowerShell 5.1 Türkçe karakterler için).
param([switch]$Panel)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$serverJs = Join-Path $root 'src\server.js'
$configFile = Join-Path $root 'data\config.json'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'WinDrop.lnk'

# Yüksek DPI ekranlarda simge bulanık olmasın (pencere oluşmadan önce çağrılmalı).
try {
  Add-Type -Namespace WinDropNative -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool DestroyIcon(System.IntPtr h);
'@ -ErrorAction Stop
  [void][WinDropNative.Win]::SetProcessDPIAware()
} catch {}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Get-Config {
  try { return (Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Get-Port {
  $c = Get-Config
  if ($c -and $c.port) { return [int]$c.port }
  return 8765
}
function Open-Panel { Start-Process ("http://localhost:{0}/" -f (Get-Port)) }

# Tek kopya: ikinci açılış paneli açar ve çıkar.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\WinDropTray', [ref]$createdNew)
if (-not $createdNew) {
  if ($Panel) { Open-Panel }
  exit 0
}

$node = $null
try { $node = (Get-Command node.exe -ErrorAction Stop).Source } catch {}
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }

# ---------------------------------------------------------------- simge çizimi
function New-WinDropIcon([bool]$on) {
  $size = [System.Windows.Forms.SystemInformation]::SmallIconSize.Width
  if ($size -lt 16) { $size = 16 }
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [single]$size
  # yuvarlak köşeli kare
  $d = $s * 0.45
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($s - $d, 0, $d, $d, 270, 90)
  $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $path.AddArc(0, $s - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  if ($on) {
    $c1 = [System.Drawing.Color]::FromArgb(255, 0x50, 0x95, 0xFB); $c2 = [System.Drawing.Color]::FromArgb(255, 0x3A, 0x7B, 0xF5)
  } else {
    $c1 = [System.Drawing.Color]::FromArgb(255, 0xA3, 0xA8, 0xB0); $c2 = [System.Drawing.Color]::FromArgb(255, 0x7F, 0x85, 0x8E)
  }
  $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, [single]90)
  $g.FillPath($brush, $path)
  # altı açık halkalar ve nokta; 24 pikselin altında iki kalın halka
  if ($size -lt 24) { $radii = @(0.235, 0.385); $pw = $s * 0.095; $dot = $s * 0.095; $gap = 48 }
  else { $radii = @(0.175, 0.275, 0.375); $pw = $s * 0.05; $dot = $s * 0.068; $gap = 40 }
  $cx = $s * 0.5; $cy = $s * 0.535
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]$pw)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  foreach ($k in $radii) {
    $r = $s * $k
    $g.DrawArc($pen, [single]($cx - $r), [single]($cy - $r), [single](2 * $r), [single](2 * $r), [single](90 + $gap), [single](360 - 2 * $gap))
  }
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.FillEllipse($white, [single]($cx - $dot), [single]($cy - $dot), [single](2 * $dot), [single](2 * $dot))
  $g.Dispose(); $pen.Dispose(); $brush.Dispose(); $white.Dispose(); $path.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  return $icon
}

# --------------------------------------------------------------- sunucu yönetimi
$script:proc = $null
$script:userStopped = $false
$script:starts = New-Object System.Collections.Generic.List[datetime]
$script:holdUntil = [datetime]::MinValue
$script:panelPending = [bool]$Panel
$script:isOn = $null

function Get-WinDropListenerPid {
  $port = Get-Port
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId={0}" -f $c.OwningProcess) -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -and $p.CommandLine -like '*src\server.js*') { return [int]$c.OwningProcess }
  }
  return $null
}

function Test-ServerRunning {
  if ($script:proc -and -not $script:proc.HasExited) { return $true }
  $id = Get-WinDropListenerPid
  if ($id) {
    try { $script:proc = Get-Process -Id $id -ErrorAction Stop } catch {}
    return $true
  }
  return $false
}

function Start-WinDropServer {
  $now = Get-Date
  if ($now -lt $script:holdUntil) { return }
  # Kısa sürede çok sık kapanıyorsa (ör. port başka programda) 30 sn bekle.
  $recent = @($script:starts | Where-Object { ($now - $_).TotalSeconds -lt 60 })
  $script:starts = New-Object System.Collections.Generic.List[datetime]
  foreach ($t in $recent) { $script:starts.Add($t) }
  if ($script:starts.Count -ge 5) { $script:holdUntil = $now.AddSeconds(30); $script:starts.Clear(); return }
  $script:starts.Add($now)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '"' + $serverJs + '"'
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  try { $script:proc = [System.Diagnostics.Process]::Start($psi) } catch { $script:proc = $null }
}

function Stop-WinDropServer {
  $script:userStopped = $true
  if ($script:proc -and -not $script:proc.HasExited) {
    try { $script:proc.Kill(); [void]$script:proc.WaitForExit(3000) } catch {}
  }
  # Portun sahibini doğrula: yalnızca komut satırında src\server.js olan süreç durdurulur.
  $id = Get-WinDropListenerPid
  if ($id) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  $script:proc = $null
}

# ---------------------------------------------------------- başlangıç kısayolu
function Test-VbsWorks {
  $cscript = Join-Path $env:WINDIR 'System32\cscript.exe'
  if (-not (Test-Path $cscript)) { return $false }
  $tmp = Join-Path $env:TEMP ('windrop-vbs-' + [guid]::NewGuid().ToString('N') + '.vbs')
  try {
    Set-Content -LiteralPath $tmp -Value 'WScript.Quit 7' -Encoding ASCII
    $p = Start-Process -FilePath $cscript -ArgumentList '//NoLogo', '//B', ('"' + $tmp + '"') -WindowStyle Hidden -Wait -PassThru
    return ($p.ExitCode -eq 7)
  } catch { return $false } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}

function New-WinDropShortcut([string]$lnkPath, [bool]$withPanel) {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $extra = ''
  if ($withPanel) { $extra = ' -Panel' }
  if (Test-VbsWorks) {
    $sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $sc.Arguments = '"' + (Join-Path $root 'WinDrop.vbs') + '"' + $extra
  } else {
    $sc.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $sc.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'tray.ps1') + '"' + $extra
    $sc.WindowStyle = 7
  }
  $sc.WorkingDirectory = $root
  $ico = Join-Path $root 'data\windrop.ico'
  if (Test-Path $ico) { $sc.IconLocation = $ico + ',0' }
  $sc.Description = 'WinDrop: iPhone fotoğraf ve videolarını bu bilgisayara al'
  $sc.Save()
}

# ------------------------------------------------------------------ arayüz
$iconOn = New-WinDropIcon $true
$iconOff = New-WinDropIcon $false

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconOff
$notify.Text = 'WinDrop'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miPanel = $menu.Items.Add('Paneli aç')
$miPanel.Font = New-Object System.Drawing.Font($miPanel.Font, [System.Drawing.FontStyle]::Bold)
$miFolder = $menu.Items.Add('Gelenler klasörünü aç')
$miToggle = $menu.Items.Add("WinDrop'u durdur")
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miAuto = New-Object System.Windows.Forms.ToolStripMenuItem('Windows açılışında başlat')
$miAuto.CheckOnClick = $false
$miAuto.Checked = (Test-Path -LiteralPath $startupLnk)
[void]$menu.Items.Add($miAuto)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit = $menu.Items.Add('Çıkış')
$notify.ContextMenuStrip = $menu

function Update-Ui([bool]$on) {
  if ($script:isOn -eq $on) { return }
  $script:isOn = $on
  if ($on) {
    $notify.Icon = $iconOn
    $notify.Text = ('WinDrop açık · port {0}' -f (Get-Port))
    $miToggle.Text = "WinDrop'u durdur"
  } else {
    $notify.Icon = $iconOff
    if ($script:userStopped) { $notify.Text = 'WinDrop durduruldu' } else { $notify.Text = 'WinDrop başlatılıyor…' }
    $miToggle.Text = "WinDrop'u başlat"
  }
}

function Invoke-Check {
  try {
    if ($script:userStopped) { Update-Ui $false; return }
    if (Test-ServerRunning) {
      Update-Ui $true
      if ($script:panelPending) { $script:panelPending = $false; Open-Panel }
    } else {
      Update-Ui $false
      Start-WinDropServer
    }
  } catch {}
}

$miPanel.add_Click({ Open-Panel })
$miFolder.add_Click({
  $c = Get-Config
  $dest = $null
  if ($c -and $c.dest) { $dest = [string]$c.dest } else { $dest = Join-Path $env:USERPROFILE 'Downloads' }
  Start-Process explorer.exe -ArgumentList ('"' + $dest + '"')
})
$miToggle.add_Click({
  if ($script:userStopped -or -not (Test-ServerRunning)) {
    $script:userStopped = $false
    $script:holdUntil = [datetime]::MinValue
    $script:isOn = $null
    Start-WinDropServer
  } else {
    Stop-WinDropServer
    $script:isOn = $null
    Update-Ui $false
  }
})
$miAuto.add_Click({
  try {
    if (Test-Path -LiteralPath $startupLnk) { Remove-Item -LiteralPath $startupLnk -Force }
    else { New-WinDropShortcut $startupLnk $false }
  } catch {}
  $miAuto.Checked = (Test-Path -LiteralPath $startupLnk)
})
$miExit.add_Click({
  $timer.Stop()
  Stop-WinDropServer
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$notify.add_MouseClick({
  param($src, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Panel }
})
$menu.add_Opening({ $miAuto.Checked = (Test-Path -LiteralPath $startupLnk) })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ Invoke-Check })
$timer.Start()
Invoke-Check

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $notify.Visible = $false
  $notify.Dispose()
  try { $mutex.ReleaseMutex() } catch {}
}
