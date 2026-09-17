// ===========================================================================
//  Halo sense
//
//  Answers questions about what is on screen, from the accessibility layer
//  Windows keeps for screen readers: what is under this point, how big is it,
//  what is it called, can it be pressed, how far is this list scrolled.
//
//  It never presses anything and never moves the pointer. Halo still clicks
//  with the user's own mouse, where they can see it; this only makes sure the
//  click lands on the middle of the button the model was looking at rather
//  than on the edge of it, and says what was actually there.
//
//  Everything is in physical screen pixels. The process declares itself
//  per-monitor DPI aware before doing anything else, so a point means the
//  same pixel here as it does in a screenshot, on every display, at every
//  scaling setting. Leaving that implicit is how a click ends up a quarter of
//  a screen away on a display at 125%.
//
//  Protocol: one request per line on stdin, "<id> <command> <args...>", and
//  exactly one reply per request on stdout, "<id> <json>".
//
//    <id> ping
//    <id> cursor                 where the pointer is
//    <id> fg                     the foreground window
//    <id> window <x> <y>         the top-level window under a point
//    <id> wake <x> <y>           ask that window to build its accessibility
//                                tree, so a later hit can see inside it
//    <id> desktop                whether input can reach the desktop at all
//    <id> idle                   milliseconds since the last keyboard or mouse input
//    <id> windows                visible top-level windows, front to back
//    <id> hit <x> <y>            the element under a point, and the control
//                                a click there would operate
//    <id> near <x> <y> <r>       operable controls within r pixels of a point
//    <id> scrollable <x> <y>     the scrollable container under a point
//    <id> elements <hwnd> [max]  named, operable controls in a window
//    <id> focus <hwnd>           bring a window to the foreground
//
//  Every accessibility call runs on its own thread with a deadline. The call
//  reaches into another process, and an application that has stopped
//  answering must not take this helper — or the click waiting on it — down
//  with it.
//
//  C# 5, because the compiler inside every copy of Windows is that old.
// ===========================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

static class Win
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();

    /// Milliseconds since the last keyboard or mouse input anybody gave.
    public static long IdleMs()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
        if (!GetLastInputInfo(ref info)) return -1;
        return (long)unchecked(GetTickCount() - info.dwTime);
    }

    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder info, int length, out int needed);

    /// The desktop that keyboard and mouse input is going to right now:
    /// "Default" when someone is at the computer, "Screen-saver" or
    /// "Winlogon" when it is locked, asleep behind a screen saver, or showing
    /// a UAC prompt. Input sent by any ordinary program goes nowhere then.
    public static string InputDesktop()
    {
        IntPtr d = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
        if (d == IntPtr.Zero) return "";      // Winlogon's desktop cannot even be opened
        try
        {
            var sb = new StringBuilder(128);
            int needed;
            return GetUserObjectInformation(d, 2 /* UOI_NAME */, sb, sb.Capacity * 2, out needed) ? sb.ToString() : "";
        }
        finally { CloseDesktop(d); }
    }

    public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
    public const int DWMWA_CLOAKED = 14;
    public const uint GW_HWNDNEXT = 2;
    public const uint GW_OWNER = 4;
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TOOLWINDOW = 0x80;
    public const long WS_EX_NOACTIVATE = 0x08000000;
    public const int SW_RESTORE = 9;

    public static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ProcessName(IntPtr h)
    {
        try
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            return Process.GetProcessById((int)pid).ProcessName;
        }
        catch { return ""; }
    }

    /// The rectangle a window visibly occupies. GetWindowRect includes the
    /// invisible resize margin Windows 10 and 11 put around every window.
    public static RECT Bounds(IntPtr h)
    {
        RECT r;
        if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) != 0)
        {
            GetWindowRect(h, out r);
        }
        return r;
    }

    public static bool Cloaked(IntPtr h)
    {
        int v;
        return DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, sizeof(int)) == 0 && v != 0;
    }
}

/// Just enough JSON to answer with, by hand: no serializer ships with the
/// compiler this is built by.
sealed class Json
{
    readonly StringBuilder sb = new StringBuilder();
    bool first = true;

