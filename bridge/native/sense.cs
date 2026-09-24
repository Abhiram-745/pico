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
//    <id> composer <hwnd>        the box a chat app is typed into, and the
//                                send/stop buttons beside it
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
    [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
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

    /// Form controls worth keeping without a name (see look): the role and
    /// the value say what they are.
    static readonly HashSet<string> UNNAMED_OK = new HashSet<string>
    {
        "ComboBox", "CheckBox", "RadioButton", "Edit", "Slider", "Spinner",
    };

    /// Controls where the exact point matters more than the middle: a caret
    /// goes where it is put, a slider moves to where it is pressed.
    static readonly HashSet<string> POSITIONAL = new HashSet<string>
    {
        "Edit", "Document", "Slider", "ScrollBar", "Text", "Custom",
    };

    public static string TypeName(AutomationElement el)
    {
        try { return TypeName(el.Current.ControlType); }
        catch { return ""; }
    }

    /// The same, from a control type already in hand — a cached read has one
    /// and asking the element again would be the round trip the cache exists
    /// to avoid.
    public static string TypeName(ControlType t)
    {
        try
        {
            string n = t.ProgrammaticName;
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

    /// Can text be put into this, whether or not it can be clicked?
    ///
    /// Kept apart from Operable on purpose. Operable decides what a click
    /// snaps to, and a document is the whole window: snapping to the middle
    /// of one would move every click in a text editor to its centre. This
    /// only decides what appears in the list of controls, where a field the
    /// caller can type into is exactly what was missing — Elements() used to
    /// return every button in Notepad and not the page you write on.
    /// What a dropdown holds, and what it is showing now.
    ///
    /// A native select is one control with a list inside it. Halo's element
    /// list is flat, so the options would otherwise be invisible until the
    /// list was open — and the run would have to click the box, look again,
    /// and click the row, spending three turns on one choice. Where the
    /// options are in the tree already they come out with the box.
    ///
    /// Read through the ControlView walker rather than a FindAll, which on
    /// a large list is the difference between a few milliseconds and a
    /// second. Capped, because a country list is 200 rows and a decision
    /// made from 200 rows is not a decision anybody wants to read.
    static string Options(AutomationElement el)
    {
        var sb = new StringBuilder("[");
        int n = 0;
        try
        {
            var walker = TreeWalker.ControlViewWalker;
            var child = walker.GetFirstChild(el);
            while (child != null && n < 40)
            {
                string name = "";
                bool selected = false;
                try
                {
                    name = Trim(child.Current.Name, 80);
                    if (Pattern(child, AutomationElement.IsSelectionItemPatternAvailableProperty))
                    {
                        var si = (SelectionItemPattern)child.GetCurrentPattern(SelectionItemPattern.Pattern);
                        selected = si.Current.IsSelected;
                    }
                }
                catch { }
                if (name.Length > 0)
                {
                    // The rectangle comes with it: the option is chosen by
                    // clicking it, like a person does, so the point has to
                    // travel with the label.
                    string rect = "null";
                    try { rect = RectJson(child.Current.BoundingRectangle); } catch { }
                    if (n++ > 0) sb.Append(',');
                    sb.Append("{\"label\":").Append(Json.Str(name))
                      .Append(",\"rect\":").Append(rect)
                      .Append(",\"selected\":").Append(selected ? "true" : "false").Append('}');
                }
                child = walker.GetNextSibling(child);
            }
        }
        catch { }
        sb.Append(']');
        return n > 0 ? sb.ToString() : null;
    }

    static bool Editable(AutomationElement el, string type)
    {
        if (type == "Document" || type == "Edit" || type == "ComboBox") return true;
        return Pattern(el, AutomationElement.IsValuePatternAvailableProperty);
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
            if (type == "ComboBox" || type == "List")
            {
                string opts = Options(el);
                if (opts != null) j.Raw("options", opts);
            }
            string how = Pattern(el, AutomationElement.IsInvokePatternAvailableProperty) ? "invoke"
                : Pattern(el, AutomationElement.IsTogglePatternAvailableProperty) ? "toggle"
                : Pattern(el, AutomationElement.IsSelectionItemPatternAvailableProperty) ? "select"
                : Pattern(el, AutomationElement.IsExpandCollapsePatternAvailableProperty) ? "expand"
                : Pattern(el, AutomationElement.IsValuePatternAvailableProperty) ? "value"
                : "";
            if (how.Length > 0) j.S("how", how);
            try { j.S("runtimeId", string.Join(".", el.GetRuntimeId())); } catch { }
            try {
                if (Pattern(el, AutomationElement.IsValuePatternAvailableProperty)) {
                    var value = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
                    j.B("readOnly", value.Current.IsReadOnly);
                    if (!c.IsPassword) j.S("value", Trim(value.Current.Value, 200));
                }
            } catch { }
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

    /// Is this element the one you would actually hit at its own centre?
    ///
    /// The element list says where every control is; it does not say what is
    /// in front of them. A dialog leaves everything behind it listed, at its
    /// old rectangle, looking perfectly clickable — and a click on one lands
    /// on the dialog.
    ///
    /// Rectangles alone cannot answer this: the thing found at the point may
    /// be a child of the control (still the control) or a panel covering it
    /// (not the control), and both can contain the same point. So the answer
    /// comes from the tree — walk up from whatever is at the point and see
    /// whether this element is on that chain. Unknown counts as visible: a
    /// control is never hidden from the run on a guess.
    static bool OnTop(AutomationElement el, System.Windows.Rect r)
    {
        try
        {
            var p = new System.Windows.Point(r.Left + (r.Width / 2), r.Top + (r.Height / 2));
            var at = AutomationElement.FromPoint(p);
            if (at == null) return true;
            var walker = TreeWalker.ControlViewWalker;
            var found = at;
            for (int i = 0; i < 8 && at != null; i++)
            {
                if (Automation.Compare(at, el)) return true;
                at = walker.GetParent(at);
            }
            /* Something else answered. Whether that means "covered" depends
               on what answered: a named control genuinely is in front, while
               an anonymous Pane is what a window hands back when it does not
               hit-test its own contents. Measured: every button on Notepad's
               toolbar resolves to an unnamed Pane, and calling those covered
               would take the whole toolbar away from the run. So a nameless
               answer is treated as no answer. */
            string over = "";
            try { over = found.Current.Name ?? ""; } catch { }
            return over.Trim().Length == 0;
        }
        catch { return true; }
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
    /// Ask a window to build its accessibility tree.
    ///
    /// Remembered per window, because the ask is slow and pointless twice —
    /// except after the page inside it changes, which throws the tree away
    /// and builds a new one only when something asks again. `force` is for
    /// that case: measured, a Wikipedia article opened by a search answered
    /// with zero controls, and every re-ask was silently dropped here
    /// because the window had been woken once already an hour before.
    public static bool Wake(IntPtr root, bool force = false)
    {
        if (root == IntPtr.Zero) return false;
        long key = root.ToInt64();
        lock (Woken)
        {
            if (!force && Woken.Contains(key)) return false;
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

    // ----------------------------------------------------------------------
    //  The box a chat app is typed into
    //
    //  ChatGPT, Claude, Lovable, Discord, WhatsApp: the thing a person types
    //  into sits at the bottom of the window, across the middle, with a send
    //  button at its right-hand end that turns into a stop button while the
    //  reply is being written. Finding it by reading the whole window does not
    //  work where it matters most: measured on a ChatGPT window holding a long
    //  conversation, `elements` ran into its deadline and came back with
    //  nothing at all, because the tree was thousands of nodes of messages.
    //
    //  So this does not read the window. It asks what is under a handful of
    //  points near the bottom, walks up from each to the nearest text field,
    //  and then reads only the few dozen nodes around that field for its
    //  buttons. A few hit tests and a small walk, whatever the conversation
    //  above it holds.
    //
    //  The window has to be the one on top at those points — a hit test sees
    //  what a click would hit — so the caller brings it forward first.
    // ----------------------------------------------------------------------
    public static string Composer(IntPtr h)
    {
        var sw = Stopwatch.StartNew();
        if (!Win.IsWindow(h)) return new Json().B("found", false).S("error", "no such window").ToString();
        var b = Win.Bounds(h);
        int w = b.Right - b.Left;
        int ht = b.Bottom - b.Top;
        if (w < 160 || ht < 160) return new Json().B("found", false).S("error", "too small").ToString();
        if (Wake(h)) Thread.Sleep(260);

        // From the bottom up, across the middle first. Chat boxes grow upwards
        // as they fill, and sit in the conversation column — which in an app
        // with a sidebar is right of the window's own centre.
        int[] ups = { 52, 76, 100, 126, 156, 190, 230, 276, 330, 392, 462 };
        double[] across = { 0.55, 0.45, 0.66, 0.34, 0.76 };
        AutomationElement field = null;
        for (int i = 0; i < ups.Length && field == null; i++)
        {
            foreach (double f in across)
            {
                if (sw.ElapsedMilliseconds > 1300) break;
                int x = b.Left + (int)Math.Round(w * f);
                int y = b.Bottom - ups[i];
                if (y <= b.Top + 40) continue;
                if (RootAt(x, y) != h) continue;   // something else is over the window here
                AutomationElement at;
                try { at = AutomationElement.FromPoint(new System.Windows.Point(x, y)); } catch { continue; }
                if (at == null) continue;
                field = TextFieldAbove(at);
                if (field != null) break;
            }
        }
        if (field == null) return new Json().B("found", false).N("ms", sw.ElapsedMilliseconds).ToString();

        System.Windows.Rect fr;
        try { fr = field.Current.BoundingRectangle; } catch { fr = System.Windows.Rect.Empty; }
        var buttons = ButtonsAround(field, fr, sw);
        return new Json()
            .B("found", true)
            .Raw("field", Describe(field))
            .Raw("buttons", buttons)
            .N("ms", sw.ElapsedMilliseconds)
            .ToString();
    }

    /// The nearest text field at or above an element: what a click at the
    /// point would put the caret in. A read-only document — a web page's own
    /// root, which is focusable and has a value, its address — is not one.
    static AutomationElement TextFieldAbove(AutomationElement at)
    {
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement el = at;
        for (int depth = 0; el != null && depth < 8; depth++)
        {
            try
            {
                var c = el.Current;
                string type = TypeName(el);
                if (type == "Window") return null;
                var r = c.BoundingRectangle;
                if (c.IsEnabled && !c.IsPassword && !r.IsEmpty && r.Width >= 80 && r.Height >= 14)
                {
                    bool writable = false;
                    if (Pattern(el, AutomationElement.IsValuePatternAvailableProperty))
                    {
                        try { writable = !((ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern)).Current.IsReadOnly; }
                        catch { }
                    }
                    if (type == "Edit" && (c.IsKeyboardFocusable || writable)) return el;
                    if (writable && c.IsKeyboardFocusable && type != "ComboBox" && type != "Spinner") return el;
                }
            }
            catch { }
            try { el = walker.GetParent(el); } catch { el = null; }
        }
        return null;
    }

    /// The buttons that belong to a chat box: send, stop, attach, voice.
    /// Read from the field's own surroundings, a level or four up, and kept
    /// to the band of the screen the box is in — a send button is beside the
    /// box, not in the message above it.
    static string ButtonsAround(AutomationElement field, System.Windows.Rect fr, Stopwatch sw)
    {
        var arr = new StringBuilder("[");
        int n = 0;
        var seen = new HashSet<string>();
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement scope = field;
        double top = fr.IsEmpty ? double.MinValue : fr.Top - 90;
        double bottom = fr.IsEmpty ? double.MaxValue : fr.Bottom + 90;
        for (int up = 0; up < 5 && scope != null && sw.ElapsedMilliseconds < 1900; up++)
        {
            try { scope = walker.GetParent(scope); } catch { scope = null; }
            if (scope == null) break;
            try { if (TypeName(scope) == "Window") break; } catch { break; }

            var queue = new Queue<KeyValuePair<AutomationElement, int>>();
            queue.Enqueue(new KeyValuePair<AutomationElement, int>(scope, 0));
            int visited = 0;
            while (queue.Count > 0 && visited < 140 && sw.ElapsedMilliseconds < 1900)
            {
                var pair = queue.Dequeue();
                var node = pair.Key;
                visited++;
                try
                {
                    var c = node.Current;
                    var r = c.BoundingRectangle;
                    if (!r.IsEmpty && r.Bottom >= top && r.Top <= bottom && TypeName(node) == "Button" && !c.IsOffscreen)
                    {
                        string key = string.Join(".", node.GetRuntimeId());
                        if (seen.Add(key))
                        {
                            if (n++ > 0) arr.Append(',');
                            arr.Append(new Json()
                                .S("name", Trim(c.Name, 80))
                                .S("id", Trim(c.AutomationId, 60))
                                .Raw("rect", RectJson(r))
                                .B("enabled", c.IsEnabled)
                                .ToString());
                        }
                    }
                }
                catch { }
                if (pair.Value >= 7) continue;
                try
                {
                    var child = walker.GetFirstChild(node);
                    while (child != null)
                    {
                        queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, pair.Value + 1));
                        child = walker.GetNextSibling(child);
                    }
                }
                catch { }
            }
            // The first level that holds a button is the box's own row. Going
            // further up only adds the page's furniture.
            if (n > 0) break;
        }
        arr.Append(']');
        return arr.ToString();
    }

    /// Named, operable controls inside a window, on screen: what a person
    /// could click there, with where each one is. Bounded in count and time,
    /// because a browser can hold thousands of nodes.
    /// Every property this reads, asked for once instead of one call each.
    ///
    /// UI Automation reads a property by talking to the other process, and
    /// the walk below reads about fifteen per control. On a browser page
    /// with a hundred controls that is fifteen hundred round trips, and it
    /// is the whole of why a snapshot of Wikipedia took two seconds while
    /// the same call on Notepad took two hundred milliseconds. A cache
    /// request fetches the lot in one go and every read afterwards is local.
    static CacheRequest ElementCache()
    {
        var cr = new CacheRequest();
        cr.TreeScope = TreeScope.Element | TreeScope.Subtree;
        cr.TreeFilter = Automation.ControlViewCondition;
        cr.AutomationElementMode = AutomationElementMode.None;
        foreach (var prop in new AutomationProperty[]
        {
            AutomationElement.NameProperty,
            AutomationElement.AutomationIdProperty,
            AutomationElement.RuntimeIdProperty,
            AutomationElement.IsPasswordProperty,
            AutomationElement.ClassNameProperty,
            AutomationElement.ControlTypeProperty,
            AutomationElement.BoundingRectangleProperty,
            AutomationElement.IsEnabledProperty,
            AutomationElement.IsOffscreenProperty,
            AutomationElement.IsKeyboardFocusableProperty,
            AutomationElement.IsInvokePatternAvailableProperty,
            AutomationElement.IsTogglePatternAvailableProperty,
            AutomationElement.IsSelectionItemPatternAvailableProperty,
            AutomationElement.IsExpandCollapsePatternAvailableProperty,
            AutomationElement.IsValuePatternAvailableProperty,
        }) cr.Add(prop);
        /* What is in the box, cached with everything else.
           Without it the table says a search field exists and not that it
           already contains what was asked for — and a run types into it
           again, and again: measured, thirteen times in a row before
           something else stopped it. */
        cr.Add(ValuePattern.ValueProperty);
        cr.Add(ValuePattern.IsReadOnlyProperty);
        // A slider's range, so a value can be reached by clicking the right
        // share of the way along it rather than by dragging a handle.
        cr.Add(RangeValuePattern.ValueProperty);
        cr.Add(RangeValuePattern.MinimumProperty);
        cr.Add(RangeValuePattern.MaximumProperty);
        cr.Add(TogglePattern.ToggleStateProperty);
        cr.Add(SelectionItemPattern.IsSelectedProperty);
        return cr;
    }

    public static string Elements(IntPtr hwnd, int max, bool ontop = false)
    {
        var sw = Stopwatch.StartNew();
        AutomationElement root = AutomationElement.FromHandle(hwnd);

        /* The quick way first: one request for the whole subtree with every
           property already in it. AutomationElementMode.None means the
           elements come back as data rather than as live references, which
           is what makes it one call — so anything needing a live element
           (the options inside a dropdown, a hit test) falls through to the
           walk below. */
        if (!ontop)
        {
            try
            {
                string quick = Cached(root, max, sw);
                if (quick != null) return quick;
            }
            catch { /* fall through to the walk */ }
        }
        var arr = new StringBuilder("[");
        int n = 0;
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);
        var walker = TreeWalker.ControlViewWalker;
        // Whatever the cached attempt already spent counts against this, so a
        // window that defeats both routes costs four seconds in total rather
        // than four on top of two.
        while (queue.Count > 0 && n < max && sw.ElapsedMilliseconds < 4000)
        {
            var el = queue.Dequeue();
            try
            {
                var c = el.Current;
                string type = TypeName(el);
                var r = c.BoundingRectangle;
                if (el != root && !c.IsOffscreen && !r.IsEmpty && r.Width > 4 && r.Height > 4
                    && (!string.IsNullOrEmpty(c.Name) || UNNAMED_OK.Contains(type)) && c.IsEnabled && type != "Window"
                    && (Operable(el, type) || Editable(el, type)))
                {
                    if (n++ > 0) arr.Append(',');
                    string one = Describe(el);
                    if (ontop)
                    {
                        // Spliced in rather than passed through Describe, which
                        // is shared with callers that have no point to test.
                        one = one.Substring(0, one.Length - 1) + ",\"ontop\":" + (OnTop(el, r) ? "true" : "false") + "}";
                    }
                    arr.Append(one);
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

    /// The same list, built from one cached request. Null when it comes back
    /// with nothing, so the caller can fall back to walking it live.
    static string Cached(AutomationElement root, int max, Stopwatch sw)
    {
        AutomationElementCollection all;
        using (ElementCache().Activate())
        {
            all = root.FindAll(TreeScope.Subtree, Condition.TrueCondition);
        }
        // An empty tree is a real answer — a window whose contents have not
        // been built yet has no controls, and walking it live to be told the
        // same thing again costs four seconds for nothing. Measured: a
        // Chrome window that had not been woken took six seconds to return
        // nothing twice.
        if (all == null) return null;

        var arr = new StringBuilder("[");
        /* What the window actually says, alongside what can be done to it.
           A table of controls tells a run where the buttons are and nothing
           about whether the job is finished: measured, a run that had the
           Alan Turing article open on screen went back to the search box
           because nothing it could see said the article was there. Headings
           and text, in the order they appear, are what answers that. */
        var words = new StringBuilder("[");
        int w = 0;
        int n = 0;
        /* Where the words are, as well as what they say, and the named
           regions that hold things: a card on a board is text, not a
           button, and the column it is dragged to is a group. Halo numbers
           these on the screenshot so a small model can say "that one"
           instead of guessing pixels. */
        var texts = new StringBuilder("[");
        int t = 0;
        var places = new StringBuilder("[");
        int pl = 0;
        foreach (AutomationElement el in all)
        {
            if (w < 40 || t < 60)
            {
                try
                {
                    var tc = el.Cached;
                    string tt = TypeName(tc.ControlType);
                    /* Text only. Buttons and links are already in the
                       control table, and taking them here filled the whole
                       quota with the browser's own furniture — Minimize,
                       Restore, Back, Reload — before reaching a word of the
                       page. */
                    if (w < 40 && tt == "Text" && !tc.IsOffscreen
                        && !string.IsNullOrEmpty(tc.Name) && tc.Name.Length > 2)
                    {
                        if (w++ > 0) words.Append(',');
                        words.Append(Json.Str(Trim(tc.Name, 90)));
                    }
                    if (tt == "Text" && t < 60 && !tc.IsOffscreen && !string.IsNullOrEmpty(tc.Name))
                    {
                        var tr = tc.BoundingRectangle;
                        if (!tr.IsEmpty && tr.Width > 4 && tr.Height > 4)
                        {
                            if (t++ > 0) texts.Append(',');
                            texts.Append(new Json().S("name", Trim(tc.Name, 90)).Raw("rect", RectJson(tr)).ToString());
                        }
                    }
                }
                catch { }
            }
            if (n >= max) continue;
            try
            {
                var c = el.Cached;
                string type = TypeName(c.ControlType);
                var r = c.BoundingRectangle;
                if (c.IsOffscreen || r.IsEmpty || r.Width <= 4 || r.Height <= 4) continue;
                /* A large picture with no name — a canvas, a map, a chart, a
                   game — is somewhere things are clicked that Windows cannot
                   describe. It is offered as a place, so it can be pointed at
                   as a whole and looked into closely (zoom.mjs). */
                if (string.IsNullOrEmpty(c.Name) && pl < 25 && (type == "Image" || type == "Custom")
                    && r.Width >= 150 && r.Height >= 120 && c.IsEnabled)
                {
                    if (pl++ > 0) places.Append(',');
                    places.Append(new Json().S("type", type).S("name", "(unnamed picture)").Raw("rect", RectJson(r)).ToString());
                    continue;
                }
                if (!c.IsEnabled || type == "Window") continue;
                /* Nameless is dropped, except a form control. On real pages
                   an unlabelled select or checkbox is common — measured on
                   two of them — and dropping it left nothing to number on
                   the screenshot, so the model guessed a pixel and clicked
                   the page behind it, turn after turn. Unnamed, it is still
                   "the dropdown showing Please select" or "the second
                   checkbox", which the marks can say. */
                if (string.IsNullOrEmpty(c.Name) && !UNNAMED_OK.Contains(type)) continue;

                bool operable = CLICKABLE.Contains(type)
                    || (bool)el.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)
                    || (bool)el.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)
                    || (bool)el.GetCachedPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty)
                    || (bool)el.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty);
                bool editable = type == "Document" || type == "Edit" || type == "ComboBox"
                    || (bool)el.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty);
                if (!operable && !editable)
                {
                    if (pl < 25 && (type == "Group" || type == "List" || type == "Pane" || type == "Custom"
                        || type == "Table" || type == "DataGrid" || type == "Tree"))
                    {
                        if (pl++ > 0) places.Append(',');
                        places.Append(new Json().S("type", type).S("name", Trim(c.Name, 90)).Raw("rect", RectJson(r)).ToString());
                    }
                    continue;
                }

                string how = (bool)el.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty) ? "invoke"
                    : (bool)el.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty) ? "toggle"
                    : (bool)el.GetCachedPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty) ? "select"
                    : (bool)el.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty) ? "expand"
                    : (bool)el.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty) ? "value"
                    : "";

                if (n++ > 0) arr.Append(',');
                var j = new Json()
                    .S("type", type)
                    .S("name", Trim(c.Name, 120))
                    .S("id", Trim(c.AutomationId, 60))
                    .S("cls", Trim(c.ClassName, 60))
                    .Raw("rect", RectJson(r))
                    .B("enabled", c.IsEnabled)
                    .B("offscreen", c.IsOffscreen)
                    .B("focusable", c.IsKeyboardFocusable)
                    .B("operable", operable)
                    .B("positional", POSITIONAL.Contains(type));
                if (how.Length > 0) j.S("how", how);
                try
                {
                    object v = el.GetCachedPropertyValue(ValuePattern.ValueProperty, true);
                    if (!c.IsPassword && v != null && v != AutomationElement.NotSupported) j.S("value", Trim(v.ToString(), 200));
                }
                catch { }
                try {
                    var ids = el.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty, true) as int[];
                    if (ids != null) j.S("runtimeId", string.Join(".", ids));
                } catch { }
                try {
                    object rv = el.GetCachedPropertyValue(RangeValuePattern.ValueProperty, true);
                    object rmin = el.GetCachedPropertyValue(RangeValuePattern.MinimumProperty, true);
                    object rmax = el.GetCachedPropertyValue(RangeValuePattern.MaximumProperty, true);
                    if (rv is double && rmin is double && rmax is double)
                        j.Raw("range", "[" + ((double)rmin).ToString(System.Globalization.CultureInfo.InvariantCulture) + "," + ((double)rmax).ToString(System.Globalization.CultureInfo.InvariantCulture) + "," + ((double)rv).ToString(System.Globalization.CultureInfo.InvariantCulture) + "]");
                } catch { }
                try {
                    object ro = el.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty, true);
                    if (ro is bool) j.B("readOnly", (bool)ro);
                } catch { }
                try {
                    object toggle = el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty, true);
                    if (toggle is ToggleState) j.B("checked", (ToggleState)toggle == ToggleState.On);
                } catch { }
                try
                {
                    object sel = el.GetCachedPropertyValue(SelectionItemPattern.IsSelectedProperty, true);
                    if (sel is bool) j.B("selected", (bool)sel);
                }
                catch { }
                arr.Append(j.ToString());
            }
            catch { }
        }
        arr.Append(']');
        words.Append(']');
        texts.Append(']');
        places.Append(']');
        return new Json()
            .Raw("elements", arr.ToString())
            .Raw("says", words.ToString())
            .Raw("texts", texts.ToString())
            .Raw("places", places.ToString())
            .N("ms", sw.ElapsedMilliseconds)
            .B("cached", true)
            .ToString();
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
                        bool asked = Sense.Wake(Sense.RootAt(Int(p[2]), Int(p[3])), p.Length > 4 && p[4] == "force");
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
                    /// Caps Lock and its friends, because a stuck one
                    /// silently inverts everything typed afterwards.
                    case "keystate":
                        Reply(id, new Json()
                            .B("caps", (Win.GetKeyState(0x14) & 1) != 0)
                            .B("num", (Win.GetKeyState(0x90) & 1) != 0)
                            .ToString());
                        break;
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
                    case "composer":
                    {
                        var h = new IntPtr(long.Parse(p[2], CultureInfo.InvariantCulture));
                        Deadline(id, 2600, () => Sense.Composer(h));
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
                        bool ontop = p.Length > 4 && p[4] == "ontop";
                        /* Short, because the caller has somewhere else to go.
                           Some pages simply do not answer UI Automation —
                           measured on a Wikipedia article that blocked every
                           call, including a plain hit test, for the full six
                           seconds. Six seconds of nothing is worse than a
                           second and a half and a screenshot. */
                        Deadline(id, 1500, () => Sense.Elements(h, max, ontop));
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
