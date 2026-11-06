# WinDrop kurulumu: Masaüstü ve Başlangıç kısayollarını oluşturur, simgeyi başlatır.
#   Kurmak:    powershell -ExecutionPolicy Bypass -File kur.ps1
#   Kaldırmak: powershell -ExecutionPolicy Bypass -File kur.ps1 -Kaldir
# Not: Bu dosya UTF-8 BOM ile kaydedilmelidir.
param([switch]$Kaldir)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')
$lnkDesktop = Join-Path $desktop 'WinDrop.lnk'
$lnkStartup = Join-Path $startup 'WinDrop.lnk'
$psExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Write-Adim([string]$m) { Write-Host ('  • ' + $m) }

function Test-Contains([string]$text, [string]$part) {
  return ($text -and $text.IndexOf($part, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Get-WinDropProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    (($_.Name -match '^powershell') -and (Test-Contains $_.CommandLine (Join-Path $root 'tray.ps1'))) -or
    (($_.Name -eq 'node.exe') -and (Test-Contains $_.CommandLine (Join-Path $root 'src\server.js')))
  }
}

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

function New-WinDropShortcut([string]$lnkPath, [bool]$withPanel, [bool]$vbs) {
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnkPath)
  $extra = ''
  if ($withPanel) { $extra = ' -Panel' }
  if ($vbs) {
    $sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $sc.Arguments = '"' + (Join-Path $root 'WinDrop.vbs') + '"' + $extra
  } else {
    # VBScript kapalıysa simge doğrudan PowerShell ile, gizli pencerede başlar.
    $sc.TargetPath = $psExe
    $sc.Arguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $root 'tray.ps1') + '"' + $extra
    $sc.WindowStyle = 7
  }
  $sc.WorkingDirectory = $root
  $ico = Join-Path $root 'data\windrop.ico'
  if (Test-Path $ico) { $sc.IconLocation = $ico + ',0' }
  $sc.Description = 'WinDrop: iPhone fotoğraf ve videolarını bu bilgisayara al'
  $sc.Save()
}

# ---------------------------------------------------------------- kaldırma
if ($Kaldir) {
  Write-Host 'WinDrop kaldırılıyor…'
  $procs = @(Get-WinDropProcesses)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Adim ('Durdurulan süreç: {0}' -f $procs.Count)
  foreach ($l in @($lnkDesktop, $lnkStartup)) {
    if (Test-Path -LiteralPath $l) { Remove-Item -LiteralPath $l -Force; Write-Adim ('Kısayol silindi: ' + $l) }
  }
  Remove-Item -Path 'HKCU:\Software\Classes\AppUserModelId\WinDrop' -Recurse -ErrorAction SilentlyContinue
  Write-Adim 'Bildirim kaydı silindi'
  Write-Host ''
  Write-Host 'WinDrop kaldırıldı. Gelen dosyalarınız İndirilenler klasöründe duruyor.'
  Write-Host ('Proje klasörünü isterseniz elle silebilirsiniz: ' + $root)
  Write-Host 'Güvenlik duvarı kurallarını kaldırmak için Yönetici PowerShell''de çalıştırın:'
  Write-Host '  Remove-NetFirewallRule -Group "WinDrop"'
  exit 0
}

# ------------------------------------------------------------------- kurulum
Write-Host 'WinDrop kuruluyor…'
$node = $null
try { $node = (Get-Command node.exe -ErrorAction Stop).Source } catch {}
if (-not $node) {
  Write-Host 'Node.js bulunamadı. Önce Node.js kurulmalı (https://nodejs.org).' -ForegroundColor Red
  exit 1
}
Write-Adim ('Node.js: {0} ({1})' -f $node, (& $node --version))

& $node (Join-Path $root 'src\server.js') --icons | Out-Null
Write-Adim 'Simgeler üretildi (data\windrop.ico)'

$vbs = Test-VbsWorks
if ($vbs) { Write-Adim 'VBScript açık: kısayollar WinDrop.vbs ile başlatacak' }
else { Write-Adim 'VBScript kapalı: kısayollar doğrudan PowerShell ile başlatacak' }

New-WinDropShortcut $lnkDesktop $true $vbs
Write-Adim ('Masaüstü kısayolu: ' + $lnkDesktop)
New-WinDropShortcut $lnkStartup $false $vbs
Write-Adim ('Windows açılışında başlat: ' + $lnkStartup)

$trayRunning = @(Get-WinDropProcesses | Where-Object { $_.Name -match '^powershell' })
if ($trayRunning.Count -gt 0) {
  $port = 8765
  try { $port = [int]((Get-Content -LiteralPath (Join-Path $root 'data\config.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port) } catch {}
  Write-Adim 'Simge zaten çalışıyor; panel açılıyor'
  Start-Process ('http://localhost:{0}/' -f $port)
} else {
  if ($vbs) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $root 'WinDrop.vbs') + '"'), '-Panel'
  } else {
    Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList '-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $root 'tray.ps1') + '"'), '-Panel'
  }
  Write-Adim 'Simge başlatıldı; sunucu açılınca panel tarayıcıda açılacak'
}
Write-Host ''
Write-Host 'Kurulum tamam. Simge görev çubuğunun sağında, ^ okunun altında olabilir; oradan görev çubuğuna sürükleyebilirsiniz.'
