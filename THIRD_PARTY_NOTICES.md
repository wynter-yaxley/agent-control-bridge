# Third-party notices

The project sources are original work under the MIT license. No third-party source is vendored.

Dependencies keep their own licenses:

| Package | Version | License | Use |
|---|---|---|---|
| @modelcontextprotocol/sdk | 1.32.1 | MIT | MCP server (stdio) and test client |
| zod | 4.6.5 | MIT | Tool input validation |
| TypeScript | 5.9.3 | Apache-2.0 | Build and type checking only |
| @types/node | 24.10.0 | MIT | Development types |
| @biomejs/biome | 2.6.2 | MIT OR Apache-2.0 | Formatting and lint only |

Transitive packages and exact versions are recorded in package-lock.json and keep their upstream licenses. Node.js, Windows PowerShell and the ChatGPT desktop app are separately installed products.

The client of the desktop app's tool pipe was written independently after reading the public [Conversation MCP](https://github.com/kajmahal/chatgpt-conversations-mcp/tree/4c2640d88cc95df1fa3d4d1c60f433d452c97351) (Apache-2.0) and [ChatGPT-MCP-Bridge](https://github.com/AresQQQQQ/ChatGPT-MCP-Bridge/blob/bf1f502e88186efa5ffca807b904dda06b1961fb/src/codex/codex-desktop.ts) (Apache-2.0) projects; none of their source was copied.
