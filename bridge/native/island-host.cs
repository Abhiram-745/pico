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
//    quiet click <x> <y>           press what is at that point without the
//                                  pointer going there. Physical pixels.
//    quiet look <x> <y>            name what is at that point, pressing
//                                  nothing. Physical pixels.
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
using System.Windows.Automation;
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
    public const int DWMWA_CAPTION_COLOR = 35;
    public const int DWMWCP_ROUND = 2;
    public const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);
    /// COLORREF black: 0x00BBGGRR. The island is black, so a black frame is
    /// an invisible one on every build, including those that will not accept
    /// DWMWA_COLOR_NONE.
    public const int COLOR_BLACK = 0x00000000;

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
/// Usually nobody's. Most of what Pico does now goes through the
/// accessibility layer (see Quiet, below), which presses a control without a
/// click happening anywhere — so this cursor walks over, presses it, and the
/// user's pointer never moves or even flickers.
///
/// Some things have no such route: a drag, a right-click, an application that
/// exposes no accessibility tree. Windows has exactly one pointer, so those
/// borrow it. For as long as one is borrowed the system pointer is invisible
/// and this is the only cursor on screen, and it goes back to where it was
/// the moment Pico stops.
///
/// Two things make sure nobody is ever left staring at an invisible pointer:
/// touching the mouse yourself hands it straight back, and it is restored on
/// every exit path this program has — including the one where it is killed
/// and stdin simply ends.
/// </summary>
static class PicoCursor
{
    /* The canvas is large and the pointer sits in the middle of it, rather
       than in its top-left corner as it did when there was only an arrow and
       a small mark to draw. The trail behind a moving cursor goes whichever
       way it came from, so there has to be room on every side of the pointer
       for it; with the hot spot in a corner, a cursor moving left or up drew
       its trail outside its own window and you saw none of it.

       It is a layered window composited by the GPU, so the extra area costs
       effectively nothing, and clicks pass straight through it. */
    const int SIZE = 240;
    const int HOT_X = 120, HOT_Y = 120;  // where the real pointer sits in the canvas
    const float PET_X = 152f, PET_Y = 162f;
    const float TRAIL = 26f;             // how far behind the mascot may fall

    /* A short comet behind the mascot while it is moving.

       The complaint this answers is that you could not see Pico move. It was
       a 30px mark on a busy desktop, going from one place to another in a
       third of a second, and if you were not already looking at the right
       part of the screen the whole journey was over before you found it. A
       trail is what makes a fast thing legible: it draws the path as well as
       the position, so the movement registers out of the corner of an eye. */
    const int TRAIL_N = 9;
    static readonly PointF[] history = new PointF[TRAIL_N];
    static int historyAt = -1;
    static double lastTrail;

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

        // Sampled on its own clock, not per frame, so the comet is the same
        // length whatever the frame rate happens to be.
        if (now - lastTrail >= 0.022)
        {
            lastTrail = now;
            historyAt = (historyAt + 1) % TRAIL_N;
            history[historyAt] = new PointF(drawX, drawY);
        }

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
        double bob = state == "thinking" ? Math.Sin(t * 3.2) * 3.2 : Math.Sin(t * 6.8) * 2.4;
        float cx = PET_X + lagX;
        float cy = PET_Y + lagY + (float)bob;

        Color accent =
            state == "clicking" ? Color.FromArgb(255, 255, 206, 74) :
            state == "done" ? Color.FromArgb(255, 88, 226, 146) :
            state == "thinking" ? Color.FromArgb(255, 170, 148, 255) :
            Color.FromArgb(255, 92, 154, 250);

