// ===========================================================================
//  Pico island host
//
//  Two jobs, both needing Win32, neither of which a web page can do:
//
//    1. Keep the island window where a notch belongs — above every other
//       window, out of the taskbar and Alt-Tab, with no frame around it.
//    2. Draw Pico's own cursor: a small animated mascot that follows the
//       pointer while Pico works, so you can see what it is doing.
//
//  It never reads the screen and never sends input. It touches the window
//  handle the bridge hands it, and a window of its own. Compiled on first run
//  with the C# compiler inside Windows (.NET Framework 4), so there is
//  nothing to download.
//
//  Protocol, one command per line on stdin, one reply per line on stdout:
//
//    pin <hwnd>                    always on top, out of taskbar and Alt-Tab
//    trim <hwnd>                   drop the resize border, round the corners
//    place <hwnd> <x> <y> <w> <h>  move and size in a single call
//    cursor on <pngPath>           show Pico's cursor
//    cursor at <x> <y>             move it, in screen coordinates
//    cursor state <name>           moving | clicking | thinking | done
//    cursor off                    hide it
//    cursor hide                   hide the system pointer, everywhere
//    cursor show                   give the system pointer back
//    cursor save                   remember where the user left the pointer
//    cursor restore                put it back there
//
//  Rounding is left to DWM (DWMWA_WINDOW_CORNER_PREFERENCE) rather than a
//  window region: SetWindowRgn reports success on a browser window and then
//  clips nothing, because the frame is drawn by the compositor.
// ===========================================================================

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class Native
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hDC, IntPtr obj);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(IntPtr hWnd, IntPtr hdcDst, ref POINT pptDst,
        ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    /// SetSystemCursor takes ownership of the handle it is given, so every id
    /// has to be handed its own copy.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr CopyIcon(IntPtr icon);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetSystemCursor(IntPtr cursor, uint id);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint action, uint param, IntPtr ptr, uint winIni);

    /// Reloads every system cursor from the user's own settings — the one
    /// call that undoes SetSystemCursor without having to have saved them.
    public const uint SPI_SETCURSORS = 0x0057;

    /// The cursors a desktop actually shows. Hiding the arrow alone is not
    /// enough: the pointer turns into a caret over a text box and reappears.
    public static readonly uint[] CURSOR_IDS =
    {
        32512, 32513, 32514, 32515, 32516,          // arrow, ibeam, wait, cross, up
        32642, 32643, 32644, 32645, 32646,          // the four resize arrows, move
        32648, 32649, 32650, 32651,                 // no, hand, app-starting, help
    };

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx; public int cy; }
    [StructLayout(LayoutKind.Sequential)] public struct BLENDFUNCTION
    {
        public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
    }

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const long WS_THICKFRAME = 0x00040000;
    public const long WS_MINIMIZEBOX = 0x00020000;
    public const long WS_MAXIMIZEBOX = 0x00010000;
    public const long WS_EX_TOOLWINDOW = 0x00000080;
    public const long WS_EX_APPWINDOW = 0x00040000;
    public const long WS_EX_LAYERED = 0x00080000;
    public const long WS_EX_TRANSPARENT = 0x00000020;
    public const long WS_EX_NOACTIVATE = 0x08000000;

    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWA_BORDER_COLOR = 34;
    public const int DWMWCP_ROUND = 2;
    public const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_NOOWNERZORDER = 0x0200;

    public const int ULW_ALPHA = 0x02;
    public const byte AC_SRC_OVER = 0x00;
    public const byte AC_SRC_ALPHA = 0x01;
}

/// <summary>
/// Pico's cursor: a layered window that follows the pointer.
///
/// It has to be its own window rather than anything drawn in a page, because
/// it must float over every other application with a genuinely transparent
/// background — and a browser window's background is always opaque. So this
/// is per-pixel alpha through UpdateLayeredWindow.
///
/// WS_EX_TRANSPARENT is what stops it eating clicks: the mouse passes
/// straight through to whatever Pico is actually working on.
///
/// WHOSE POINTER MOVES
/// Windows has exactly one pointer, and driving an application means moving
/// it — there is no second mouse to lend to a program. So while Pico works
/// the system pointer is made invisible and this is the only cursor on
/// screen: what moves is Pico's, not yours. Yours goes back, to the place
/// you left it, the moment Pico stops.
///
/// Two things make sure you are never left staring at an invisible pointer:
/// touching the mouse yourself hands it straight back, and it is restored on
/// every exit path this program has — including the one where it is killed
/// and stdin simply ends.
/// </summary>
static class PicoCursor
{
    const int SIZE = 96;                 // canvas, with room for the mascot to trail
    const int HOT_X = 8, HOT_Y = 6;      // where the real pointer sits in the canvas
    const float PET_X = 40f, PET_Y = 42f;
    const float TRAIL = 18f;             // how far behind the mascot may fall

