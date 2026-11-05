# Composio implementation report — pt29u

Date: 2026-11-05. Local work only. No commits/pushes, cloud coding agents, external messages, actual mail sends, live OAuth initiation/disconnect, environment-file reads, credential-file reads or CLI authentication inspection were performed. Mock send execution tests never contacted a provider. Stored secrets were not extracted for verification.

## Delivery and blockers

Implemented local Halo SDK integration source, credential storage adapter, Settings UI, session authorization/reuse, exact tool policy, agent dispatch/guardian gates, desktop signal mapping and mocked tests. This is not end-to-end verified: dependency installation and UI build are blocked by this environment. No claim of live OAuth, Windows Credential Manager or Gmail/calendar production verification is made.

The requested `/workspace/composio-task/report.md` destination was writable at the start, but the restarted environment's explicit writable roots became `/workspace/pico` and `/tmp`. This report is saved as `/workspace/pico/docs/composio-report.md` under the currently permitted root. The original preexisting-change inventory and patch remain at `/workspace/composio-task/preexisting-files.txt` and `preexisting.patch` from the initial pass.

## Files added

- `bridge/composio.mjs`: SDK client initialization from process environment or runtime OS secret store; disabled defaults; same-user/private connection listing and selection; managed sessions restricted to gmail/outlook/googlecalendar/slack; session authorize links; disable connection; exact slug allowlist; schema/version retrieval; read/draft agent adapter; send approval receipt checks; throttled Gmail/calendar watch mappings.
- `bridge/composio-secret.mjs`: Windows Credential Manager Generic Credential `Halo/Composio` using native CredWrite/CredRead through a hidden PowerShell helper. Key goes through stdin, never command arguments. Retrieval remains inside app runtime. Other platforms cannot persist keys and can use inherited process injection.
- `bridge/composio-routes.mjs`: loopback/Host/Origin guarded status, key, settings, connect/disconnect controls, bounded JSON requests and sanitized failures. No generic tool execution/approval-minting endpoint.
- `bridge/composio-agent.mjs`: model tool definitions for search_mail, list_unread and draft_reply_do_not_send; no send tool.
- `pico-ui/react/connections.jsx`: Settings card with feature enable, password key entry, stable user ID, existing account selection, connection statuses, hosted consent link and status polling, explicit disconnect and watch controls.
- `scripts/test-composio.mjs`: 15 offline mocked tests.
- `scripts/verify-composio-live.mjs`: inherited-key-only read-only connection count/status verification. No dotenv or secret-store lookup.
- `docs/composio-connections.md`: setup, official SDK references, linking alternatives, limitations and Windows verification checklist.
- This report.

## Existing files intentionally extended

Already dirty at task start:

- `bridge/agent.mjs`: Composio attachment, small-tool dispatcher and real Halo guardian approval promise. Does not honor autoApproveAll for integration reads/drafts.
- `bridge/desktop-monitor.mjs`: optional watch signal reader and fixed-provider Open handler; existing event/Dismiss routing reused; distinct account signal identities.
- `bridge/server.mjs`: construct/attach integration, mount guarded routes, optional desktop watch and fixed-provider opening.
- `pico-ui/react/app.jsx`: import/render Tools / Connections card.
- `package.json`: declare official `@composio/core` dependency (`^0.19.1`) and `check:composio` script.

Previously clean files edited:

- `bridge/driver.mjs`: expose only the three small tools during enabled action turns and dispatch through HostAgent; tool results marked untrusted.
- `bridge/policy.mjs`: explicit integration allowlist and RequireConfirmation policy.

`package-lock.json` was already dirty. Failed npm installation did not produce a Composio lock resolution; its preexisting diff was preserved. **The new dependency is not installed or resolved in the lockfile.** A successful `npm install` with registry access is required before this feature can run. Do not treat the manifest declaration as a verified install.

All other preexisting tracked diffs were checked against the initial saved patch and preserved byte-for-byte. No reset/revert was used. The initial dirty set included `.gitignore`, computer/LLM/notch code, multiple React and voice/platform files, generated HTML and UI build script changes, plus existing untracked bot/watch/icons/platform files. These were not attributed to this task. Generated UI output was not successfully rebuilt.

## Exact verification results

