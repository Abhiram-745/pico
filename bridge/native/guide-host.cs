// ===========================================================================
//  Halo guide cursor
//
//  Guide mode's second pointer: drawn over the whole desktop, pointing at the
//  thing to click next and saying, beside it, what to do there. It never
//  clicks, never types and never takes the focus. Your own pointer does the
//  work; this one only shows the way.
//
//  WHY IT IS NATIVE
//  It has to sit over every other window, let every click fall straight
//  through it to whatever is underneath, and never become the active window —
//  three things a browser window cannot be made to do. A layered, click-
//  through, no-activate, topmost window can do all three, so the cursor is
//  drawn by this small program rather than by a page.
//
//  Protocol, one command per line on stdin:
//
//    scale <f>                  logical-to-device pixels (1.5 at 150%)
//    point <x> <y> <text...>    glide to (x, y) and say this beside it
//    say <text...>              change the words, stay where it is
//    hide                       fade out
//
//  Coordinates arrive in the same logical pixels the rest of Halo uses (what
//  nut reports); this process is DPI-aware, so it multiplies by `scale` and
//  draws at the display's real resolution — sharp text, not a stretched
//  bitmap of it.
//
//  Compiled on first run with the C# compiler in Windows, like the island
//  host, so there is nothing to download.
// ===========================================================================

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class NativeGuide
{
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref PT pptDst, ref SZ psize,
        IntPtr hdcSrc, ref PT pprSrc, int crKey, ref BLEND pblend, int dwFlags);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)] public struct PT { public int x, y; public PT(int x, int y) { this.x = x; this.y = y; } }
    [StructLayout(LayoutKind.Sequential)] public struct SZ { public int cx, cy; public SZ(int cx, int cy) { this.cx = cx; this.cy = cy; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct BLEND { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }

    public const int ULW_ALPHA = 2;
    public const byte AC_SRC_OVER = 0, AC_SRC_ALPHA = 1;
}

/// The overlay: one small layered window that moves, rather than a window
/// over the whole screen that repaints — small is cheap to redraw sixty times
/// a second, and nothing it does can cover anything it is not pointing at.
class GuideWindow : Form
{
    const int W = 470, H = 200;           // device pixels, before scale
    const float TIP = 16f;                // room round the tip for the ring
    const float TAIL = 32f;               // the arrow hangs this far below its tip

    float scale = 1f;
    float x, y, tx, ty;                   // where it is, where it is going
    float alpha, talpha;                  // fading in and out
    string text = "";
    bool visible;
    readonly System.Windows.Forms.Timer frame;
    DateTime last = DateTime.UtcNow;
    float pulse;

    public GuideWindow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        Bounds = new Rectangle(-4000, -4000, W, H);

        frame = new System.Windows.Forms.Timer { Interval = 15 };
        frame.Tick += (s, e) => Step();
        frame.Start();
    }

    // Layered (per-pixel alpha), transparent to the mouse, never activated,
    // never in Alt-Tab, always on top.
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x00080000   // WS_EX_LAYERED
                        | 0x00000020   // WS_EX_TRANSPARENT: clicks go through
                        | 0x08000000   // WS_EX_NOACTIVATE
                        | 0x00000080   // WS_EX_TOOLWINDOW
                        | 0x00000008;  // WS_EX_TOPMOST
            return cp;
        }
    }
    protected override bool ShowWithoutActivation { get { return true; } }

    public void SetScale(float s) { if (s > 0.5f && s < 5f) scale = s; }

    /* One instruction, and short enough to stay inside the bubble: past
       about this much it wraps to more lines than the bitmap is tall and
       the end of the sentence is simply not drawn. */
    static string Fit(string words)
    {
        string t = (words ?? "").Trim();
        return t.Length > 120 ? t.Substring(0, 119) + "…" : t;
    }

    public void Point(float lx, float ly, string words)
    {
        tx = lx * scale; ty = ly * scale;
        if (!visible) { x = tx - 60 * scale; y = ty - 40 * scale; }   // arrive, rather than appear
        text = Fit(words);
        visible = true; talpha = 1f;
    }

    public void Say(string words) { text = Fit(words); }

    public void HideGuide() { talpha = 0f; }

    void Step()
    {
        var now = DateTime.UtcNow;
        float dt = (float)Math.Min(0.05, (now - last).TotalSeconds);
        last = now;

        // A critically damped approach: quick to set off, no overshoot — an
        // overshooting pointer points at the wrong thing for a moment, which
        // is the one thing a guide must not do.
        float k = 1f - (float)Math.Exp(-dt * 11.0);
        x += (tx - x) * k;
        y += (ty - y) * k;
        alpha += (talpha - alpha) * (1f - (float)Math.Exp(-dt * 9.0));
        pulse += dt;

        if (alpha < 0.01f && talpha == 0f) { if (visible) { visible = false; Render(0); } return; }
        Render(alpha);
    }

    /* Which way the bubble opens.

       It used to open down-and-right always, and the window was placed with
       the tip a fixed 16px from its top-left corner — with nothing anywhere
       that knew where the screen ended. Point at a Send button in the
       bottom-right, or a close button in the top-right, and the words went
       off the edge of the display: an arrow with no instruction beside it,
       which in guide mode is the whole of what Halo had to say. Now the
       side is chosen from the monitor the tip is actually on, so the bubble
       opens into whatever room there is. */
    void Sides(out bool flipX, out bool flipY)
    {
        var area = Screen.FromPoint(new Point((int)Math.Round(x), (int)Math.Round(y))).WorkingArea;
        // Room needed to the right of / below the tip for the bubble to fit.
        float needX = (W - TIP) * scale, needY = (H - TIP) * scale;
        flipX = (x + needX) > area.Right && (x - needX) >= area.Left;
        flipY = (y + needY) > area.Bottom && (y - needY) >= area.Top;
    }

    void Render(float a)
    {
        int w = (int)(W * scale), h = (int)(H * scale);
        bool flipX, flipY;
        Sides(out flipX, out flipY);
        // Where the tip sits inside the bitmap. Flipped vertically it needs
        // TAIL rather than TIP below it, or the arrow's own tail is clipped.
        float ox = flipX ? (W - TIP) * scale : TIP * scale;
        float oy = flipY ? (H - TAIL) * scale : TIP * scale;

        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                /* Painted at full strength and faded by the window itself
                   below. Watering every colour down instead left the label
                   box see-through at rest — GDI+ blending part-alpha fills
                   into a premultiplied surface does not land where the
                   numbers say it should, and an instruction you cannot read
                   over the page behind it is no instruction. */
                if (a > 0.01f) Draw(g, 1f, ox, oy, flipX, flipY);
            }
            Blit(bmp, (int)Math.Round(x) - (int)Math.Round(ox), (int)Math.Round(y) - (int)Math.Round(oy), a);
        }
    }

    void Draw(Graphics g, float a, float ox, float oy, bool flipX, bool flipY)
    {
        float s = scale;

        // A soft ring at the tip that breathes, so the eye finds the point.
        float r = (9f + (float)Math.Sin(pulse * 4.2) * 2.2f) * s;
        using (var ring = new SolidBrush(Color.FromArgb((int)(70 * a), 90, 170, 255)))
            g.FillEllipse(ring, ox - r, oy - r, r * 2, r * 2);

        // The pointer itself: Windows' own arrow shape, in Halo's blue, with
        // a white edge so it reads on dark and light pages alike.
        var arrow = new PointF[] {
            new PointF(ox, oy), new PointF(ox, oy + 21 * s), new PointF(ox + 5.2f * s, oy + 16.2f * s),
            new PointF(ox + 9 * s, oy + 24 * s), new PointF(ox + 12.2f * s, oy + 22.6f * s),
            new PointF(ox + 8.6f * s, oy + 15 * s), new PointF(ox + 15.2f * s, oy + 15 * s),
        };
        using (var shadow = new SolidBrush(Color.FromArgb((int)(90 * a), 0, 0, 0)))
        {
            var sh = (PointF[])arrow.Clone();
            for (int i = 0; i < sh.Length; i++) { sh[i].X += 1.5f * s; sh[i].Y += 2f * s; }
            g.FillPolygon(shadow, sh);
        }
        using (var fill = new LinearGradientBrush(new PointF(ox, oy), new PointF(ox, oy + 24 * s),
                   Color.FromArgb((int)(255 * a), 111, 192, 255), Color.FromArgb((int)(255 * a), 29, 110, 208)))
            g.FillPolygon(fill, arrow);
        using (var edge = new Pen(Color.FromArgb((int)(255 * a), 255, 255, 255), 1.6f * s) { LineJoin = LineJoin.Round })
            g.DrawPolygon(edge, arrow);

        if (string.IsNullOrEmpty(text)) return;

        // What to do there, in a bubble just below-right of the arrow — out
        // of the way of the thing being pointed at, and read in one glance.
        using (var font = new Font("Segoe UI Semibold", 11f * s, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var small = new Font("Segoe UI", 9.5f * s, FontStyle.Regular, GraphicsUnit.Pixel))
        {
            var size = g.MeasureString(text, font, (int)(300 * s));
            float bw = Math.Min(size.Width, 300 * s) + 22 * s;
            float bh = size.Height + 30 * s;
            // Opening away from whichever edge the tip is near, so the words
            // are on the screen even when the thing to click is in a corner.
            float bx = flipX ? ox - 18 * s - bw : ox + 18 * s;
            float by = flipY ? oy - 22 * s - bh : oy + 22 * s;
            var box = new RectangleF(bx, by, bw, bh);

            using (var path = Rounded(box, 10 * s))
            {
                using (var drop = new SolidBrush(Color.FromArgb((int)(110 * a), 0, 0, 0)))
                using (var dropPath = Rounded(new RectangleF(bx + 2 * s, by + 4 * s, bw, bh), 10 * s))
                    g.FillPath(drop, dropPath);
                using (var bg = new LinearGradientBrush(box, Color.FromArgb(255, 34, 104, 192),
                           Color.FromArgb(255, 20, 66, 138), LinearGradientMode.Vertical))
                    g.FillPath(bg, path);
                using (var rim = new Pen(Color.FromArgb((int)(120 * a), 160, 212, 255), 1f * s))
                    g.DrawPath(rim, path);
            }
            using (var label = new SolidBrush(Color.FromArgb(235, 196, 226, 255)))
                g.DrawString("HALO · GUIDE", small, label, bx + 11 * s, by + 7 * s);
            using (var ink = new SolidBrush(Color.FromArgb((int)(255 * a), 255, 255, 255)))
                g.DrawString(text, font, ink, new RectangleF(bx + 11 * s, by + 20 * s, 300 * s, size.Height + 4 * s));
        }
    }

    static GraphicsPath Rounded(RectangleF r, float rad)
    {
        var p = new GraphicsPath();
        float d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    void Blit(Bitmap bmp, int left, int top, float a)
    {
        IntPtr screen = NativeGuide.GetDC(IntPtr.Zero);
        IntPtr mem = NativeGuide.CreateCompatibleDC(screen);
        IntPtr hbmp = bmp.GetHbitmap(Color.FromArgb(0));
        IntPtr old = NativeGuide.SelectObject(mem, hbmp);
        try
        {
            var size = new NativeGuide.SZ(bmp.Width, bmp.Height);
            var src = new NativeGuide.PT(0, 0);
            var dst = new NativeGuide.PT(left, top);
            var blend = new NativeGuide.BLEND { BlendOp = NativeGuide.AC_SRC_OVER, SourceConstantAlpha = (byte)Math.Max(0, Math.Min(255, (int)Math.Round(255f * a))), AlphaFormat = NativeGuide.AC_SRC_ALPHA };
            NativeGuide.UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, NativeGuide.ULW_ALPHA);
        }
        finally
        {
            NativeGuide.SelectObject(mem, old);
            NativeGuide.DeleteObject(hbmp);
            NativeGuide.DeleteDC(mem);
            NativeGuide.ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

static class GuideHost
{
    [STAThread]
    static void Main()
    {
        NativeGuide.SetProcessDPIAware();
        // The words arrive as UTF-8. This program has no console (it is a
        // window program), so the console's encoding cannot be set — the
        // pipe is read as a UTF-8 stream directly instead, which is what
        // keeps "Compose" in curly quotes from arriving as mojibake.
        var input = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
        var output = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
        Application.EnableVisualStyles();
        var win = new GuideWindow();
        win.Show();

        // Commands arrive on stdin, on their own thread, and are handed to the
        // window's thread — a Form may only be touched by the thread that made it.
        var reader = new Thread(() =>
        {
            output.WriteLine("ready");
            string line;
            while ((line = input.ReadLine()) != null)
            {
                string l = line.Trim();
                if (l.Length == 0) continue;
                try
                {
                    string[] p = l.Split(new[] { ' ' }, 4);
                    switch (p[0])
                    {
                        case "scale":
                            float sc = float.Parse(p[1], CultureInfo.InvariantCulture);
                            win.BeginInvoke((Action)(() => win.SetScale(sc)));
                            break;
                        case "point":
                            float px = float.Parse(p[1], CultureInfo.InvariantCulture);
                            float py = float.Parse(p[2], CultureInfo.InvariantCulture);
                            string words = p.Length > 3 ? p[3] : "";
                            win.BeginInvoke((Action)(() => win.Point(px, py, words)));
                            break;
                        case "say":
                            string said = l.Length > 4 ? l.Substring(4) : "";
                            win.BeginInvoke((Action)(() => win.Say(said)));
                            break;
                        case "hide":
                            win.BeginInvoke((Action)(() => win.HideGuide()));
                            break;
                    }
                }
                catch (Exception e)
                {
                    output.WriteLine("err " + e.Message.Replace((char)10, ' '));
                }
            }
            // stdin closed: the bridge has gone, and so does the guide.
            win.BeginInvoke((Action)(() => Application.Exit()));
        });
        reader.IsBackground = true;
        reader.Start();

        Application.Run(win);
    }
}