        // The comet, oldest and faintest first so the newest draws on top.
        if (historyAt >= 0)
        {
            for (int i = TRAIL_N - 1; i >= 1; i--)
            {
                PointF h = history[((historyAt - i) % TRAIL_N + TRAIL_N) % TRAIL_N];
                if (h.X == 0 && h.Y == 0) continue;
                float hx = h.X - (targetX - HOT_X);
                float hy = h.Y - (targetY - HOT_Y);
                // Only worth drawing where the cursor has actually travelled;
                // a stationary cursor would otherwise sit inside a blob of
                // its own history.
                float gap = (float)Math.Sqrt(((hx - cx) * (hx - cx)) + ((hy - cy) * (hy - cy)));
                if (gap < 6) continue;
                float age = 1f - ((float)i / TRAIL_N);          // 0 oldest, 1 newest
                float rad = 3f + (11f * age);
                int alpha = (int)(105 * age * age);
                if (alpha < 4) continue;
                using (var b = new SolidBrush(Color.FromArgb(alpha, accent)))
                    g.FillEllipse(b, hx - rad, hy - rad, rad * 2, rad * 2);
            }
        }

        using (var path = new GraphicsPath())
        {
            path.AddEllipse(cx - 38, cy - 38, 76, 76);
            using (var glow = new PathGradientBrush(path))
            {
                glow.CenterColor = Color.FromArgb(150, accent);
                glow.SurroundColors = new Color[] { Color.FromArgb(0, accent) };
                g.FillEllipse(glow, cx - 38, cy - 38, 76, 76);
            }
        }

        // A ring that swells out of a click and fades. It belongs at the point
        // that was clicked, which is the pointer, not the mascot. Two rings,
        // offset in time, because one thin ring on a busy screen is easy to
        // miss and the whole point of it is to say "that just got pressed".
        double since = t - clickAt;
        if (since >= 0 && since < 0.62)
        {
            for (int ring = 0; ring < 2; ring++)
            {
                double s2 = since - (ring * 0.1);
                if (s2 < 0 || s2 >= 0.52) continue;
                float p = (float)(s2 / 0.52);
                float r = 12 + (p * 34);
                using (var pen = new Pen(Color.FromArgb((int)(215 * (1 - p) * (1 - (ring * 0.35))), accent), 3f))
                    g.DrawEllipse(pen, HOT_X - r, HOT_Y - r, r * 2, r * 2);
            }
        }

        if (mascot != null)
        {
            g.DrawImage(mascot, cx - 23, cy - 23, 46, 46);
        }
        else
        {
            using (var b = new SolidBrush(accent)) g.FillEllipse(b, cx - 13, cy - 13, 26, 26);
        }

