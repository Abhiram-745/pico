// ===========================================================================
//  Halo island host
//
//  One job, needing Win32, which a web page cannot do for itself: keep the
//  island window where a notch belongs — above every other window, out of the
//  taskbar and Alt-Tab, with no frame around it, and moved and sized in a
//  single call so it springs between shapes without tearing.
//
//  It never reads the screen and never sends input. It touches the window
//  handle the bridge hands it, and nothing else. Compiled on first run with
//  the C# compiler inside Windows (.NET Framework 4), so there is nothing to
//  download.
//
//  Protocol, one command per line on stdin, one reply per line on stdout:
//
//    pin <hwnd>                    always on top, out of taskbar and Alt-Tab
//    trim <hwnd>                   drop the resize border (place rounds it)
//    place <hwnd> <x> <y> <w> <h> [<side> <top> <squareTop>]
//                                  move and size in a single call; with the
//                                  frame inset, also clip to the content
//    hide <hwnd>                   take it off the screen, still running
//    show <hwnd>                   put it back, without taking the focus
//    hotkey <id> <mods> <vk>       register a chord with Windows
//    unhotkey                      drop every chord
//
//  and one line it sends unprompted:
//
//    fired <id>                    that chord was pressed, anywhere
//    released <id> <ms>            and its key was let go, <ms> later — how
//                                  a tap is told from a hold (hold to talk)
//
//  GLOBAL CHORDS
//  A web page only hears the keyboard while it has the focus, and Halo's
//  whole point is to be reachable while you are working in something else.
//  RegisterHotKey is how Windows hands a chord to a program that is not in
//  front, so the chords live here — on their own thread with its own message
//  loop, because the main thread is busy reading commands off stdin.
//
//  THE GREY FRAME
//  Trim() removes the resize border style, but the pixels it used to occupy
//  are still there — a few pixels of browser chrome along the left, right
//  and bottom edges that Chrome goes on painting its own (light grey)
//  background into, because nothing told it the window is any smaller than
//  its full rectangle. place() now clips the window to exactly its content
//  with SetWindowRgn (see Clip()), which is a region the compositor honours
//  regardless of what the page underneath draws — the frame has nothing
//  left to be painted on. Corner rounding moved here too, for the same
//  reason DWMWA_WINDOW_CORNER_PREFERENCE was tried first and dropped: DWM
//  rounds the whole window by a fixed system radius it does not take
//  suggestions on, which fought visibly with a region already rounded to
//  the island's own radius. Trim() now asks DWM not to round at all, and
//  Clip()'s region is the only rounding left.
//
//  THERE IS NO SECOND CURSOR HERE ANY MORE
//  There was, for a while: a drawn mascot that followed the work, the system
//  pointer hidden underneath it, and two routes for operating things without
//  moving the mouse at all — the accessibility layer, and injected touch,
//  which really is a separate input stream with no cursor attached. All of it
//  worked. All of it has gone.
//
//  Watching a cursor that is not yours do the work while your own sits frozen
//  somewhere else turns out to be stranger than watching your own cursor do
//  it, and things being pressed with no cursor anywhere near them is stranger
//  still. Halo moves the pointer you already have, where you can see it,
//  the way anybody else would.
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

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

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vk);

    [DllImport("user32.dll")]
    public static extern bool PeekMessage(out MSG msg, IntPtr hWnd, uint min, uint max, uint remove);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    public const uint WM_HOTKEY = 0x0312;
    public const uint PM_REMOVE = 0x0001;
    public const uint MOD_NOREPEAT = 0x4000;
    public const int SW_HIDE = 0;
    public const int SW_SHOWNOACTIVATE = 4;

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

    // Clipping the window to its content — see Clip() — rather than trusting
    // the browser to paint its own edges black. All four coordinates are in
    // the window's own units, the same ones place's x/y/w/h already arrive
    // in: island-host.exe carries no manifest, so it is DPI-unaware, and
    // Windows quietly rescales every one of these calls it makes against a
    // per-monitor-aware window (Chrome) from that assumption — the same
    // virtualisation that already makes SetWindowPos agree with libnut's
    // logical-pixel rectangles in notch-window.mjs. Were this ever made
    // DPI-aware, these would need converting to physical pixels first.
    /* Whether SetWindowRgn is rescaled like SetWindowPos is not something to
       rely on, and if it is not, the region lands at 1/1.25 of the window
       at 125% — the island cut short on the right and bottom. So Clip()
       measures instead: for the length of the call the thread is made
       per-monitor aware, the window's real size is read in real pixels, and
       the region is built at that scale. Measured, not assumed, either way. */
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);

    [StructLayout(LayoutKind.Sequential)]
    public struct WinRect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out WinRect rect);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int cellWidth, int cellHeight);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

    [DllImport("gdi32.dll")]
    public static extern int CombineRgn(IntPtr dest, IntPtr src1, IntPtr src2, int mode);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);

    [DllImport("user32.dll")]
    public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

    public const int RGN_OR = 2;

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const long WS_THICKFRAME = 0x00040000;
    public const long WS_MINIMIZEBOX = 0x00020000;
    public const long WS_MAXIMIZEBOX = 0x00010000;
    public const long WS_EX_TOOLWINDOW = 0x00000080;
    public const long WS_EX_APPWINDOW = 0x00040000;
    public const long WS_EX_LAYERED = 0x00080000;
    public const long WS_EX_TRANSPARENT = 0x00000020;

    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWA_BORDER_COLOR = 34;
    public const int DWMWCP_DONOTROUND = 1;
    public const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);

    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_NOOWNERZORDER = 0x0200;
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

    /// Make the island deaf to the mouse, or give it its ears back.
    ///
    /// The island hangs over the top centre of the screen, which on a
    /// browser is exactly where the tab strip is. A run reaching for a tab
    /// hit the island instead — and the island is the one window on screen
    /// that must never be clicked by the thing it is reporting on.
    ///
    /// WS_EX_TRANSPARENT makes the mouse pass straight through to whatever
    /// is behind, so the click lands where it was aimed. It needs
    /// WS_EX_LAYERED alongside it to take effect on a normal window. Both
    /// are taken off again the moment the run finishes, because an island
    /// nobody can click is not much of an island.
    static void Deaf(IntPtr h, bool deaf)
    {
        long ex = Native.GetWindowLongPtr(h, Native.GWL_EXSTYLE).ToInt64();
        ex = deaf
            ? (ex | Native.WS_EX_LAYERED | Native.WS_EX_TRANSPARENT)
            : (ex & ~Native.WS_EX_TRANSPARENT);
        Native.SetWindowLongPtr(h, Native.GWL_EXSTYLE, new IntPtr(ex));
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
    /// down the right and bottom edges of the island. Clip() (called from
    /// every place) is what actually gets rid of it; removing the style bit
    /// here on top stops Windows offering a resize cursor along an edge that
    /// no longer looks like one.
    static void Trim(IntPtr h)
    {
        long style = Native.GetWindowLongPtr(h, Native.GWL_STYLE).ToInt64();
        style &= ~(Native.WS_THICKFRAME | Native.WS_MINIMIZEBOX | Native.WS_MAXIMIZEBOX);
        Native.SetWindowLongPtr(h, Native.GWL_STYLE, new IntPtr(style));

        int none = Native.DWMWA_COLOR_NONE;
        Native.DwmSetWindowAttribute(h, Native.DWMWA_BORDER_COLOR, ref none, sizeof(int));
        // Not DWMWCP_ROUND: DWM would round the window's whole bounding
        // rectangle by its own fixed radius, on top of the shape Clip()
        // already cuts — two different curves at the same corner. Clip() is
        // the only rounding now, so DWM is told to leave the corners alone.
        int noRound = Native.DWMWCP_DONOTROUND;
        Native.DwmSetWindowAttribute(h, Native.DWMWA_WINDOW_CORNER_PREFERENCE, ref noRound, sizeof(int));

        Native.SetWindowPos(h, Native.HWND_TOPMOST, 0, 0, 0, 0,
            Native.SWP_NOMOVE | Native.SWP_NOSIZE | Native.SWP_NOACTIVATE
            | Native.SWP_FRAMECHANGED | Native.SWP_SHOWWINDOW);
    }

    static void Place(IntPtr h, int x, int y, int w, int hgt, int side, int top, bool haveInset, bool squareTop)
    {
        // Re-asserting topmost every frame is deliberate: another app going
        // topmost after us would otherwise quietly cover the island.
        //
        // Position and size in one call, which is what keeps the morph smooth
        // — moving and then resizing paints an intermediate, off-centre frame
        // between the two.
        Native.SetWindowPos(h, Native.HWND_TOPMOST, x, y, w, hgt,
            Native.SWP_NOACTIVATE | Native.SWP_NOOWNERZORDER);

        if (haveInset) Clip(h, w, hgt, side, top, squareTop);
    }

    /// Clip the window to exactly its visible content.
    ///
    /// The window is drawn a few pixels bigger than the island on screen —
    /// room for the resize border Trim() strips and the title bar parked
    /// above the top edge (see notch-window.mjs's `frame`) — and Chrome goes
    /// on painting its own light-grey background into that leftover space
    /// whether or not anything is there to see it, because nothing told it
    /// the window is really any smaller. A region is what tells it: nothing
    /// outside this shape is drawn, by this window or by DWM's compositor,
    /// no matter what the page underneath thinks its own size is. Recomputed
    /// on every place, since the content's own size changes constantly as
    /// the island springs between shapes.
    ///
    /// Only the bottom two corners are rounded when `squareTop` is set, to
    /// match the island's own CSS (border-radius: 0 0 r r): the top sits
    /// flush with the screen edge like a real notch, and rounding it would
    /// open a sliver at the very top where the desktop shows through instead
    /// of the island. The card is not flush with anything and rounds every
    /// corner. The radius itself grows a little with the window's own width
    /// — a small, calm curve on the resting pill, a slightly fuller one on
    /// the open panel — so every shape looks proportioned to its own size
    /// rather than sharing one fixed number.
    static void Clip(IntPtr h, int w, int hgt, int side, int top, bool squareTop)
    {
        int cl = Math.Max(0, side);
        int ct = Math.Max(0, top);
        int cr = w - cl;
        int cb = hgt - cl;  // the bottom inset mirrors the sides — see learnFrame() in notch-window.mjs
        if (cr <= cl || cb <= ct) return;   // too small to mean anything yet

        // The island's radius rises with its width, as island.css's --r does
        // (16px at compact, 22px open). The card is one size and one radius
        // — 22px, the card's own --r — whatever its width.
        double t = Clamp((double)(cr - cl - 216) / (540 - 216), 0, 1);
        int radius = squareTop ? (int)Math.Round(16 + (t * 6)) : 22;

        // The window's real size, in its own pixels (see the note on
        // SetThreadDpiAwarenessContext). Windows older than 10 1607 have no
        // such call, and there the units are left as they come.
        IntPtr previous = IntPtr.Zero;
        bool switched = false;
        try
        {
            previous = Native.SetThreadDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            switched = previous != IntPtr.Zero;
        }
        catch (EntryPointNotFoundException) { }
        try
        {
            double sx = 1, sy = 1;
            Native.WinRect real;
            if (switched && Native.GetWindowRect(h, out real) && w > 0 && hgt > 0)
            {
                int pw = real.Right - real.Left, ph = real.Bottom - real.Top;
                if (pw > 0 && ph > 0) { sx = (double)pw / w; sy = (double)ph / hgt; }
            }
            int L = (int)Math.Round(cl * sx), T = (int)Math.Round(ct * sy);
            int R = (int)Math.Round(cr * sx), B = (int)Math.Round(cb * sy);
            int r = (int)Math.Round(radius * sx);
            int d = r * 2;                                  // CreateRoundRectRgn wants a diameter, not a radius

            IntPtr rgn = Native.CreateRoundRectRgn(L, T, R, B, d, d);
            if (rgn == IntPtr.Zero) return;

            if (squareTop && r > 0)
            {
                // Fill the two rounded-away top corners back in to a square
                // edge: the union of the round rect with a plain strip across
                // its top `radius` pixels tall, which covers exactly the bite
                // CreateRoundRectRgn took out of those two corners and no more.
                IntPtr topStrip = Native.CreateRectRgn(L, T, R, T + r);
                if (topStrip != IntPtr.Zero)
                {
                    Native.CombineRgn(rgn, rgn, topStrip, Native.RGN_OR);
                    Native.DeleteObject(topStrip);
                }
            }

            // On success SetWindowRgn takes ownership of the region and frees it
            // itself; deleting it here as well would be a use-after-free the
            // next time DWM touches the window. Only a refused region is still
            // this code's to clean up.
            if (Native.SetWindowRgn(h, rgn, true) == 0) Native.DeleteObject(rgn);
        }
        finally
        {
            if (switched) Native.SetThreadDpiAwarenessContext(previous);
        }
    }

    static double Clamp(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /* ----------------------------------------------------------------------
       Chords

       Registered on this thread and nowhere else: RegisterHotKey with a null
       window binds the chord to the calling thread's message queue, so the
       thread that registers is the only one that can ever be told about it.
       The loop polls rather than blocking in GetMessage so that a chord
       arriving and a new registration arriving are handled by the same few
       lines, without a second thread to synchronise with.
       ---------------------------------------------------------------------- */
    class Chord
    {
        public int Id;
        public uint Mods;
        public uint Vk;
        public string Name;
    }

    static readonly object Out = new object();
    static readonly Queue<Chord> Pending = new Queue<Chord>();
    static readonly Dictionary<int, string> Live = new Dictionary<int, string>();
    static readonly Dictionary<int, uint> LiveVk = new Dictionary<int, uint>();
    static bool dropAll;
    static Thread chordThread;

    static void Say(string line)
    {
        lock (Out)
        {
            Console.WriteLine(line);
            Console.Out.Flush();
        }
    }

    static void ChordLoop()
    {
        var mine = new List<int>();
        /* The chord last fired, while its key is still down. RegisterHotKey
           says when a chord is pressed and never when it is let go, so the
           key is watched until it comes up: a quick tap and a long hold are
           different requests (start hands-free voice, or talk while held). */
        string holdName = null;
        uint holdVk = 0;
        int holdSince = 0;
        for (;;)
        {
            lock (Pending)
            {
                if (dropAll)
                {
                    dropAll = false;
                    foreach (int id in mine) Native.UnregisterHotKey(IntPtr.Zero, id);
                    mine.Clear();
                    Live.Clear();
                    LiveVk.Clear();
                }
                while (Pending.Count > 0)
                {
                    Chord c = Pending.Dequeue();
                    Native.UnregisterHotKey(IntPtr.Zero, c.Id);
                    // MOD_NOREPEAT: holding the chord down is one press, not
                    // a stream of them — onboarding counts presses.
                    if (Native.RegisterHotKey(IntPtr.Zero, c.Id, c.Mods | Native.MOD_NOREPEAT, c.Vk))
                    {
                        if (!mine.Contains(c.Id)) mine.Add(c.Id);
                        Live[c.Id] = c.Name;
                        LiveVk[c.Id] = c.Vk;
                        Say("registered " + c.Name);
                    }
                    else
                    {
                        Say("err chord " + c.Name + " is already taken by something else");
                    }
                }
            }

            Native.MSG msg;
            bool got = false;
            while (Native.PeekMessage(out msg, IntPtr.Zero, 0, 0, Native.PM_REMOVE))
            {
                got = true;
                if (msg.message == Native.WM_HOTKEY)
                {
                    int id = msg.wParam.ToInt32();
                    string name;
                    lock (Pending) { Live.TryGetValue(id, out name); }
                    if (name != null)
                    {
                        Say("fired " + name);
                        uint vk;
                        lock (Pending) { LiveVk.TryGetValue(id, out vk); }
                        holdName = name; holdVk = vk; holdSince = Environment.TickCount;
                    }
                }
            }
            if (holdName != null)
            {
                int held = Environment.TickCount - holdSince;
                if (holdVk == 0 || (Native.GetAsyncKeyState((int)holdVk) & 0x8000) == 0)
                {
                    Say("released " + holdName + " " + held);
                    holdName = null;
                }
                else if (held > 120000) holdName = null;
            }
            if (!got) Thread.Sleep(holdName != null ? 8 : 12);
        }
    }

    static void Hotkey(string name, uint mods, uint vk)
    {
        // The id is the name's hash, so re-registering the same chord
        // replaces it rather than stacking a second one on top.
        int id = Math.Abs(name.GetHashCode()) % 0xBFFF + 1;
        lock (Pending) { Pending.Enqueue(new Chord { Id = id, Mods = mods, Vk = vk, Name = name }); }
        if (chordThread == null)
        {
            chordThread = new Thread(ChordLoop);
            chordThread.IsBackground = true;
            chordThread.Start();
        }
    }

    [STAThread]
    static void Main()
    {
        Say("ready");

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
                    case "deaf":
                        Deaf(Handle(p[1]), p.Length > 2 && p[2] == "1");
                        break;
                    case "place":
                    {
                        // The frame inset is optional: three more numbers
                        // when the bridge knows it (see place() in
                        // island-host.mjs), none from an older caller —
                        // which is placed exactly as before, unclipped.
                        bool haveInset = p.Length >= 9;
                        Place(Handle(p[1]), Int(p[2]), Int(p[3]), Int(p[4]), Int(p[5]),
                            haveInset ? Int(p[6]) : 0, haveInset ? Int(p[7]) : 0,
                            haveInset, haveInset && p[8] == "1");
                        break;
                    }
                    case "hide":
                        Native.ShowWindow(Handle(p[1]), Native.SW_HIDE);
                        break;
                    case "show":
                        // No activation: putting the island back must not take
                        // the keyboard away from whatever is being typed in.
                        Native.ShowWindow(Handle(p[1]), Native.SW_SHOWNOACTIVATE);
                        Pin(Handle(p[1]));
                        break;
                    case "hotkey":
                        Hotkey(p[1], uint.Parse(p[2], CultureInfo.InvariantCulture), uint.Parse(p[3], CultureInfo.InvariantCulture));
                        break;
                    case "unhotkey":
                        lock (Pending) { dropAll = true; }
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
                reply = "err " + e.Message.Replace((char)10, ' ').Replace((char)13, ' ');
            }
            Say(reply);
        }
    }
}
