# RelayKM
Experimental PKM

## Claude Code plugin

This repository doubles as a Claude Code plugin marketplace. The `relaykm` plugin
gives Claude sandboxed filesystem access to your knowledge base (default
`~/Documents/RelayKM` on macOS) and loads its `AGENTS.md` at the start of each
conversation.

```
/plugin marketplace add ./RelayKM-src
/plugin install relaykm@relaykm
```

See [plugins/relaykm/README.md](plugins/relaykm/README.md) for the tool reference
and configuration.
