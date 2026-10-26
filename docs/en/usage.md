# Usage

## Adding a source

Click the **＋** button in the toolbar to reveal three actions:

| Action | Description |
| --- | --- |
| **Open file** | Preview a single file directly |
| **Open folder** | Open a local directory in the file tree (repeatable — many folders at once) |
| **Add connection** | Create a remote source (GitHub / GitLab / SFTP / WebDAV / S3 / HTTP) |

Remote connections are configured in a dialog (address + credentials) and appear under their group in the left rail after saving.

## Browsing

- **Sources rail** (left): tree groups (Local / GitHub / GitLab / SFTP / S3 …); click a group header to collapse/expand; the Local group can hold multiple open folders, shown by folder name — click an entry to switch.
- **File tree** (middle): the top search box filters by name; each row shows a type icon · name · date · size; when narrow, the filename keeps priority while date/size ellipsize.
- **Breadcrumbs** (toolbar): shows the current path, each segment clickable.
- **Preview** (right): the selected file renders inline.

## Multiple tabs

Opened files appear in the tab bar above the preview; open many at once and switch quickly. When tabs overflow, scroll horizontally (mouse wheel works). Switching a tab keeps the source rail and file tree selection in sync.

Keyboard: `←` / `→` switch to the previous/next file.

## Full-text search

- The search box at the top of the file tree, or the `omniviewer search` command.
- Covers indexed local directories + cached remote files.
- Chinese and English equally: Chinese via jieba + 2-gram, English via tokens + identifier (camelCase/snake_case) splitting.
- The index is maintained incrementally in the background; the first index of a large directory takes a moment.

## Watermarks

Configure under **Settings → Watermark**:

- **Visible watermark**: on/off, text, font, size, color (default red), opacity, angle, density; baked into supported formats (e.g. PDF).
- **Invisible watermark**: anti-screenshot dot matrix (screen watermark) + a user ID; upload a screenshot to decode the ID for leak tracing.

## Download & pack

- Right-click a file/folder → Download; large files chunk and retry on interruption.
- Packing to ZIP can be encrypted; passwords are managed under **Settings → Download** (save several, pick, remove).

## CLI

The CLI ships with the app — click "**Install CLI to PATH**" under **Settings → About**, then use it in the terminal (see [Installation](install.md)):

```bash
omniviewer search  design-doc            # full-text search
omniviewer search  design-doc --remote   # include cached remote files
omniviewer index   /path/to/dir          # rebuild the index
omniviewer cat     /path/file.md         # print text content
omniviewer ls      /path/to/dir          # list a directory
omniviewer status                        # status overview
```

## Connect AI agents (MCP)

**Local agents (stdio)** — e.g. Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "omniviewer": {
      "command": "omniviewer",
      "args": ["mcp"]
    }
  }
}
```

**Remote agents (Streamable HTTP)** — start the server and point the remote agent at the endpoint:

```bash
omniviewer mcp --http --host 0.0.0.0 --port 8765 --key <at-least-8-chars>
# Endpoint: http://<host>:8765/mcp , Auth: Authorization: Bearer <key>
```

> Security: binding `--host` to a non-loopback address (not 127.0.0.1/localhost/::1) requires `--key`, otherwise startup is refused.