- `npm run check:composio`: **15 tests, 15 pass, 0 fail, 0 skipped**. Covers disabled/no key, exact slugs, MCP/generic executor refusal, send receipt binding/replay, watch app gating, matching active connection, concrete version pin, existing-account reuse, session toolkit filters, guardian refusal, unread/possible-reply mapping, calendar mapping, fixed Open/Dismiss, local route security, real HostAgent guardian resisting autoApproveAll, config changes during approval, mocked valid receipt and injected secret storage/no-key echo.
- `npm run check:desktop`: **exit 0**. Monitor lifecycle/parsing/stale/redaction/selection/dedup/pause/cancellation, result scenarios, summary safety, local routes, explicit Open/Dismiss checks passed. Run twice after changes, both passed.
- `node scripts/test-policy.mjs`: **exit 0**, passed.
- `node scripts/test-intent.mjs`: **exit 0**, 91 messages routed correctly.
- `node scripts/test-agent-speed.mjs`: **exit 0**, passed.
- `node scripts/test-job.mjs`: **exit 0**, “job: all passed”.
- `node scripts/test-driver.mjs`: **exit 1**, seven failures. Re-ran the exact suite against a temporary copy of the unchanged HEAD driver with the same local dependencies/dirty surrounding files: **same seven failures**, same labels and observed values. Baseline temporary source/test copies were then removed. Failures: two Back navigation checks; four same-screen batch checks (single act call, screenshot count, completion, activity); vanished batch target check. Existing screen-capture dependency warning: missing node-screenshots. These failures predate this driver edit and were not changed out of task scope.
- `node --check` for composio, composio-routes, composio-secret, agent, driver, server, policy and live-check script: **exit 0** when run.
- `git diff --check` over intentionally edited tracked sources: **exit 0**.
- `npm run ui`: **exit 1**, `Cannot find package 'esbuild' imported from /workspace/pico/scripts/build-ui.mjs`. Tried twice. UI JSX source has not been compiled or browser-tested in this environment.
- `npm install @composio/core --ignore-scripts`: **exit 1**, EAI_AGAIN resolving registry.npmjs.org. Retried with writable `/tmp/halo-npm-cache`, fetch retries 0 and timeout 20000: **same EAI_AGAIN**. No registry/network bypass attempted. Dependency/lock update cannot be completed here.
- Initial `node --test scripts/test-composio.mjs` invocation produced a generic subprocess failure under the managed harness. The direct node test-runner invocation exposes proper per-test results and is now the npm script. The first direct run found a test-order issue (checking cards after stopping clears them); corrected, and subsequent final suite passed 15/15.
- `npm run check` was not run: its general file scanner can read environment templates, contrary to this task's prohibition. Used targeted syntax/tests instead.
- `node scripts/verify-composio-live.mjs`: **exit 0**, “Live verification blocked: COMPOSIO_API_KEY is absent from process.env. No secret store was accessed.” No live list, sessions or OAuth calls were made.

## Architecture and security review

Reviewed the new modules and selected tracked diffs for credential leakage and policy bypasses. Key entry follows the existing OpenAI local Settings shape, but OpenAI's existing implementation writes an environment file; Composio deliberately uses Windows Credential Manager instead. OpenAI behavior was preserved. No Gmail password fields exist.

Backend validates exact watch/draft/send slugs, watch app selection, active matching private connection, and concrete official schema version before execution. No latest-version bypass. Settings changes invalidate pending tool approvals; guardian approvals bind the selected account and arguments; send receipts are one-use, short-lived and bound to tool/arguments/account. No send UI/model tool exists, so send execution remains inaccessible to ordinary Halo model actions. No Composio MCP/proxy/sandbox executor is exposed. Session sandbox is disabled.

Same-user account reuse is the preferred low-friction path. New connections use managed `session.authorize`, only after an explicit Connect click. The browser is used for hosted consent and status is polled afterward; no local token-bearing OAuth callback is required. Custom verifier projects are not supported by this pass. `connectedAccounts.initiate` is not used; official docs retire it for managed OAuth in 2026 and recommend `link` for direct auth flows. Tool execution pins the version returned by `getRawComposioToolBySlug`.

Windows helper and new UI require Windows/manual verification. Network/provider error bodies never reach UI/logs. Watch cards contain count/heuristic text, not private mail/event bodies. Open uses hardcoded provider home pages; no content-provided URLs or commands. No logo/PNG work was added.

## Enable and Windows checks

Follow `docs/composio-connections.md`: install dependencies and resolve lockfile on a network-enabled machine; run tests and `npm run ui`; save a new Composio project key via Settings; enable feature; choose stable local user ID; reuse existing active private accounts or explicitly complete hosted consent; select accounts; enable watches and Desktop mode. Verify Credential Manager entry by name without revealing its value, restart to test runtime retrieval, and decline test tool approvals (also with autoApproveAll enabled). Test Open/Dismiss and timed calendar cards. Disconnect only an intentionally disposable test connection.

## Remaining limitations

1. SDK install/lock resolution, UI build, real SDK runtime compatibility, Windows native secret storage and full OAuth/provider flows remain unverified because of missing dependencies/network/key/platform. Do not ship claiming these passed.
2. Sessions handle authorization and selection; direct SDK execution is used for the strictly gated tools to explicitly pin the tool version/account. No model meta-tool chain or remote workbench is used.
3. Shared/team account pin+ACL sessions are unavailable in this implementation. Listing explicitly excludes shared accounts.
4. Gmail needs-reply is a clearly labeled unread-inbox review heuristic, not AI inference. Unread counts are bounded samples. Calendar covers primary calendar timed events within 30 minutes and checks current schema field support.
5. Outlook supports linking/status/selection but watch adapters are not implemented. Slack supports linking/status only; watch and all execution remain disabled. No unrequested Slack slugs were added.
6. Connection listing is bounded to the first 100 accounts; no pagination UI. Open provider home pages may require selecting the desired signed-in browser account.
7. No sending workflow is offered; backend send policy is mocked-test verified, not wired to a send button. Small tools are available on desktop action turns, not ordinary chat turns.
8. Claude Desktop Composio Connect (`https://connect.composio.dev/mcp`) and native Codex/Claude Code Composio plugin are documented alternatives only. Consumer/developer project separation prevents automatic credential sharing. No assistant credentials/cookies/sessions were read. Device auth is not implemented or claimed for Gmail/calendar/Slack.
