// ===========================================================================
//  Pico island host
//
//  Keeps the island window where a notch belongs: above every other window,
//  out of the taskbar and Alt-Tab, and cut to a real rounded shape.
//
//  It does nothing else. It never reads the screen, never sends input, and
//  only ever touches the window handle the bridge hands it. Compiled on first
//  run with the C# compiler that ships inside Windows (.NET Framework 4), so
//  there is nothing to download.
//
//  Protocol, one command per line on stdin, one reply per line on stdout:
//
//    pin <hwnd>
//        always on top, hidden from the taskbar and Alt-Tab
//    place <hwnd> <x> <y> <w> <h> <left> <top> <right> <bottom> <radius>
//        move and size the window in a single call, then clip it to the
//        content rectangle inset by left/top/right/bottom, with the bottom
//        corners rounded by radius. The top corners are pushed above the
//        content so the island stays square against the screen edge.
//
//  Moving and sizing in one SetWindowPos is what makes the morph smooth: two
//  separate calls per frame paint an intermediate, off-centre frame between
//  them, which is the jitter a browser-driven resize otherwise has.
// ===========================================================================

using System;
using System.Globalization;
using System.Runtime.InteropServices;

static class IslandHost
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

    [DllImport("gdi32.dll")]
    static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int widthEllipse, int heightEllipse);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr obj);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    const int GWL_EXSTYLE = -20;
    const long WS_EX_TOOLWINDOW = 0x00000080;
    const long WS_EX_APPWINDOW = 0x00040000;

    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);

    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_NOOWNERZORDER = 0x0200;

    static int Int(string s) { return int.Parse(s, CultureInfo.InvariantCulture); }

    static IntPtr Handle(string s)
    {
        var h = new IntPtr(long.Parse(s, CultureInfo.InvariantCulture));
        if (!IsWindow(h)) throw new ArgumentException("no such window");
        return h;
    }

    static void Pin(IntPtr h)
    {
        long ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        ex = (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
        SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(ex));
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    }

    static void Place(IntPtr h, int x, int y, int w, int hgt, int left, int top, int right, int bottom, int radius)
    {
        // Re-asserting topmost every frame is deliberate: another app going
        // topmost after us would otherwise quietly cover the island.
        SetWindowPos(h, HWND_TOPMOST, x, y, w, hgt, SWP_NOACTIVATE | SWP_NOOWNERZORDER);

        int d = Math.Max(0, radius * 2);
        IntPtr rgn = CreateRoundRectRgn(left, top - d, w - right + 1, hgt - bottom + 1, d, d);
        if (SetWindowRgn(h, rgn, true) == 0) DeleteObject(rgn);   // on success the system owns it
    }

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
                    case "place":
                        Place(Handle(p[1]), Int(p[2]), Int(p[3]), Int(p[4]), Int(p[5]),
                              Int(p[6]), Int(p[7]), Int(p[8]), Int(p[9]), Int(p[10]));
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
    }
}