    public static string Str(string s)
    {
        if (s == null) return "null";
        var o = new StringBuilder(s.Length + 2);
        o.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': o.Append("\\\""); break;
                case '\\': o.Append("\\\\"); break;
                case '\n': o.Append("\\n"); break;
                case '\r': o.Append("\\r"); break;
                case '\t': o.Append("\\t"); break;
                default:
                    if (c < 0x20) o.Append("\\u").Append(((int)c).ToString("x4"));
                    else o.Append(c);
                    break;
            }
        }
        o.Append('"');
        return o.ToString();
    }

    public static string Num(double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
        return Math.Round(v, 2).ToString(CultureInfo.InvariantCulture);
    }

    public Json Raw(string key, string value)
    {
        sb.Append(first ? "{" : ",");
        first = false;
        sb.Append(Str(key)).Append(':').Append(value);
        return this;
    }

    public Json S(string key, string value) { return Raw(key, Str(value)); }
    public Json N(string key, double value) { return Raw(key, Num(value)); }
    public Json B(string key, bool value) { return Raw(key, value ? "true" : "false"); }

    public override string ToString() { return first ? "{}" : sb.ToString() + "}"; }
}

static class Sense
{
    /// Kinds of control a click is meant for. A pane, a group, a document
    /// body or a whole window is not one of them: "the middle of it" is not
    /// a place anybody aims.
    static readonly HashSet<string> CLICKABLE = new HashSet<string>
    {
        "Button", "SplitButton", "MenuItem", "TabItem", "ListItem", "TreeItem",
        "Hyperlink", "CheckBox", "RadioButton", "ComboBox", "DataItem",
        "HeaderItem", "Edit", "Image", "Thumb", "Slider", "Spinner", "MenuBar",
    };

    /// Controls where the exact point matters more than the middle: a caret
    /// goes where it is put, a slider moves to where it is pressed.
    static readonly HashSet<string> POSITIONAL = new HashSet<string>
    {
        "Edit", "Document", "Slider", "ScrollBar", "Text", "Custom",
    };

    public static string TypeName(AutomationElement el)
    {
        try
        {
            string n = el.Current.ControlType.ProgrammaticName;
            int dot = n.LastIndexOf('.');
            return dot >= 0 ? n.Substring(dot + 1) : n;
        }
        catch { return ""; }
    }

    static bool Pattern(AutomationElement el, AutomationProperty p)
    {
        try { return (bool)el.GetCurrentPropertyValue(p); } catch { return false; }
    }

    static bool Operable(AutomationElement el, string type)
    {
        if (CLICKABLE.Contains(type)) return true;
        return Pattern(el, AutomationElement.IsInvokePatternAvailableProperty)
            || Pattern(el, AutomationElement.IsTogglePatternAvailableProperty)
            || Pattern(el, AutomationElement.IsSelectionItemPatternAvailableProperty)
            || Pattern(el, AutomationElement.IsExpandCollapsePatternAvailableProperty);
    }

    static string RectJson(System.Windows.Rect r)
    {
        if (r.IsEmpty) return "null";
        return "[" + Json.Num(r.X) + "," + Json.Num(r.Y) + "," + Json.Num(r.Width) + "," + Json.Num(r.Height) + "]";
    }

    static string Describe(AutomationElement el)
    {
        var j = new Json();
        string type = TypeName(el);
        System.Windows.Rect r = System.Windows.Rect.Empty;
        try
        {
            var c = el.Current;
            r = c.BoundingRectangle;
            j.S("type", type)
             .S("name", Trim(c.Name, 120))
             .S("id", Trim(c.AutomationId, 60))
             .S("cls", Trim(c.ClassName, 60))
             .Raw("rect", RectJson(r))
             .B("enabled", c.IsEnabled)
             .B("offscreen", c.IsOffscreen)
             .B("focusable", c.IsKeyboardFocusable)
             .B("operable", Operable(el, type))
             .B("positional", POSITIONAL.Contains(type));
            string how = Pattern(el, AutomationElement.IsInvokePatternAvailableProperty) ? "invoke"
                : Pattern(el, AutomationElement.IsTogglePatternAvailableProperty) ? "toggle"
                : Pattern(el, AutomationElement.IsSelectionItemPatternAvailableProperty) ? "select"
                : Pattern(el, AutomationElement.IsExpandCollapsePatternAvailableProperty) ? "expand"
                : Pattern(el, AutomationElement.IsValuePatternAvailableProperty) ? "value"
                : "";
            if (how.Length > 0) j.S("how", how);
        }
        catch (Exception e)
        {
            j.S("type", type).S("error", e.GetType().Name);
        }
        return j.ToString();
    }

