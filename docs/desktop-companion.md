# Desktop companion

Halo has two modes, selected in the sidebar or from the labeled Agent | Desktop toggle in the floating island.

- **Agent** uses the existing OpenAI desktop agent and its approval, pause, and stop controls.
- **Desktop** watches selected apps and gathers progress directly in the island. Switching to it stops the action agent. New tasks, saved shortcuts, and resume commands cannot start actions in this mode.

The island keeps the active mode highlighted, with a sensing light in Desktop and action activity in Agent. Mode changes wait for the bridge to confirm and remain synchronized with the sidebar. Motion follows the system’s reduced-motion preference.

Switch to **Desktop** on the island, then hover or click to expand it. A short sensing animation accompanies a fresh local read. The expanded island shows watched apps (including unknown or not-detected states), result cards, pause/resume, and **Watching preferences** for app selection, custom apps, quiet updates, and optional OpenAI briefings. **More detail** opens Workspace for a deeper view; it is optional for everyday watching. Pause preserves the last observations and stops new reads. Quit stops Halo completely.

Finished cards name the app and project, show the task and bounded reply excerpt when available, and offer **Open result** / **Dismiss**. Identical result observations are combined; different prompts or replies remain separate. A new turn clears the previous reply excerpt. If the adapter exposes no result text, Halo says so rather than inventing an outcome. Open result brings a uniquely matched existing app window forward, without executing transcript links or commands; if no unique window is available, Halo asks you to open the app directly. Dismissals last for the current Halo process and apply to the same result content across polls.

Quiet updates remain available when the island expands. Disabling quiet permits brief island expansions for new completions, errors, and requests for input. Merely finding an open window never creates a feed event or a floating notification. Historical sessions found on first observation stay in the expanded island without interrupting you. Dismissing a result does not replay an older notification.

Choose **Appearance → System, Light, or Dark** in the sidebar. The preference is saved locally and shared across open app windows. The briefing's custom vector animation has a transparent background, follows the current work state, rests while paused, and respects reduced-motion preferences. It stays inside the layout rather than covering controls.

## What the statuses mean

Local Claude Code and Codex session files provide bounded recent activity. Explicit completion events mean a reply or turn ended, not that an entire project succeeded. A submitted prompt or tool request is an inferred activity signal. Older activity becomes unknown rather than claiming work is still running.

Windows discovery and accessibility provide window titles and selected readable controls. A live “Stop generating” control can establish generation; an explicit approval control can establish that input is needed. Merely opening Chrome or a title containing “done” never proves task completion. The UI labels the source and confidence of each observation.

This is not an integration into every provider's account. Background browser tabs, minimized/inaccessible windows, remote sessions, apps without accessibility data, and unrecognized transcript versions may not expose progress. Those remain open/unknown, rather than inventing percentages. Local transcript readers are best-effort adapters, bounded to recent files; they do not modify Claude or Codex settings or install hooks.

## OpenAI summaries

Summaries are optional and off initially. Turning them on sends bounded selected-app metadata (name, project, state, short detail and reply excerpt, source, confidence) directly to OpenAI's Responses API using your existing local OpenAI key. It does not send screenshots, full transcripts, raw window titles, or complete local paths. Requests use `store:false`, have no tools, and cannot operate the desktop. Common credential patterns are redacted. OpenAI's applicable API data policies still apply.

Local results are useful with summaries off. When enabled, briefings name the app/project and describe available result evidence. Briefings run in the background: opening the island never waits for OpenAI, and an outdated briefing cannot replace newer local evidence. Meaningful changes are summarized at most once per minute. Local status and a local briefing remain usable if OpenAI fails. Disabling summaries or pausing cancels in-flight summaries. Only monitoring preferences are saved; the observed feed is held in memory.

## Development checks

`npm run ui` builds the interface. `npm run check:desktop` runs offline monitor, OpenAI request, and local route tests. `node bridge/server.mjs --headless --console` runs the bridge without opening the floating window for development. Closing or quitting a normal floating window exits; it is not automatically recreated.

## Research used

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create): direct model requests and response handling.
- [Codex app server](https://learn.chatgpt.com/docs/app-server): explicit started/completed/failed turn notifications. Halo does not attach a second app server to existing sessions; its current adapter reads local session evidence.
- [Claude Code hooks](https://code.claude.com/docs/en/hooks): lifecycle, stop, and notification semantics used to distinguish completion from a request for attention.
- [Microsoft UI Automation](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview): reading supported controls across desktop apps.