    static readonly object gate = new object();

    static Form form;
    static Thread ui;
    static Image mascot;
    static System.Windows.Forms.Timer timer;
    static readonly Stopwatch clock = Stopwatch.StartNew();

    static int targetX, targetY;         // where Pico's cursor is drawn
    static int expectedX, expectedY;     // where this program last put the real pointer
    static float drawX, drawY;           // where the mascot has got to, eased
    static bool placed;
    static double lastFrame;
    static double lastAt = -1;           // when the bridge last moved us
    static double t;                     // animation clock, seconds
    static string state = "moving";
    static double clickAt = -10;

    // The system pointer, while Pico has it.
    static bool hidden;
    static double hiddenAt;
    static bool haveSaved;
    static bool handedBack;              // the user picked the mouse up; it is theirs now
    static Native.POINT saved;
    static System.Threading.Timer deadman;

    /// Nothing is left half-done if this program is killed: the pointer is
    /// the user's, and it goes back whatever happens here.
    static PicoCursor()
    {
        AppDomain.CurrentDomain.ProcessExit += delegate { Show(); };
    }

    public static void On(string pngPath)
    {
        if (form != null) return;
        try { mascot = Image.FromFile(pngPath); } catch { mascot = null; }

        var ready = new ManualResetEventSlim(false);
        ui = new Thread(() =>
        {
            form = new Form
            {
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                TopMost = true,
                Bounds = new Rectangle(-4000, -4000, SIZE, SIZE),
            };
            form.Load += delegate
            {
                long ex = Native.GetWindowLongPtr(form.Handle, Native.GWL_EXSTYLE).ToInt64();
                ex |= Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT
                    | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE;
                Native.SetWindowLongPtr(form.Handle, Native.GWL_EXSTYLE, new IntPtr(ex));
                ready.Set();
            };

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 15;                 // ~60fps
            timer.Tick += delegate { Frame(); };
            timer.Start();

            Application.Run(form);
        });
        ui.IsBackground = true;
        ui.SetApartmentState(ApartmentState.STA);
        ui.Start();
        ready.Wait(4000);
    }

    public static void At(int x, int y)
    {
        targetX = x;
        targetY = y;
        expectedX = x;
        expectedY = y;
        lastAt = clock.Elapsed.TotalSeconds;
        if (!placed) { drawX = x; drawY = y; placed = true; }   // do not fly in from a corner
    }

    public static void State(string s)
    {
        if (s == "clicking") clickAt = clock.Elapsed.TotalSeconds;
        state = s;
    }

    public static void Off()
    {
        var f = form;
        form = null;
        placed = false;
        if (f != null)
        {
            try { f.Invoke((Action)delegate { timer.Stop(); f.Close(); }); }
            catch { }
            if (mascot != null) { mascot.Dispose(); mascot = null; }
        }
        Show();
    }

    /* ----------------------------------------------------------------------
       The system pointer
       -------------------------------------------------------------------- */

    /// Make the pointer invisible everywhere, by pointing every system cursor
    /// at a blank one. Restoring is a single call that reloads the user's own
    /// cursors from their settings, so nothing here has to survive a crash.
    public static void Hide()
    {
        lock (gate)
        {
            if (hidden) return;
            IntPtr blank = IntPtr.Zero;
            try
            {
                using (var bmp = new Bitmap(32, 32, PixelFormat.Format32bppArgb))
                {
                    blank = bmp.GetHicon();
                    foreach (uint id in Native.CURSOR_IDS)
                    {
                        IntPtr copy = Native.CopyIcon(blank);
                        if (copy == IntPtr.Zero) continue;
                        if (!Native.SetSystemCursor(copy, id)) Native.DestroyIcon(copy);
                    }
                }
                hidden = true;
                hiddenAt = clock.Elapsed.TotalSeconds;

                // Last line of defence, on its own thread so it runs even if
                // the drawing loop never starts: an invisible pointer is only
                // ever a temporary state, and this ends it regardless of what
                // the bridge does or fails to do.
                if (deadman != null) deadman.Dispose();
                deadman = new System.Threading.Timer(delegate { Show(); }, null, 120000, Timeout.Infinite);
            }
            catch { /* the pointer stays visible; nothing else is affected */ }
            finally
            {
                if (blank != IntPtr.Zero) Native.DestroyIcon(blank);
            }
        }
    }