        // A slightly larger arrow than Windows' own, so that Pico's cursor is
        // recognisably Pico's rather than looking like the pointer misbehaving.
        PointF[] tip = new PointF[]
        {
            new PointF(HOT_X, HOT_Y),
            new PointF(HOT_X + 15.5f, HOT_Y + 12.1f),
            new PointF(HOT_X + 6.4f, HOT_Y + 13.3f),
            new PointF(HOT_X + 3.0f, HOT_Y + 20.7f),
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

/// <summary>
/// Pressing things without the pointer.
///
/// Windows has one pointer, so driving an application normally means moving
/// the user's own cursor across their screen — which is the thing they most
/// want it not to do. There is one way round it, and it is not a trick: UI
/// Automation, the accessibility layer that every well-behaved Windows
/// application exposes so that screen readers can operate it. A button
/// pressed through it is pressed exactly as if clicked, and no click happens.
///
/// So Pico's cursor can be the only cursor that moves, and the user's stays
/// where they left it — not put back afterwards, never taken in the first
/// place.
///
/// It does not always work. Games, custom-drawn interfaces and anything that
/// exposes no accessibility tree have nothing to press, and a right-click or
/// a double-click has no equivalent here at all. Those say so plainly and the
/// bridge falls back to the pointer, which is why this is an attempt rather
/// than a replacement.
///
/// COORDINATES
/// Everything here is in physical screen pixels, because that is what UI
/// Automation reports and accepts — verified rather than assumed: on this
/// machine a taskbar button comes back at y=1380 on a display the process
/// otherwise believes is 1152 tall. The bridge converts before sending.
/// </summary>
static class Quiet
{
    /// Nothing that is clicked is this big. A button, a menu item, a link, a
    /// tab, a list row — all comfortably under it; a pane, a document body or
    /// a whole window is over it, and "invoke" on one of those means something
    /// other than the click that was intended. Physical pixels, deliberately
    /// generous, because the cost of refusing is only that the pointer does it
    /// instead.
    const double MAX_W = 900, MAX_H = 700;

    public static string Act(int x, int y) { return Run(x, y, true); }

    /// <summary>
    /// What is under this point, without touching it.
    ///
    /// The same resolution as a press, stopping short of the press. It exists
    /// because Pico was clicking the wrong things in a way that was invisible
    /// to it: told to open Locked chats it pressed Archived, the row above,
    /// and had no idea it had. The accessibility layer knew the difference the
    /// whole time — it reports the control's name — so the bridge now reads
    /// that name before committing to a click and can tell when the aim is
    /// wrong while there is still time to do something about it.
    /// </summary>
    public static string Look(int x, int y) { return Run(x, y, false); }

    static string Run(int x, int y, bool press)
    {
        string answer = "no timed-out";

        // On its own thread, with a deadline: a UI Automation call reaches
        // into another process, and an application that has stopped answering
        // must not take Pico down with it.
        var t = new Thread(() =>
        {
            try { answer = press ? Press(x, y) : Name(x, y); }
            catch (Exception e) { answer = "no " + e.GetType().Name; }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        // Short, because this sits in front of every click. An application
        // that cannot answer in a second is one the pointer should handle.
        return t.Join(1200) ? answer : "no timed-out";
    }

    static double Area(System.Windows.Rect r) { return r.Width * r.Height; }

    static bool Actionable(AutomationElement el, out object pattern, out string how)
    {
        pattern = null;
        how = null;
        if (el == null) return false;
        try
        {
            if (!el.Current.IsEnabled || el.Current.IsOffscreen) return false;
            if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) { how = "invoke"; return true; }
            if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) { how = "toggle"; return true; }
            if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) { how = "select"; return true; }
            if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) { how = "expand"; return true; }
        }
        catch { }
        return false;
    }

    /// <summary>
    /// The smallest thing under this point that can actually be operated.
    ///
    /// FromPoint gives whatever the application's hit-testing hands back, and
    /// that is often a container — ask the taskbar what is at a button and it
    /// offers the taskbar. So descend from there, keeping only descendants
    /// that contain the point, and take the smallest one that has something
    /// to press.
    /// </summary>
    static bool SmallEnough(System.Windows.Rect r)
    {
        return !r.IsEmpty && r.Width > 0 && r.Height > 0 && r.Width <= MAX_W && r.Height <= MAX_H;
    }

    static AutomationElement Resolve(AutomationElement from, System.Windows.Point p)
    {
        object pat;
        string how;

        // The common case, and the fast one: what hit-testing returned is
        // already the control itself. Chromium, WinForms and WPF nearly always
        // answer this precisely, and walking their trees for confirmation would
        // cost more than the click.
        try
        {
            if (SmallEnough(from.Current.BoundingRectangle) && Actionable(from, out pat, out how))
            {
                return from;
            }
        }
        catch { }

        AutomationElement best = null;
        double bestArea = double.MaxValue;

        var queue = new System.Collections.Generic.Queue<AutomationElement>();
        queue.Enqueue(from);
        int seen = 0;

        while (queue.Count > 0 && seen < 150)
        {
            var el = queue.Dequeue();
            seen++;
            System.Windows.Rect r;
            try { r = el.Current.BoundingRectangle; } catch { continue; }
            if (r.IsEmpty || !r.Contains(p)) continue;

            if (SmallEnough(r) && Area(r) < bestArea && Actionable(el, out pat, out how))
            {
                best = el;
                bestArea = Area(r);
            }

            try
            {
                foreach (AutomationElement c in el.FindAll(TreeScope.Children, Condition.TrueCondition))
                {
                    queue.Enqueue(c);
                }
            }
            catch { }
        }
        return best;
    }

