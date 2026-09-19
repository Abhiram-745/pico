# Halo

Halo is a Windows-first personal computer-use agent with a floating companion instead of a normal application window. It can observe the active desktop, carry out mouse and keyboard actions, pause for consequential decisions, and hand control back for credentials, CAPTCHAs, UAC, or other human-only steps.

**[Download the latest release](https://github.com/Abhiram-745/pico/releases/latest)** · **[Website](https://blurt-ai.me/pico/)**

This repository is an early personal-use build. It is deliberately conservative around sensitive and irreversible actions.

---

## What's here

| Folder | What it is |
| --- | --- |
| [`pico-ui/`](pico-ui/) | The interface: floating companion, `Ctrl+Shift+P` command palette, approval and takeover cards, live activity timeline |
| [`phone/`](phone/) | The phone companion — an installable web app that pairs with your laptop over Wi-Fi |
| [`bridge/`](bridge/) | The LAN server that connects the two. Zero dependencies |
| [`docs/`](docs/) | The website |

The current build runs on Node.js and starts from `Start Halo.cmd`. The older compiled interface (`Halo.exe`, `Halo.Guardian.exe`, ~350 MB together, far past what git should carry) still ships attached to numbered/tagged [releases](https://github.com/Abhiram-745/pico/releases/latest) for anyone who prefers it.

---

## Use it

1. Download [`Halo-Setup.exe`](https://github.com/Abhiram-745/pico/releases/latest/download/Halo-Setup.exe) and run it. It's a normal Windows installer — pick a folder, it installs, adds Start-menu and Desktop shortcuts, and offers to launch Halo. On first run it asks for your OpenAI key — it goes to Windows Credential Manager, not a JSON file.
2. Press **`Ctrl+Shift+P`**, type a narrowly scoped task, press Enter.
3. Review the orange approval cards before external, destructive, installation, account, or financial actions.
4. Complete credentials, CAPTCHAs, UAC, and secure-desktop steps yourself when Halo asks.

Prefer a portable copy with nothing installed? Download and unzip [`Halo-latest.zip`](https://github.com/Abhiram-745/pico/releases/latest) instead, then double-click `Start Halo.cmd` — no installer, no shortcuts, run it from wherever you unzipped it.

This personal build is not code-signed, so Windows SmartScreen may show an unknown-publisher warning. Verify the package hash before running it; do not weaken SmartScreen globally.

### Shortcuts

| Shortcut | Effect |
| --- | --- |
| `Ctrl+Shift+P` | Open or close the command palette |
| `Ctrl+Shift+Space` | Pause or resume before the next action |
| `Esc` | Emergency-stop the current run immediately |
| `Ctrl+Shift+Backspace` | Emergency-stop the current run |

The pause and stop shortcuts are registered by `Halo.Guardian.exe`, not by the model-facing process. Halo refuses to start a task until the guardian confirms every safety hotkey is registered. The action injector also refuses to synthesize those protected keys and chords — including `Ctrl+Shift+P`, so the model cannot summon Halo's own interface.

---

## Control it from your phone

Start the bridge on your laptop:

```bash
node bridge/server.mjs
```

A QR code appears in the terminal with a pairing code beneath it. Scan it with your phone on the same Wi-Fi and the phone app opens and pairs itself. Add it to your home screen: on iPhone that gives you a real standalone app, and on Android an icon that opens Halo straight away. (Chrome reserves its full *Install* for sites on trusted HTTPS, which a local address cannot have — [the phone guide](https://blurt-ai.me/pico/phone.html) covers the difference.)

From your phone you can send tasks, watch what Halo is doing step by step, pause or stop it, and answer approvals and takeovers.

**Your phone talks to your laptop directly.** The bridge binds to your local network and refuses any connection from outside a private address range. There is no relay server, no account, and nothing is exposed to the internet. See [`bridge/README.md`](bridge/README.md) for the full security posture.

The phone is you, so it can *answer* an approval — it can never skip one.

---

## Model provider

The Windows app talks to OpenAI directly and stores its key in Windows
Credential Manager. The **bridge** is separate, and can use any
OpenAI-compatible gateway — it ships configured for
[BazaarLink](https://bazaarlink.ai):

```bash
cp .env.example .env      # paste your key, then start the bridge
```

Keys live in `.env`, which is gitignored and read only by `bridge/llm.mjs` on
your own machine. Nothing is ever embedded in a page or sent to the phone.

Note that BazaarLink cannot drive the desktop loop: it does not support the
Responses API `computer_use_preview` tool. It plans and summarises; moving the
mouse still needs a model with the computer tool. See
[`bridge/README.md`](bridge/README.md).

---

## Build

Requirements:

- Windows 10 version 2004 or newer, or Windows 11, x64.
- PowerShell 7 or Windows PowerShell 5.1.
- .NET 8 SDK when building from source. The packaged application is self-contained.
- An OpenAI API key with access to a current model that supports the Responses API computer tool.
- Node 18+ only if you want the phone bridge.

```powershell
./scripts/build-windows.ps1
```

The model field accepts custom API model IDs. Use a model that explicitly supports **Computer use** in the [official OpenAI model list](https://developers.openai.com/api/docs/models). GPT-5 nano and GPT-5.4 nano are text/image models and currently do not support computer use; GPT-5.6, GPT-5.4 mini, and `computer-use-preview` are examples of compatible choices.

---

## Privacy and OpenAI data retention

During a task, Halo sends bounded full-desktop screenshots of all attached displays to OpenAI through the Responses API. Halo keeps the local screenshot bytes in memory only long enough to send the request and does not write them to its audit log. Responses API application state may be retained according to your OpenAI organization and project data-control settings; OpenAI currently documents at least 30 days of retention by default. Review [OpenAI's API data controls](https://developers.openai.com/api/docs/guides/your-data) before using Halo with sensitive information.

Halo has no publisher upload, telemetry, cloud relay, or automatic web-deployment path. Its only intentional network traffic is the HTTPS Responses API request required for a task, plus — if you start it — the bridge, which stays on your own network.

---

## Security model

Halo treats websites, documents, emails, chats, filenames, notifications, and all other screen content as untrusted input. Only the task entered directly by the user provides authority. A local policy independently checks each action even when the model fails to request confirmation.

Halo does not automate CAPTCHA solving or bypass Windows security boundaries. See [SAFETY.md](SAFETY.md) for the full action matrix.

The activity timeline renders an allowlist of fields, never the raw audit record — typed text, coordinates, and screenshots cannot reach the interface even if a host sends them.

---

## Platform limits

- Halo cannot inject input into the Windows secure desktop, login screen, or `Ctrl+Alt+Delete` screen.
- A normal-integrity process cannot reliably control a higher-integrity application because of Windows UIPI.
- Protected media and some exclusive full-screen applications may not appear in captures.
- Custom canvas, game, and remote-desktop controls that UI Automation cannot identify require direct human takeover in this build.
- A model can still make mistakes. The guardian, per-action policy, and human approval boundary reduce risk; they do not make arbitrary desktop automation infallible.

---

## Development

```powershell
dotnet restore Halo.sln
dotnet test Halo.sln -c Release
dotnet build Halo.sln -c Release
```

Interface work does not need the .NET SDK — see [`pico-ui/README.md`](pico-ui/README.md) to run it standalone, and [`pico-ui/INTEGRATION.md`](pico-ui/INTEGRATION.md) for the WebView2 host contract.

Native behavior must be smoke-tested on Windows. Follow [WINDOWS-TEST.md](WINDOWS-TEST.md) before trusting a new build with real accounts or data.

---

## Acknowledgements

Two mechanisms in the desktop loop are adapted from
[Agent-S](https://github.com/simular-ai/Agent-S) by Simular AI, used under the
Apache License 2.0:

- **Checked answers with an in-turn re-ask.** A model's answer is validated
  before the turn returns, and a failed check goes back to it with the
  specific complaint attached rather than costing a round trip to discover.
  After `call_llm_formatted` and `formatters.py`.
- **A text buffer the agent writes to and is shown every turn**, for things a
  later step needs that the screen will no longer show. After the grounding
  agent's `notes` and `save_to_knowledge`.

No Agent-S source is included; both are reimplementations against Halo's own
tools, screen layer and accessibility grounding.
