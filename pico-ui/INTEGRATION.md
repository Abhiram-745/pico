# Hosting this UI in Halo (C# / WPF / WebView2)

This front-end is transport-agnostic. It runs today against a mock host in a
browser; to ship it, implement the message contract below in `Halo.Desktop`.

Nothing here changes the agent loop, the policy engine, or `Halo.Guardian.exe`.

---

## 1. Two windows, not one

The current build puts the entire UI in a single `OverlayWindow`. That window is
created with `WS_EX_NOACTIVATE`, which is correct for a desktop companion and
**fatal for a command palette**: a window that never activates can never receive
keyboard focus, so it can never host a text field.

The redesign therefore needs two top-level windows:

| Window | Content | Activatable | Extended style |
| --- | --- | --- | --- |
| `OverlayWindow` (existing) | `companion.html` | No | `WS_EX_NOACTIVATE \| WS_EX_TOOLWINDOW \| WS_EX_TOPMOST` |
| `PaletteWindow` (new) | `palette.html` | **Yes** | `WS_EX_TOOLWINDOW \| WS_EX_TOPMOST` |

`WS_EX_TOOLWINDOW` on both keeps them out of Alt+Tab and the taskbar, matching
the behaviour `WINDOWS-TEST.md` already checks for.

The palette should be centred on the monitor containing the cursor, hide on
deactivate, and restore focus to the previously foreground window when it
closes — otherwise dismissing it steals focus from whatever the agent is about
to act on.

---

## 2. Capture exclusion — required, not optional

> The overlay is excluded from screenshots. Coordinates are relative to the
> complete captured Windows virtual desktop.
> — Halo's own system prompt

`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` is already applied to
the overlay. **It must also be applied to `PaletteWindow`**, and the existing
startup guard that refuses to run when capture exclusion fails must cover both
HWNDs.

If the palette is not excluded:

- the agent screenshots its own UI and feeds it back to the model;
- an approval card describing a pending action becomes model-visible input,
  which is exactly the untrusted-content confusion the safety model is built to
  prevent.

Both windows must be excluded **before** the first capture, and the affinity
re-applied after any monitor hot-plug or session reconnect that recreates the
HWND.

---

## 3. Hotkey registration

`Halo.Guardian.exe` owns the safety chords and must keep owning them:

| Chord | Owner | Effect |
| --- | --- | --- |
| `Ctrl+Shift+Space` | Guardian | Pause / resume before the next action |
| `Esc` | Guardian | Emergency stop |
| `Ctrl+Shift+Backspace` | Guardian | Emergency stop |
| `Ctrl+Shift+P` | **`Halo.Desktop` (new)** | Toggle the palette |

The palette chord is *not* a safety hotkey, so it is registered by the desktop
process and its failure must not block task submission the way a missing
Guardian chord does. Register with `RegisterHotKey(hwnd, id, MOD_CONTROL | MOD_SHIFT, 0x50 /* VK_P */)`
and degrade gracefully: if another app already owns it, surface a settings
warning rather than refusing to start.

### Add `Ctrl+Shift+P` to the protected-chord list

The action injector already refuses to synthesize the Guardian chords. The
palette chord must join them. Otherwise a model-requested `keypress` can summon
Halo's own UI, and — combined with a screenshot — read state that is meant to be
outside the agent's view.

This mirrors the existing `WINDOWS-TEST.md` case *"A model-generated protected
chord is rejected."*

---

## 4. WebView2 setup

```csharp
await webView.EnsureCoreWebView2Async(env);

// The companion floats over the desktop; the page must not paint a ground.
webView.DefaultBackgroundColor = System.Drawing.Color.Transparent;

var s = webView.CoreWebView2.Settings;
s.AreDefaultContextMenusEnabled = false;
s.AreDevToolsEnabled            = false;   // true only in Debug
s.IsStatusBarEnabled            = false;
s.IsZoomControlEnabled          = false;
s.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+R / Ctrl+P must not reach the page

// Ship the UI as local files, not from disk paths the user can edit.
webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
    "pico.ui", uiFolder, CoreWebView2HostResourceAccessKind.DenyCors);

webView.CoreWebView2.Navigate("https://pico.ui/companion.html");
```

The UI never calls out to the network. A CSP of
`default-src 'self'; connect-src 'none'` is compatible with everything here and
is worth adding at the host level.

**Transparency caveat.** WebView2 honours a transparent background, but a
transparent WebView2 does not give you per-pixel hit-testing: the whole control
rectangle swallows the mouse. For the companion this matters, because
`WINDOWS-TEST.md` requires that *"a control directly behind the pet can be
clicked while the pet yields."* Two workable options:

1. **Keep the companion native** (recommended). Render the mascot in WPF and use
   WebView2 only for `palette.html`. The mascot rig in `src/mascot.js` is a
   direct translation target — the geometry constants at the top of that file
   are the measured asset coordinates.
2. Keep the companion in WebView2 and drive `SetWindowRgn` / a layered-window
   region from the mascot's current bounds, so clicks outside the character
   pass through.

---

## 5. Message contract

### Host → UI

`PostWebMessageAsJson(JsonSerializer.Serialize(new { type, payload }))`