    static string Trim(string s, int max)
    {
        if (string.IsNullOrEmpty(s)) return "";
        s = s.Replace('\n', ' ').Replace('\r', ' ').Trim();
        return s.Length > max ? s.Substring(0, max) : s;
    }

    /// A fact the model is never asked to read out of a picture: what
    /// actually holds keyboard focus, and what its own application says its
    /// value is. The verdict used to be judged on the screenshot alone, and
    /// a final "hello there" resolved from a compressed JPEG as "hello ther"
    /// often enough to report perfectly good runs back as failures.
    ///
    /// Read-only throughout: this answers a question. Setting focus or a
    /// value would be doing the user's work behind their back, which is the
    /// one thing this helper is forbidden to do.
    public static string Focused()
    {
        try
        {
            var el = AutomationElement.FocusedElement;
            if (el == null) return new Json().B("found", false).ToString();

            var j = new Json().B("found", true)
                .S("title", Trim(TopWindowsTitleOf(el), 120));
            try { j.Raw("at", Describe(el)); } catch { }
            try
            {
                if (Pattern(el, AutomationElement.IsValuePatternAvailableProperty))
                {
                    var v = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
                    j.S("value", Trim(v.Current.Value, 800));
                }
            }
            catch { /* an element without a value is a valid answer */ }
            return j.ToString();
        }
        catch (Exception e)
        {
            return new Json().B("found", false).S("error", e.GetType().Name).ToString();
        }
    }

    /// The title of the window an element lives in. Reading it through the
    /// element rather than the foreground window matters when something else
    /// has come forward since: the focus being asked about is still the one
    /// the last keystrokes went to.
    static string TopWindowsTitleOf(AutomationElement el)
    {
        try
        {
            var w = el.Current.NativeWindowHandle;
            if (w != 0)
            {
                IntPtr h = new IntPtr(w);
                IntPtr root = GetAncestor(h, 2);
                if (root != IntPtr.Zero) h = root;
                return Win.Title(h);
            }
        }
        catch { }
        return "";
    }

    static double Area(System.Windows.Rect r) { return r.IsEmpty ? double.MaxValue : r.Width * r.Height; }

    /// <summary>
    /// The control a click at this point would operate.
    ///
    /// Hit-testing hands back whatever the application decides is there,
    /// which is either too deep (the text inside a button) or too shallow (a
    /// toolbar, when asked about one of its buttons). So look both ways: up
    /// through the ancestors for the first operable control that contains
    /// the point, and down through a bounded number of descendants for a
    /// smaller one. The smallest operable thing containing the point wins.
    /// </summary>
    static AutomationElement Resolve(AutomationElement at, System.Windows.Point p, out List<AutomationElement> chain)
    {
        chain = new List<AutomationElement>();
        AutomationElement best = null;
        double bestArea = double.MaxValue;

        var walker = TreeWalker.ControlViewWalker;
        AutomationElement el = at;
        for (int depth = 0; el != null && depth < 8; depth++)
        {
            chain.Add(el);
            try
            {
                var c = el.Current;
                var r = c.BoundingRectangle;
                string type = TypeName(el);
                if (type == "Window" || type == "Pane" && Area(r) > 600000) break;
                if (!r.IsEmpty && r.Contains(p) && c.IsEnabled && Operable(el, type) && Area(r) < bestArea)
                {
                    best = el;
                    bestArea = Area(r);
                    break;      // the nearest operable ancestor is the one pressed
                }
            }
            catch { }
            try { el = walker.GetParent(el); } catch { el = null; }
        }

        // Downwards, for applications whose hit-testing stops at a container.
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(at);
        int seen = 0;
        while (queue.Count > 0 && seen < 120)
        {
            var node = queue.Dequeue();
            seen++;
            System.Windows.Rect r;
            try { r = node.Current.BoundingRectangle; } catch { continue; }
            if (r.IsEmpty || !r.Contains(p)) continue;
            string type = TypeName(node);
            try
            {
                if (node != at && node.Current.IsEnabled && Operable(node, type) && Area(r) < bestArea)
                {
                    best = node;
                    bestArea = Area(r);
                }
            }
            catch { }
            try
            {
                foreach (AutomationElement child in node.FindAll(TreeScope.Children, Condition.TrueCondition))
                {
                    queue.Enqueue(child);
                }
            }
            catch { }
        }
        return best;
    }

