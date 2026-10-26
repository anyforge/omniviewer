# Changelog

本项目所有值得记录的改动都写在这里。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.5.0] - 2026-10-23

### Added
- 内容嗅探：未知扩展名 + UTF-8 纯文本 → 按文本打开（覆盖 .pub/.pem/.crt 及乱后缀文本文件）
- 文件图标：文件树按类型显示图标（文件夹/代码/图片/文档/压缩包/媒体/数据）
- 右键菜单：刷新 / 复制路径 / 在访达中显示
- 文件树元数据：行内显示大小 + 修改时间（MM-DD HH:mm）
- 文件树树形缩进：引导线体现层级（VSCode 式）
- 大文本分块读取：`read_file_range` 命令 + 滚动懒加载（分块默认 2MB，Phase 3 设置页可配置）
- Phase 2a GitHub 源：添加连接（账号 + 可选 Token）、浏览仓库/目录/文件、预览（fetch contents/blob API + base64 解码，raw 直链被墙故改走 API）
- 连接改为粘贴链接输入（支持 URL 或 owner/repo，自动解析），GitHub 可直达仓库
- Phase 2b GitLab 源：项目链接 + Token，浏览目录/文件、预览（fetch tree/raw API）
- Phase 2c HTTP 静态源：URL 连接，autoindex 目录浏览（best-effort 解析 HTML）+ 单文件预览
- Phase 2d WebDAV 源：URL + 用户名/密码，PROPFIND 目录浏览 + 文件预览
- Rust 引入 reqwest（rustls-tls）+ regex，绕过浏览器 CORS 拉取远程内容
- Phase 2e SFTP 源：`sftp://` 链接 + 密码，SSH 列目录/读文件（ssh2 vendored，无系统依赖）
- 凭证持久化：所有连接（含 token/密码）存 `~/.omniviewer/config.json`，启动自动加载、添加自动保存、可更换
- Phase 2f S3 源：`s3://endpoint/bucket?region=` 链接 + AK/SK，ListObjectsV2 目录浏览 + GetObject（rust-s3，SigV4）
- **Phase 2 完成**：本地 / GitHub / GitLab / HTTP / WebDAV / SFTP / S3 七个源全部可用
- Phase 3a 设置页：界面主题（深/浅）、代码主题（跟随/深/浅）、强调色（5 色）、界面字号、密度、大文本分块大小，全部持久化即时生效
- Phase 3b 语言 i18n：中英双语，默认英文，设置页切换即时生效（静态文案 data-i18n + 动态文案 t()）
- Phase 3c 远程文件本地缓存：打开过的远程文件缓存到 `~/.omniviewer/cache/`（key 哈希命名），二次打开秒开；设置页可查看缓存大小、一键清空
- Phase 4a 明水印：设置页配置（文字/字体/字号/颜色/透明度/角度/密度）+ 预览区平铺旋转叠加即时生效；P4 完整设计见 `docs/P4-DESIGN.md`
- 下载/另存：右击文件「另存为…」（本地复制 / 远程拉取写盘），右击文件或文件夹「压缩为 Zip…」（加密 ZipCrypto，密码在设置页配置）
- 远程文件夹下载：递归枚举 + 有界并发下载（并发数可在设置页配置）+ 进度条/取消；「压缩为 Zip」下载到临时目录再打包；本地文件夹「另存为」=递归复制
- 单文件分块并行下载（HTTP/WebDAV）：Range 请求分块并发，加速大文件下载
- Phase 4b 图片明水印导出：右击图片「另存为带水印…」→ 原图 + 水印烘焙为 PNG
- Phase 4e 图片暗水印（DCT 域 QIM）：右击图片「嵌入暗水印」（8×8 DCT 中频系数承载 marker+标识，抗轻度 JPEG 压缩）、「提取暗水印」（读回并显示标识）；研究级实现，不保证抗截图/重裁剪
- Phase 4d（文本）可去除明水印：右击文本/代码文件「嵌入可去除水印」（按语言注释语法加 OMNIVIEWER-WATERMARK 标记行）、「去除水印」（只剥离本软件标记行）
- Phase 4g 检索（初版）：搜索框实时过滤文件名；回车全文检索（本地文本/代码文件递归 grep，返回匹配行，最多 200 条）
- Phase 4f 屏幕水印（overlay）：设置页开关，预览区叠加低可视度点阵（左/右点编码标识比特，抗截图）；解码待做；剩余项调研见 `docs/P4-RESEARCH.md`
- Phase 4c 强绑定明水印导出：明水印配置映射给 file-viewer 原生 watermark 选项（导出/打印时烘焙）+ 右键「打印带水印」
- Phase 4e（docx）暗水印：右击 docx「嵌入暗水印」（ZIP+XML 注入不可见文本 marker+标识）、「提取暗水印」「去除水印」
- Phase 4e（PDF）暗水印：右击 pdf「嵌入暗水印」（keywords 元数据 marker + 每页白字）、「提取暗水印」「去除水印」（pdf-lib）
- Phase 4e（文本）零宽字符暗水印：右击文本「嵌入暗水印」（零宽字符编码标识，复制粘贴保留）、「提取暗水印」；「去除水印」同时剥离 marker 行和零宽
- Phase 4h 主题插件：`~/.omniviewer/themes/*.css` 作为自定义主题，设置页下拉可选
- Phase 4d（docx）明水印：右击 docx「嵌入可去除水印」（header VML 斜水印，带 marker）；「去除水印」同时剥离不可见文本 + VML 明水印
- Phase 4g 检索（Office 抽取）：全文检索扩展到 docx/xlsx/pptx（ZIP+XML 抽文本再 grep）；FTS5 索引暂缓（trigram 需 ≥3 字符查询、当前规模 grep 足够）
- Phase 4g 检索升级：FTS5 + jieba 索引（中英三通道分词：jieba 词 + 英文标识符 camelCase/snake_case 拆分 + 中文 2-gram），BM25 排序 + 增量（mtime 跳过）+ 短查询/空结果回退 grep；索引存 `~/.omniviewer/index.sqlite`
- 加密压缩包预览：接入 file-viewer 密码通道，自定义密码弹窗 + 按文件记忆密码（同文件同密码不重复输入，密码错/变更才重新弹窗并覆盖保存）
- 检索 snippet 改用原始文本窗口（索引额外存原文，非分词后文本，展示干净上下文）
- `omniviewer-core` lib crate：抽取/索引/搜索/水印/缓存/状态逻辑抽出共用，GUI（tauri）与 CLI 双入口
- `omniviewer` CLI（clap）：search（全文检索）/ index（建索引）/ cat（读文件抽文本）/ ls（列目录）/ cache（size/clear）/ wm（docx 水印 embed/visible/extract/remove）/ conn list / status / version 子命令
- MCP server（rmcp）：`omniviewer mcp`（stdio，本地智能体 spawn）+ `omniviewer mcp --http --port --host --key`（Streamable HTTP，本地+远程智能体），暴露 search / list_files / read_file / get_file_info 四个工具（JSON Schema 2020-12）
- Phase 4g 检索（PDF 抽取）：全文检索/索引扩展到 PDF（pdf-extract 文本层抽取）
- Phase 4f 屏幕水印解码：设置页「上传截图解码」，从截图恢复点阵编码的标识（溯源）
- Phase 4d（PDF）明水印：右击 pdf「嵌入明水印」（pdf-lib 每页平铺旋转文字，烘焙进内容、不可去除，复用设置页明水印配置；ASCII 文本）
- Phase 4g 远程全文（层1）：检索已缓存过的远程文件（缓存时记录 hash→源标识映射，索引用源标识作为路径回显；覆盖 GitHub/GitLab/HTTP/WebDAV/SFTP/S3）

