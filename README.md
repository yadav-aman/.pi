# .pi

Personal configuration for [Pi](https://github.com/earendil-works/pi) — the terminal coding agent from `@earendil-works/pi-coding-agent`. This directory is the default agent home (`PI_CODING_AGENT_DIR` → `~/.pi/agent`).

Tracked files are a portable snapshot of settings, extensions, skills, and prompts. Sessions, auth, and other runtime state stay local and are not committed.

## Prerequisites

- [Bun](https://bun.com) (for dev dependencies and extension type-checking)
- Pi CLI — installed globally or via this repo’s dev dependency:

```bash
bun install
bunx pi --help
```

## Quick start

From any project directory:

```bash
pi
```

## Development

Type-check local TypeScript extensions:

```bash
bun run type-check
```

Add or edit extensions under `agent/extensions/` using types from `@earendil-works/pi-coding-agent`.