    public static string Hit(int x, int y)
    {
        var p = new System.Windows.Point(x, y);

        // First time Halo looks into this window, ask it for its tree. In a
        // browser this is the difference between "a Pane" and the button.
        // Only the first look pays the wait; every later one is already warm.
        if (Wake(RootAt(x, y))) Thread.Sleep(240);

        string window = WindowAt(x, y);
        AutomationElement at = AutomationElement.FromPoint(p);
        if (at == null) return new Json().B("found", false).Raw("window", window).ToString();

        List<AutomationElement> chain;
        var target = Resolve(at, p, out chain);

        var path = new StringBuilder("[");
        for (int i = 0; i < chain.Count && i < 6; i++)
        {
            if (i > 0) path.Append(',');
            string name = "";
            try { name = Trim(chain[i].Current.Name, 40); } catch { }
            path.Append(Json.Str(TypeName(chain[i]) + (name.Length > 0 ? ":" + name : "")));
        }
        path.Append(']');

        // Every operable layer under the point, smallest first: a tab and the
        // close button inside it, a list row and the checkbox in it. Which
        // one was meant is a question of names, answered by the caller.
        var layers = new StringBuilder("[");
        int count = 0;
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement el = target ?? at;
        for (int depth = 0; el != null && depth < 10 && count < 4; depth++)
        {
            try
            {
                var c = el.Current;
                var r = c.BoundingRectangle;
                string type = TypeName(el);
                if (type == "Window") break;
                if (!r.IsEmpty && r.Contains(p) && Operable(el, type))
                {
                    if (count++ > 0) layers.Append(',');
                    layers.Append(Describe(el));
                }
            }
            catch { }
            try { el = walker.GetParent(el); } catch { el = null; }
        }
        layers.Append(']');

        return new Json()
            .B("found", true)
            .Raw("at", Describe(at))
            .Raw("target", target == null ? "null" : Describe(target))
            .Raw("layers", layers.ToString())
            .Raw("path", path.ToString())
            .Raw("window", window)
            .ToString();
    }

    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Win.POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

    // ----------------------------------------------------------------------
    //  Waking an application's accessibility tree
    //
    //  Chromium — so Chrome, Edge, and every Electron app — does not build an
    //  accessibility tree until something asks for one. Until then the whole
    //  window answers as a single "Pane" with nothing inside it, which is
    //  exactly as useful as no accessibility layer at all. Measured on this
    //  machine: asking what was under the middle of a button gave `Pane`,
    //  with no operable layers, every time.
    //
    //  The signal it waits for is the one a screen reader sends: WM_GETOBJECT
    //  asking for OBJID_CLIENT. Send that and the tree appears — the same
    //  point answered `Button "Save changes"` about two tenths of a second
    //  later. So Halo asks, once per window, and from then on a click can be
    //  put on the middle of the control the model meant instead of wherever
    //  in it the model happened to point.
    //
    //  It is a question, not an instruction: WM_GETOBJECT asks an application
    //  to hand over an interface for reading its UI. Nothing is pressed and
    //  nothing is changed. The cost is the one every screen reader user pays
    //  — the application keeps a tree in memory — and it buys the difference
    //  between aiming at a control and aiming near one.
    //
    //  Sent with a deadline and a budget, because it reaches into another
    //  process: an application that has stopped answering must not take the
    //  click waiting on this down with it.
    // ----------------------------------------------------------------------
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(
        IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, EnumChildProc cb, IntPtr p);
    delegate bool EnumChildProc(IntPtr h, IntPtr p);

