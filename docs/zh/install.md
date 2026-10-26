# 安装说明

## 从 Release 下载（推荐）

发布后到 [GitHub Releases](https://github.com/anyforge/omniviewer/releases) 页面，下载对应平台的安装包：

| 平台 | 安装包 |
| --- | --- |
| macOS（Apple Silicon / M 系列） | `Omniviewer_<版本>_aarch64.dmg` |
| macOS（Intel） | `Omniviewer_<版本>_x64.dmg` |
| Windows | `Omniviewer_<版本>_x64-setup.exe`（或 `.msi`） |
| Linux | `Omniviewer_<版本>_amd64.AppImage` / `.deb` |

下载后双击安装即可，无需编译。

## macOS 首次打开授权（暂无开发者 ID）

应用目前**尚未签名 / 无 Apple Developer ID**，macOS 会拦截首次打开。两种方式放行：

**方式一：右键打开**

1. 在「访达」中找到应用图标；
2. **右键点击 → 打开**；
3. 弹出提示后再次点 **打开**，即可正常启动（只需一次）。

**方式二：命令行移除隔离标记**

```bash
xattr -dr com.apple.quarantine /Applications/Omniviewer.app
```

> 接入 Apple Developer ID 并完成公证（notarization）后，将不再需要此步骤。

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（开发用 26） | 前端构建 |
| pnpm | ≥ 9（开发用 12） | 包管理器 |
| Rust | ≥ 1.77（开发用 1.99） | Tauri 后端 |
| 系统 | macOS / Windows / Linux | Tauri 2 支持平台 |

macOS 还需 Xcode Command Line Tools（`xcode-select --install`）；Linux 需 `webkit2gtk` 等 Tauri 系统依赖。

## 从源码构建（自构建）

```bash
# 1. 安装前端依赖
pnpm install

# 2. 开发运行（首次编译 Rust 较慢，属正常）
pnpm tauri dev

# 3. 仅构建前端（tsc + vite，用于快速验证）
pnpm build

# 4. 打包发行版（产物在 src-tauri/target/release/bundle/）
pnpm tauri build
```

### 国内镜像

crates.io 直连可能超时（被墙）。本机已在 `~/.cargo/config.toml` 配置 rsproxy.cn 稀疏镜像：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
```

## 安装 CLI（终端命令）

普通用户无需手动编译 CLI——打开应用 → **设置 → 关于**，点「**安装 CLI 到 PATH**」，即可把随 App 打包的 `omniviewer` 命令安装到 `~/.local/bin/omniviewer`，之后在终端直接使用。

> 若安装后终端提示 command not found，说明 `~/.local/bin` 不在 PATH 里。zsh 用户可在 `~/.zshrc` 加一行：`export PATH="$HOME/.local/bin:$PATH"`。

## 编译产物（开发者）

从源码构建后，`omniviewer` CLI 二进制位于 `src-tauri/target/release/omniviewer`（CLI 源码在 `crates/cli`，Tauri 打包时会自动构建并作为 sidecar 随 App 分发），可直接使用其子命令：

```bash
omniviewer version
omniviewer status
omniviewer mcp --http --port 8765 --key <密钥>
```
