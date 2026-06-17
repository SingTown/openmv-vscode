# CLAUDE.md

This file provides guidance to Claude Code and Codex when working with the VS Code extension.

## Install Dependencies

```bash
pnpm install
```

## Build

```bash
pnpm run build
pnpm run watch    # watch mode
```

## Code Quality

```bash
pnpm run lint       # check with biome
pnpm run format     # auto-format with biome
pnpm run typecheck  # tsc --noEmit
pnpm run check      # biome (auto-fix) + typecheck
```

## Commits

Use Conventional Commits style for commit messages, such as `feat:`, `fix:`, `docs:`, or `chore:`.

## Run & Debug

1. Open `vscode-extension/` in VS Code
2. Press `F5` to launch the Extension Development Host
3. The extension activates on startup, downloads the MCP server if needed, and launches it as a daemon