| `type` | `payload` |
| --- | --- |
| `phase` | `{ phase }` — `Idle`, `Starting`, `Observing`, `Thinking`, `Acting`, `Paused`, `AwaitingApproval`, `AwaitingTakeover`, `Completed`, `Stopped`, `Failed` |
| `action` | `{ type, detail? }` — type ∈ `Screenshot`, `Click`, `Move`, `Drag`, `Scroll`, `Keypress`, `Type`, `Wait`, `Validate`. Omit `detail` to use the app's standard wording. |
| `approval` | `{ id, summary, target, risk: { level, decision, categories, reason } }` |
| `takeover` | `{ id, reason, appName }` |
| `pauseState` | `{ paused, source, blockedReason?, heldModifiers? }` |
| `guardian` | `{ ready }` |
| `settings` | `{ model, pauseOnPhysicalInput, maximumComputerTurns, hasApiKey }` |
| `auditEvent` | the sanitized audit record, verbatim |
| `error` | `{ title, message, recoverable }` |

`risk` fields use the policy's existing vocabulary unchanged — the observed
values in the real audit log are `level` ∈ `None`/`High`, `decision` ∈
`Allow`/`RequireConfirmation`, `categories` ∈ `None`/`ExternalCommunication`.
`reason` is rendered **verbatim**; do not pre-format or truncate it.

### UI → Host

`CoreWebView2.WebMessageReceived` → `{ command, payload }`

| `command` | `payload` | Notes |
| --- | --- | --- |
| `submitTask` | `{ text }` | Reject if the Guardian is not ready |
| `pause` / `resume` / `stop` | `{}` | |
| `approve` / `deny` | `{ id }` | **Must** match the pending approval id |
| `takeoverDone` | `{ id }` | Host takes a fresh observation afterwards |
| `saveSettings` | `{ model?, pauseOnPhysicalInput?, maximumComputerTurns?, apiKey? }` | `apiKey` present only when the user typed one |
| `tuckAway` | `{}` | Hide the overlay, leave the tray icon |
| `openPalette` / `closePalette` | `{}` | |
| `movePalette` | `{ x, y }` | |

**Treat every inbound message as untrusted.** Validate the command name against
an allowlist, bound `text` to the existing task length limit, and match
`approve`/`deny` ids against the single pending decision — never approve
"whatever is current". A renderer compromise must not be able to authorise an
action.

`apiKey` goes straight to Windows Credential Manager. It is never echoed back:
the UI only ever learns `hasApiKey`.

---

## 6. The held-modifier state

The real audit log contains this sequence:

```
11:24:37  resumed  (guardian-hotkey)
11:24:37  paused   (held-modifier)
11:24:40  resumed  (guardian-hotkey)
11:24:40  paused   (held-modifier)
11:24:42  resumed  (guardian-hotkey)
11:24:42  paused   (held-modifier)
11:24:43  resumed  (overlay)
```

Three resume presses, each immediately re-paused because `Ctrl+Shift` were still
physically down, with nothing on screen explaining it. The user escaped only by
clicking the overlay.

The host should now send:

```jsonc
{ "type": "pauseState",
  "payload": { "paused": true, "source": "held-modifier",
               "blockedReason": "modifier-held",
               "heldModifiers": ["ctrl", "shift"] } }
```

and push an updated `heldModifiers` array as each key comes up. The UI lights a
keycap per held modifier and extinguishes them one by one.

Two host-side changes make this fully correct:

1. Report `heldModifiers` from the existing low-level keyboard hook.
2. **Resume on modifier release** rather than requiring another chord press —
   once the user has asked to resume, the intent is unambiguous.

---

## 7. Additions to `WINDOWS-TEST.md`

```
- [ ] The palette window is absent from screenshots (WDA_EXCLUDEFROMCAPTURE).
- [ ] The palette does not appear in the Alt+Tab list or taskbar.
- [ ] Ctrl+Shift+P opens and closes the palette when Halo is unfocused.
- [ ] A model-generated Ctrl+Shift+P is rejected by the injector.
- [ ] Esc during an active run emergency-stops and does NOT close the palette.
- [ ] Esc with no run active closes the palette without stopping anything.
- [ ] Closing the palette returns focus to the previously foreground window.
- [ ] Holding Ctrl+Shift while resuming shows the held-modifier explainer.
- [ ] Releasing the modifiers resumes the run without a second chord press.
- [ ] The activity timeline never shows typed text, coordinates or screenshots.
- [ ] Palette text scales correctly at 100%, 125%, 150% and 200% DPI.
```

---

## 8. File map

| File | Role |
| --- | --- |
| `companion.html` | WebView2 target #1 — mascot surface |
| `palette.html` | WebView2 target #2 — command palette |
| `src/bridge.js` | The contract above; swap transport, nothing else changes |
| `src/store.js` | Phase machine + the app's real copy strings |
| `src/mascot.js` | Face rig; measured asset geometry at the top |
| `src/hotkeys.js` | In-page chord handling (host owns these in production) |
| `src/timeline.js` | Audit renderer + `assertSafeEvent` redaction guard |
| `index.html`, `src/harness.css`, `mock/` | Development only — do not ship |

`assets/pico.png` was extracted from `Halo.exe` at offset `10027263`
(1254×1254 RGBA) so the harness runs standalone. Replace it with the project's
own `src/Halo.Desktop/Assets/pico.png` when wiring this up.
