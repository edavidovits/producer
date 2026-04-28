# Producer

A lightweight PM workspace that pairs Claude Code with a file viewer and markdown previewer.

## Features

- **Claude Code terminal** with tabbed sessions
- **File viewer** with markdown rendering, docx support, and inline editing
- **Workspaces** to organize multiple projects with their own tabs and file state
- **Drag-to-reorder** workspaces and tabs
- Auto-naming tabs from your first message
- Configurable home folder (picked on first launch)
- Window state and workspace state persist across restarts

## Requirements

- macOS (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) v18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

## Install

```bash
git clone https://github.com/edavidovits/producer.git
cd producer
./scripts/setup.sh
```

The setup script creates a local signing certificate (so macOS permissions persist across rebuilds), installs dependencies, builds the app, and copies it to `/Applications`.

Then open **Producer** from Spotlight or run:

```bash
open /Applications/Producer.app
```

On first launch you'll be prompted to pick your workspace folder.

## Development

```bash
npm start          # Run in dev mode (faster iteration)
npm run build      # Build + install to /Applications
npm run dist       # Build a distributable DMG
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New tab |
| Cmd+W | Close tab |
