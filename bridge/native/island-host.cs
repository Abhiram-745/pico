// ===========================================================================
//  Pico island host
//
//  Keeps the island window where a notch belongs: above every other window,
//  out of the taskbar and Alt-Tab, with no frame around it.
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
//    trim <hwnd>
//        drop the resize border and let DWM round the corners, so the page
//        is all you see
//    place <hwnd> <x> <y> <w> <h>
//        move and size the window in a single call
//
//  Rounding is left to DWM (DWMWA_WINDOW_CORNER_PREFERENCE) rather than a
//  window region: SetWindowRgn reports success on a browser window and then
//  clips nothing, because the frame is drawn by the compositor.
// ===========================================================================

using System;
using System.Globalization;
using System.Runtime.InteropServices;

static class IslandHost
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr hWnd);

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

    // Windows 11 draws the frame through DWM, which is why SetWindowRgn has
    // no effect on a browser window: the legacy region clips nothing that the
    // compositor draws. These two attributes are the supported way to say
    // "no border" and "round the corners".
    const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    const int DWMWA_BORDER_COLOR = 34;
    const int DWMWCP_ROUND = 2;
    const int DWMWA_COLOR_NONE = unchecked((int)0xFFFFFFFE);

    const int GWL_STYLE = -16;
    const long WS_THICKFRAME = 0x00040000;
    const long WS_MINIMIZEBOX = 0x00020000;
    const long WS_MAXIMIZEBOX = 0x00010000;

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

    /// Trim the window's edges.
    ///
    /// Only the resize border goes. The caption stays, because a browser in
    /// app mode draws its own title bar inside the client area — removing
    /// WS_CAPTION does not delete that, it just exposes it. The caption is
    /// dealt with by parking it above the top of the screen instead.
    ///
    /// What this removes is the ~7px invisible resize margin, which Windows
    /// fills with the window's frame colour and which showed as a grey band
    /// down the right and bottom edges of the island. Together with a border
    /// colour of NONE that leaves only the page.
    static void Trim(IntPtr h)
    {
        long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
        style &= ~(WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLongPtr(h, GWL_STYLE, new IntPtr(style));

        int none = DWMWA_COLOR_NONE;
        DwmSetWindowAttribute(h, DWMWA_BORDER_COLOR, ref none, sizeof(int));
        int round = DWMWCP_ROUND;
        DwmSetWindowAttribute(h, DWMWA_WINDOW_CORNER_PREFERENCE, ref round, sizeof(int));

        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    }

    static void Place(IntPtr h, int x, int y, int w, int hgt)
    {
        // Re-asserting topmost every frame is deliberate: another app going
        // topmost after us would otherwise quietly cover the island.
        //
        // Position and size in one call, which is what keeps the morph
        // smooth — moving and then resizing paints an intermediate,
        // off-centre frame between the two.
        SetWindowPos(h, HWND_TOPMOST, x, y, w, hgt, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
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
                reply = "err " + e.Message.Replace('\n', ' ');
            }
            Console.WriteLine(reply);
            Console.Out.Flush();
        }
    }
}
