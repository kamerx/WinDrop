// WinDrop masaüstü programı: kendi penceresi (WebView2), bildirim alanı simgesi ve sunucu yönetimi.
// Windows'taki .NET Framework derleyicisiyle (csc, C# 5) derlenir.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

[assembly: AssemblyTitle("WinDrop")]
[assembly: AssemblyDescription("iPhone fotoğraf ve videolarını bu bilgisayara alır")]
[assembly: AssemblyCompany("Kamer EKENEL")]
[assembly: AssemblyProduct("WinDrop")]
[assembly: AssemblyCopyright("© 2026 Kamer EKENEL")]
[assembly: AssemblyVersion("1.3.1.0")]
[assembly: AssemblyFileVersion("1.3.1.0")]
[assembly: AssemblyInformationalVersion("1.3.1")]

namespace WinDrop
{
    internal static class Program
    {
        internal const string MutexName = @"Local\WinDropTray";
        internal const string QuitEventName = @"Local\WinDropTrayQuit";
        internal const string ShowEventName = @"Local\WinDropShow";

        [STAThread]
        private static int Main(string[] args)
        {
            bool background = false, quit = false;
            string capture = null, hash = null;
            for (int i = 0; i < args.Length; i++)
            {
                string s = args[i].ToLowerInvariant();
                if (s == "/background") background = true;
                else if (s == "/quit") quit = true;
                else if (s == "/capture" && i + 1 < args.Length) capture = args[++i];
                else if (s == "/hash" && i + 1 < args.Length) hash = args[++i];
                else if (s == "/port" && i + 1 < args.Length) { int p; if (int.TryParse(args[++i], out p)) Paths.PortOverride = p; }
                else if (s == "/dest" && i + 1 < args.Length) Paths.DestOverride = args[++i];
            }
            if (quit) return Quit();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // Deneme/ekran görüntüsü kipi: yalnızca pencere açılır, görüntü kaydedilip kapanır.
            if (capture != null)
            {
                Application.Run(new MainWindow(null, capture, hash));
                return 0;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    // Zaten çalışıyor: yeni kopya açılmaz, mevcut pencere öne getirilir.
                    if (!background)
                    {
                        try
                        {
                            EventWaitHandle ev;
                            if (EventWaitHandle.TryOpenExisting(ShowEventName, out ev)) { ev.Set(); ev.Dispose(); }
                        }
                        catch { }
                    }
                    return 0;
                }
                Application.Run(new AppCore(!background));
                GC.KeepAlive(mutex);
            }
            return 0;
        }