    const uint WM_GETOBJECT = 0x003D;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    const int WAKE_BUDGET_MS = 420;      // total, across every window messaged
    const int WAKE_MAX_CHILDREN = 12;

    static readonly HashSet<long> Woken = new HashSet<long>();

    /// Ask the window under this point for its accessibility tree, once ever.
    /// Returns true if this call was the one that asked, so the caller knows
    /// to give the application a moment to build it.
    public static bool Wake(IntPtr root)
    {
        if (root == IntPtr.Zero) return false;
        long key = root.ToInt64();
        lock (Woken)
        {
            if (Woken.Contains(key)) return false;
            Woken.Add(key);
        }

        var sw = Stopwatch.StartNew();
        var targets = new List<IntPtr> { root };
        try
        {
            EnumChildWindows(root, delegate(IntPtr child, IntPtr unused)
            {
                // The renderer's own window is the one that actually holds the
                // page; the top-level frame alone is not enough.
                if (targets.Count >= WAKE_MAX_CHILDREN + 1) return false;
                targets.Add(child);
                return true;
            }, IntPtr.Zero);
        }
        catch { }

        foreach (IntPtr h in targets)
        {
            if (sw.ElapsedMilliseconds > WAKE_BUDGET_MS) break;
            try
            {
                IntPtr result;
                SendMessageTimeout(h, WM_GETOBJECT, IntPtr.Zero, new IntPtr(-4) /* OBJID_CLIENT */,
                    SMTO_ABORTIFHUNG, 120, out result);
            }
            catch { }
        }
        return true;
    }

    /// The top-level window owning a point, as a handle.
    public static IntPtr RootAt(int x, int y)
    {
        try
        {
            IntPtr h = WindowFromPoint(new Win.POINT { X = x, Y = y });
            if (h == IntPtr.Zero) return IntPtr.Zero;
            IntPtr root = GetAncestor(h, 2);    // GA_ROOT
            return root != IntPtr.Zero ? root : h;
        }
        catch { return IntPtr.Zero; }
    }

