<div align="center">
  <img src="assets/logo.png" alt="Omniviewer logo" width="110" />
  <h1>Omniviewer</h1>
  <p><strong>Any source. Any format. One glance.</strong></p>
  <p>A cross-source universal file viewer for the desktop — with full-text search, watermarks, a CLI, and an MCP server so AI agents can read and cite everything you can see.</p>
</div>

![Omniviewer](assets/screenshot.png)

## What is Omniviewer?

Omniviewer previews files from **anywhere** — your local disk, GitHub, GitLab, SFTP, WebDAV, S3, or a plain HTTP server — in one three-pane interface, without downloading first and without launching a third-party app.

It renders **275+ formats** inline (Office documents, PDFs, code, images, audio, video, archives, ML models, and more). On top of viewing, it adds cross-source full-text search, traceable watermarks, a unified CLI, and an MCP server that turns the app into a file-and-search back end for AI agents.

## Highlights

- 🗂 **Seven sources, one tree** — browse Local / GitHub / GitLab / HTTP / WebDAV / SFTP / S3 side by side, with many local folders open at once.
- 👁 **Universal preview** — 275+ formats rendered inline by the file-viewer kernel; no download, no third-party app.
- 🔍 **Full-text search** — FTS5 + jieba tokenization, built for **Chinese and English equally** (word segmentation + identifier splitting + 2-gram).
- 🖼 **Multiple tabs** — open many files at once; switching a tab keeps the source tree and file tree selection in sync.
- 🎨 **Themeable** — color palettes in Settings let you pick every UI element (dark/light) and every code token (Dracula / GitHub Light presets), applied live.
- 🛡 **Watermarks** — visible per-format watermarks plus an invisible anti-screenshot dot matrix, both traceable to a user ID.
- 💾 **Download & archive** — download files/folders and pack encrypted ZIPs (with a built-in password manager).
- 🏭 **Production-grade** — streaming & chunked reads for large files, an LRU preview cache with eviction, resumable downloads with retry, and traceable visible + invisible watermarks.
- ⌨ **CLI** — one `omniviewer` binary: `search / index / cat / ls / cache / wm / conn / mcp / status / version`.
- 🤖 **MCP server** — expose your sources and search to any AI agent over Streamable HTTP or stdio.

## Data sources

| Source | Description |
| --- | --- |
| **Local** | Any folder on your machine (multiple at once, tree view) |
| **GitHub** | Browse public and private repositories (token auth) |
| **GitLab** | Browse GitLab projects and subgroups |
| **HTTP** | Static file servers and directory listings |
| **WebDAV** | WebDAV shares |
| **SFTP** | SSH file servers |
| **S3** | Amazon S3 and S3-compatible buckets |

## File formats (275+)

- **Documents** — PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, ODT/ODS/ODP, RTF, TXT, CSV, OFD
- **Code** — syntax highlighting for hundreds of programming languages
- **Images** — PNG, JPEG, GIF, SVG, WebP, BMP, ICO, TIFF
- **Audio / Video** — MP3, WAV, FLAC, OGG, MP4, WebM, MOV
- **Archives** — ZIP, RAR, 7Z, TAR, GZ (in-app extraction; encrypted ZIP supported)
- **Model files** — ONNX, GGUF, safetensors, .pt/.pth, .h5/.keras, .tflite
- **Others** — Markdown, EPUB, HTML

→ Full registry: [docs/en/formats.md](docs/en/formats.md) (275 extensions · 18 categories).

Anything unsupported still opens as plain text (like VS Code) — never an "install plugin" prompt.

## AI & MCP

Omniviewer ships an [MCP](https://modelcontextprotocol.io) server, so AI agents (Claude Desktop, Cursor, custom agents…) can read your files and search across every connected source:

```bash
omniviewer mcp                                   # stdio (for local agents)
omniviewer mcp --http --port 8765 --key <secret> # Streamable HTTP (local + remote agents)
```

| Tool | Description |
| --- | --- |
| `search` | Full-text search across local and remote sources |
| `list_files` | List a directory (local or remote) |
| `read_file` | Read file content (with Office/PDF text extraction) |
| `get_file_info` | File metadata |

## CLI

One binary, ten sub-commands. Install it from **Settings → About → Install CLI to PATH** (it ships bundled with the app), then run `omniviewer` in the terminal:


```bash
omniviewer search  <query>       # full-text search (--remote to include cached remote files)
omniviewer index   <path>        # (re)build the search index
omniviewer cat     <file>        # print a file's text content
omniviewer ls      <path>        # list a directory
omniviewer cache   <sub>         # manage the preview cache
omniviewer wm      <sub>         # watermark encode / decode
omniviewer conn    <sub>         # list / add / remove connections
omniviewer mcp     [--http]      # start the MCP server
omniviewer status                # sources, index and cache status
omniviewer version               # print version
```

## Getting started

```bash
pnpm install
pnpm tauri dev        # run the desktop app (first Rust build is slow)
pnpm tauri build      # produce the release bundle
```

See [Installation](docs/en/install.md), [Usage](docs/en/usage.md) and [Configuration](docs/en/configuration.md) for details.

## Documentation

- [Introduction](docs/en/introduction.md)
- [Installation](docs/en/install.md)
- [Usage](docs/en/usage.md)
- [Configuration](docs/en/configuration.md)
- [Supported formats](docs/en/formats.md)
- [Changelog](CHANGELOG.md)

## Tech stack

Tauri 2 · Rust (rusqlite/FTS5, jieba-rs, rmcp, clap, axum) · Vite 8 + TypeScript (vanilla) · file-viewer rendering kernel

## License

[AGPL-3.0](LICENSE) — GNU Affero General Public License v3.0.

## Sponsor

If Omniviewer helps you, consider sponsoring its development:

<div align="center">
  <img src="assets/alipay.png" alt="Alipay" width="200" />
  <img src="assets/wechatpay.png" alt="WeChat Pay" width="200" />
</div>