### Fixed
- **代码预览语法高亮失效（无主题）**：highlight.js 的 `es/core.js` 相对引用 CJS `lib/core.js`，Vite dev 原样 serve 时 `module.exports` 拿不到 default 导出，导致 file-viewer 语法高亮静默回退为纯文本。补 `highlight.js` 为直接依赖 + `optimizeDeps.include: ["highlight.js/lib/core"]` 预打包，CJS→ESM 互操作后高亮 + Dracula/GitHub Light 代码主题正常生效
- 本地重活同步阻塞卡 UI：`read_file` / `list_dir` / `read_file_range` / `zip_paths` / `copy_path` / `extract_file_text` / `describe_structured` 全部改 async + `spawn_blocking`；预览区新增加载指示（转圈 +「加载中…」），大文件/大文件夹打开不再「卡一下突然出现」
- 本地文件/文件夹右键菜单补齐「刷新/编辑/更新/删除」四项（编辑=在访达中显示，删除=从数据源移除不删磁盘文件）
- Logo 满幅无留白导致 Dock 图标偏大：图形缩至 88% 居中留出安全边距，重新生成全套图标
- 预览工具栏收拢：隐藏 file-viewer 内置的下载/打印/明暗切换按钮（下载走浏览器 blob 无路径选择、打印依赖 window.print 在 WKWebView 无效、明暗切换与自有主题脱节）；新增自有「下载」按钮走原生另存为对话框（可选路径+文件名），明暗跟随设置页主题统一驱动
- 设置页水印区补使用/溯源说明：明水印（预览叠加 + 下载烘焙）与暗水印（填标识→嵌入→外传→提取溯源）各加提示文案，中英双语
- 搜索框升级为递归文件名模糊搜索：输入即触发（200ms 防抖）递归遍历当前目录，四级匹配（精准 > 前缀 > 子串 > 模糊子序列）排序，如 `onfig` 子串命中 `config`、`cnfg` 子序列命中 `config`；文件点击预览、目录点击进入；回车仍为全文内容检索（FTS5）；远程源退回渲染行过滤