    public static void Show()
    {
        lock (gate)
        {
            if (deadman != null) { deadman.Dispose(); deadman = null; }
            if (!hidden) return;
            hidden = false;
            try { Native.SystemParametersInfo(Native.SPI_SETCURSORS, 0, IntPtr.Zero, 0); }
            catch { }
        }
    }

    /// Where the user left the pointer, so it can be handed back untouched.
    public static void Save()
    {
        Native.POINT p;
        if (!Native.GetCursorPos(out p)) return;
        saved = p;
        haveSaved = true;
        handedBack = false;
    }

    /// <summary>
    /// Put the pointer back where the user left it.
    ///
    /// Called at the end of a run, and again every time Pico stops to think —
    /// which is most of a run. Between two clicks there is nothing the pointer
    /// needs to be doing, so it goes home and waits there, and what travels
    /// across the screen in the meantime is Pico's cursor and not the user's.
    ///
    /// The saved position is not consumed by this, because it is not a
    /// one-shot: it is where the pointer belongs for the whole run.
    /// </summary>
    public static void Restore()
    {
        if (!haveSaved || handedBack) return;
        try
        {
            Native.SetCursorPos(saved.X, saved.Y);
            expectedX = saved.X;
            expectedY = saved.Y;
            lastAt = clock.Elapsed.TotalSeconds;
        }
        catch { }
    }

    /// <summary>
    /// Has the user taken the mouse back?
    ///
    /// Only asked once the pointer has been left alone for a moment: during a
    /// glide the bridge moves it every few milliseconds and the real pointer
    /// is legitimately ahead of the last position we were told about. A
    /// pointer that drifts while nothing is driving it drifted because a hand
    /// moved it — so give it back at once.
    /// </summary>
    static void CheckTakeover(double now)
    {
        if (!hidden) return;
        if (now - hiddenAt > 90) { Show(); return; }        // nothing is driving it; do not leave it hidden
        if (lastAt < 0 || now - lastAt < 0.25) return;

        Native.POINT p;
        if (!Native.GetCursorPos(out p)) return;
        if (Math.Abs(p.X - expectedX) + Math.Abs(p.Y - expectedY) <= 10) return;

        // A hand moved it. The mouse is the user's again: give the pointer
        // back, and stop putting it anywhere — including back where they
        // started, which is no longer where they want it.
        handedBack = true;
        Show();
    }

    static void Frame()
    {
        var f = form;
        if (f == null || !f.IsHandleCreated) return;

        double now = clock.Elapsed.TotalSeconds;
        double dt = lastFrame > 0 ? Math.Min(0.1, now - lastFrame) : 0.016;
        lastFrame = now;
        t = now;

        CheckTakeover(now);

        // The mascot trails the pointer. The lag is the point: a mark sitting
        // exactly on the pointer is lost against it, while one easing in
        // behind reads as something following along. Eased against the clock
        // rather than per frame, so a dropped frame does not change the feel.
        float k = (float)(1 - Math.Exp(-dt / 0.055));
        drawX += (targetX - drawX) * k;
        drawY += (targetY - drawY) * k;

        using (var bmp = new Bitmap(SIZE, SIZE, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                Paint(g);
            }
            Push(f, bmp);
        }
    }