    /// The top-level window that owns a point — so the caller can tell a
    /// click aimed at an application from one that would land on Halo.
    public static string WindowAt(int x, int y)
    {
        try
        {
            var pt = new Win.POINT { X = x, Y = y };
            IntPtr h = WindowFromPoint(pt);
            if (h == IntPtr.Zero) return "null";
            IntPtr root = GetAncestor(h, 2);    // GA_ROOT
            if (root != IntPtr.Zero) h = root;
            var r = Win.Bounds(h);
            return new Json()
                .S("hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture))
                .S("title", Trim(Win.Title(h), 120))
                .S("process", Win.ProcessName(h))
                .S("cls", Win.ClassOf(h))
                .Raw("rect", "[" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "]")
                .ToString();
        }
        catch { return "null"; }
    }

    /// Operable controls around a point, for a click that landed just beside
    /// what it was meant for. Hit-tests a small set of rings rather than
    /// walking a whole tree, which in a browser can be thousands of nodes.
    public static string Near(int x, int y, int radius)
    {
        // No wait here: Near is already the fallback, and a tree that is still
        // being built will simply be found on the next look rather than
        // holding this one up.
        Wake(RootAt(x, y));

        var found = new Dictionary<string, string>();
        var dist = new Dictionary<string, double>();
        var sw = Stopwatch.StartNew();
        var origin = new System.Windows.Point(x, y);

        /* Whatever is found has to belong to the same window as the point.
           This looks outwards from where the model aimed, and a few pixels
           out in any direction can be a different window altogether — the
           one thing certain to be near every point is Halo's own island,
           which floats above everything by design. Without this, a click
           meant for a tab underneath could be pulled onto the island and
           pressed there, and one of the things on it is "Accept all".

           The rule is more general than that, and right for the same reason
           in every case: the model aimed at what it could see, and what it
           could see is the window on top at that point. Nothing in a window
           behind it, and nothing in a window floating over it, is what was
           meant. */
        IntPtr ownWindow = RootAt(x, y);

        var samples = new List<System.Windows.Point> { origin };
        int[] fractions = { 3, 2, 1 };
        foreach (int f in fractions)
        {
            double rr = radius / (double)f;
            for (int k = 0; k < 8; k++)
            {
                double a = Math.PI * k / 4;
                samples.Add(new System.Windows.Point(x + (rr * Math.Cos(a)), y + (rr * Math.Sin(a))));
            }
        }

        foreach (var s in samples)
        {
            // A click is waiting on this. Closest rings first, so running out
            // of time drops the farthest guesses, which matter least.
            if (sw.ElapsedMilliseconds > 700) break;
            if (ownWindow != IntPtr.Zero && RootAt((int)Math.Round(s.X), (int)Math.Round(s.Y)) != ownWindow) continue;
            AutomationElement at;
            try { at = AutomationElement.FromPoint(s); } catch { continue; }
            if (at == null) continue;
            List<AutomationElement> chain;
            AutomationElement target;
            try { target = Resolve(at, s, out chain); } catch { continue; }
            if (target == null) continue;

            string key;
            try { key = string.Join(".", target.GetRuntimeId()); } catch { continue; }
            if (found.ContainsKey(key)) continue;

            System.Windows.Rect r;
            try { r = target.Current.BoundingRectangle; } catch { continue; }
            if (r.IsEmpty) continue;
            double dx = Math.Max(Math.Max(r.Left - x, 0), x - r.Right);
            double dy = Math.Max(Math.Max(r.Top - y, 0), y - r.Bottom);
            found[key] = Describe(target);
            dist[key] = Math.Sqrt((dx * dx) + (dy * dy));
        }

        var keys = new List<string>(found.Keys);
        keys.Sort((a, b) => dist[a].CompareTo(dist[b]));
        var arr = new StringBuilder("[");
        for (int i = 0; i < keys.Count; i++)
        {
            if (i > 0) arr.Append(',');
            string d = found[keys[i]];
            arr.Append(d.Substring(0, d.Length - 1)).Append(",\"distance\":").Append(Json.Num(dist[keys[i]])).Append('}');
        }
        arr.Append(']');
        return new Json().Raw("controls", arr.ToString()).N("ms", sw.ElapsedMilliseconds).ToString();
    }

    /// Named, operable controls inside a window, on screen: what a person
    /// could click there, with where each one is. Bounded in count and time,
    /// because a browser can hold thousands of nodes.
    public static string Elements(IntPtr hwnd, int max)
    {
        var sw = Stopwatch.StartNew();
        AutomationElement root = AutomationElement.FromHandle(hwnd);
        var arr = new StringBuilder("[");
        int n = 0;
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);
        var walker = TreeWalker.ControlViewWalker;
        while (queue.Count > 0 && n < max && sw.ElapsedMilliseconds < 4000)
        {
            var el = queue.Dequeue();
            try
            {
                var c = el.Current;
                string type = TypeName(el);
                var r = c.BoundingRectangle;
                if (el != root && !c.IsOffscreen && !r.IsEmpty && r.Width > 4 && r.Height > 4
                    && !string.IsNullOrEmpty(c.Name) && c.IsEnabled && Operable(el, type) && type != "Window")
                {
                    if (n++ > 0) arr.Append(',');
                    arr.Append(Describe(el));
                }
            }
            catch { }
            try
            {
                var child = walker.GetFirstChild(el);
                while (child != null)
                {
                    queue.Enqueue(child);
                    child = walker.GetNextSibling(child);
                }
            }
            catch { }
        }
        arr.Append(']');
        return new Json().Raw("elements", arr.ToString()).N("ms", sw.ElapsedMilliseconds).ToString();
    }

