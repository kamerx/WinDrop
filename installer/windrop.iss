; WinDrop kurulum sihirbazı (Inno Setup 6). build\build.ps1 ile derlenir.
#define AppName "WinDrop"
#define AppVersion "1.3.2"
#define BuildDir "..\dist\build"

[Setup]
AppId={{6F1C2B9E-3A7D-4E58-9C21-5B8E0D4A7F13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Kamer EKENEL
AppCopyright=© 2026 Kamer EKENEL
VersionInfoCompany=Kamer EKENEL
VersionInfoCopyright=© 2026 Kamer EKENEL
VersionInfoVersion={#AppVersion}
VersionInfoDescription=WinDrop kurulumu
VersionInfoProductName={#AppName}
DefaultDirName={localappdata}\Programs\WinDrop
DisableDirPage=yes
UsePreviousAppDir=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableFinishedPage=no
DefaultGroupName=WinDrop
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=WinDrop-Kurulum-{#AppVersion}
SetupIconFile={#BuildDir}\windrop.ico
LicenseFile=sozlesme.txt
WizardImageFile={#BuildDir}\wizard-100.bmp,{#BuildDir}\wizard-150.bmp,{#BuildDir}\wizard-200.bmp
WizardSmallImageFile={#BuildDir}\small-100.bmp,{#BuildDir}\small-150.bmp,{#BuildDir}\small-200.bmp
UninstallDisplayIcon={app}\WinDrop.exe
UninstallDisplayName={#AppName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=no
RestartApplications=no
SetupMutex=WinDropSetup

[Languages]
Name: "tr"; MessagesFile: "compiler:Languages\Turkish.isl"

[Messages]
tr.WelcomeLabel1=WinDrop'a hoş geldiniz
tr.WelcomeLabel2=Bu sihirbaz WinDrop {#AppVersion} sürümünü bilgisayarınıza kuracak.%n%nWinDrop ile iPhone'daki fotoğraf ve videoları ev ağınız üzerinden kablosuz olarak bu bilgisayara gönderebilirsiniz.%n%nKurulumdan sonra açılan rehber, iPhone'da yapmanız gerekenleri adım adım gösterir.
tr.FinishedHeadingLabel=WinDrop kuruldu
tr.FinishedLabel=WinDrop bilgisayarınıza kuruldu. Açıldığında rehber sizi iPhone'u bağlama adımlarında yönlendirecek.%n%nProgram, görev çubuğunun sağındaki simgeden de açılabilir.

[Tasks]
Name: "desktopicon"; Description: "Masaüstüne kısayol ekle"
Name: "autostart"; Description: "Windows açılışında arka planda başlat (dosyalar her zaman alınabilsin)"
Name: "firewall"; Description: "Güvenlik duvarında Özel ağlar için izin ver (yönetici onayı istenir)"

[Files]
Source: "{#BuildDir}\WinDrop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\windrop-server.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#BuildDir}\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "sozlesme.txt"; DestDir: "{app}"; DestName: "Kullanım Sözleşmesi.txt"; Flags: ignoreversion
Source: "{#BuildDir}\licenses\*"; DestDir: "{app}\lisanslar"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\WinDrop"; Filename: "{app}\WinDrop.exe"; Comment: "iPhone'dan fotoğraf ve video al"
Name: "{autodesktop}\WinDrop"; Filename: "{app}\WinDrop.exe"; Comment: "iPhone'dan fotoğraf ve video al"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "WinDrop"; ValueData: """{app}\WinDrop.exe"" /background"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\WinDrop.exe"; Description: "WinDrop'u şimdi aç"; Flags: postinstall nowait skipifsilent

[InstallDelete]
; Eski adla (KMRDrop) kalmış kısayollar
Type: files; Name: "{autodesktop}\KMRDrop.lnk"
Type: files; Name: "{autoprograms}\KMRDrop.lnk"

[UninstallRun]
Filename: "{app}\WinDrop.exe"; Parameters: "/quit"; Flags: runhidden waituntilterminated; RunOnceId: "QuitTray"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
Type: filesandordirs; Name: "{localappdata}\WinDrop\webview"
Type: filesandordirs; Name: "{localappdata}\WinDrop\webview-capture"
Type: filesandordirs; Name: "{localappdata}\WinDrop\thumbs-app"

[Code]
const
  RuleTcp = 'WinDrop (TCP)';
  RuleUdp = 'WinDrop mDNS (UDP)';
  WebView2Key = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

function WebView2Installed(): Boolean;
var
  V: String;
begin
  Result := (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0')) or
            (RegQueryStringValue(HKCU, 'Software\' + WebView2Key, 'pv', V) and (V <> '') and (V <> '0.0.0.0'));
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if not WebView2Installed() then
    if SuppressibleMsgBox('WinDrop penceresi için Microsoft Edge WebView2 bileşeni gerekiyor ve bu bilgisayarda bulunamadı.' + #13#10#13#10 +
       'Microsoft''un indirme sayfasını şimdi açmak ister misiniz? (Ücretsiz. Kurulum devam edecek; bileşeni sonra da kurabilirsiniz.)',
       mbConfirmation, MB_YESNO, IDNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '', SW_SHOWNORMAL, ewNoWait, Code);
end;

function RuleAdd(const Name, Proto, Port: String): String;
begin
  Result := 'netsh advfirewall firewall add rule name="' + Name + '" dir=in action=allow program="' +
    ExpandConstant('{app}\windrop-server.exe') + '" protocol=' + Proto + ' localport=' + Port + ' profile=private enable=yes';
end;

function RuleDelete(): String;
begin
  Result := 'netsh advfirewall firewall delete rule name="' + RuleTcp + '" & netsh advfirewall firewall delete rule name="' + RuleUdp + '"';
end;

function FirewallRuleExists(): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall show rule name="' + RuleTcp + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function IsWinDropDir(const Dir: String): Boolean;
begin
  Result := FileExists(AddBackslash(Dir) + 'windrop-server.exe') or FileExists(AddBackslash(Dir) + 'kmrdrop-server.exe');
end;

// Başka bir klasörde kalmış eski bir kopya açılışta yanlışlıkla başlayabilir: kapat ve sil.
// Yalnızca içinde WinDrop sunucusu olan ve bu kurulumun klasörü olmayan klasörler silinir.
procedure RemoveStrayCopy(const Dir: String);
var
  Code: Integer;
begin
  if (Dir = '') or (not DirExists(Dir)) then Exit;
  if CompareText(AddBackslash(Dir), AddBackslash(ExpandConstant('{app}'))) = 0 then Exit;
  if not IsWinDropDir(Dir) then Exit;
  if FileExists(AddBackslash(Dir) + 'WinDrop.exe') then
    Exec(AddBackslash(Dir) + 'WinDrop.exe', '/quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  if FileExists(AddBackslash(Dir) + 'KMRDrop.exe') then
    Exec(AddBackslash(Dir) + 'KMRDrop.exe', '/quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  DelTree(Dir, True, True, True);
  Log('Eski WinDrop kopyası silindi: ' + Dir);
end;

// Güncellemede çalışan WinDrop'u kapat ki dosyalar değiştirilebilsin; eski kopyaları temizle.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Prev: String;
begin
  if FileExists(ExpandConstant('{app}\WinDrop.exe')) then
    Exec(ExpandConstant('{app}\WinDrop.exe'), '/quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F1C2B9E-3A7D-4E58-9C21-5B8E0D4A7F13}_is1', 'InstallLocation', Prev) then
    RemoveStrayCopy(RemoveBackslash(Prev));
  RemoveStrayCopy(ExpandConstant('{localappdata}\Programs\KMRDrop'));
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'KMRDrop');
  RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\AppUserModelId\KMRDrop');
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Cmd: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if not WizardIsTaskSelected('autostart') then
    RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'WinDrop');
  if WizardIsTaskSelected('firewall') then
  begin
    Cmd := '/s /c " ' + RuleDelete() + ' & ' + RuleAdd(RuleTcp, 'TCP', '8765-8799') + ' & ' + RuleAdd(RuleUdp, 'UDP', '5353') + ' "';
    if not ShellExec('runas', ExpandConstant('{sys}\cmd.exe'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code) then
      SuppressibleMsgBox('Güvenlik duvarı izni eklenemedi. WinDrop ilk açıldığında Windows izin sorarsa ev ağınız için izin verin.', mbInformation, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    if FirewallRuleExists() then
      ShellExec('runas', ExpandConstant('{sys}\cmd.exe'), '/s /c " ' + RuleDelete() + ' "', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Classes\AppUserModelId\WinDrop');
    if (not UninstallSilent()) and DirExists(ExpandConstant('{localappdata}\WinDrop')) then
      if MsgBox('WinDrop ayarları (eşleşme kodu ve geçmiş) da silinsin mi?' + #13#10 + 'Gelen fotoğraf ve videolarınız silinmez.', mbConfirmation, MB_YESNO) = IDYES then
      begin
        DelTree(ExpandConstant('{localappdata}\WinDrop'), True, True, True);
        RegDeleteKeyIncludingSubkeys(HKCU, 'Software\WinDrop');
      end;
  end;
end;
