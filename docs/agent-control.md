# Agent control

Agent mode works toward the original task through the existing driver, accessibility helper, input executor, and local safety policy. Desktop watching is separate.

## Fast decisions

The action model returns one `act` call with a first action and up to six visible continuations in `then`. Visible continuations are the default; a new page, dialog, missing target, or unexpected result ends the batch. Parallel tool calls stay disabled. Each queued target is found again in current accessibility data, and every action retains its pause/stop gate, policy assessment, approval, focus, and target checks. Completing a batch does not authorize a later consequential action.

The first action of a model batch now uses the same semantic observation path as its continuations. Readable controls, focus evidence, and window-title changes can establish progress without another screenshot. If a fresh model look is needed, the driver refreshes the picture before asking. An exact, unique navigation target in a readable menu can be selected locally, including a sparse menu with fewer than four controls. Ambiguous names remain on the model path. “Open Locked chats” and “open chat Mira” are in-app navigation tasks, rather than requests to launch apps called Locked chats or Chat Mira.

Act requests use `none` reasoning effort when supported, `minimal` for the original GPT-5 variants, and `low` for model families that do not accept either. Providers that reject an effort are retried with the next compatible effort, which is remembered. Function-tool batching works on both Responses and the existing Chat Completions path. No native computer-tool or code-execution adapter is enabled: native pixel batches still need to be translated through Halo’s target identity, safety, approval and guardian checks before such an adapter could safely replace function tools.

## Outcomes and recovery

The live action label comes from the action and target, rather than the model’s `why` prose. Milestone Activity contains bounded executed outcomes. Reasoning items and provider reasoning-content fields are not rendered as activity.

A missed action triggers recovery from current evidence without shortening the configured action budget. A contradicted milestone completion claim cannot become success after two refusals. An unverified final claim gets up to two additional attempts within the remaining budget; a successful final verification is reused rather than requested again. Repeated inability to progress can ask the user once for a missing detail.

When the action limit or recovery attempts are exhausted, the run shows **Ready to continue** with the reason and **Continue task**. This starts a fresh Agent task from the current screen through the usual guardian and approval gates. It does not automatically resume a cancellation, denied approval, or password handover. The configured maximum action count remains in force.

## Checks

- `node scripts/test-agent-speed.mjs`: sparse named navigation, outcome labels, Responses/Chat batching contracts and effort compatibility (offline).
- `node scripts/test-driver.mjs`: one model call for a same-screen batch, no intermediate full screenshots, recovery budget, premature completion recovery, focus theft, and existing driver behavior (mocked).
- `npm run check`, `npm run check:desktop`, and `npm run ui`.

Native focus, authentication handover, and real application accessibility behavior still require Windows testing. The screenshot of a stopped run alone does not establish the original failure cause; these checks cover concrete failure paths found in the driver.

The batching contract follows the [OpenAI computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use); effort compatibility follows the [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).
