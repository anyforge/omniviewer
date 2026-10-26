# Configuration

## Settings panel

The gear in the toolbar opens Settings, with five tabs:

| Tab | Contents |
| --- | --- |
| **General** | Language (zh/en), theme (dark/light), UI scale |
| **Theme** | Color palettes for UI and code themes |
| **Watermark** | Visible (on/text/font/size/color/opacity/angle/density) + invisible (ID, screen watermark, decode) |
| **Download** | Concurrency, chunk size, Zip password manager (save/select/remove) |
| **About** | Version, author (AnyForge), check for updates, install CLI to PATH |

Settings apply immediately and persist.

## Config directory

All runtime data lives under `~/.omniviewer/`:

| Path | Purpose |
| --- | --- |
| `config.json` | App settings and source credentials (Unix perms 600) |
| `index.sqlite` | Full-text search index (FTS5) |
| `labels.json` | Remote file cache → source label mapping |
| `cache/` | Preview cache (with cap and eviction) |

## Theme

The theme is configured entirely in **Settings → Theme** through color palettes:

- **UI colors** — dark and light variants, each element editable: background, panel, raised, border, text, muted, faint, accent.
- **Code colors** — dark (default Dracula) and light (default GitHub Light), each token editable: background, foreground, comment, keyword, string, number, function, type, variable.

Colors apply live to the interface (as CSS variables) and to code syntax highlighting. The accent-soft background is derived automatically from the accent color.

## Source credentials

Remote connection credentials (GitHub tokens, SSH keys, S3 keys…) are stored in `config.json` and reused across sessions — no repeated entry; they can be changed any time in **Add connection**.

> Note: in this version credentials are stored in plaintext with Unix permissions tightened to 600 (owner-only). OS keychain (macOS Keychain etc.) will be integrated after the app is code-signed.

## MCP server parameters

```
omniviewer mcp                        # stdio (default)
omniviewer mcp --http                 # Streamable HTTP
  --host 0.0.0.0                      # bind address (default 127.0.0.1)
  --port 8765                         # port
  --key <secret>                      # auth key (≥8 chars; required for non-loopback bind)
```

## Versioning & changelog

Versions follow SemVer; changes are recorded in `CHANGELOG.md` at the repository root. Development-phase planning and design documents live under `design/` (local reference, not uploaded to GitHub).
