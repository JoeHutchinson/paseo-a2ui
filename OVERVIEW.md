A2UI lets coding agents show interactive interfaces in the Paseo chat: forms, option pickers, cards, tabbed summaries and simple dashboards. It renders [A2UI](https://a2ui.org) v1.0 with the basic component catalog using native Paseo components, so the same interface works on desktop, web, iOS and Android and follows your theme.

## How it works

The plugin gives each interactive agent an `a2ui_render` tool and one sentence in its system prompt saying the tool exists. The agent sends A2UI messages and the interface appears in the conversation. When a turn ends, the latest state of each interface is shown below the agent's reply, so it stays visible after Paseo folds the turn. If a later turn changes an interface, the earlier copy is replaced by a short note.

Text fields, checkboxes, choice pickers, sliders and date fields change a local copy of the data. Nothing reaches the agent until you press a button with an event action. The agent then receives a user message with a one-line summary and an `<a2ui-action>` JSON block holding the action name and the values the button sends.

Agents can update an interface they rendered earlier, including after a daemon or plugin restart. The plugin rebuilds its state from the conversation.

## Setup

- Turn on Paseo tools for agents (`daemon.mcp.injectIntoAgents: true`). Plugin tools reach agents through the same channel.
- Agents in an "always ask" permission mode ask before each `a2ui_render` call.
- To keep the tool away from an agent, give it the label `a2ui/enabled=false`. Background agents never receive it.
- Requires Paseo 0.17.3 or later.

## Data and network access

- Interface definitions and their data are stored as rows in the agent's Paseo timeline.
- Button presses become user messages to the agent, so the values they carry are sent to that agent's model provider like any other message.
- The plugin makes no network requests of its own. Images in an interface are loaded by your Paseo app from the `https` or `data:image` URLs the agent supplies. Buttons can open `http`, `https`, `mailto` and `tel` links in your browser only when you press them.

## Limits

- Supports the A2UI basic catalog only. Custom catalogs, `callRendererFunction` and agent-side functions are not supported.
- On phones, Paseo opens a side panel on long horizontal swipes, so dragging a slider far can open the panel. Sliders have minus and plus buttons, and tapping the track sets the value directly.
- Video and audio components open the URL instead of playing inline.
- Date and time fields are text inputs (`YYYY-MM-DD`, `HH:MM`) with a "now" shortcut, not native pickers. Their `min` and `max` are not enforced.
- SVG images display on web and desktop only.
- One interface holds at most 60 KiB of components and data.
- Unsent edits are kept on each device while the app is open and are lost when it restarts.
- Regex validation rejects patterns that could run slowly, following the A2UI regex safety rules; the agent is warned when that happens.