    static void Paint(Graphics g)
    {
        // The arrow is drawn at the true pointer and never eased: it is the
        // only cursor on screen while Pico works, and a click lands under its
        // tip. Everything else — mascot, glow, the ring a click leaves —
        // trails behind it.
        float lagX = Clamp(drawX - targetX, -TRAIL, TRAIL);
        float lagY = Clamp(drawY - targetY, -TRAIL, TRAIL);

        // It bobs while it moves and breathes more slowly while thinking, so
        // the cursor itself says which of those is happening.
        double bob = state == "thinking" ? Math.Sin(t * 3.2) * 2.4 : Math.Sin(t * 6.4) * 1.6;
        float cx = PET_X + lagX;
        float cy = PET_Y + lagY + (float)bob;

        Color accent =
            state == "clicking" ? Color.FromArgb(255, 255, 214, 102) :
            state == "done" ? Color.FromArgb(255, 108, 227, 155) :
            state == "thinking" ? Color.FromArgb(255, 168, 150, 255) :
            Color.FromArgb(255, 96, 190, 255);

        using (var path = new GraphicsPath())
        {
            path.AddEllipse(cx - 26, cy - 26, 52, 52);
            using (var glow = new PathGradientBrush(path))
            {
                glow.CenterColor = Color.FromArgb(125, accent);
                glow.SurroundColors = new Color[] { Color.FromArgb(0, accent) };
                g.FillEllipse(glow, cx - 26, cy - 26, 52, 52);
            }
        }

        // A ring that swells out of a click and fades. It belongs at the point
        // that was clicked, which is the pointer, not the mascot.
        double since = t - clickAt;
        if (since >= 0 && since < 0.55)
        {
            float p = (float)(since / 0.55);
            float r = 13 + (p * 21);
            using (var pen = new Pen(Color.FromArgb((int)(200 * (1 - p)), accent), 2.4f))
                g.DrawEllipse(pen, HOT_X - r, HOT_Y - r, r * 2, r * 2);
        }

        if (mascot != null)
        {
            g.DrawImage(mascot, cx - 15, cy - 15, 30, 30);
        }
        else
        {
            using (var b = new SolidBrush(accent)) g.FillEllipse(b, cx - 9, cy - 9, 18, 18);
        }

        PointF[] tip = new PointF[]
        {
            new PointF(HOT_X, HOT_Y),
            new PointF(HOT_X + 13.5f, HOT_Y + 10.5f),
            new PointF(HOT_X + 5.6f, HOT_Y + 11.6f),
            new PointF(HOT_X + 2.6f, HOT_Y + 18.0f),
        };
        using (var shadow = new SolidBrush(Color.FromArgb(110, 0, 0, 0)))
        {
            g.TranslateTransform(0.9f, 1.3f);
            g.FillPolygon(shadow, tip);
            g.ResetTransform();
        }
        using (var fill = new SolidBrush(Color.White))
        using (var edge = new Pen(Color.FromArgb(210, 10, 12, 18), 1f))
        {
            g.FillPolygon(fill, tip);
            g.DrawPolygon(edge, tip);
        }
    }

    static float Clamp(float v, float lo, float hi)
    {
        return v < lo ? lo : (v > hi ? hi : v);
    }

