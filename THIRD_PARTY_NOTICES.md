# Third-party notices

The project sources and the twelve migrated desktop files are original project work. The owner explicitly authorized MIT publication during this task. No third-party source was vendored from an upstream repository.

Dependencies retain their own licenses:

| Package | Version | License | Use |
|---|---|---|---|
| TypeScript | 5.9.3 | Apache-2.0 | Build/typecheck only |
| @types/node | 24.10.0 | MIT | Development types |
| undici-types | See package-lock.json | MIT | Transitive development types |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | MCP stdio server and test client; maintenance protocol line |
| zod | 4.6.5 | MIT | Strict MCP tool input validation |
| websocket-client | 1.8.0 | Apache-2.0 | Optional desktop CDP transport |

Node.js, Python, Git and external Agent applications are separately installed products and are not relicensed by this repository.

Runtime transitive packages and exact versions are recorded in package-lock.json and retain their upstream licenses. No upstream implementation is copied into project source. SDK v1 implements the 2025-11-25 protocol line; MCP 2026-07-28 features are not claimed by this release.

The native desktop read-only diagnostic was independently implemented after reviewing the public [Conversation MCP protocol](https://github.com/kajmahal/chatgpt-conversations-mcp/tree/4c2640d88cc95df1fa3d4d1c60f433d452c97351) (Apache-2.0) and the public [Codex issue #48314](https://github.com/openai/codex/issues/48314). No source, helper, binary or authentication material from those projects was vendored or executed. OpenAI MCP Extensions were reviewed as documentation, not added as a dependency or claimed as an ordinary-chat background service.