    /// The nearest thing under a point that can scroll, and how far it is
    /// scrolled — the difference between "I scrolled" and "I scrolled 40% of
    /// the way down a list that has since reached its end".
    public static string Scrollable(int x, int y)
    {
        var p = new System.Windows.Point(x, y);
        AutomationElement el = AutomationElement.FromPoint(p);
        var walker = TreeWalker.ControlViewWalker;
        for (int depth = 0; el != null && depth < 25; depth++)
        {
            try
            {
                if (Pattern(el, AutomationElement.IsScrollPatternAvailableProperty))
                {
                    var sp = (ScrollPattern)el.GetCurrentPattern(ScrollPattern.Pattern);
                    var c = sp.Current;
                    if (c.VerticallyScrollable || c.HorizontallyScrollable)
                    {
                        return new Json()
                            .B("found", true)
                            .S("type", TypeName(el))
                            .S("name", Trim(el.Current.Name, 80))
                            .Raw("rect", RectJson(el.Current.BoundingRectangle))
                            .B("vertical", c.VerticallyScrollable)
                            .N("v", c.VerticalScrollPercent)
                            .N("vsize", c.VerticalViewSize)
                            .B("horizontal", c.HorizontallyScrollable)
                            .N("h", c.HorizontalScrollPercent)
                            .N("hsize", c.HorizontalViewSize)
                            .ToString();
                    }
                }
            }
            catch { }
            try { el = walker.GetParent(el); } catch { el = null; }
        }
        return new Json().B("found", false).ToString();
    }
}

static class TopWindows
{
    public static string Describe(IntPtr h)
    {
        var r = Win.Bounds(h);
        long ex = Win.GetWindowLongPtr(h, Win.GWL_EXSTYLE).ToInt64();
        return new Json()
            .S("hwnd", h.ToInt64().ToString(CultureInfo.InvariantCulture))
            .S("title", Win.Title(h))
            .S("cls", Win.ClassOf(h))
            .S("process", Win.ProcessName(h))
            .Raw("rect", "[" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "]")
            .B("minimized", Win.IsIconic(h))
            .B("tool", (ex & Win.WS_EX_TOOLWINDOW) != 0)
            .ToString();
    }

    public static string Foreground()
    {
        IntPtr h = Win.GetForegroundWindow();
        if (h == IntPtr.Zero) return new Json().B("found", false).ToString();
        return Describe(h);
    }

    /// Visible, uncloaked top-level windows, front to back. Cloaked windows
    /// are the ones on other virtual desktops and suspended Store apps: there
    /// in the list, nowhere on the screen.
    public static string List()
    {
        var sb = new StringBuilder("[");
        int n = 0;
        for (IntPtr h = Win.GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = Win.GetWindow(h, Win.GW_HWNDNEXT))
        {
            if (!Win.IsWindowVisible(h) || Win.Cloaked(h)) continue;
            var r = Win.Bounds(h);
            if (r.Right - r.Left < 40 || r.Bottom - r.Top < 20) continue;
            if (Win.Title(h).Length == 0) continue;
            if (n++ > 0) sb.Append(',');
            sb.Append(Describe(h));
            if (n >= 60) break;
        }
        sb.Append(']');
        return new Json().Raw("windows", sb.ToString()).ToString();
    }

    /// Bring a window forward.
    ///
    /// Windows only lets the process the user is interacting with change the
    /// foreground, so a plain SetForegroundWindow from a helper flashes the
    /// taskbar button and does nothing. Borrowing the foreground thread's
    /// input state for the duration of the call is the documented way round
    /// that, and SwitchToThisWindow is the fallback Alt-Tab itself uses.
    public static string Focus(IntPtr h)
    {
        if (!Win.IsWindow(h)) return new Json().B("ok", false).S("error", "no such window").ToString();
        if (Win.IsIconic(h)) Win.ShowWindow(h, Win.SW_RESTORE);

        IntPtr fg = Win.GetForegroundWindow();
        if (fg != h)
        {
            uint pid;
            uint fgThread = Win.GetWindowThreadProcessId(fg, out pid);
            uint me = Win.GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && Win.AttachThreadInput(me, fgThread, true);
            try
            {
                Win.BringWindowToTop(h);
                Win.SetForegroundWindow(h);
            }
            finally
            {
                if (attached) Win.AttachThreadInput(me, fgThread, false);
            }
            if (Win.GetForegroundWindow() != h)
            {
                Win.SwitchToThisWindow(h, true);
                Thread.Sleep(60);
            }
        }
        bool ok = Win.GetForegroundWindow() == h;
        return new Json().B("ok", ok).S("fg", Win.GetForegroundWindow().ToInt64().ToString(CultureInfo.InvariantCulture)).ToString();
    }
}

static class Program
{
    static readonly object Out = new object();

