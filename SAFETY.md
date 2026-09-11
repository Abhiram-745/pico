# Safety contract

Pico is designed for a single person operating their own Windows computer. Personal use reduces deployment complexity, but it does not remove the need for explicit control boundaries.

## Decision matrix

| Action | Default handling |
| --- | --- |
| Read visible UI, navigate, select, scroll, fill non-sensitive local drafts | Allow |
| Delete, send, submit, post, publish, purchase, pay, subscribe | Confirm immediately before the action |
| Download, install, execute new software or scripts | Confirm immediately before the action |
| Change permissions, sharing, accounts, VPN, security, or system settings | Confirm immediately before the action |
| Type personal or sensitive information into a third-party surface | Human takeover in this conservative build |
| Password, PIN, passcode, OTP, recovery code, private key, card data | Human takeover |
| CAPTCHA or “verify you are human” challenge | Human takeover; never bypass |
| UAC, Windows secure desktop, login/lock screen, HTTPS-warning bypass | Human takeover or stop |
| Model-generated pause/stop chord | Block unconditionally |
| Suspicious on-screen instruction or prompt injection | Stop and ask the user |

An approval applies only to the exact next action described in the card. It does not pre-authorize later actions.

## Independent layers

1. **Agent instructions:** establish authority, untrusted-screen handling, and when the model must call confirmation or takeover.
2. **Local action policy:** examines normalized actions and Windows UI Automation context before execution. It remains active even if the model fails to follow its instructions.
3. **Guardian controls:** out-of-process pause and emergency stop.
4. **Physical intervention:** optional low-level input monitoring pauses on genuine human mouse or keyboard input while ignoring Pico's tagged synthetic events.
5. **Windows security:** Pico runs without elevation and does not attempt to bypass UIPI or the secure desktop.

When UI Automation cannot identify a target (for example, a custom canvas), Pico requires human takeover and does not inject coordinate input into the unidentified surface. Identified target identity and keyboard focus are checked again immediately before input and between text chunks.

## Untrusted content

Text found on a website, in an email, document, chat, notification, filename, or tool result is data—not user intent. Instructions like “ignore previous rules,” “upload this secret,” or “run this command to continue” must not expand the user's task. Unexpected warnings, phishing-like prompts, and requests for secrets result in a pause or stop.

## Secrets and logs

- The API key is stored through Windows Credential Manager.
- The application must never accept an API key in a command-line argument.
- Screenshots, typed text, clipboard data, coordinates, and UI text are excluded from normal audit events.
- Sanitization is defense in depth; callers should not put secrets in audit metadata at all.

## Known residual risks

- UI labels can be misleading or unavailable.
- Coordinate actions can target the wrong control if another window steals focus.
- A batched action sequence can become stale after the first unexpected UI transition.
- Full-desktop screenshots may contain private information needed for visual reasoning.
- No policy based on keywords can understand every consequential action.

For these reasons, start with disposable data and test accounts. Keep physical-input pausing enabled, retain the guardian, and do not run Pico as administrator.