    /// The name of the smallest operable thing under the point. Reads only.
    static string Name(int x, int y)
    {
        var p = new System.Windows.Point(x, y);
        var at = AutomationElement.FromPoint(p);
        if (at == null) return "no nothing-there";

        var el = Resolve(at, p) ?? at;
        string name = null;
        try { name = el.Current.Name; } catch { }
        if (string.IsNullOrEmpty(name))
        {
            // A control with no name of its own is often labelled by the text
            // inside it — a chat row whose label is a child Text element is
            // the ordinary case in exactly the applications this is for.
            try
            {
                foreach (AutomationElement c in el.FindAll(TreeScope.Descendants, Condition.TrueCondition))
                {
                    string cn = c.Current.Name;
                    if (!string.IsNullOrEmpty(cn)) { name = cn; break; }
                }
            }
            catch { }
        }
        if (string.IsNullOrEmpty(name)) return "no unnamed";
        return "is " + name.Replace((char)10, ' ').Replace((char)13, ' ');
    }

    static string Press(int x, int y)
    {
        var p = new System.Windows.Point(x, y);
        var at = AutomationElement.FromPoint(p);
        if (at == null) return "no nothing-there";

        var el = Resolve(at, p);
        if (el == null) return "no not-operable";

        if (!SmallEnough(el.Current.BoundingRectangle)) return "no too-big";

        object pattern;
        string how;
        if (!Actionable(el, out pattern, out how)) return "no not-operable";

        if (how == "invoke") ((InvokePattern)pattern).Invoke();
        else if (how == "toggle") ((TogglePattern)pattern).Toggle();
        else if (how == "select") ((SelectionItemPattern)pattern).Select();
        else if (how == "expand")
        {
            var ec = (ExpandCollapsePattern)pattern;
            if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse();
            else ec.Expand();
        }
        else return "no not-operable";

        string name = el.Current.Name;
        if (string.IsNullOrEmpty(name)) name = el.Current.ControlType.ProgrammaticName;
        return "done " + how + " " + name.Replace((char)10, ' ').Replace((char)13, ' ');
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
    ///
    /// THE HAIRLINE
    /// Dropping the resize margin still leaves DWM's own one-pixel border
    /// around the window, drawn in the system's frame colour — a soft grey
    /// ring around what is supposed to be a piece of the bezel. Asking for
    /// DWMWA_COLOR_NONE removes it outright, but only on builds that know
    /// that value; where it is not recognised the call fails, nothing is
    /// changed, and the grey line stays. So: ask for none, check whether the
    /// answer was yes, and paint the border black if it was not. Black on a
    /// black island is the same thing as no border, and it works everywhere.
    static void Trim(IntPtr h)
    {
        long style = Native.GetWindowLongPtr(h, Native.GWL_STYLE).ToInt64();
        style &= ~(Native.WS_THICKFRAME | Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX);
        Native.SetWindowLongPtr(h, Native.GWL_STYLE, new IntPtr(style));

        int none = Native.DWMWA_COLOR_NONE;
        int hr = Native.DwmSetWindowAttribute(h, Native.DWMWA_BORDER_COLOR, ref none, sizeof(int));
        if (hr != 0)
        {
            int black = Native.COLOR_BLACK;
            Native.DwmSetWindowAttribute(h, Native.DWMWA_BORDER_COLOR, ref black, sizeof(int));
        }

        // The caption is parked above the screen, but a browser that decides
        // to redraw its frame can flash it; black costs nothing and means
        // there is nothing to see if it does.
        int capBlack = Native.COLOR_BLACK;
        Native.DwmSetWindowAttribute(h, Native.DWMWA_CAPTION_COLOR, ref capBlack, sizeof(int));

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
                    case "quiet":
                        if (p[1] == "click") reply = "ok " + Quiet.Act(Int(p[2]), Int(p[3]));
                        else if (p[1] == "look") reply = "ok " + Quiet.Look(Int(p[2]), Int(p[3]));
                        else reply = "err unknown quiet command";
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
