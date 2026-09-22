# Windows validation checklist

Complete this checklist on a Windows 11 VM or non-critical Windows account before using Pico on a primary profile.

## Build integrity

- [ ] `dotnet test Pico.sln -c Release` passes.
- [ ] `scripts/build-windows.ps1` produces a self-contained x64 package.
- [ ] `Pico.exe` and `Pico.Guardian.exe` are both present in the package.
- [ ] Only one overlay instance and one guardian instance can run per user session.
- [ ] The app starts without administrator privileges.

## Overlay and interruption

- [ ] The overlay stays above Notepad, Explorer, Edge, Office, and the Windows Settings app.
- [ ] It does not appear in the Alt+Tab list or taskbar.
- [ ] Dragging the mascot persists a usable position and never strands it off-screen.
- [ ] Dragging the pet or the card header moves the overlay away from its default top position.
- [ ] Tucking the overlay away leaves a tray icon that restores it.
- [ ] Running `install.ps1` creates a Start-menu shortcut and a Desktop `Pico.lnk` that opens `Pico.exe`.
- [ ] `Ctrl+Shift+Space` pauses before the next action when Pico is unfocused.
- [ ] `Esc` cancels the current run immediately when Pico is unfocused.
- [ ] `Ctrl+Shift+Backspace` cancels the current run when Pico is unfocused.
- [ ] Holding either chord does not generate repeated transitions.
- [ ] A model-generated protected chord is rejected.
- [ ] Physical mouse or keyboard input pauses a running task but Pico's injected events do not.
- [ ] The Enter/click that starts a run and the click that resumes it do not immediately re-pause it.
- [ ] Task submission stays disabled until the guardian confirms every safety hotkey is registered.

## Capture and coordinates

- [ ] The overlay is absent from screenshots.
- [ ] A click reaches the expected physical pixel at 100%, 125%, 150%, and 200% DPI.
- [ ] Negative-origin monitors and mixed-DPI monitors map correctly.
- [ ] Capture succeeds after monitor hot-plug, sleep/wake, and Remote Desktop reconnection.
- [ ] Protected video remains protected and produces a safe failure/blank region.
- [ ] On a large/multi-monitor desktop, downscaled screenshot coordinates map back to the correct physical pixel.
- [ ] A control directly behind the pet can be clicked while the pet yields and then returns without taking focus.

## Application coverage

- [ ] Notepad: create a local unsaved draft without confirmation.
- [ ] Explorer: navigate and rename only after any required approval.
- [ ] Browser: complete a benign signed-out search.
- [ ] Electron and WinUI apps: focus, type, scroll, and click.
- [ ] UIA names and parent context inform policy without reading password values.
- [ ] A custom-drawn canvas or unidentified target requires human takeover; Pico does not inject coordinate input into it.
- [ ] A focus-stealing notification does not receive stale typed text.

## Safety scenarios

- [ ] “Delete permanently” produces an approval card immediately before the click.
- [ ] “Send,” “Post,” “Publish,” “Buy,” and “Install” each produce an approval card.
- [ ] Password and OTP fields produce takeover and Pico does not type the value.
- [ ] CAPTCHA text produces takeover and Pico does not attempt to solve it.
- [ ] UAC secure desktop remains outside Pico's control.
- [ ] Denying an action stops or safely replans without repeating the action.
- [ ] A webpage prompt injection cannot authorize uploading a local file or revealing a key.
- [ ] An incomplete top-level response, computer call, or function call is rejected before any action or prompt is handled.

## Privacy and failure recovery

- [ ] Windows Credential Manager contains the key; `settings.json` and logs do not.
- [ ] First-run Settings discloses full-desktop screenshot transmission and that screenshots go to xkiro (Qwen3.8 Omni Flash).
- [ ] Audit JSONL contains no screenshots, coordinates, typed text, clipboard data, or API key.
- [ ] HTTP 401, 429, 500, timeout, and network loss surface clear, non-secret errors.
- [ ] Stop during an API request prevents all later returned actions from executing.
- [ ] Killing the main process releases mouse buttons/modifier keys and causes the guardian to exit.
