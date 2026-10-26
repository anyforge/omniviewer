# Installation

## Download from Releases (recommended)

After release, download the installer for your platform from [GitHub Releases](https://github.com/anyforge/omniviewer/releases):

| Platform | Installer |
| --- | --- |
| macOS (Apple Silicon) | `Omniviewer_<version>_aarch64.dmg` |
| macOS (Intel) | `Omniviewer_<version>_x64.dmg` |
| Windows | `Omniviewer_<version>_x64-setup.exe` (or `.msi`) |
| Linux | `Omniviewer_<version>_amd64.AppImage` / `.deb` |

Download and open to install — no compilation needed.

## macOS first-launch authorization (no Developer ID yet)

The app is currently **unsigned / has no Apple Developer ID**, so macOS blocks the first launch. Two ways to allow it:

**Option 1: Right-click → Open**

1. Locate the app in Finder;
2. **Right-click → Open**;
3. Click **Open** again in the prompt — it launches (once is enough).

**Option 2: Remove the quarantine flag**

```bash
xattr -dr com.apple.quarantine /Applications/Omniviewer.app
```

> Once an Apple Developer ID and notarization are in place, this step will no longer be needed.

## Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 20 (26 used in dev) | Frontend build |
| pnpm | ≥ 9 (12 used in dev) | Package manager |
| Rust | ≥ 1.77 (1.99 used in dev) | Tauri backend |
| OS | macOS / Windows / Linux | Tauri 2 supported platforms |

macOS also needs Xcode Command Line Tools (`xcode-select --install`); Linux needs the Tauri system dependencies such as `webkit2gtk`.

## Build from source (self-build)

```bash
# 1. Install frontend dependencies
pnpm install

# 2. Run in development (the first Rust build is slow — expected)
pnpm tauri dev

# 3. Build the frontend only (tsc + vite, for quick checks)
pnpm build

# 4. Produce the release bundle (output in src-tauri/target/release/bundle/)
pnpm tauri build
```

### China mirror

Direct crates.io access may time out. This machine configures the rsproxy.cn sparse mirror in `~/.cargo/config.toml`:

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
```

## Install the CLI (terminal command)

End users don't need to compile the CLI manually — open the app → **Settings → About**, click "**Install CLI to PATH**". This copies the bundled `omniviewer` command to `~/.local/bin/omniviewer`, after which it works in the terminal.

> If the terminal still reports "command not found", `~/.local/bin` is not on your PATH. zsh users can add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc`.

## Build artifacts (developers)

After building from source, the `omniviewer` CLI binary is at `src-tauri/target/release/omniviewer` (CLI source in `crates/cli`; `tauri build` builds it automatically and ships it as a sidecar in the app). Its sub-commands:

```bash
omniviewer version
omniviewer status
omniviewer mcp --http --port 8765 --key <secret>
```
