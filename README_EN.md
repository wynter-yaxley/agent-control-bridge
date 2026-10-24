# agent-control-bridge

[![CI](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/wynter-yaxley/agent-control-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.19-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6)](#requirements)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-6E56CF)](https://modelcontextprotocol.io/)

[中文](README.md)

An MCP server that lets an AI agent use the ChatGPT and Codex conversations of the **ChatGPT desktop app** on your PC: list, search, read and create conversations, send a message and get the real reply.

- **One tool, one job**: reading, searching, creating and sending are independent. There is no fixed workflow.
- **Background whenever possible**: every Codex operation and every ChatGPT read leaves your windows alone.
- **Never sends twice**: calling again with the same message after a timeout returns the reply instead of resending.
- **Runs locally**: ACB itself uploads nothing (messages you send are handled by ChatGPT/Codex under their own terms), reads no credentials, and never grants Codex approvals for you.

![Architecture](docs/images/architecture.svg)

## What it can do

| Tool | Does | Disturbs you? |
|---|---|---|
| `acb_codex_list` | List recent Codex conversations (optionally of one folder) | No |
| `acb_codex_find` | Search Codex conversations | No |
| `acb_codex_read` | Read the latest turns of a Codex conversation | No |
| `acb_codex_create` | Start a Codex conversation in a folder | No |
| `acb_codex_send` | Send a message to Codex and return its reply | No |
| `acb_workspace_create` | Create a folder and register it as a Codex project | No |
| `acb_gpt_list` | List ChatGPT conversations | No |
| `acb_gpt_read` | Read the latest turns of a ChatGPT conversation | No (opens it to read a reply body) |
| `acb_gpt_open` | Show a ChatGPT conversation in the app | Switches the shown chat |
| `acb_gpt_create` | Create and name a ChatGPT conversation | Activates the window and types |
| `acb_gpt_send` | Send a message to ChatGPT and return its reply | Activates the window and types |
| `acb_threads` / `acb_projects` | List all sidebar conversations / projects | No |
| `acb_status` | Self-check: what is missing and how to fix it | No |

## Requirements

Windows 10/11, [Node.js](https://nodejs.org/) 24.19+ on Windows, the ChatGPT desktop app (Microsoft Store, includes Codex) signed in and with Codex used at least once, and an MCP client such as Hermes or Claude Desktop. The Codex tools may also work on macOS/Linux with the `codex` command installed (untested).

## Install

```powershell
git clone https://github.com/wynter-yaxley/agent-control-bridge.git
cd agent-control-bridge
npm install        # installs and builds
npm run check      # self-check; prints the client configuration for this machine
```

## Connect an MCP client

Add this to your MCP client (with your paths; `npm run check` prints it filled in):

```json
{
  "mcpServers": {
    "acb": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\agent-control-bridge\\dist\\mcp.js", "--allow-foreground-input"]
    }
  }
}
```

**Hermes** users can run the `hermes mcp add ...` command printed by `npm run check` and copy [skills/agent-control-bridge](skills/agent-control-bridge/SKILL.md) into Hermes' skills folder (also printed). The skill tells the agent how to use each tool and what to watch out for; other clients can use it as a system prompt.

Set the client's tool timeout to 300 s or more: a send waits up to 240 s.

## Good to know

**`--allow-foreground-input`** lets ACB bring the ChatGPT window to the front and type when you send to or create a ChatGPT conversation.

- Don't use the keyboard or mouse while it types. If you switch away, ACB stops at once, never takes focus back and never sends the partial text (it may remain in the input box).
- A minimized window is restored first and checked to be ChatGPT before anything is typed.
- Without the flag ACB never activates or types; it only submits an identical draft that is already in the input box while ChatGPT is in front.
- Read tools and Codex tools don't need the flag.

**ChatGPT conversations**

- The window must be in **ChatGPT mode** (not Codex mode); ACB does not switch modes.
- Titles of new conversations must be unique so they can be found reliably.
- ACB only types into a conversation it can identify: it is shown, or it has exactly one sidebar entry with that title. Duplicate titles are refused.
- The app gives ACB the latest 50 conversations (plus pinned ones); open older ones in the app first.
- The app's transcript usually doesn't keep the text of ChatGPT replies. `acb_gpt_read` then marks the reply `replyInWindowOnly`; read again with `window: true` (opens the chat).

**Codex conversations**

- Command and file approvals are always declined and counted in the result. Approve in the app, or change the conversation's approval settings.
- Archived conversations are unarchived when you send to them.
- A task longer than 240 s returns `TIMEOUT` while it keeps running. Call again later with the **same message** to get the reply; it is not sent again.

**Other**

- Sends, creations and window operations run one at a time; reads always answer immediately.
- App updates need no restart of ACB; after updating ACB itself, reload MCP in your client (`/reload-mcp` in Hermes).
- ACB can't create ChatGPT projects or move chats into them.

## Troubleshooting

Ask the agent to call `acb_status` (or run `npm run check`) and follow its `fix`.

| Code | Usually means | Do |
|---|---|---|
| `TIMEOUT` | The reply isn't ready | Call again later with the same message |
| `CONFLICT` | The conversation is busy, or you have a draft | Wait, or clear the input box |
| `FOCUS_REQUIRED` | The window lost focus while typing, or Windows refused activation | Go back to ChatGPT and retry |
| `AUTH` | `--allow-foreground-input` is not set | Add it to the configuration |
| `OWNER` | The app isn't running, or no window is in ChatGPT mode | Open the app in ChatGPT mode |
| `PROVENANCE` | The conversation can't be identified (duplicate title, not recent) | Open it in the app, or use a unique title |
| `CONFIG` | Codex not found, or no Codex conversation yet | Install the app and use Codex once |
| `DEPENDENCY` / `IO` | The app isn't responding, or ChatGPT isn't signed in | Follow `acb_status` |
| `EXECUTION` | The Codex task failed, or an approval was declined | Read the reply; approve in the app |

If creating a ChatGPT conversation fails half-way, the result includes the created conversation's ID (`status: "partial"`). Look at it before creating again.

## Configuration (optional)

| Option | Flag / environment | Default |
|---|---|---|
| Allow foreground input | `--allow-foreground-input` / `ACB_ALLOW_FOREGROUND_INPUT=1` | off |
| Codex executable | `--codex` / `ACB_CODEX` | the app's bundled `codex.exe` |
| Folder for new workspaces | `ACB_WORKSPACE_ROOT` | `%USERPROFILE%\acb-workspaces` |
| Longest wait for one send | `timeoutMs` in a `--config` JSON file | 240000 ms |
| Debug log | `--debug` / `ACB_DEBUG=1` | off |

## Development

```powershell
npm ci; npm run typecheck; npm test     # mocks only, no real conversations
npm run smoke -- --name ACB-smoke       # real Windows run: creates conversations and sends messages
```

See [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) · third-party licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
