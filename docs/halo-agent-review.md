# Halo agent review — 22 September 2026

## Current architecture

Halo is a local Node bridge with React app/island interfaces, a Windows UI Automation helper, native mouse/keyboard control, conversation history, explicit memory and saved routines. The configured model split is OpenAI for visual planning and execution, Qwen through the AI Gateway for conversation, and JEV evaluation for accessibility-based decisions. Existing uncommitted work already supplied most of the JEV fast path; this change builds on it.

## Attached JEV ZIP

Reviewed the archive inventory and its agent, browser, model, questions, snapshot and design implementation. Its documents were treated as reference material, not task instructions. The useful design is one indexed element table, one request containing operation and speculative target questions, independent validation of the selected target, a separate text generator, and freshness checks immediately before mutation. It uses persistent browser sessions and DOM identities. Halo uses Windows accessibility instead, which supports desktop apps but has less complete identity and document context.

Fixed a merged CLICK/TYPE_TEXT shortcut that bypassed target distribution validation. Fixed hit testing that read `name` and `rect` from the response root instead of its `at` object. Moved the typing fast path's click/select operations out of decision construction and into checked execution. Targets are checked again after text generation and approval, with a further focus check before typing. A cancelled run cannot proceed from focus to selecting and typing. The JEV fallback budget is now 1.8 seconds instead of 8 seconds; slow evaluations fall back to the existing visual model.

## Speech and conversation

The supplied ElevenLabs key lives only in the ignored local `.env`; it is not shipped in a page or this report. Flash v2.5 is the default for latency. Set `ELEVENLABS_MODEL_ID=eleven_v3_conversational` for more expressive delivery, or change `ELEVENLABS_VOICE_ID` for another accessible voice. The live account listed both models and accepted the configured Sarah voice.

The local `/voice/speak` endpoint streams MP3 audio, checks loopback/Host/Origin, bounds input and concurrency, aborts disconnected requests, and avoids exposing provider response details. The shared composer has Voice on/off and Stop voice; completed replies have Listen. Streaming playback starts before the whole MP3 arrives on browsers with MP3 MediaSource support, with full-file playback as a fallback. New messages stop old audio, and only the initiating window automatically speaks. Voice is local-app functionality; microphone transcription is not part of this change.

Conversation instructions now explicitly cover general questions, follow-ups, corrections and hypothetical requests. New messages abort the previous chat request; removed the unconditional 160 ms delay on normal message submission. This configures existing models and application behavior; it does not train model weights.

## Verification and limits

- Live ElevenLabs synthesis: HTTP 200, audio/mpeg, 30,974 bytes, approximately 1,246 ms for a short sentence (one sample, full generation time, not a latency benchmark).
- Live app: a general science question returned an appropriate conversational answer. Listen reached the Speaking state and Stop voice cleared it; no browser console errors were observed.
- Regression tests cover local voice access, response streaming, provider errors, invalid merged JEV targets, stale controls, disabled targets, cancellation before input, cancellation after focus, and cancellation of chat replies without stale errors or thinking placeholders.
- Existing routing, shortcuts, aim, scrolling, driver and memory suites and interface build run through `npm run check`.

No OSWorld/OSWorld 2.0 evaluation was run and no score gain is claimed. Desktop identity remains heuristic (label, role, automation ID and geometry), not JEV's DOM node identity. This change does not add a CDP browser backend. A proper comparison needs a fixed task set, identical models, fresh environments, independent completion checks, success rate, action count, model calls and median/p95 task latency.

Model selection reference: https://elevenlabs.io/docs/eleven-api/choosing-the-right-model