    static void Push(Form f, Bitmap bmp)
    {
        IntPtr screen = Native.GetDC(IntPtr.Zero);
        IntPtr mem = Native.CreateCompatibleDC(screen);
        IntPtr hBitmap = IntPtr.Zero;
        IntPtr old = IntPtr.Zero;
        try
        {
            hBitmap = bmp.GetHbitmap(Color.FromArgb(0));
            old = Native.SelectObject(mem, hBitmap);

            var size = new Native.SIZE { cx = SIZE, cy = SIZE };
            var src = new Native.POINT { X = 0, Y = 0 };

            // The window follows the pointer exactly; only what is drawn
            // inside it lags. That way the tip never drifts off the click.
            var dst = new Native.POINT { X = targetX - HOT_X, Y = targetY - HOT_Y };

            var blend = new Native.BLENDFUNCTION
            {
                BlendOp = Native.AC_SRC_OVER,
                BlendFlags = 0,
                SourceConstantAlpha = 255,
                AlphaFormat = Native.AC_SRC_ALPHA,
            };

            Native.UpdateLayeredWindow(f.Handle, screen, ref dst, ref size, mem, ref src,
                0, ref blend, Native.ULW_ALPHA);

            // Above the island and everything else, without taking focus.
            Native.SetWindowPos(f.Handle, Native.HWND_TOPMOST, 0, 0, 0, 0,
                Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
        }
        finally
        {
            if (old != IntPtr.Zero) Native.SelectObject(mem, old);
            if (hBitmap != IntPtr.Zero) Native.DeleteObject(hBitmap);
            Native.DeleteDC(mem);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

static class IslandHost
{
    static int Int(string s) { return int.Parse(s, CultureInfo.InvariantCulture); }

    static IntPtr Handle(string s)
    {
        var h = new IntPtr(long.Parse(s, CultureInfo.InvariantCulture));
        if (!Native.IsWindow(h)) throw new ArgumentException("no such window");
        return h;
    }

    static void Pin(IntPtr h)
    {
        long ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
        ex = (ex | Native.WS_EX_TOOLWINDOW) & ~Native.WS_EX_APPWINDOW;
        Native.SetWindowLongPtr(h, Native.GWL_EXSTYLE, new IntPtr(ex));
        Native.SetWindowPos(h, Native.HWND_TOPMOST, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE
            | Native.SWP_FRAMECHANGED | Native.SWP_SHOWWINDOW);
    }

    /// Trim the window's edges.
    ///
    /// Only the resize border goes. The caption stays, because a browser in
    /// app mode draws its own title bar inside the client area — removing
    /// WS_CAPTION does not delete that, it just exposes it. The caption is
    /// dealt with by parking it above the top of the screen instead.
    ///
    /// What this removes is the ~7px invisible resize margin, which Windows
    /// fills with the window's frame colour and which showed as a grey band
    /// down the right and bottom edges of the island.
    static void Trim(IntPtr h)
    {
        long style = Native.GetWindowLongPtr(h, Native.GWL_STYLE).ToInt64();
        style &= ~(Native.WS_THICKFRAME | Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX);
        Native.SetWindowLongPtr(h, Native.GWL_STYLE, new IntPtr(style));

        int none = Native.DWMWA_COLOR_NONE;
        Native.DwmSetWindowAttribute(h, Native.DWMWA_BORDER_COLOR, ref none, sizeof(int));
        int round = Native.DWMWCP_ROUND;
        Native.DwmSetWindowAttribute(h, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));

        Native.SetWindowPos(h, Native.HWND_TOPMOST, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE
            | Native.SWP_FRAMECHANGED | Native.SWP_SHOWWINDOW);
    }

    static void Place(IntPtr h, int x, int y, int w, int hgt)
    {
        // Re-asserting topmost every frame is deliberate: another app going
        // topmost after us would otherwise quietly cover the island.
        //
        // Position and size in one call, which is what keeps the morph smooth
        // — moving and then resizing paints an intermediate, off-centre frame
        // between the two.
        Native.SetWindowPos(h, Native.HWND_TOPMOST, x, y, w, hgt,
            Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);
    }

    [STAThread]
    static void Main()
    {
        Console.WriteLine("ready");
        Console.Out.Flush();

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string reply = "ok";
            try
            {
                string[] p = line.Trim().Split(' ');
                switch (p[0])
                {
                    case "pin":
                        Pin(Handle(p[1]));
                        break;
                    case "trim":
                        Trim(Handle(p[1]));
                        break;
                    case "place":
                        Place(Handle(p[1]), Int(p[2]), Int(p[3]), Int(p[4]), Int(p[5]));
                        break;
                    case "cursor":
                        switch (p[1])
                        {
                            case "on": PicoCursor.On(string.Join(" ", p, 2, p.Length - 2)); break;
                            case "at": PicoCursor.At(Int(p[2]), Int(p[3])); break;
                            case "state": PicoCursor.State(p[2]); break;
                            case "off": PicoCursor.Off(); break;
                            case "hide": PicoCursor.Hide(); break;
                            case "show": PicoCursor.Show(); break;
                            case "save": PicoCursor.Save(); break;
                            case "restore": PicoCursor.Restore(); break;
                            default: reply = "err unknown cursor command"; break;
                        }
                        break;
                    case "":
                        continue;
                    default:
                        reply = "err unknown command";
                        break;
                }
            }
            catch (Exception e)
            {
                reply = "err " + e.Message.Replace('\n', ' ');
            }
            Console.WriteLine(reply);
            Console.Out.Flush();
        }

        PicoCursor.Off();
    }
}