    static void Reply(string id, string json)
    {
        lock (Out)
        {
            Console.Out.Write(id);
            Console.Out.Write(' ');
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    static int Int(string s) { return (int)Math.Round(double.Parse(s, CultureInfo.InvariantCulture)); }

    /// Run one accessibility question with a deadline, on a thread of its
    /// own, and answer either way.
    static void Deadline(string id, int ms, Func<string> work)
    {
        var t = new Thread(() =>
        {
            string answer;
            try { answer = work(); }
            catch (Exception e) { answer = new Json().S("error", e.GetType().Name + ": " + e.Message).ToString(); }
            Reply(id, answer);
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.MTA);
        var guard = new Thread(() =>
        {
            if (!t.Join(ms)) Reply(id, new Json().S("error", "timeout").ToString());
        });
        guard.IsBackground = true;
        t.Start();
        guard.Start();
    }

    static void Main()
    {
        // Before anything that measures anything. PER_MONITOR_AWARE_V2 is -4.
        try { if (!Win.SetProcessDpiAwarenessContext(new IntPtr(-4))) Win.SetProcessDPIAware(); }
        catch { try { Win.SetProcessDPIAware(); } catch { } }

        Console.OutputEncoding = new UTF8Encoding(false);
        Console.WriteLine("ready");
        Console.Out.Flush();

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] p = line.Trim().Split(' ');
            if (p.Length < 2) continue;
            string id = p[0];
            try
            {
                switch (p[1])
                {
                    case "ping":
                        Reply(id, new Json().B("ok", true).ToString());
                        break;
                    case "cursor":
                    {
                        Win.POINT c;
                        Win.GetCursorPos(out c);
                        Reply(id, new Json().N("x", c.X).N("y", c.Y).ToString());
                        break;
                    }
                    case "fg":
                        Reply(id, TopWindows.Foreground());
                        break;
                    case "focused":
                        Deadline(id, 1500, () => Sense.Focused());
                        break;
                    case "window":
                        Reply(id, Sense.WindowAt(Int(p[2]), Int(p[3])));
                        break;
                    // Asked for ahead of the first click, so the wait to build
                    // the tree happens while the plan is still being written
                    // rather than in front of the click that needs it.
                    case "wake":
                    {
                        bool asked = Sense.Wake(Sense.RootAt(Int(p[2]), Int(p[3])));
                        Reply(id, new Json().B("asked", asked).ToString());
                        break;
                    }
                    case "idle":
                        Reply(id, new Json().N("ms", Win.IdleMs()).ToString());
                        break;
                    case "desktop":
                    {
                        string name = Win.InputDesktop();
                        Reply(id, new Json().S("name", name).B("usable", name == "Default").ToString());
                        break;
                    }
                    case "windows":
                        Reply(id, TopWindows.List());
                        break;
                    case "focus":
                    {
                        var h = new IntPtr(long.Parse(p[2], CultureInfo.InvariantCulture));
                        Deadline(id, 1500, () => TopWindows.Focus(h));
                        break;
                    }
                    case "hit":
                    {
                        int x = Int(p[2]), y = Int(p[3]);
                        Deadline(id, 1500, () => Sense.Hit(x, y));
                        break;
                    }
                    case "near":
                    {
                        int x = Int(p[2]), y = Int(p[3]), r = Int(p[4]);
                        Deadline(id, 2500, () => Sense.Near(x, y, r));
                        break;
                    }
                    case "scrollable":
                    {
                        int x = Int(p[2]), y = Int(p[3]);
                        Deadline(id, 1500, () => Sense.Scrollable(x, y));
                        break;
                    }
                    case "elements":
                    {
                        var h = new IntPtr(long.Parse(p[2], CultureInfo.InvariantCulture));
                        int max = p.Length > 3 ? Int(p[3]) : 200;
                        Deadline(id, 5000, () => Sense.Elements(h, max));
                        break;
                    }
                    default:
                        Reply(id, new Json().S("error", "unknown command").ToString());
                        break;
                }
            }
            catch (Exception e)
            {
                Reply(id, new Json().S("error", e.GetType().Name + ": " + e.Message).ToString());
            }
        }
    }
}
