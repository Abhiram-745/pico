# Halo bridge

Lets a paired phone drive Halo on your laptop, over your own Wi-Fi.

```bash
node bridge/server.mjs
```

A QR code and an 8-character pairing code appear in the terminal. Scan the code with your phone — on the same network — and it pairs itself.

| URL | What |
| --- | --- |
| `http://<your-lan-ip>:4177/` | Phone app |

Set `PICO_BRIDGE_PORT` to use a different port.

No dependencies. The WebSocket server and the QR encoder are both implemented here — a remote-control surface is the last place to inherit an unaudited dependency tree.

---

## Security posture

**Local network only.** The server binds to your LAN so a phone can reach it, and rejects any connection whose remote address is outside a private range (RFC1918, loopback, link-local, IPv6 ULA). There is no relay, no account, and nothing is exposed to the internet. If you want access from outside your network, put it behind something that does its own authentication — Tailscale or a Cloudflare Tunnel — rather than port-forwarding it.

**Pairing.** A phone must present the pairing code shown on the laptop before it is issued a token. The code is regenerated every time the server starts, uses an alphabet with no ambiguous characters, and is compared in constant time. Wrong codes are rate limited: five failures from an address triggers a 60-second lockout. An unpaired socket is dropped after 30 seconds.

**Loopback is auto-paired.** Anyone already on the laptop can drive Halo directly, so requiring a code from `127.0.0.1` would be theatre.

**Commands are allowlisted.** Anything outside `ALLOWED_COMMANDS` is dropped and logged. Task text is length-capped. `approve`, `deny`, and `takeoverDone` must name the exact pending decision, so a phone that has been asleep cannot answer a question it never saw.

**The phone is you, not a new authority.** It can answer an approval or a takeover; it can never skip one. Every safety boundary in [SAFETY.md](../SAFETY.md) applies identically whether a task came from the laptop or the phone.

**Frames are bounded.** Messages over 256 KB are refused, fragmented frames are size-checked as they accumulate, and unmasked client frames are rejected per RFC 6455.

---

## Model provider

The bridge can call an LLM to turn a task into real steps instead of running a
scripted sequence. It speaks the OpenAI-compatible API, and is configured for
[BazaarLink](https://bazaarlink.ai):

```bash
cp .env.example .env      # then paste your key
node bridge/server.mjs
```

```
BAZAARLINK_API_KEY=sk-bl-...
BAZAARLINK_BASE_URL=https://api.bazaarlink.ai/v1
PICO_MODEL=auto:free
```

Without a key the bridge still runs, using the scripted scenarios — the UI is
always demonstrable.

**The key never leaves the laptop.** It is read from `.env` by
`bridge/llm.mjs`, used server-side, and scrubbed from any error text by
`redact()` before it can reach a log or a client. The phone receives the
resulting steps and nothing else. `.env` is gitignored; `.env.example` is the
committed template. Never import `llm.mjs` from anything under `phone/` or
`pico-ui/` — those run in a browser, where any key is readable.

### What it cannot do

BazaarLink does **not** support the Responses API `computer_use_preview` tool —
verified, it returns `400 The model service rejected the request parameters`.
That tool is what returns structured click/type/screenshot actions, and it is
the thing Halo's desktop loop is built on. So BazaarLink can plan and summarise,
but it cannot drive the mouse and keyboard. Actually controlling the desktop
still needs a model with the computer tool.

Free-tier keys are limited to 20 requests a minute; `llm.mjs` self-throttles to
stay under that. Free routing lands on reasoning models that spend most of the
token budget thinking, so the client retries once with a larger budget when
`content` comes back empty.

---

## Message contract

Identical to the one the WebView2 host implements — see [`pico-ui/INTEGRATION.md`](../pico-ui/INTEGRATION.md). The bridge is a fan-out hub: it keeps a snapshot of host state, replays it to every client on connect so a phone joining mid-task is not staring at a blank screen, and broadcasts every subsequent change.

```
  phone ──┐
          ├── bridge/server.mjs ── host
 laptop ──┘
```

Today the host is the mock agent in `pico-ui/mock/agent.js`, which is what makes the whole thing runnable without the Windows app. Swapping in the real one means replacing that single import with a connection to `Halo.Desktop`.

---

## Files

| File | Role |
| --- | --- |
| `server.mjs` | HTTP + WebSocket, pairing, allowlist, static serving |
| `ws.mjs` | RFC 6455 server — text frames, ping/pong, fragmentation, close |
| `qr.mjs` | QR encoder, byte mode, EC level L, versions 1–5. Renders to a terminal or to SVG |
| `llm.mjs` | BazaarLink client — planning and summaries. Reads `.env`; never client-facing |
