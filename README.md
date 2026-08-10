# RelayKM

Experimental PKM.

This repository is a Claude Code plugin: it gives Claude sandboxed filesystem
access to your RelayKM knowledge base, and loads the knowledge base's
`AGENTS.md` into every new conversation. It also acts as its own plugin
marketplace, so it can be installed directly.

## Install

From the directory containing this repository, start Claude Code and run:

```
/plugin marketplace add ./RelayKM-src
/plugin install relaykm@relaykm
```

The MCP server starts automatically as soon as the plugin is enabled — there is
no install step and no dependencies to fetch. If the install summary says
`Run /reload-plugins to activate.`, run that.

To try it without installing:

```bash
claude --plugin-dir .
```

## The knowledge base root

| Platform | Default root |
| :--- | :--- |
| macOS | `~/Documents/RelayKM` |
| Windows | `%USERPROFILE%\Documents\RelayKM` |
| Linux | `$XDG_DOCUMENTS_DIR/RelayKM`, else `~/Documents/RelayKM` |

Set `RELAYKM_ROOT` to point somewhere else. The root is created on first use,
along with a starter `AGENTS.md`.

Every tool path is relative to this root; `.` is the root itself. Paths that
resolve outside it — via `..`, an absolute path, `~`, or a symlink pointing out
of the tree — are refused. Containment is checked twice: once lexically, and
again after resolving symlinks.

## Tools

Exposed by the `relaykm-fs` MCP server.

| Tool | What it does |
| :--- | :--- |
| `list_folder` | List a folder's contents, optionally recursive |
| `create_folder` | Create a folder and any missing parents |
| `delete_folder` | Delete a folder; needs `recursive: true` when non-empty |
| `read_file` | Read a UTF-8 text file |
| `write_file` | Create or edit a file (`overwrite` or `append`) |
| `delete_file` | Delete a file |

The root itself cannot be deleted. Binary files are refused rather than returned
as mojibake, and reads are capped at 1 MB by default.

## Session-start hook

On session start the hook reads `AGENTS.md` from the root of the knowledge base
and injects it as conversation context, so standing conventions are in place
before Claude touches anything.

`SessionStart` also fires on resume, clear, compact, and fork, which all share a
session id. The hook claims a marker file under `${CLAUDE_PLUGIN_DATA}/sessions/`
on its first run, so the file is injected exactly once per conversation. Markers
older than seven days are pruned. If anything fails — missing root, unreadable
file — the hook exits quietly rather than blocking the session.

## Layout

The plugin lives at the repository root rather than in a subdirectory, since
this repo ships exactly one plugin.

```
.claude-plugin/
├── marketplace.json     marketplace catalog (source: "./")
└── plugin.json          plugin manifest
.mcp.json                MCP server registration
hooks/
├── hooks.json           SessionStart registration
└── session-start.js     AGENTS.md injection
lib/
├── rpc.js               JSON-RPC 2.0 stdio transport
└── store.js             root resolution and path sandbox
mcp/server.js            tool definitions and handlers
```

One consequence of the plugin living at the repository root: `.mcp.json` is also
where Claude Code looks for a repo's *project* MCP config. Opening RelayKM in
Claude Code to work on it will therefore offer to enable `relaykm-fs` as a
project server, where `${CLAUDE_PLUGIN_ROOT}` is undefined and the server would
not start. Project MCP servers are opt-in, so this is a prompt to decline rather
than a broken server. Declining does not affect the installed plugin, which
resolves the path through the plugin runtime.

## Development

The server speaks MCP's stdio transport directly rather than depending on
`@modelcontextprotocol/sdk`, which is what lets the plugin work the instant it is
enabled — no `npm install`, no network. The protocol surface is small
(`initialize`, `tools/list`, `tools/call`, `ping`) and lives in `lib/rpc.js`; swap
in the SDK there if the server outgrows it.

Drive the server by hand:

```bash
RELAYKM_ROOT=/tmp/relaykm-test node mcp/server.js
```

then paste newline-delimited JSON-RPC frames on stdin:

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_folder","arguments":{"path":"."}}}
```

Validate the manifests:

```bash
claude plugin validate .
```

That checks `marketplace.json` and, via its per-entry pass, `plugin.json` — but
not `hooks/hooks.json` or skill and agent frontmatter. With the plugin at the
repository root, the validator sees a marketplace directory and uses marketplace
mode; the fuller per-component pass only runs when it is pointed at a plugin
directory with no `marketplace.json` beside it. To get that coverage, validate a
copy without the marketplace file:

```bash
d=$(mktemp -d) && cp -R .claude-plugin hooks lib mcp package.json "$d"/ && rm "$d"/.claude-plugin/marketplace.json && claude plugin validate "$d"; rm -rf "$d"
```
