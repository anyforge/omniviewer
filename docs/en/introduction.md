# Introduction

Omniviewer is a **cross-source universal file viewer** for the desktop: it gathers files scattered across your local disk, Git platforms, cloud storage, and file servers into a single three-pane interface for viewing, searching, and citing.

## Positioning

- **Any source** — Local, GitHub, GitLab, HTTP, WebDAV, SFTP, and S3, browsed side by side.
- **Any format** — 275+ formats previewed inline, no download, no third-party app.
- **One glance** — a three-pane layout (sources / file tree / preview).

## Interface

```
┌───────────┬──────────────┬──────────────────────────────┐
│  Toolbar (settings · add · breadcrumbs)                   │
├───────────┴──────────────┴──────────────────────────────┤
│  Tabs (fast switching between files)                      │
├───────────┬──────────────┬──────────────────────────────┤
│ Sources   │ File tree     │  Preview                      │
│ ▾ Local   │ 🔍 Search…    │  (inline: documents / code /   │
│   omniviewer│ ▸ src-tauri │    images / media / archives)  │
│   proj-b  │   lib.rs      │                              │
│ ▾ GitHub  │   main.rs     │                              │
│ ▾ SFTP    │ ▸ docs        │                              │
│ ▾ S3      │              │                              │
├───────────┴──────────────┴──────────────────────────────┤
│  Status bar (version · ready · file info)                 │
└──────────────────────────────────────────────────────────┘
```

## Core capabilities

1. **Universal preview**: the file-viewer kernel renders Office documents, PDFs, code, images, audio/video, archives, Markdown, EPUB and more.
2. **Full-text search**: FTS5 + jieba tokenization treats Chinese and English equally; local and cached remote files hit together with BM25 ranking.
3. **Traceable watermarks**: visible per-format watermarks + an invisible anti-screenshot dot matrix; upload a screenshot to decode the owner ID.
4. **Download & pack**: file/folder download, encrypted ZIP packing (with a built-in password manager).
5. **Unified CLI**: one `omniviewer` binary with ten sub-commands covering search, index, preview, cache, watermark, connections, and MCP.
6. **MCP server**: expose your sources and search to any AI agent (Streamable HTTP + stdio).

## Architecture

```
┌─────────────┐     ┌──────────────────────┐     ┌──────────────┐
│  Frontend   │────▶│  omniviewer-core     │◀────│  omniviewer  │
│  Tauri 2    │ IPC │  (Rust core library) │     │  CLI + MCP   │
│  Vite 8     │     │  fs / search / cache /│     │  clap + rmcp │
│  file-viewer│     │  watermark / extract │     └──────────────┘
└─────────────┘     └──────────────────────┘
```

- **Frontend**: Tauri 2 + Vite 8 + TypeScript (vanilla), file-viewer Web Component for rendering.
- **Core library**: `crates/core`, shared by GUI and CLI (rusqlite/FTS5, jieba-rs, pdf-extract, …).
- **CLI/MCP**: `crates/cli`, sharing `omniviewer-core`, a single `omniviewer` binary.

## AI integration

Omniviewer's value goes beyond human viewing — it also lets agents *see*. The built-in MCP server turns every source you have opened into an AI retrieval-and-read backend. Agents can:

- `search` your files full-text across sources;
- `read_file` to read Office/PDF text directly;
- `list_files` to browse directories, `get_file_info` for metadata.

This lifts a "universal viewer" into a "view + search + cite" AI workbench.