### 已知边界（发布说明）
- 水印（明/暗/屏幕）为「研究级」：抗截图/重裁剪/拍屏不保证；屏幕水印解码需截图覆盖预览区，真机有内容噪声时检出率会下降
- PDF 明水印仅支持 ASCII 文本（中文需嵌入 CJK 字体）；PDF 检索仅覆盖含文本层的 PDF（扫描版无文本层搜不到）
- 远程全文检索只覆盖「已打开过（已缓存）」的远程文件
- 凭证存 OS 钥匙串（macOS Keychain / Windows 凭据管理器 / Linux Secret Service）；钥匙串不可用时回退明文存储

## [0.4.0] - 2026-10-22

### Added
- 本地目录树：打开文件夹 → 懒加载目录树（目录/文件排序、子目录展开收起、点击文件预览）
- 文件树显示文件大小（B/KB/MB/GB/PB），修改时间悬停提示
- 分割线拖拽：数据源 / 文件树分割线支持左右拖拽改变宽度
- 窗口默认尺寸加大到 1600×1000

## [0.3.0] - 2026-10-22

### Added
- 全格式预览：改用 preset-all（PDF / Office / OFD / 3D / 压缩包 / 邮件 / 电子书等 275 格式）
- 窗口默认尺寸加大（1440×900）

### Changed
- 剔除 CAD 渲染器（renderer-cad 依赖 AGPL 的 @flyfish-dev/cad-viewer，闭源商用有传染风险，且暂不需要）
- 不支持的格式显示「此格式暂不支持」，不再泄露「推荐安装 preset」开发者文案

## [0.2.0] - 2026-10-22

### Added
- Phase 1a：本地文件打开 + file-viewer 预览（preset-lite 格式：文本 / Markdown / 代码 / 图片 / 音视频）
- 集成 `@file-viewer/web`（Web Component）+ `@file-viewer/vite-plugin`（copyAssets）+ `@file-viewer/preset-lite`
- 集成 `tauri-plugin-dialog`（文件选择对话框）
- Rust 命令 `read_file`（读取本地文件字节）

## [0.1.0] - 2026-10-22

### Added
- 工程脚手架：Tauri 2 + Vite 8 + TypeScript（vanilla，无前端框架）
- 界面骨架：三栏布局（数据源连接列表 / 文件树 / 预览区）+ 标签栏 + 工具栏 + 状态栏
- 设计系统：深色主题 + 琥珀强调色，token 见 `docs/DESIGN.md`
- 开发阶段规划 `docs/PHASES.md` 与版本管理规范 `docs/VERSIONING.md`
- Rust 命令 `app_info`（返回应用名与版本，打通 invoke 桥）
