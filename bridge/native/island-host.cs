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
//    trim <hwnd>                   drop the resize border, round the corners
//    place <hwnd> <x> <y> <w> <h>  move and size in a single call
//
//  Rounding is left to DWM (DWMWA_WINDOW_CORNER_PREFERENCE) rather than a
//  window region: SetWindowRgn reports success on a browser window and then
//  clips nothing, because the frame is drawn by the compositor.
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
using System.Globalization;
using System.Runtime.InteropServices;

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

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const long WS_THICKFRAME = 0x00040000;
    public const long WS_MINIMIZEBOX = 0x00020000;
    public const long WS_MAXIMIZEBOX = 0x00010000;
    public const long WS_EX_TOOLWINDOW = 0x00000080;
    public const long WS_EX_APPWINDOW = 0x00040000;

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
            Console.WriteLine(reply);
            Console.Out.Flush();
        }
    }
}