        // Kurulum ve kaldırma sırasında: çalışan programı kapatır, sunucuyu durdurur.
        private static int Quit()
        {
            try
            {
                EventWaitHandle ev;
                if (EventWaitHandle.TryOpenExisting(QuitEventName, out ev)) { ev.Set(); ev.Dispose(); }
            }
            catch { }
            for (int i = 0; i < 100; i++)
            {
                bool exists;
                try { using (Mutex m = Mutex.OpenExisting(MutexName)) { exists = true; } }
                catch { exists = false; }
                if (!exists) break;
                Thread.Sleep(100);
            }
            Paths.KillServers();
            return 0;
        }
    }

    internal static class Paths
    {
        public static readonly string AppDir = Path.GetDirectoryName(Application.ExecutablePath);
        public static readonly string ServerExe = Path.Combine(AppDir, "windrop-server.exe");
        public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WinDrop");
        public static readonly string DataDir = Path.Combine(Root, "data");
        public static readonly string ConfigFile = Path.Combine(DataDir, "config.json");
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

        private static string ReadConfig()
        {
            try { return File.ReadAllText(ConfigFile, Encoding.UTF8); } catch { return ""; }
        }

        // Yalnızca ekran görüntüsü kipinde: başka bir porttaki (ör. demo) sunucuya bağlanmak için.
        public static int PortOverride;
        public static string DestOverride;

        public static int Port()
        {
            if (PortOverride > 0) return PortOverride;
            Match m = Regex.Match(ReadConfig(), "\"port\"\\s*:\\s*(\\d+)");
            int p;
            if (m.Success && int.TryParse(m.Groups[1].Value, out p) && p > 0 && p < 65536) return p;
            return 8765;
        }

        public static string Dest()
        {
            if (!string.IsNullOrEmpty(DestOverride)) return DestOverride;
            Match m = Regex.Match(ReadConfig(), "\"dest\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            if (m.Success) return JsonUnescape(m.Groups[1].Value);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        private static string JsonUnescape(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
                char n = s[++i];
                switch (n)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 < s.Length) { sb.Append((char)Convert.ToInt32(s.Substring(i + 1, 4), 16)); i += 4; }
                        break;
                    default: sb.Append(n); break;
                }
            }
            return sb.ToString();
        }

        public static string PanelUrl()
        {
            return "http://localhost:" + Port() + "/";
        }

        public static void OpenFolder()
        {
            try { Process.Start("explorer.exe", "\"" + Dest() + "\""); } catch { }
        }

        public static bool AutoStart
        {
            get
            {
                try { using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey)) { return k != null && k.GetValue("WinDrop") != null; } }
                catch { return false; }
            }
            set
            {
                try
                {
                    using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
                    {
                        if (value) k.SetValue("WinDrop", "\"" + Application.ExecutablePath + "\" /background");
                        else k.DeleteValue("WinDrop", false);
                    }
                }
                catch { }
            }
        }

        public static bool DarkMode()
        {
            try
            {
                using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object v = k == null ? null : k.GetValue("AppsUseLightTheme");
                    return v is int && (int)v == 0;
                }
            }
            catch { return false; }
        }

        // Portta bir WinDrop sunucusu yanıt veriyorsa süreç kimliğini döndürür, yoksa 0.
        public static int PingPid()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port() + "/api/ping");
                req.Proxy = null;
                req.Timeout = 1500;
                req.ReadWriteTimeout = 1500;
                req.KeepAlive = false;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    if (body.IndexOf("\"app\":\"windrop\"", StringComparison.Ordinal) < 0) return 0;
                    Match m = Regex.Match(body, "\"pid\":(\\d+)");
                    return m.Success ? int.Parse(m.Groups[1].Value) : 0;
                }
            }
            catch { return 0; }
        }

        public static string ProcessFile(Process p)
        {
            try { return p.MainModule.FileName; } catch { return ""; }
        }

        // Yalnızca bu klasördeki windrop-server.exe durdurulur.
        public static void KillServers()
        {
            foreach (Process p in Process.GetProcessesByName("windrop-server"))
            {
                try
                {
                    if (string.Equals(ProcessFile(p), ServerExe, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
                }
                catch { }
            }
        }

        public static void OpenExternal(string uri)
        {
            try
            {
                if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("ms-settings:", StringComparison.OrdinalIgnoreCase))
                    Process.Start(uri);
            }
            catch { }
        }
    }

    internal static class IconPainter
    {
        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr h);

        // Yuvarlak köşeli kare, beyaz nokta ve altı açık halkalar; 24 pikselin altında iki kalın halka.
        public static Icon Make(bool on, int size)
        {
            if (size < 16) size = 16;
            using (Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.Clear(Color.Transparent);
                    float s = size;
                    float d = s * 0.45f;
                    using (GraphicsPath path = new GraphicsPath())
                    {
                        path.AddArc(0, 0, d, d, 180, 90);
                        path.AddArc(s - d, 0, d, d, 270, 90);
                        path.AddArc(s - d, s - d, d, d, 0, 90);
                        path.AddArc(0, s - d, d, d, 90, 90);
                        path.CloseFigure();
                        Color c1 = on ? Color.FromArgb(255, 0x50, 0x95, 0xFB) : Color.FromArgb(255, 0xA3, 0xA8, 0xB0);
                        Color c2 = on ? Color.FromArgb(255, 0x3A, 0x7B, 0xF5) : Color.FromArgb(255, 0x7F, 0x85, 0x8E);
                        using (LinearGradientBrush br = new LinearGradientBrush(new RectangleF(-1, -1, s + 2, s + 2), c1, c2, 90f))
                        {
                            g.FillPath(br, path);
                        }
                    }
                    float[] radii;
                    float pw, dot, gap;
                    if (size < 24) { radii = new float[] { 0.235f, 0.385f }; pw = s * 0.095f; dot = s * 0.095f; gap = 48; }
                    else { radii = new float[] { 0.175f, 0.275f, 0.375f }; pw = s * 0.05f; dot = s * 0.068f; gap = 40; }
                    float cx = s * 0.5f, cy = s * 0.535f;
                    using (Pen pen = new Pen(Color.White, pw))
                    {
                        pen.StartCap = LineCap.Round;
                        pen.EndCap = LineCap.Round;
                        foreach (float k in radii)
                        {
                            float r = s * k;
                            g.DrawArc(pen, cx - r, cy - r, 2 * r, 2 * r, 90 + gap, 360 - 2 * gap);
                        }
                    }
                    using (SolidBrush w = new SolidBrush(Color.White)) g.FillEllipse(w, cx - dot, cy - dot, 2 * dot, 2 * dot);
                }
                IntPtr h = bmp.GetHicon();
                Icon copy;
                using (Icon tmp = Icon.FromHandle(h)) copy = (Icon)tmp.Clone();
                DestroyIcon(h);
                return copy;
            }
        }
    }

    // Windows'un kendi küçük resim sistemi: HEIC, video ve Gezgin'in önizleyebildiği her şey.
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(NativeSize size, int flags, out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeSize { public int cx; public int cy; }

    internal static class Thumbs
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr pbc,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory factory);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr h);

        private static readonly BlockingCollection<Action> queue = new BlockingCollection<Action>();
        private static readonly string cacheDir = Path.Combine(Paths.Root, "thumbs-app");

        static Thumbs()
        {
            Thread t = new Thread(() => { foreach (Action a in queue.GetConsumingEnumerable()) { try { a(); } catch { } } });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        public static void Request(string path, int size, Action<byte[]> done)
        {
            queue.Add(() => done(Get(path, size)));
        }

        private static byte[] Get(string path, int size)
        {
            FileInfo fi = new FileInfo(path);
            if (!fi.Exists) return null;
            string key;
            using (SHA1 sha = SHA1.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToLowerInvariant() + "|" + fi.Length + "|" + fi.LastWriteTimeUtc.Ticks + "|" + size));
                key = BitConverter.ToString(h).Replace("-", "").ToLowerInvariant();
            }
            string cached = Path.Combine(cacheDir, key + ".jpg");
            try { if (File.Exists(cached)) return File.ReadAllBytes(cached); } catch { }
            IShellItemImageFactory f = null;
            IntPtr hbm = IntPtr.Zero;
            try
            {
                SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
                NativeSize sz;
                sz.cx = size;
                sz.cy = size;
                if (f.GetImage(sz, 0x08 /* SIIGBF_THUMBNAILONLY */, out hbm) != 0 || hbm == IntPtr.Zero) return null;
                using (Bitmap bmp = Image.FromHbitmap(hbm))
                using (MemoryStream ms = new MemoryStream())
                {
                    ImageCodecInfo jpeg = null;
                    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpeg = c;
                    EncoderParameters ep = new EncoderParameters(1);
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 86L);
                    bmp.Save(ms, jpeg, ep);
                    byte[] data = ms.ToArray();
                    try { Directory.CreateDirectory(cacheDir); File.WriteAllBytes(cached, data); } catch { }
                    return data;
                }
            }
            catch { return null; }
            finally
            {
                if (hbm != IntPtr.Zero) DeleteObject(hbm);
                if (f != null) Marshal.ReleaseComObject(f);
            }
        }

        public static void CleanOld()
        {
            try
            {
                foreach (string f in Directory.GetFiles(cacheDir))
                    if ((DateTime.UtcNow - File.GetLastAccessTimeUtc(f)).TotalDays > 30) File.Delete(f);
            }
            catch { }
        }
    }

    // Programın kendi penceresi: arayüz WebView2 içinde, tarayıcı açılmaz.
    internal sealed class MainWindow : Form
    {
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        private readonly WebView2 web;
        private readonly AppCore core;
        private readonly string capturePath, captureHash;
        private readonly bool dark;
        private readonly System.Windows.Forms.Timer retry;
        private bool showingWait;

        public MainWindow(AppCore core, string capturePath, string captureHash)
        {
            this.core = core;
            this.capturePath = capturePath;
            this.captureHash = captureHash;
            dark = Paths.DarkMode();
            Text = "WinDrop";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            // Ekran ölçeği (%125, %150…) hesaba katılır; pencere çalışma alanından büyük olmaz.
            float scale = 1f;
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) scale = Math.Max(1f, g.DpiX / 96f); } catch { }
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min((int)(1180 * scale), (int)(wa.Width * 0.92));
            int h = Math.Min((int)(780 * scale), (int)(wa.Height * 0.92));
            Size = new Size(w, h);
            MinimumSize = new Size(Math.Min((int)(760 * scale), w), Math.Min((int)(540 * scale), h));
            BackColor = dark ? Color.FromArgb(18, 18, 20) : Color.FromArgb(242, 242, 247);
            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            retry = new System.Windows.Forms.Timer();
            retry.Interval = 1200;
            retry.Tick += delegate { retry.Stop(); LoadPanel(); };
            Load += async delegate { await InitAsync(); };
            FormClosing += OnClosing;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try { int v = dark ? 1 : 0; DwmSetWindowAttribute(Handle, 20, ref v, 4); } catch { }
        }

        private void OnClosing(object sender, FormClosingEventArgs e)
        {
            // Kapatma düğmesi programı kapatmaz; bildirim alanında dosya almaya devam eder.
            if (core != null && e.CloseReason == CloseReason.UserClosing && !core.Exiting)
            {
                e.Cancel = true;
                Hide();
                core.HiddenToTray();
            }
        }

        private async Task InitAsync()
        {
            try
            {
                string udf = Path.Combine(Paths.Root, capturePath != null ? "webview-capture" : "webview");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, udf, null);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                if (capturePath != null) { try { File.WriteAllText(capturePath + ".error.txt", ex.ToString()); } catch { } Close(); return; }
                DialogResult r = MessageBox.Show(this,
                    "WinDrop penceresi için gereken Microsoft Edge WebView2 bileşeni bulunamadı.\n\nŞimdi Microsoft'un sayfasından indirmek ister misiniz? (Ücretsiz, birkaç MB)",
                    "WinDrop", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) Paths.OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                return;
            }
            CoreWebView2 cw = web.CoreWebView2;
            cw.Settings.AreDevToolsEnabled = false;
            cw.Settings.IsStatusBarEnabled = false;
            cw.Settings.IsZoomControlEnabled = false;
            cw.Settings.IsGeneralAutofillEnabled = false;
            cw.Settings.IsPasswordAutosaveEnabled = false;
            cw.Settings.AreDefaultContextMenusEnabled = false;
            cw.AddWebResourceRequestedFilter("http://windrop-thumb/*", CoreWebView2WebResourceContext.All);
            cw.WebResourceRequested += OnThumbRequest;
            cw.NewWindowRequested += (s, e) => { e.Handled = true; Paths.OpenExternal(e.Uri); };
            cw.NavigationStarting += (s, e) =>
            {
                string u = e.Uri ?? "";
                bool ok = u.StartsWith("http://localhost:" + Paths.Port() + "/", StringComparison.OrdinalIgnoreCase) || u.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || u == "about:blank";
                if (!ok) { e.Cancel = true; Paths.OpenExternal(u); }
            };
            cw.NavigationCompleted += OnNavigated;
            cw.WebMessageReceived += (s, e) =>
            {
                string msg = "";
                try { msg = e.TryGetWebMessageAsString(); } catch { }
                if (msg == "start" && core != null) { core.StartFromUi(); retry.Start(); }
            };
            LoadPanel();
        }

        public void LoadPanel()
        {
            if (web.CoreWebView2 == null) return;
            showingWait = false;
            web.CoreWebView2.Navigate(Paths.PanelUrl() + (captureHash != null ? "#" + captureHash : ""));
        }

        private async void OnNavigated(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (showingWait) return;
            if (!e.IsSuccess)
            {
                ShowWait();
                retry.Start();
                return;
            }
            if (capturePath != null)
            {
                await Task.Delay(3500);
                try
                {
                    using (FileStream fs = File.Create(capturePath))
                        await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                }
                catch (Exception ex) { try { File.WriteAllText(capturePath + ".error.txt", ex.ToString()); } catch { } }
                Close();
            }
        }

        private void ShowWait()
        {
            showingWait = true;
            bool stopped = core != null && core.UserStopped;
            string bg = dark ? "#121214" : "#f2f2f7", fg = dark ? "#f2f2f7" : "#1c1c1e", mu = dark ? "#98989f" : "#6e6e73";
            string html = "<!doctype html><html><head><meta charset=utf-8><style>html,body{height:100%;margin:0;background:" + bg + ";color:" + fg +
                ";font:15px 'Segoe UI Variable Text','Segoe UI',sans-serif;display:grid;place-items:center;text-align:center}" +
                ".s{width:34px;height:34px;border:3px solid #3A7BF544;border-top-color:#3A7BF5;border-radius:50%;animation:r 1s linear infinite;margin:0 auto 16px}" +
                "@keyframes r{to{transform:rotate(360deg)}}p{color:" + mu + "}button{font:inherit;border:0;border-radius:9px;padding:9px 18px;background:#3A7BF5;color:#fff;cursor:pointer}</style></head><body><div>" +
                (stopped
                    ? "<h2>WinDrop durduruldu</h2><p>Telefondan dosya almak için başlatın.</p><button onclick=\"chrome.webview.postMessage('start')\">WinDrop'u başlat</button>"
                    : "<div class=s></div><h2>WinDrop başlatılıyor…</h2><p>Birkaç saniye sürebilir.</p>") +
                "</div></body></html>";
            try { web.CoreWebView2.NavigateToString(html); } catch { }
        }

        private void OnThumbRequest(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri u;
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out u)) return;
            string path = null;
            int size = 320;
            foreach (string part in u.Query.TrimStart('?').Split('&'))
            {
                int i = part.IndexOf('=');
                if (i < 0) continue;
                string k = part.Substring(0, i), v = Uri.UnescapeDataString(part.Substring(i + 1).Replace('+', ' '));
                if (k == "p") path = v;
                else if (k == "s") int.TryParse(v, out size);
            }
            size = Math.Max(64, Math.Min(1600, size));
            CoreWebView2Environment env = web.CoreWebView2.Environment;
            // Yalnızca gelenler klasöründeki dosyalar önizlenir.
            string dest = Path.GetFullPath(Paths.Dest()).TrimEnd('\\') + "\\";
            string full = null;
            try { if (path != null) full = Path.GetFullPath(path); } catch { }
            if (full == null || !full.StartsWith(dest, StringComparison.OrdinalIgnoreCase))
            {
                e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            CoreWebView2Deferral deferral = e.GetDeferral();
            Thumbs.Request(full, size, data =>
            {
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        try
                        {
                            if (data == null) e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                            else e.Response = env.CreateWebResourceResponse(new MemoryStream(data), 200, "OK", "Content-Type: image/jpeg\r\nCache-Control: max-age=86400");
                        }
                        catch { }
                        deferral.Complete();
                    }));
                }
                catch { try { deferral.Complete(); } catch { } }
            });
        }
    }

    // Bildirim alanı simgesi, sunucu ve pencere yönetimi.
    internal sealed class AppCore : ApplicationContext
    {
        private readonly NotifyIcon notify;
        private readonly Icon iconOn, iconOff;
        private readonly ToolStripMenuItem miToggle, miAuto;
        private readonly System.Windows.Forms.Timer timer;
        private readonly SynchronizationContext ui;
        private readonly List<DateTime> starts = new List<DateTime>();
        private MainWindow window;
        private Process proc;
        private bool userStopped, exiting, hiddenTipShown;
        private int lastState = -1;
        private DateTime holdUntil = DateTime.MinValue;

        public bool Exiting { get { return exiting; } }
        public bool UserStopped { get { return userStopped; } }

        public AppCore(bool showWindow)
        {
            ui = new WindowsFormsSynchronizationContext();
            int iconSize = SystemInformation.SmallIconSize.Width;
            iconOn = IconPainter.Make(true, iconSize);
            iconOff = IconPainter.Make(false, iconSize);

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem miOpen = new ToolStripMenuItem("WinDrop'u aç");
            miOpen.Font = new Font(miOpen.Font, FontStyle.Bold);
            miOpen.Click += delegate { ShowWindow(); };
            ToolStripMenuItem miFolder = new ToolStripMenuItem("Gelenler klasörünü aç");
            miFolder.Click += delegate { Paths.OpenFolder(); };
            miToggle = new ToolStripMenuItem("WinDrop'u durdur");
            miToggle.Click += delegate { Toggle(); };
            miAuto = new ToolStripMenuItem("Windows açılışında başlat");
            miAuto.Click += delegate { Paths.AutoStart = !Paths.AutoStart; miAuto.Checked = Paths.AutoStart; };
            ToolStripMenuItem miExit = new ToolStripMenuItem("Çıkış");
            miExit.Click += delegate { ExitAll(); };
            menu.Items.AddRange(new ToolStripItem[] { miOpen, miFolder, miToggle, new ToolStripSeparator(), miAuto, new ToolStripSeparator(), miExit });
            menu.Opening += delegate { miAuto.Checked = Paths.AutoStart; };

            notify = new NotifyIcon();
            notify.Icon = iconOff;
            notify.Text = "WinDrop";
            notify.ContextMenuStrip = menu;
            notify.Visible = true;
            notify.MouseClick += (sender, e) => { if (e.Button == MouseButtons.Left) ShowWindow(); };

            WaitFor(Program.QuitEventName, () => ExitAll());
            WaitFor(Program.ShowEventName, () => ShowWindow());

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 3000;
            timer.Tick += delegate { Check(); };
            timer.Start();
            Thumbs.CleanOld();
            Check();
            if (showWindow) ShowWindow();
        }

        private void WaitFor(string name, Action action)
        {
            EventWaitHandle ev = new EventWaitHandle(false, EventResetMode.AutoReset, name);
            Thread t = new Thread(() =>
            {
                while (true)
                {
                    try { ev.WaitOne(); } catch { return; }
                    ui.Post(_ => action(), null);
                }
            });
            t.IsBackground = true;
            t.Start();
        }

        public void ShowWindow()
        {
            if (exiting) return;
            if (window == null || window.IsDisposed) window = new MainWindow(this, null, null);
            if (!window.Visible) window.Show();
            if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
            window.Activate();
            window.BringToFront();
        }

        public void HiddenToTray()
        {
            if (hiddenTipShown) return;
            hiddenTipShown = true;
            notify.ShowBalloonTip(5000, "WinDrop arka planda çalışıyor", "Telefondan gelen dosyalar alınmaya devam eder. Kapatmak için simgeye sağ tıklayıp Çıkış'ı seçin.", ToolTipIcon.Info);
        }

        public void StartFromUi()
        {
            userStopped = false;
            holdUntil = DateTime.MinValue;
            starts.Clear();
            lastState = -1;
            StartServer();
        }

        private bool IsRunning()
        {
            if (proc != null)
            {
                try { if (!proc.HasExited) return true; } catch { }
                proc = null;
            }
            int pid = Paths.PingPid();
            if (pid > 0)
            {
                try { proc = Process.GetProcessById(pid); } catch { }
                return true;
            }
            return false;
        }

        private void Check()
        {
            if (exiting) return;
            try
            {
                if (userStopped) { SetState(false); return; }
                if (IsRunning()) SetState(true);
                else { SetState(false); StartServer(); }
            }
            catch { }
        }

        private void StartServer()
        {
            DateTime now = DateTime.Now;
            if (now < holdUntil) return;
            // Kısa sürede çok sık kapanıyorsa (ör. port başka programda) 30 sn bekle.
            starts.RemoveAll(t => (now - t).TotalSeconds > 60);
            if (starts.Count >= 5) { holdUntil = now.AddSeconds(30); starts.Clear(); return; }
            starts.Add(now);
            if (!File.Exists(Paths.ServerExe))
            {
                holdUntil = now.AddMinutes(5);
                notify.ShowBalloonTip(5000, "WinDrop", "windrop-server.exe bulunamadı. WinDrop'u yeniden kurun.", ToolTipIcon.Error);
                return;
            }
            ProcessStartInfo psi = new ProcessStartInfo(Paths.ServerExe);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = Paths.AppDir;
            psi.EnvironmentVariables["WINDROP_DATA"] = Paths.DataDir;
            try { proc = Process.Start(psi); } catch { proc = null; }
        }

        private void StopServer()
        {
            if (proc != null)
            {
                try { if (!proc.HasExited) { proc.Kill(); proc.WaitForExit(3000); } } catch { }
                proc = null;
            }
            // Portun sahibini doğrula: yalnızca WinDrop olduğunu söyleyen ve
            // windrop-server.exe (ya da geliştirme sürümündeki node.exe) olan süreç durdurulur.
            int pid = Paths.PingPid();
            if (pid > 0)
            {
                try
                {
                    Process p = Process.GetProcessById(pid);
                    string name = Path.GetFileName(Paths.ProcessFile(p)).ToLowerInvariant();
                    if (name == "windrop-server.exe" || name == "node.exe") { p.Kill(); p.WaitForExit(3000); }
                }
                catch { }
            }
        }

        private void Toggle()
        {
            if (userStopped || !IsRunning())
            {
                StartFromUi();
                if (window != null && !window.IsDisposed) window.LoadPanel();
            }
            else
            {
                userStopped = true;
                StopServer();
                lastState = -1;
                SetState(false);
                if (window != null && !window.IsDisposed) window.LoadPanel();
            }
        }

        private void SetState(bool on)
        {
            int s = on ? 1 : 0;
            if (s == lastState) return;
            lastState = s;
            notify.Icon = on ? iconOn : iconOff;
            if (on) notify.Text = "WinDrop açık · port " + Paths.Port();
            else notify.Text = userStopped ? "WinDrop durduruldu" : "WinDrop başlatılıyor…";
            miToggle.Text = on ? "WinDrop'u durdur" : "WinDrop'u başlat";
        }

        private void ExitAll()
        {
            if (exiting) return;
            exiting = true;
            timer.Stop();
            userStopped = true;
            StopServer();
            try { if (window != null && !window.IsDisposed) window.Close(); } catch { }
            notify.Visible = false;
            notify.Dispose();
            ExitThread();
        }
    }
}
