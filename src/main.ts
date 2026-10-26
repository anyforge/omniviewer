import { invoke } from "@tauri-apps/api/core";
import { open, save, message, confirm } from "@tauri-apps/plugin-dialog";
import { revealItemInDir, openUrl } from "@tauri-apps/plugin-opener";
import { defineFileViewerElement } from "@file-viewer/web";
import "@file-viewer/capability-rtf"; // RTF 预览（opt-in 能力）
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

// 注册 <flyfish-file-viewer> Web Component
defineFileViewerElement();

type FileViewerElement = HTMLElement & {
  buffer: ArrayBuffer;
  name: string;
  type?: string;
  options?: Record<string, unknown>;
};

// 树条目：本地与远程统一结构
type TreeEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number; // 0 = 未知（远程无修改时间）
  sha: string; // 仅 GitHub 文件
};

// 当前数据源
type Source =
  | { kind: "local" }
  | { kind: "github"; owner: string; repo: string; token: string }
  | { kind: "gitlab"; owner: string; repo: string; token: string }
  | { kind: "http"; base: string }
  | { kind: "webdav"; base: string; user: string; pass: string }
  | { kind: "sftp"; host: string; port: number; user: string; pass: string }
  | { kind: "s3"; endpoint: string; region: string; accessKey: string; secretKey: string; bucket: string };
let activeSource: Source = { kind: "local" };

// ---------- 打开文件 tab（多标签切换） ----------
interface OpenTab {
  id: string;
  name: string;
  source: Source;
  target: { path: string; repo?: string; sha?: string };
}
let openTabs: OpenTab[] = [];
let activeTabId = "";

function registerTab(name: string, target: { path: string; repo?: string; sha?: string }) {
  const id = `${activeSource.kind}:${target.path}`;
  const existing = openTabs.find((t) => t.id === id);
  if (existing) {
    existing.source = { ...activeSource };
    activeTabId = id;
  } else {
    openTabs.push({ id, name, source: { ...activeSource }, target: { ...target } });
    activeTabId = id;
  }
  renderTabs();
}

function openTabFile(tab: OpenTab) {
  const t = tab.target;
  const src = tab.source;
  if (src.kind === "local") previewFile(t.path);
  else if (src.kind === "github") previewGitHubFile(src.repo, t.path, t.sha ?? "", tab.name);
  else if (src.kind === "gitlab") previewGitLabFile(t.path, tab.name);
  else if (src.kind === "http") previewHttpFile(t.path, tab.name);
  else if (src.kind === "webdav") previewWebdavFile(t.path, tab.name);
  else if (src.kind === "sftp") previewSftpFile(t.path, tab.name);
  else previewS3File(t.path, tab.name);
}

function activateTab(id: string) {
  const tab = openTabs.find((t) => t.id === id);
  if (!tab) return;
  activeTabId = id;
  activeSource = tab.source;
  syncSidebarForTab(tab);
  openTabFile(tab);
  renderTabs();
}

function closeTab(id: string) {
  openTabs = openTabs.filter((t) => t.id !== id);
  if (activeTabId === id) {
    const next = openTabs[openTabs.length - 1];
    if (next) {
      activeTabId = next.id;
      activeSource = next.source;
      syncSidebarForTab(next);
      openTabFile(next);
    } else {
      activeTabId = "";
    }
  }
  renderTabs();
}

// 匹配连接与源（用于切 tab 时联动左栏选中）
function connMatches(c: Conn, s: Source): boolean {
  if (c.kind !== s.kind) return false;
  if (s.kind === "github" || s.kind === "gitlab") {
    const g = s as { owner: string; repo: string };
    return c.owner === g.owner && c.repo === g.repo;
  }
  if (s.kind === "http" || s.kind === "webdav") {
    return c.url === (s as { base: string }).base;
  }
  if (s.kind === "sftp") {
    const f = s as { host: string; port: number };
    return c.url === f.host && (c.port || 22) === f.port;
  }
  const b = s as { endpoint: string; bucket: string };
  return c.url === b.endpoint && c.root === b.bucket;
}

function highlightRailConn(s: Source) {
  document.querySelectorAll(".rail .conn").forEach((el) => el.classList.remove("active"));
  if (s.kind === "local") {
    renderLocalConns();
    return;
  }
  const idx = conns.findIndex((c) => connMatches(c, s));
  if (idx >= 0) document.querySelector<HTMLElement>(`.rail .conn[data-cid="${idx}"]`)?.classList.add("active");
}

// 本地目录树（多个已打开目录，按文件夹名显示）
function renderLocalConns() {
  const container = $("local-conns");
  const count = $("local-count");
  if (count) count.textContent = String(openLocalFolders.length + openLocalFiles.length);
  if (!container) return;

  const makeEntry = (path: string, isDir: boolean) => {
    const conn = document.createElement("div");
    const active = isDir
      ? path === currentRoot && activeSource.kind === "local"
      : path === currentPreviewPath && activeSource.kind === "local";
    conn.className = "conn" + (active ? " active" : "");
    const name = path.split(/[\\/]/).pop() || path;
    conn.innerHTML = `<span class="ico">${isDir ? "⌂" : "▤"}</span><span class="name"></span>`;
    (conn.querySelector(".name") as HTMLElement).textContent = name;
    conn.title = path;
    conn.addEventListener("click", async () => {
      document.querySelectorAll(".rail .conn").forEach((c) => c.classList.remove("active"));
      conn.classList.add("active");
      activeSource = { kind: "local" };
      setCrumbSource("local");
      const crumbPath = $("crumb-path");
      if (crumbPath) crumbPath.textContent = path;
      if (isDir) {
        currentRoot = path;
        conn.classList.add("loading");
        setTreeBusy(true);
        try {
          await renderDir(path, true);
        } catch (e) {
          console.error("读取目录失败", e);
          showError(e);
        } finally {
          conn.classList.remove("loading");
          setTreeBusy(false);
        }
      } else {
        currentPreviewPath = path;
        previewFile(path);
      }
    });
    return conn;
  };

  container.innerHTML = "";
  openLocalFolders.forEach((dir) => container.appendChild(makeEntry(dir, true)));
  openLocalFiles.forEach((file) => container.appendChild(makeEntry(file, false)));
}

// 数据源分组折叠
function setupGroupToggle() {
  document.querySelectorAll(".rail .group-head").forEach((head) => {
    head.addEventListener("click", () => {
      head.classList.toggle("collapsed");
      const next = head.nextElementSibling as HTMLElement | null;
      if (next) next.style.display = next.style.display === "none" ? "" : "none";
    });
  });
}

function highlightTreeRow(path: string) {
  document.querySelectorAll(".tree .row").forEach((r) => r.classList.remove("sel"));
  const row = Array.from(document.querySelectorAll<HTMLElement>(".tree .row")).find((r) => r.dataset.path === path);
  row?.classList.add("sel");
}

// 切 tab 时联动：左栏选中 + 文件树选中
async function syncSidebarForTab(tab: OpenTab) {
  const s = tab.source;
  if (s.kind === "local") {
    const owner = openLocalFolders.find((f) => tab.target.path.startsWith(f));
    if (owner) currentRoot = owner;
    if (openLocalFiles.includes(tab.target.path)) currentPreviewPath = tab.target.path;
  }
  highlightRailConn(s);
  if (s.kind === "local") {
    const parent = tab.target.path.split(/[\\/]/).slice(0, -1).join("/") || "/";
    try {
      await renderDir(parent, true);
      highlightTreeRow(tab.target.path);
    } catch { /* ignore */ }
  } else {
    const idx = conns.findIndex((c) => connMatches(c, s));
    if (idx >= 0) {
      try {
        await openRemoteConnection(conns[idx]);
      } catch { /* ignore */ }
    }
  }
}

function renderTabs() {
  const strip = $("tabstrip");
  if (!strip) return;
  strip.innerHTML = "";
  for (const tab of openTabs) {
    const div = document.createElement("div");
    div.className = "tab" + (tab.id === activeTabId ? " active" : "");
    div.title = tab.target.path;
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = tab.source.kind === "local" ? "#e6a23c" : "#5b8def";
    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = tab.name;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = "×";
    div.appendChild(dot);
    div.appendChild(name);
    div.appendChild(x);
    div.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("x")) closeTab(tab.id);
      else activateTab(tab.id);
    });
    strip.appendChild(div);
  }
}

type ConnKind = "github" | "gitlab" | "http" | "webdav" | "sftp" | "s3";
type Conn = {
  kind: ConnKind;
  owner: string; // github/gitlab 账号
  repo: string; // github/gitlab 仓库
  url: string; // http/webdav URL；sftp host；s3 endpoint
  user: string; // webdav/sftp 用户名；s3 access key
  token: string; // github/gitlab token / webdav/sftp 密码 / s3 secret key
  port: number; // sftp 端口
  root: string; // sftp 根路径；s3 bucket
  region: string; // s3 region
};
let conns: Conn[] = [];

// file-viewer 已知支持的扩展名（源自其格式矩阵，剔除 CAD 后的白名单）。
const KNOWN_EXTS = new Set(
  `
txt lrc log md markdown js mjs cjs jsx ts tsx json jsonc json5 xml yaml yml toml ini htm html css vue py java go rs c cpp cc h hpp cs diff patch bundle bdl php rb swift kt sh bash sql proto hcl tex gv graphviz http react ipynb
doc docx docm dot dotx dotm odt odp rtf
xls xlsx xltx xlsm xlsb xlt xla xlam xltm csv tsv ods fods dbf
ppt pot pptx pptm potx potm ppsx ppsm
pdf ofd typ typst pages numbers key keynote wpd wp wp5 wp6 hwp hwpx
drawio dio excalidraw mermaid mmd plantuml puml
stl obj gltf glb fbx dae 3ds 3mf amf ply pcd vrml wrl vtk vtp xyz usd usda usdc usdz kmz step stp iges igs ifc 3dm brep
zip zipx 7z rar tar gz gzip tgz bz2 bzip2 tbz tbz2 xz txz lzma zst tzst cab ar cpio iso xar lha lzh jar war ear apk cbz cbr
chm eml msg mbox epub fb2 umd
jpg jpeg png gif webp svg bmp tiff tif avif ico heic heif jxl
mp3 mpeg wav ogg oga opus flac aac m4a mp4 webm weba mov m3u8 midi mid
xmind geojson kml gpx shp
sqlite db sqlite3 parquet avro webarchive wasm ttf otf woff woff2
gds oas oasis olb dra dsn
`.trim().split(/\s+/),
);

// 文本类扩展名（小文件走 file-viewer 语法高亮，大文件走分块文本预览）
const TEXT_EXTS = new Set(
  "txt lrc log md markdown code js mjs cjs jsx ts tsx json jsonc json5 xml yaml yml toml ini htm html css vue py java go rs c cpp cc h hpp cs diff patch php rb swift kt sh bash sql proto hcl tex gv graphviz http react ipynb".split(" "),
);

// 结构化数据 / 模型文件：走 Rust 侧结构解析（非 file-viewer 渲染）
const STRUCTURED_EXTS = new Set(
  "parquet arrow feather safetensors gguf onnx pt pth h5 hdf5 keras tflite".split(" "),
);

// 文件图标（Material Icon Theme 风格：彩色填充；代码文件按语言着色）
const ICONS: Record<string, string> = {
  folder:
    '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1.75 3.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .8.4l1.05 1.6h5.55a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" fill="#dcb67a"/></svg>',
  file: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="#c5c5c5"/><path d="M9.25 1.75v3.5h3.5z" fill="#9aa0a6"/></svg>',
  image:
    '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="#4eb27e"/><path d="M9.25 1.75v3.5h3.5z" fill="#3d9568"/><circle cx="6" cy="7" r="1.1" fill="#fff"/><path d="M4 11.2l2.3-2.5 1.6 1.7 1.2-1.3 1.9 2.1z" fill="#fff" opacity=".85"/></svg>',
  doc: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="#4a9eff"/><path d="M9.25 1.75v3.5h3.5z" fill="#3d86d9"/><path d="M4.75 9h6.5M4.75 11h6.5M4.75 7h4" stroke="#fff" stroke-width="1" stroke-linecap="round"/></svg>',
  archive:
    '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="#b98a5a"/><path d="M9.25 1.75v3.5h3.5z" fill="#9c7350"/><path d="M8 5.25v7" stroke="#fff" stroke-width="1.1" stroke-dasharray="1.6 1.2"/></svg>',
  media:
    '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="#d1495b"/><path d="M9.25 1.75v3.5h3.5z" fill="#b03d4d"/><path d="M6.6 7.2v3.6l3.2-1.8z" fill="#fff"/></svg>',
  data: '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="#4fc1e8"/><path d="M9.25 1.75v3.5h3.5z" fill="#3ba3c9"/><ellipse cx="8" cy="6.3" rx="3.2" ry="1.4" fill="#fff" opacity=".9"/><path d="M4.8 6.3v3.4c0 .8 1.4 1.4 3.2 1.4s3.2-.6 3.2-1.4V6.3" fill="none" stroke="#fff" stroke-width=".9" opacity=".9"/></svg>',
};

// 代码语言 → 文件图标颜色（Material 风格）
const CODE_LANG_COLORS: Record<string, string> = {
  js: "#f1dd35", mjs: "#f1dd35", cjs: "#f1dd35", jsx: "#61dafb",
  ts: "#3178c6", tsx: "#3178c6",
  py: "#3776ab",
  go: "#00add8",
  rs: "#dea584",
  java: "#e76f00",
  c: "#5a6b7c", cpp: "#5a6b7c", cc: "#5a6b7c", h: "#5a6b7c", hpp: "#5a6b7c",
  cs: "#68217a",
  php: "#777bb3",
  rb: "#cc342d",
  swift: "#f05138",
  kt: "#7f52ff",
  sh: "#89e051", bash: "#89e051", zsh: "#89e051",
  sql: "#e38c00",
  html: "#e44d26", htm: "#e44d26",
  css: "#1572b6",
  vue: "#42b883",
  json: "#cbcb41", jsonc: "#cbcb41", json5: "#cbcb41",
  yaml: "#cb171e", yml: "#cb171e",
  toml: "#9c4221",
  xml: "#e34f26",
};

function codeIcon(color: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.25 1.75h6l3.5 3.5v9h-9.5z" fill="${color}"/><path d="M9.25 1.75v3.5h3.5z" fill="rgba(0,0,0,.2)"/><path d="M5.8 8.4L4.6 9.6l1.2 1.2M10.2 8.4l1.2 1.2-1.2 1.2" stroke="#fff" stroke-width=".9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

const CODE_EXTS = new Set(
  "js mjs cjs jsx ts tsx py rs go java c cpp cc h hpp cs php rb swift kt sh bash sql proto hcl vue html htm css json jsonc json5 yaml yml toml xml diff patch ini".split(" "),
);
const IMAGE_EXTS = new Set("png jpg jpeg gif webp svg bmp tiff tif avif ico heic heif jxl".split(" "));
const DOC_EXTS = new Set("pdf ofd doc docx xls xlsx ppt pptx odt odp rtf md markdown txt log lrc".split(" "));
const ARCHIVE_EXTS = new Set("zip zipx 7z rar tar gz gzip tgz bz2 tbz tbz2 xz txz lzma zst tzst cab iso jar war ear apk".split(" "));
const MEDIA_EXTS = new Set("mp3 mpeg wav ogg oga opus flac aac m4a mp4 webm weba mov m3u8 midi mid avi mkv".split(" "));
const DATA_EXTS = new Set("csv tsv sqlite db sqlite3 parquet avro geojson kml gpx shp xmind".split(" "));

function iconFor(entry: TreeEntry): string {
  if (entry.is_dir) return ICONS.folder;
  const ext = extOf(entry.name);
  if (CODE_EXTS.has(ext)) return codeIcon(CODE_LANG_COLORS[ext] ?? "#3b82f6");
  if (IMAGE_EXTS.has(ext)) return ICONS.image;
  if (DOC_EXTS.has(ext)) return ICONS.doc;
  if (ARCHIVE_EXTS.has(ext)) return ICONS.archive;
  if (MEDIA_EXTS.has(ext)) return ICONS.media;
  if (DATA_EXTS.has(ext)) return ICONS.data;
  return ICONS.file;
}

// 分块大小默认 2MB，设置页可配置
let CHUNK_SIZE = 2 * 1024 * 1024;
const LARGE_FILE = 4 * 1024 * 1024; // 超过此大小的文本走分块懒加载
const SNIFF_BYTES = 256 * 1024; // 内容嗅探读取的头部字节数

type Lang = "en" | "zh";

// 应用设置（Phase 3）
type Settings = {
  language: Lang;
  theme: "dark" | "light";
  fontSize: number; // 界面字号 px
  density: "compact" | "comfortable";
  chunkMb: number; // 分块大小 MB
  uiDark: Record<string, string>; // 界面配色（暗）
  uiLight: Record<string, string>; // 界面配色（亮）
  codeDark: Record<string, string>; // 代码语法配色（暗，默认 Dracula）
  codeLight: Record<string, string>; // 代码语法配色（亮，默认 GitHub Light）
  // 明水印
  wmEnabled: boolean;
  wmText: string;
  wmFont: "sans" | "serif" | "mono";
  wmSize: number;
  wmColor: string;
  wmOpacity: number; // 0-100
  wmAngle: number; // 度
  wmDensity: "low" | "medium" | "high";
  zipPassword: string; // Zip 加密密码，空 = 不加密
  zipPasswords: string[]; // 已保存的 Zip 密码列表
  dlConcurrency: number; // 下载并发数
  wmUserId: string; // 暗水印标识（溯源）
  wmScreen: boolean; // 屏幕水印（低可视度点阵，抗截图）
};

// 界面配色元素（设置页调色板，key → i18n 标签）
const UI_COLORS: [string, string][] = [
  ["background", "settings.ui.background"], ["panel", "settings.ui.panel"],
  ["raised", "settings.ui.raised"], ["border", "settings.ui.border"],
  ["text", "settings.ui.text"], ["muted", "settings.ui.muted"],
  ["faint", "settings.ui.faint"], ["accent", "settings.ui.accent"],
];
const CODE_COLORS: [string, string][] = [
  ["background", "settings.code.background"], ["foreground", "settings.code.foreground"],
  ["comment", "settings.code.comment"], ["keyword", "settings.code.keyword"],
  ["string", "settings.code.string"], ["number", "settings.code.number"],
  ["func", "settings.code.func"], ["type", "settings.code.type"],
  ["variable", "settings.code.variable"],
];
const UI_VAR: Record<string, string> = {
  background: "--win-bg", panel: "--panel", raised: "--raised", border: "--border",
  text: "--text", muted: "--muted", faint: "--faint", accent: "--accent",
};
const CODE_VAR: Record<string, string> = {
  background: "--code-bg", foreground: "--code-fg", comment: "--code-comment",
  keyword: "--code-keyword", string: "--code-string", number: "--code-number",
  func: "--code-func", type: "--code-type", variable: "--code-variable",
};
const DEFAULT_UI_DARK: Record<string, string> = {
  background: "#14171b", panel: "#171a1f", raised: "#1d2126", border: "#262b31",
  text: "#f2f4f7", muted: "#b4bbc4", faint: "#9099a5", accent: "#e6a23c",
};
const DEFAULT_UI_LIGHT: Record<string, string> = {
  background: "#ffffff", panel: "#f7f7f8", raised: "#efeff1", border: "#d9d9de",
  text: "#1a1c20", muted: "#5a6270", faint: "#8a929e", accent: "#e6a23c",
};
const DEFAULT_CODE_DARK: Record<string, string> = {
  background: "#282a36", foreground: "#f8f8f2", comment: "#6272a4", keyword: "#ff79c6",
  string: "#f1fa8c", number: "#bd93f9", func: "#50fa7b", type: "#8be9fd", variable: "#f8f8f2",
};
const DEFAULT_CODE_LIGHT: Record<string, string> = {
  background: "#ffffff", foreground: "#24292e", comment: "#6a737d", keyword: "#d73a49",
  string: "#032f62", number: "#005cc5", func: "#6f42c1", type: "#005cc5", variable: "#24292e",
};

const DEFAULT_SETTINGS: Settings = {
  language: "en",
  theme: "dark",
  fontSize: 13,
  density: "comfortable",
  chunkMb: 2,
  uiDark: { ...DEFAULT_UI_DARK },
  uiLight: { ...DEFAULT_UI_LIGHT },
  codeDark: { ...DEFAULT_CODE_DARK },
  codeLight: { ...DEFAULT_CODE_LIGHT },
  wmEnabled: false,
  wmText: "Omniviewer",
  wmFont: "sans",
  wmSize: 24,
  wmColor: "#e53935",
  wmOpacity: 12,
  wmAngle: 30,
  wmDensity: "medium",
  zipPassword: "",
  zipPasswords: [],
  dlConcurrency: 4,
  wmUserId: "user",
  wmScreen: false,
};
let settings: Settings = { ...DEFAULT_SETTINGS };

const WM_FONTS: Record<string, string> = {
  sans: "-apple-system, system-ui, sans-serif",
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"SF Mono", Menlo, monospace',
};
const WM_SPACING: Record<string, number> = { low: 340, medium: 220, high: 130 };

// 语言字典（默认英文，可在设置页切中文）
const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    "tab.preview": "预览",
    "btn.openFolder": "打开文件夹",
    "btn.openFile": "打开文件",
    "btn.settings": "设置",
    "crumb.path.none": "未打开",
    "search.placeholder": "搜索文件…",
    "search.clear": "清除",
    "rail.sources": "数据源",
    "rail.add": "添加连接",
    "group.local": "本地",
    "conn.workingDir": "工作目录",
    "tree.files": "文件树",
    "tree.empty": "点击「打开文件夹」浏览本地目录，或「＋添加连接」接入远程源",
    "tree.loading": "加载中…",
    "pw.toggle": "显示",
    "pw.hide": "隐藏",
    "preview.title": "预览",
    "preview.loading": "加载中…",
    "preview.download": "下载",
    "preview.none": "未打开文件",
    "preview.empty.sub": "选择文件开始预览",
    "status.ready": "就绪",
    "status.lines": "行",
    "status.chars": "字",
    "ctx.refresh": "刷新",
    "ctx.copyPath": "复制路径",
    "ctx.reveal": "在访达中显示",
    "ctx.edit": "编辑",
    "ctx.update": "更新",
    "ctx.delete": "删除",
    "connModal.title": "添加数据源连接",
    "connModal.editTitle": "编辑数据源连接",
    "connModal.cancel": "取消",
    "connModal.ok": "添加",
    "connModal.save": "保存",
    "connModal.repo": "仓库",
    "connModal.token": "Token",
    "connModal.user": "用户名",
    "connModal.pass": "密码",
    "connModal.host": "主机",
    "connModal.port": "端口",
    "connModal.root": "路径（默认 /）",
    "connModal.region": "区域",
    "connModal.githubHint": "GitHub 仓库，如 https://github.com/owner/repo 或 owner/repo；私有仓库填 Token。",
    "connModal.gitlabHint": "GitLab 项目完整链接，如 https://gitlab.com/group/project。",
    "connModal.httpHint": "静态文件服务器地址，如 http://server/（支持 autoindex 目录列表）。",
    "connModal.davHint": "WebDAV 共享地址 + 凭证。",
    "connModal.sftpHint": "SSH 服务器，如 host 或 sftp://user@host:port/path。",
    "connModal.s3Hint": "S3 兼容存储，Endpoint 如 https://s3.amazonaws.com。",
    "connType.http": "HTTP 静态",
    "settings.title": "设置",
    "btn.add": "新建",
    "settings.tab.general": "常规",
    "settings.tab.theme": "主题",
    "settings.tab.watermark": "水印",
    "settings.tab.download": "下载",
    "settings.tab.about": "关于",
    "settings.about.version": "版本",
    "settings.about.author": "作者",
    "settings.about.update": "更新",
    "settings.about.checkUpdate": "检查更新",
    "settings.about.newer": "发现新版本 v{v}，是否前往下载页？",
    "settings.about.latest": "已是最新版本",
    "settings.about.download": "前往下载",
    "settings.about.later": "以后再说",
    "settings.about.checkFailed": "检查更新失败，请检查网络后重试",
    "settings.about.cli": "omniviewer CLI",
    "settings.about.installCli": "安装 CLI 到 PATH",
    "settings.about.cliHint": "安装后可在终端直接运行 omniviewer（~/.local/bin）",
    "settings.language": "语言",
    "settings.theme": "界面主题",
    "settings.theme.dark": "深色",
    "settings.theme.light": "浅色",
    "settings.ui.dark": "界面配色 · 深色",
    "settings.ui.light": "界面配色 · 浅色",
    "settings.ui.background": "背景",
    "settings.ui.panel": "面板",
    "settings.ui.raised": "浮起",
    "settings.ui.border": "边框",
    "settings.ui.text": "文字",
    "settings.ui.muted": "次要文字",
    "settings.ui.faint": "弱文字",
    "settings.ui.accent": "强调色",
    "settings.code.dark": "代码配色 · 深色（Dracula）",
    "settings.code.light": "代码配色 · 浅色（GitHub Light）",
    "settings.code.background": "背景",
    "settings.code.foreground": "前景",
    "settings.code.comment": "注释",
    "settings.code.keyword": "关键字",
    "settings.code.string": "字符串",
    "settings.code.number": "数字",
    "settings.code.func": "函数",
    "settings.code.type": "类型",
    "settings.code.variable": "变量",
    "settings.fontSize": "界面字号",
    "settings.fontSize.small": "小",
    "settings.fontSize.normal": "标准",
    "settings.fontSize.large": "大",
    "settings.density": "界面密度",
    "settings.density.compact": "紧凑",
    "settings.density.comfortable": "舒适",
    "settings.chunk": "大文本分块大小（MB）",
    "settings.cache": "预览缓存",
    "settings.cacheClear": "清空缓存",
    "settings.close": "关闭",
    "unit.items": "项",
    "unit.repos": "个仓库",
    "error.connFailed": "连接失败",
    "unsupported.title": "此格式暂不支持",
    "unsupported.message": "Omniviewer 暂不支持预览此格式。",
    "text.text": "文本",
    "meta.modified": "修改时间：",
    "settings.wm": "明水印",
    "settings.wmOn": "开",
    "settings.wmOff": "关",
    "settings.wmText": "水印文字",
    "settings.wmFont": "字体",
    "settings.wmFont.sans": "系统",
    "settings.wmFont.serif": "衬线",
    "settings.wmFont.mono": "等宽",
    "settings.wmSize": "字号",
    "settings.wmColor": "明水印颜色",
    "settings.wmOpacity": "透明度（%）",
    "settings.wmAngle": "旋转角度（°）",
    "settings.wmDensity": "密度",
    "settings.wmDensity.low": "低",
    "settings.wmDensity.medium": "中",
    "settings.wmDensity.high": "高",
    "settings.wmUserId": "暗水印标识",
    "settings.wmScreen": "屏幕水印（抗截图点阵）",
    "settings.wmDecode": "解码屏幕水印（溯源）",
    "settings.wmDecodeBtn": "上传截图解码",
    "settings.wmDecodeFail": "未检测到水印",
    "ctx.saveWatermark": "另存为带水印…",
    "ctx.embedWatermark": "嵌入暗水印",
    "ctx.extractWatermark": "提取暗水印",
    "ctx.printWatermark": "打印带水印",
    "ctx.embedTextWatermark": "嵌入可去除水印",
    "ctx.embedPdfVisible": "嵌入明水印（PDF）",
    "ctx.removeTextWatermark": "去除水印",
    "wm.needEnable": "请先在设置中开启并配置明水印",
    "wm.tooSmall": "图片太小，无法嵌入暗水印",
    "wm.notFound": "未检测到暗水印",
    "wm.textNotFound": "未检测到本软件的水印",
    "wm.pdfAsciiOnly": "PDF 明水印暂仅支持 ASCII 文本（中文需嵌入字体）",
    "ctx.saveAs": "另存为…",
    "ctx.zip": "压缩为 Zip…",
    "settings.zipPassword": "Zip 加密密码（留空=不加密）",
    "settings.zipPassword.ph": "可选",
    "settings.zipPassword.none": "不加密",
    "settings.zipPw.add": "添加",
    "settings.zipPw.del": "删除",
    "settings.wmVisible": "明水印",
    "settings.wmVisible.hint": "看得见，防拍屏/截图外传。开启后预览区实时平铺叠加；下载带水印：右键图片「另存为带水印」、右键 PDF「嵌入明水印」、右键 Word「嵌入可去除水印」。",
    "settings.wmInvisible": "暗水印",
    "settings.wmInvisible.hint": "看不见，用于溯源外泄者。① 上方填标识（工号/邮箱）② 右键文件「嵌入暗水印」③ 外传后对泄露文件右键「提取暗水印」查出是谁。屏幕水印：开开关 → 截图外泄 → 下方「上传截图解码」溯源。",
    "settings.wmUserId.ph": "user",
    "settings.dlConcurrency": "下载并发数",
    "dl.allFiles": "所有文件",
    "archivePw.title": "输入密码",
    "archivePw.description": "此压缩包已加密，请输入密码",
    "archivePw.placeholder": "密码",
    "archivePw.invalid": "密码错误，请重试",
    "archivePw.cancel": "取消",
    "archivePw.confirm": "确定",
    "dl.chooseDir": "选择目标文件夹",
    "progress.title": "下载中",
    "progress.preparing": "准备中…",
    "progress.files": "已下载 {done}/{total}",
    "progress.cancel": "取消",
    "search.title": "搜索结果",
    "search.noResults": "无结果",
    "search.dir": "目录",
    "search.localOnly": "全文搜索暂只支持本地文件",
    "search.notCached": "该远程文件尚未缓存（需先打开过才能检索）",
    "search.searching": "搜索中…",
    "error.title": "操作失败",
    "dialog.openFile": "选择要预览的文件",
    "dialog.openFolder": "选择文件夹",
  },
  en: {
    "tab.preview": "Preview",
    "btn.openFolder": "Open Folder",
    "btn.openFile": "Open File",
    "btn.settings": "Settings",
    "crumb.path.none": "Not opened",
    "search.placeholder": "Search files…",
    "search.clear": "Clear",
    "rail.sources": "Sources",
    "rail.add": "Add Connection",
    "group.local": "Local",
    "conn.workingDir": "Working Directory",
    "tree.files": "Files",
    "tree.empty": "Click \"Open Folder\" to browse a local directory, or \"＋ Add Connection\" to add a remote source",
    "tree.loading": "Loading…",
    "pw.toggle": "Show",
    "pw.hide": "Hide",
    "preview.title": "Preview",
    "preview.loading": "Loading…",
    "preview.download": "Download",
    "preview.none": "No file opened",
    "preview.empty.sub": "Select a file to preview",
    "status.ready": "Ready",
    "status.lines": "Ln",
    "status.chars": "Ch",
    "ctx.refresh": "Refresh",
    "ctx.copyPath": "Copy Path",
    "ctx.reveal": "Reveal in Finder",
    "ctx.edit": "Edit",
    "ctx.update": "Update",
    "ctx.delete": "Delete",
    "connModal.title": "Add Source Connection",
    "connModal.editTitle": "Edit Source Connection",
    "connModal.cancel": "Cancel",
    "connModal.ok": "Add",
    "connModal.save": "Save",
    "connModal.repo": "Repository",
    "connModal.token": "Token",
    "connModal.user": "Username",
    "connModal.pass": "Password",
    "connModal.host": "Host",
    "connModal.port": "Port",
    "connModal.root": "Path (default /)",
    "connModal.region": "Region",
    "connModal.githubHint": "GitHub repo, e.g. https://github.com/owner/repo or owner/repo. Add a token for private repos.",
    "connModal.gitlabHint": "Full GitLab project URL, e.g. https://gitlab.com/group/project.",
    "connModal.httpHint": "Static file server URL, e.g. http://server/ (autoindex listing supported).",
    "connModal.davHint": "WebDAV share URL + credentials.",
    "connModal.sftpHint": "SSH server, e.g. host or sftp://user@host:port/path.",
    "connModal.s3Hint": "S3-compatible storage; endpoint e.g. https://s3.amazonaws.com.",
    "connType.http": "HTTP static",
    "settings.title": "Settings",
    "btn.add": "New",
    "settings.tab.general": "General",
    "settings.tab.theme": "Theme",
    "settings.tab.watermark": "Watermark",
    "settings.tab.download": "Download",
    "settings.tab.about": "About",
    "settings.about.version": "Version",
    "settings.about.author": "Author",
    "settings.about.update": "Update",
    "settings.about.checkUpdate": "Check for Updates",
    "settings.about.newer": "New version v{v} is available. Go to the download page?",
    "settings.about.latest": "You're on the latest version",
    "settings.about.download": "Download",
    "settings.about.later": "Later",
    "settings.about.checkFailed": "Update check failed. Check your network and try again.",
    "settings.about.cli": "omniviewer CLI",
    "settings.about.installCli": "Install CLI to PATH",
    "settings.about.cliHint": "After install, run `omniviewer` in terminal (~/.local/bin)",
    "settings.language": "Language",
    "settings.theme": "UI Theme",
    "settings.theme.dark": "Dark",
    "settings.theme.light": "Light",
    "settings.ui.dark": "UI colors · Dark",
    "settings.ui.light": "UI colors · Light",
    "settings.ui.background": "Background",
    "settings.ui.panel": "Panel",
    "settings.ui.raised": "Raised",
    "settings.ui.border": "Border",
    "settings.ui.text": "Text",
    "settings.ui.muted": "Muted",
    "settings.ui.faint": "Faint",
    "settings.ui.accent": "Accent",
    "settings.code.dark": "Code colors · Dark (Dracula)",
    "settings.code.light": "Code colors · Light (GitHub Light)",
    "settings.code.background": "Background",
    "settings.code.foreground": "Foreground",
    "settings.code.comment": "Comment",
    "settings.code.keyword": "Keyword",
    "settings.code.string": "String",
    "settings.code.number": "Number",
    "settings.code.func": "Function",
    "settings.code.type": "Type",
    "settings.code.variable": "Variable",
    "settings.fontSize": "Font Size",
    "settings.fontSize.small": "Small",
    "settings.fontSize.normal": "Normal",
    "settings.fontSize.large": "Large",
    "settings.density": "Density",
    "settings.density.compact": "Compact",
    "settings.density.comfortable": "Comfortable",
    "settings.chunk": "Chunk Size (MB)",
    "settings.cache": "Preview Cache",
    "settings.cacheClear": "Clear Cache",
    "settings.close": "Close",
    "unit.items": "items",
    "unit.repos": "repos",
    "error.connFailed": "Connection failed",
    "unsupported.title": "This format is not supported",
    "unsupported.message": "Omniviewer cannot preview this format yet.",
    "text.text": "text",
    "meta.modified": "Modified: ",
    "settings.wm": "Visible Watermark",
    "settings.wmOn": "On",
    "settings.wmOff": "Off",
    "settings.wmText": "Watermark Text",
    "settings.wmFont": "Font",
    "settings.wmFont.sans": "System",
    "settings.wmFont.serif": "Serif",
    "settings.wmFont.mono": "Monospace",
    "settings.wmSize": "Font Size",
    "settings.wmColor": "Visible watermark color",
    "settings.wmOpacity": "Opacity (%)",
    "settings.wmAngle": "Angle (°)",
    "settings.wmDensity": "Density",
    "settings.wmDensity.low": "Low",
    "settings.wmDensity.medium": "Medium",
    "settings.wmDensity.high": "High",
    "settings.wmUserId": "Watermark ID",
    "settings.wmScreen": "Screen watermark (anti-screenshot dots)",
    "settings.wmDecode": "Decode screen watermark",
    "settings.wmDecodeBtn": "Upload screenshot",
    "settings.wmDecodeFail": "No watermark detected",
    "ctx.saveWatermark": "Save with Watermark…",
    "ctx.embedWatermark": "Embed Invisible Watermark",
    "ctx.extractWatermark": "Extract Invisible Watermark",
    "ctx.printWatermark": "Print with watermark",
    "ctx.embedTextWatermark": "Embed Removable Watermark",
    "ctx.embedPdfVisible": "Embed Visible Watermark (PDF)",
    "ctx.removeTextWatermark": "Remove Watermark",
    "wm.needEnable": "Enable and configure the visible watermark in Settings first.",
    "wm.tooSmall": "Image too small to embed the invisible watermark.",
    "wm.notFound": "No invisible watermark detected.",
    "wm.textNotFound": "No Omniviewer watermark detected.",
    "wm.pdfAsciiOnly": "PDF visible watermark supports ASCII text only.",
    "ctx.saveAs": "Save As…",
    "ctx.zip": "Compress to Zip…",
    "settings.zipPassword": "Zip password (empty = no encryption)",
    "settings.zipPassword.ph": "Optional",
    "settings.zipPassword.none": "No encryption",
    "settings.zipPw.add": "Add",
    "settings.zipPw.del": "Remove",
    "settings.wmVisible": "Visible watermark",
    "settings.wmVisible.hint": "Visible — deters screen capture / photo leaks. When enabled it overlays the preview in real time. To bake it into a file: right-click an image → \"Save with watermark\", PDF → \"Embed visible watermark\", Word → \"Embed removable watermark\".",
    "settings.wmInvisible": "Invisible watermark",
    "settings.wmInvisible.hint": "Invisible — traces who leaked a file. ① Fill in an identifier (staff ID/email) above ② right-click a file → \"Embed invisible watermark\" ③ after a leak, right-click the leaked file → \"Extract invisible watermark\" to identify the source. Screen watermark: enable → screenshot leaks → \"Upload screenshot to decode\" below.",
    "settings.wmUserId.ph": "user",
    "settings.dlConcurrency": "Download concurrency",
    "dl.allFiles": "All Files",
    "archivePw.title": "Enter Password",
    "archivePw.description": "This archive is encrypted. Enter the password.",
    "archivePw.placeholder": "Password",
    "archivePw.invalid": "Wrong password, try again.",
    "archivePw.cancel": "Cancel",
    "archivePw.confirm": "OK",
    "dl.chooseDir": "Choose destination folder",
    "progress.title": "Downloading",
    "progress.preparing": "Preparing…",
    "progress.files": "Downloaded {done}/{total}",
    "progress.cancel": "Cancel",
    "search.title": "Search Results",
    "search.noResults": "No results",
    "search.dir": "Folder",
    "search.localOnly": "Full-text search currently supports local files only",
    "search.notCached": "This remote file isn't cached yet (open it once to search it)",
    "search.searching": "Searching…",
    "error.title": "Operation failed",
    "dialog.openFile": "Select a file to preview",
    "dialog.openFolder": "Select a folder",
  },
};

function t(key: string): string {
  return I18N[settings.language]?.[key] ?? I18N.en[key] ?? key;
}

// 覆盖 file-viewer 的「推荐安装 preset / renderer」开发者文案，换成用户友好的「不支持」提示。
function unsupportedMessages(): Record<string, string> {
  const title = t("unsupported.title");
  const message = t("unsupported.message");
  return {
    "state.unsupported.install.title": title,
    "state.unsupported.install.message": message,
    "state.unsupported.install.description": "",
    "state.unsupported.title": title,
    "state.unsupported.message": message,
    "state.unsupported.description": "",
  };
}

let currentRoot = ""; // 当前打开的文件树根目录（本地）
let openLocalFolders: string[] = []; // 已打开的本地目录（数据源树）
let openLocalFiles: string[] = []; // 已打开的本地文件（数据源树）
let textLoadMore: (() => void) | null = null; // 当前文本分块的「加载更多」回调
let crumbSourceKey = "local"; // "local" 或品牌名（GitHub 等），用于语言切换后重渲染
let treeCountState: { n: number; unit: "items" | "repos" } = { n: 0, unit: "items" };
let archivePasswords: Record<string, string> = {}; // 压缩包密码缓存（按文件身份）
let currentArchiveKey = ""; // 当前预览文件的缓存键
let archivePwResolve: ((pw: string | null) => void) | null = null; // 密码弹窗回调

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ---------- 连接持久化（凭证缓存，避免重复输入） ----------
const CONN_KINDS: ConnKind[] = ["github", "gitlab", "http", "webdav", "sftp", "s3"];

async function loadState() {
  try {
    const json = await invoke<string>("load_state");
    if (!json) return;
    const saved = JSON.parse(json);
    const savedConns = Array.isArray(saved) ? saved : saved?.conns;
    if (Array.isArray(savedConns)) {
      conns = savedConns
        .filter((c) => c && CONN_KINDS.includes(c.kind))
        .map((c) => ({ port: 22, root: "", region: "", ...c } as Conn));
      renderConns();
    }
    if (saved && typeof saved === "object" && saved.settings) {
      settings = { ...DEFAULT_SETTINGS, ...saved.settings };
    }
    if (saved && typeof saved === "object" && saved.archivePasswords) {
      archivePasswords = saved.archivePasswords;
    }
    if (saved && typeof saved === "object" && Array.isArray(saved.openLocalFolders)) {
      openLocalFolders = saved.openLocalFolders.filter((d: unknown) => typeof d === "string");
    }
    if (saved && typeof saved === "object" && Array.isArray(saved.openLocalFiles)) {
      openLocalFiles = saved.openLocalFiles.filter((f: unknown) => typeof f === "string");
    }
    renderLocalConns();
  } catch (e) {
    console.warn("读取配置失败", e);
  }
  applySettings();
}

function persistState() {
  invoke("save_state", {
    json: JSON.stringify({ conns, settings, archivePasswords, openLocalFolders, openLocalFiles }),
  }).catch((e) => console.error("保存配置失败", e));
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(230,162,60,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function codeThemeCss(code: Record<string, string>): string {
  const c = (k: string, fb: string) => code[k] || fb;
  // file-viewer 代码高亮用 .code-viewer 上的 --code-* 变量（codeStyle.ts），
  // 直接覆盖这些变量即可换色；覆盖 .hljs-* 类名无效。
  const map: [string, string][] = [
    ["--code-bg", "background"],
    ["--code-text", "foreground"],
    ["--code-keyword", "keyword"],
    ["--code-title", "func"],
    ["--code-string", "string"],
    ["--code-number", "number"],
    ["--code-comment", "comment"],
    ["--code-built-in", "type"],
    ["--code-attr", "variable"],
    ["--code-muted", "comment"],
    ["--code-accent", "keyword"],
  ];
  const vars = map.map(([v, k]) => `${v}:${c(k, "#888")}!important`).join(";");
  return `.code-viewer{${vars}}`;
}

function applyCodeTheme() {
  const variant = settings.theme === "light" ? "light" : "dark";
  const code = variant === "light" ? settings.codeLight : settings.codeDark;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(CODE_VAR)) {
    if (code[key]) root.style.setProperty(cssVar, code[key]);
  }
  applyCodeThemeToViewer();
}

// file-viewer 代码高亮 + 错误/空状态在 shadow DOM 里，全局 CSS 进不去，需注入到 shadow root
function viewerStateCss(): string {
  return [
    ".file-viewer-render-error,.file-viewer-missing-renderer{color:var(--text)!important;background:var(--panel)!important}",
    ".file-viewer-render-error>div,.file-viewer-missing-renderer>div{background:var(--raised)!important;border-color:var(--border)!important}",
    ".file-viewer-render-error strong,.file-viewer-missing-renderer strong{color:var(--text)!important}",
    ".file-viewer-render-error p,.file-viewer-missing-renderer p{color:var(--muted)!important}",
  ].join("");
}

function applyCodeThemeToViewer() {
  const viewer = $("viewer");
  const shadow = viewer?.shadowRoot;
  if (!shadow) return;
  const code = settings.theme === "light" ? settings.codeLight : settings.codeDark;
  let el = shadow.getElementById("omniviewer-code-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "omniviewer-code-theme";
    shadow.appendChild(el);
  }
  // 值相等时不写，避免 MutationObserver 因自身写入而无限重入
  const css = codeThemeCss(code) + viewerStateCss();
  if (el.textContent !== css) el.textContent = css;
}

// 渲染失败时回退为文本抽取（针对 PDF/Office/文本等可抽取格式）
let currentPreviewPath = "";
let textFallbackDone = false;
function checkRenderErrorFallback() {
  if (textFallbackDone) return;
  const viewer = $("viewer");
  const shadow = viewer?.shadowRoot;
  if (!shadow) return;
  if (!shadow.querySelector(".file-viewer-render-error")) return;
  const path = currentPreviewPath;
  const ext = extOf(path);
  if (!(ext === "pdf" || DOC_EXTS.has(ext) || TEXT_EXTS.has(ext))) return;
  textFallbackDone = true;
  invoke<string>("extract_file_text", { path })
    .then((text) => {
      if (text && text.trim()) {
        const name = path.split(/[\\/]/).pop() ?? path;
        showStructuredPreview(`（预览渲染失败，已回退为文本抽取）\n\n${text}`, name, ext);
      }
    })
    .catch(() => {});
}

let codeThemeObserver: MutationObserver | null = null;

// 幂等：shadow 出现后挂一次 MutationObserver（重复调用无害）
function ensureViewerThemeObserver() {
  const viewer = $("viewer");
  if (!viewer || codeThemeObserver) return;
  const shadow = viewer.shadowRoot;
  if (!shadow) return;
  codeThemeObserver = new MutationObserver(() => {
    applyCodeThemeToViewer();
    checkRenderErrorFallback();
  });
  codeThemeObserver.observe(shadow, { childList: true, subtree: true });
  applyCodeThemeToViewer();
}

// file-viewer 的 shadow root 是首次渲染时才 attachShadow 创建的，
// 且 attachShadow 不触发 childList mutation，所以不能靠监听元素来等。
// 用 rAF 轮询直到 shadow 出现再挂 observer；showFileViewer 里也会主动触发。
function watchViewerCodeTheme() {
  let attempts = 0;
  const poll = () => {
    ensureViewerThemeObserver();
    if (!codeThemeObserver && ++attempts < 1200) requestAnimationFrame(poll);
  };
  poll();
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.density = settings.density;
  const variant = settings.theme === "light" ? "light" : "dark";
  const ui = variant === "light" ? settings.uiLight : settings.uiDark;
  for (const [key, cssVar] of Object.entries(UI_VAR)) {
    if (ui[key]) root.style.setProperty(cssVar, ui[key]);
  }
  const acc = ui.accent;
  root.style.setProperty("--accent-soft", hexToRgba(acc ?? "#e6a23c", 0.14));
  root.style.setProperty("--font-size", `${settings.fontSize}px`);
  CHUNK_SIZE = settings.chunkMb * 1024 * 1024;
  const viewer = $("viewer");
  if (viewer) viewer.setAttribute("theme", settings.theme);
  applyCodeTheme();
  applyI18n();
  renderWatermark();
}

function renderPalette(containerId: string, colorMap: Record<string, string>, keys: [string, string][]) {
  const c = $(containerId);
  if (!c) return;
  c.innerHTML = "";
  keys.forEach(([key, labelKey]) => {
    const row = document.createElement("label");
    row.className = "palette-row";
    const span = document.createElement("span");
    span.textContent = t(labelKey);
    const input = document.createElement("input");
    input.type = "color";
    input.value = colorMap[key] || "#000000";
    input.dataset.key = key;
    row.appendChild(span);
    row.appendChild(input);
    c.appendChild(row);
  });
}

function renderPalettes() {
  renderPalette("ui-dark-colors", settings.uiDark, UI_COLORS);
  renderPalette("ui-light-colors", settings.uiLight, UI_COLORS);
  renderPalette("code-dark-colors", settings.codeDark, CODE_COLORS);
  renderPalette("code-light-colors", settings.codeLight, CODE_COLORS);
  updatePaletteVisibility();
}

// 深色主题只显示深色调色板，浅色只显示浅色
function updatePaletteVisibility() {
  document.querySelectorAll<HTMLElement>(".palette-group").forEach((g) => {
    g.style.display = g.dataset.variant === settings.theme ? "" : "none";
  });
}

function setupPalettes() {
  renderPalettes();
  const targets: [string, Record<string, string>][] = [
    ["ui-dark-colors", settings.uiDark],
    ["ui-light-colors", settings.uiLight],
    ["code-dark-colors", settings.codeDark],
    ["code-light-colors", settings.codeLight],
  ];
  targets.forEach(([id, map]) => {
    const c = $(id);
    if (!c) return;
    c.addEventListener("input", (e) => {
      const inp = e.target as HTMLInputElement;
      if (inp.type === "color" && inp.dataset.key) {
        map[inp.dataset.key] = inp.value;
        applySettings();
        persistState();
      }
    });
  });
}

function applyI18n() {
  document.documentElement.lang = settings.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const k = el.dataset.i18n;
    if (k) el.textContent = t(k);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-ph]").forEach((el) => {
    const k = el.dataset.i18nPh;
    if (k) (el as HTMLInputElement).placeholder = t(k);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const k = el.dataset.i18nTitle;
    if (k) el.title = t(k);
  });
  renderCrumbSource();
  setTreeCount(treeCountState.n, treeCountState.unit);
  renderConns();
  configureViewer();
}

function renderCrumbSource() {
  const crumb = $("crumb-source");
  if (crumb) crumb.textContent = crumbSourceKey === "local" ? t("group.local") : crumbSourceKey;
}

function setCrumbSource(key: string) {
  crumbSourceKey = key;
  renderCrumbSource();
}

function setTreeCount(n: number, unit: "items" | "repos" = "items") {
  treeCountState = { n, unit };
  const count = $("tree-count");
  if (count) count.textContent = `${n} ${t(unit === "repos" ? "unit.repos" : "unit.items")}`;
}

// 水印绘制（供预览叠加 + 图片导出复用），按尺寸自适应缩放。
function drawWatermarkOn(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const scale = Math.max(1, Math.max(w, h) / 1000);
  const spacing = (WM_SPACING[settings.wmDensity] ?? 220) * scale;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, settings.wmOpacity / 100));
  ctx.fillStyle = settings.wmColor;
  ctx.font = `${settings.wmSize * scale}px ${WM_FONTS[settings.wmFont] ?? WM_FONTS.sans}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.translate(w / 2, h / 2);
  ctx.rotate((settings.wmAngle * Math.PI) / 180);
  const extent = Math.max(w, h) * 1.6;
  for (let x = -extent; x <= extent; x += spacing) {
    for (let y = -extent; y <= extent; y += spacing) {
      ctx.fillText(settings.wmText, x, y);
    }
  }
  ctx.restore();
}

// 屏幕水印：低可视度点阵，每格一个点（左=0/右=1）编码标识，抗截图。
function drawScreenWatermark(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const id = settings.wmUserId || settings.wmText || "OV";
  const bytes = new TextEncoder().encode(id);
  const bits: number[] = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  if (bits.length === 0) return;
  const cell = 20;
  const dotR = 2.5;
  ctx.save();
  ctx.fillStyle = settings.wmColor;
  ctx.globalAlpha = 0.18;
  let bitIdx = 0;
  for (let y = cell / 2; y < h; y += cell) {
    for (let x = cell / 2; x < w; x += cell) {
      const offset = bits[bitIdx % bits.length] === 0 ? -cell / 4 : cell / 4;
      ctx.beginPath();
      ctx.arc(x + offset, y, dotR, 0, Math.PI * 2);
      ctx.fill();
      bitIdx++;
    }
  }
  ctx.restore();
}

// 屏幕水印解码：从截图恢复点阵编码的标识（best-effort，截图需覆盖预览区）。
function decodeScreenWatermarkFromImage(img: HTMLImageElement | ImageBitmap): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = "naturalWidth" in img ? img.naturalWidth : img.width;
  canvas.height = "naturalHeight" in img ? img.naturalHeight : img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return decodeScreenWatermark(canvas);
}

function decodeScreenWatermark(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const bright = (x: number, y: number) => {
    const xi = Math.max(0, Math.min(w - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(h - 1, Math.round(y)));
    const i = (yi * w + xi) * 4;
    return (d[i] + d[i + 1] + d[i + 2]) / 3;
  };
  // 尝试不同 DPR（cell = 20 * dpr）
  for (const cell of [20, 30, 40, 60]) {
    const bits: number[] = [];
    const off = cell / 4;
    for (let y = cell / 2; y < h; y += cell) {
      for (let x = cell / 2; x < w; x += cell) {
        const L = bright(x - off, y);
        const R = bright(x + off, y);
        // 左点更暗 → 0；右点更暗 → 1
        bits.push(L < R ? 0 : 1);
      }
    }
    const id = bitsToId(bits);
    if (id) return id;
  }
  return null;
}

function bitsToId(bits: number[]): string | null {
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length && bytes.length < 64; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    bytes.push(b);
  }
  if (bytes.length < 2) return null;
  for (let L = 1; L <= bytes.length / 2; L++) {
    let ok = true;
    for (let i = 0; i < L; i++) {
      if (bytes[i] !== bytes[i + L]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const idBytes = new Uint8Array(bytes.slice(0, L));
      try {
        const s = new TextDecoder("utf-8", { fatal: true }).decode(idBytes);
        if (s.length > 0 && s.length <= 64) return s;
      } catch {
        // 继续尝试其他周期
      }
    }
  }
  return null;
}

// 明水印预览叠加：平铺旋转文字 + 屏幕点阵，配置即时生效。
function renderWatermark() {
  const layer = $("watermark-layer") as HTMLCanvasElement | null;
  const host = $("preview-body");
  if (!layer || !host) return;
  const viewer = $("viewer");
  const textView = $("text-view");
  const contentShown = (viewer && viewer.style.display !== "none") || (textView && textView.style.display !== "none");
  const showText = settings.wmEnabled && !!settings.wmText;
  const showScreen = settings.wmScreen;
  if ((!showText && !showScreen) || !contentShown) {
    layer.style.display = "none";
    return;
  }
  const w = host.clientWidth;
  const h = host.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  layer.width = Math.max(1, Math.floor(w * dpr));
  layer.height = Math.max(1, Math.floor(h * dpr));
  layer.style.width = `${w}px`;
  layer.style.height = `${h}px`;
  const ctx = layer.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (showScreen) drawScreenWatermark(ctx, w, h);
  if (showText) drawWatermarkOn(ctx, w, h);
  layer.style.display = "block";
}

// ---- 图片明水印导出 + 暗水印（LSB）嵌入/提取 ----
async function getFileBytes(target: { path: string; repo?: string; sha?: string }): Promise<Uint8Array> {
  if (activeSource.kind === "local") {
    return new Uint8Array(await invoke<number[]>("read_file", { path: target.path }));
  }
  return fetchRemoteBytes(target);
}

async function imageToCanvas(bytes: Uint8Array): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const img = await createImageBitmap(new Blob([toArrayBuffer(bytes)]));
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  return { canvas, ctx };
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("导出失败");
  return new Uint8Array(await blob.arrayBuffer());
}

async function saveImageWithWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "image";
  if (!settings.wmEnabled || !settings.wmText) {
    await message(t("wm.needEnable"), { title: t("ctx.saveWatermark"), kind: "warning" });
    return;
  }
  try {
    const { canvas, ctx } = await imageToCanvas(await getFileBytes(target));
    drawWatermarkOn(ctx, canvas.width, canvas.height);
    const png = await canvasToPng(canvas);
    const dest = await save({ defaultPath: `${name}.wm.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(png) });
  } catch (e) {
    console.error("另存为带水印失败", e);
  }
}

const WM_MAGIC = "OVWM1";

// 载荷 → 比特流（magic + 长度 + 数据）
function payloadToBits(payload: string): Uint8Array {
  const data = new TextEncoder().encode(WM_MAGIC + "\u0000" + payload);
  const full = new Uint8Array([(data.length >> 8) & 0xff, data.length & 0xff, ...data]);
  const bits = new Uint8Array(full.length * 8);
  for (let b = 0; b < full.length * 8; b++) bits[b] = (full[b >> 3] >> (7 - (b & 7))) & 1;
  return bits;
}

function bitsToPayload(bits: Uint8Array): string | null {
  if (bits.length < 16) return null;
  let length = 0;
  for (let b = 0; b < 16; b++) length = (length << 1) | bits[b];
  if (length <= 0 || length > 8192 || bits.length < 16 + length * 8) return null;
  const bytes: number[] = [];
  for (let i = 0; i < length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[16 + i * 8 + b];
    bytes.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// 8×8 DCT-II（正交变换，预计算矩阵）。C = M·B·Mᵀ，逆 = Mᵀ·C·M
const DCT_M: number[][] = (() => {
  const m: number[][] = [];
  for (let k = 0; k < 8; k++) {
    m[k] = [];
    const a = k === 0 ? Math.sqrt(1 / 8) : Math.sqrt(2 / 8);
    for (let n = 0; n < 8; n++) m[k][n] = a * Math.cos((Math.PI * (2 * n + 1) * k) / 16);
  }
  return m;
})();

function dct2(block: Float64Array): Float64Array {
  const tmp = new Float64Array(64);
  for (let k = 0; k < 8; k++) for (let j = 0; j < 8; j++) {
    let s = 0;
    for (let n = 0; n < 8; n++) s += DCT_M[k][n] * block[n * 8 + j];
    tmp[k * 8 + j] = s;
  }
  const out = new Float64Array(64);
  for (let k = 0; k < 8; k++) for (let l = 0; l < 8; l++) {
    let s = 0;
    for (let n = 0; n < 8; n++) s += tmp[k * 8 + n] * DCT_M[l][n];
    out[k * 8 + l] = s;
  }
  return out;
}

function idct2(coeff: Float64Array): Float64Array {
  const tmp = new Float64Array(64);
  for (let k = 0; k < 8; k++) for (let j = 0; j < 8; j++) {
    let s = 0;
    for (let n = 0; n < 8; n++) s += DCT_M[n][k] * coeff[n * 8 + j];
    tmp[k * 8 + j] = s;
  }
  const out = new Float64Array(64);
  for (let k = 0; k < 8; k++) for (let l = 0; l < 8; l++) {
    let s = 0;
    for (let n = 0; n < 8; n++) s += tmp[k * 8 + n] * DCT_M[n][l];
    out[k * 8 + l] = s;
  }
  return out;
}

// QIM 量化索引调制：每个 8×8 块的一个中频系数承载 1 bit。研究级实现，抗轻度 JPEG 压缩，不保证抗截图/重裁剪。
const DCT_STEP = 40;
const COEF_X = 3;
const COEF_Y = 3;

function yFromImage(data: Uint8ClampedArray, width: number, bw: number, bh: number): Float64Array {
  const y = new Float64Array(bw * bh);
  for (let i = 0; i < bh; i++) for (let j = 0; j < bw; j++) {
    const idx = (i * width + j) * 4;
    y[i * bw + j] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }
  return y;
}

function writeYToImage(data: Uint8ClampedArray, width: number, bw: number, bh: number, y: Float64Array) {
  for (let i = 0; i < bh; i++) for (let j = 0; j < bw; j++) {
    const idx = (i * width + j) * 4;
    const oldY = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    const delta = y[i * bw + j] - oldY;
    data[idx] = Math.max(0, Math.min(255, data[idx] + delta));
    data[idx + 1] = Math.max(0, Math.min(255, data[idx + 1] + delta));
    data[idx + 2] = Math.max(0, Math.min(255, data[idx + 2] + delta));
  }
}

function embedBitsIntoY(y: Float64Array, bw: number, bh: number, bits: Uint8Array): boolean {
  const capacity = (bw >> 3) * (bh >> 3);
  if (bits.length > capacity) return false;
  let bitIdx = 0;
  outer: for (let by = 0; by < (bh >> 3); by++) {
    for (let bx = 0; bx < (bw >> 3); bx++) {
      if (bitIdx >= bits.length) break outer;
      const block = new Float64Array(64);
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) block[i * 8 + j] = y[(by * 8 + i) * bw + (bx * 8 + j)];
      const coeff = dct2(block);
      const c = coeff[COEF_X * 8 + COEF_Y];
      const bit = bits[bitIdx];
      const q = Math.round((c - bit * DCT_STEP) / (2 * DCT_STEP)) * (2 * DCT_STEP) + bit * DCT_STEP;
      coeff[COEF_X * 8 + COEF_Y] = q;
      const inv = idct2(coeff);
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) y[(by * 8 + i) * bw + (bx * 8 + j)] = inv[i * 8 + j];
      bitIdx++;
    }
  }
  return true;
}

function extractBitsFromY(y: Float64Array, bw: number, bh: number, count: number): Uint8Array {
  const bits = new Uint8Array(count);
  let bitIdx = 0;
  outer: for (let by = 0; by < (bh >> 3); by++) {
    for (let bx = 0; bx < (bw >> 3); bx++) {
      if (bitIdx >= count) break outer;
      const block = new Float64Array(64);
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) block[i * 8 + j] = y[(by * 8 + i) * bw + (bx * 8 + j)];
      const coeff = dct2(block);
      const c = coeff[COEF_X * 8 + COEF_Y];
      bits[bitIdx] = Math.round(c / DCT_STEP) & 1;
      bitIdx++;
    }
  }
  return bits;
}

async function embedImageWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "image";
  const id = settings.wmUserId || settings.wmText || "Omniviewer";
  try {
    const { canvas, ctx } = await imageToCanvas(await getFileBytes(target));
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const width = canvas.width, height = canvas.height;
    const bw = width & ~7, bh = height & ~7;
    const y = yFromImage(imageData.data, width, bw, bh);
    if (!embedBitsIntoY(y, bw, bh, payloadToBits(id))) {
      await message(t("wm.tooSmall"), { title: t("ctx.embedWatermark"), kind: "error" });
      return;
    }
    writeYToImage(imageData.data, width, bw, bh, y);
    ctx.putImageData(imageData, 0, 0);
    const png = await canvasToPng(canvas);
    const dest = await save({ defaultPath: `${name}.wm.png`, filters: [{ name: "PNG", extensions: ["png"] }] });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(png) });
  } catch (e) {
    console.error("嵌入暗水印失败", e);
  }
}

async function extractImageWatermark(target: { path: string; repo?: string; sha?: string }) {
  try {
    const { canvas, ctx } = await imageToCanvas(await getFileBytes(target));
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const width = canvas.width, height = canvas.height;
    const bw = width & ~7, bh = height & ~7;
    const y = yFromImage(imageData.data, width, bw, bh);
    const head = extractBitsFromY(y, bw, bh, 16);
    let length = 0;
    for (let b = 0; b < 16; b++) length = (length << 1) | head[b];
    if (length <= 0 || length > 8192) {
      await message(t("wm.notFound"), { title: t("ctx.extractWatermark"), kind: "info" });
      return;
    }
    const dataBits = extractBitsFromY(y, bw, bh, 16 + length * 8);
    const raw = bitsToPayload(dataBits);
    if (!raw || !raw.startsWith(WM_MAGIC)) {
      await message(t("wm.notFound"), { title: t("ctx.extractWatermark"), kind: "info" });
      return;
    }
    const id = raw.slice(WM_MAGIC.length + 1); // 去掉 magic + \0
    await message(`${t("settings.wmUserId")}: ${id}`, { title: t("ctx.extractWatermark"), kind: "info" });
  } catch (e) {
    console.error("提取暗水印失败", e);
  }
}

// ---- 文本可去除明水印（marker 机制：只去除本软件加的） ----
const TEXT_WM_MARKER = "OMNIVIEWER-WATERMARK";

function lineCommentFor(ext: string): { prefix: string; suffix: string } {
  const hash = ["py", "sh", "bash", "zsh", "rb", "yml", "yaml", "toml", "ini", "conf", "cfg", "pl", "r", "ps1", "gitignore"];
  const slash = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "java", "go", "rs", "c", "cpp", "cc", "h", "hpp", "cs", "css", "php", "kt", "swift", "scala", "dart"];
  const dash = ["sql", "lua", "hs", "vim"];
  if (hash.includes(ext)) return { prefix: "# ", suffix: "" };
  if (slash.includes(ext)) return { prefix: "// ", suffix: "" };
  if (dash.includes(ext)) return { prefix: "-- ", suffix: "" };
  if (["html", "htm", "xml", "vue", "svg", "md", "markdown"].includes(ext)) return { prefix: "<!-- ", suffix: " -->" };
  if (["bat", "cmd"].includes(ext)) return { prefix: "REM ", suffix: "" };
  if (["lisp", "clj", "cljs", "el", "ini"].includes(ext)) return { prefix: "; ", suffix: "" };
  return { prefix: "", suffix: "" }; // 纯文本/未知：直接一行
}

async function embedTextWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file";
  const id = settings.wmUserId || settings.wmText || "Omniviewer";
  try {
    const bytes = await getFileBytes(target);
    const text = new TextDecoder().decode(bytes);
    const { prefix, suffix } = lineCommentFor(extOf(name));
    const line = `${prefix}${TEXT_WM_MARKER}: ${id} ${new Date().toISOString()}${suffix}\n`;
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(new TextEncoder().encode(line + text)) });
  } catch (e) {
    console.error("嵌入文本水印失败", e);
  }
}

async function removeTextWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file";
  try {
    const bytes = await getFileBytes(target);
    const text = new TextDecoder().decode(bytes);
    const out = text
      .split("\n").filter((l) => !l.includes(TEXT_WM_MARKER)).join("\n")
      .replace(new RegExp(ZW_START + `[${ZW_ZERO}${ZW_ONE}]+` + ZW_END, "g"), "");
    if (out === text) {
      await message(t("wm.textNotFound"), { title: t("ctx.removeTextWatermark"), kind: "info" });
      return;
    }
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(new TextEncoder().encode(out)) });
  } catch (e) {
    console.error("去除文本水印失败", e);
  }
}

function isDocx(path: string): boolean {
  return ["docx", "docm", "dotx"].includes(extOf(path));
}

function isPdf(path: string): boolean {
  return extOf(path) === "pdf";
}

function isLatin1(s: string): boolean {
  return [...s].every((c) => c.charCodeAt(0) < 256);
}

// 确保本地路径（远程文件先下载到临时目录）
async function ensureLocalPath(target: { path: string; repo?: string; sha?: string }): Promise<string> {
  if (activeSource.kind === "local") return target.path;
  const bytes = await fetchRemoteBytes(target);
  const tmp = await invoke<string>("make_temp_dir");
  const name = target.path.split(/[\\/]/).pop() ?? "file";
  const p = `${tmp}/${name}`;
  await invoke("save_bytes", { dest: p, bytes: toArrayBuffer(bytes) });
  return p;
}

async function embedDocxWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file.docx";
  const id = settings.wmUserId || settings.wmText || "Omniviewer";
  try {
    const src = await ensureLocalPath(target);
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("docx_embed_watermark", { src, dest, id });
  } catch (e) {
    console.error("嵌入文档暗水印失败", e);
  }
}

async function embedDocxVisibleWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file.docx";
  const text = settings.wmText || "Omniviewer";
  try {
    const src = await ensureLocalPath(target);
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("docx_embed_visible_watermark", { src, dest, text });
  } catch (e) {
    console.error("嵌入文档明水印失败", e);
  }
}

async function extractDocxWatermark(target: { path: string; repo?: string; sha?: string }) {
  try {
    const src = await ensureLocalPath(target);
    const id = await invoke<string | null>("docx_extract_watermark", { src });
    if (id) {
      await message(`${t("settings.wmUserId")}: ${id}`, { title: t("ctx.extractWatermark"), kind: "info" });
    } else {
      await message(t("wm.notFound"), { title: t("ctx.extractWatermark"), kind: "info" });
    }
  } catch (e) {
    console.error("提取文档暗水印失败", e);
  }
}

async function removeDocxWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file.docx";
  try {
    const src = await ensureLocalPath(target);
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    const removed = await invoke<boolean>("docx_remove_watermark", { src, dest });
    if (!removed) {
      await message(t("wm.textNotFound"), { title: t("ctx.removeTextWatermark"), kind: "info" });
    }
  } catch (e) {
    console.error("去除文档暗水印失败", e);
  }
}

const PDF_WM_PREFIX = "OMNIVIEWER-WATERMARK";

async function embedPdfWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file.pdf";
  const id = settings.wmUserId || settings.wmText || "Omniviewer";
  try {
    const bytes = await getFileBytes(target);
    const pdf = await PDFDocument.load(toArrayBuffer(bytes));
    const marker = `${PDF_WM_PREFIX}: ${id} ${new Date().toISOString()}`;
    // 1) 元数据：keywords 追加 marker
    const parts = (pdf.getKeywords() ?? "").split(/[,;]\s*/).map((k) => k.trim()).filter(Boolean).filter((k) => !k.startsWith(PDF_WM_PREFIX));
    pdf.setKeywords([...parts, marker]);
    // 2) 每页白字（ASCII 安全时才画，中文标识仅靠元数据承载）
    if (isLatin1(marker)) {
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (const page of pdf.getPages()) {
        page.drawText(marker, { x: 6, y: 6, size: 3, font, color: rgb(1, 1, 1) });
      }
    }
    const out = await pdf.save();
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(out) });
  } catch (e) {
    console.error("嵌入 PDF 暗水印失败", e);
  }
}

async function extractPdfWatermark(target: { path: string; repo?: string; sha?: string }) {
  try {
    const bytes = await getFileBytes(target);
    const pdf = await PDFDocument.load(toArrayBuffer(bytes));
    const marker = (pdf.getKeywords() ?? "").split(/[,;]\s*/).map((k) => k.trim()).find((k) => k.startsWith(PDF_WM_PREFIX));
    if (marker) {
      const id = marker.replace(new RegExp(`^${PDF_WM_PREFIX}:\\s*`), "");
      await message(`${t("settings.wmUserId")}: ${id}`, { title: t("ctx.extractWatermark"), kind: "info" });
    } else {
      await message(t("wm.notFound"), { title: t("ctx.extractWatermark"), kind: "info" });
    }
  } catch (e) {
    console.error("提取 PDF 暗水印失败", e);
  }
}

async function removePdfWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file.pdf";
  try {
    const bytes = await getFileBytes(target);
    const pdf = await PDFDocument.load(toArrayBuffer(bytes));
    const parts = (pdf.getKeywords() ?? "").split(/[,;]\s*/).map((k) => k.trim()).filter(Boolean);
    const filtered = parts.filter((k) => !k.startsWith(PDF_WM_PREFIX));
    if (filtered.length === parts.length) {
      await message(t("wm.textNotFound"), { title: t("ctx.removeTextWatermark"), kind: "info" });
      return;
    }
    pdf.setKeywords(filtered);
    const out = await pdf.save();
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(out) });
  } catch (e) {
    console.error("去除 PDF 暗水印失败", e);
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 230 / 255, g: 162 / 255, b: 60 / 255 }; // 默认琥珀
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// PDF 可见明水印（烘焙进页面内容，不可去除；ASCII 文本，复用设置页明水印配置）。
async function embedPdfVisibleWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file.pdf";
  const text = settings.wmText || "Omniviewer";
  if (!isLatin1(text)) {
    await message(t("wm.pdfAsciiOnly"), { title: t("ctx.embedPdfVisible"), kind: "warning" });
    return;
  }
  try {
    const bytes = await getFileBytes(target);
    const pdf = await PDFDocument.load(toArrayBuffer(bytes));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const { r, g, b } = hexToRgb(settings.wmColor);
    const opacity = Math.min(0.8, Math.max(0.05, settings.wmOpacity / 100));
    const gap = WM_SPACING[settings.wmDensity] ?? 220;
    const size = Math.max(14, Math.min(80, settings.wmSize));
    const angle = settings.wmAngle;
    for (const page of pdf.getPages()) {
      const pw = page.getWidth();
      const ph = page.getHeight();
      for (let y = -ph; y < ph + gap; y += gap) {
        for (let x = -pw; x < pw + gap; x += gap) {
          page.drawText(text, { x, y, size, font, color: rgb(r, g, b), opacity, rotate: degrees(angle) });
        }
      }
    }
    const out = await pdf.save();
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(out) });
  } catch (e) {
    console.error("嵌入 PDF 明水印失败", e);
  }
}

// 文本零宽字符暗水印（不可见，复制粘贴仍保留）
const ZW_START = "\u200d\u200d\u200d";
const ZW_ZERO = "\u200b";
const ZW_ONE = "\u200c";
const ZW_END = "\u200d\u200d\u200d";

function encodeZeroWidth(id: string): string {
  const bytes = new TextEncoder().encode(id);
  let bits = "";
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits += (b >> i) & 1 ? ZW_ONE : ZW_ZERO;
  return ZW_START + bits + ZW_END;
}

function decodeZeroWidth(s: string): string | null {
  const m = s.match(new RegExp(ZW_START + `([${ZW_ZERO}${ZW_ONE}]+)` + ZW_END));
  if (!m) return null;
  const bits = [...m[1]].map((c) => (c === ZW_ONE ? "1" : "0")).join("");
  if (bits.length % 8 !== 0) return null;
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return new TextDecoder().decode(bytes);
}

async function embedTextInvisibleWatermark(target: { path: string; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file";
  const id = settings.wmUserId || settings.wmText || "Omniviewer";
  try {
    const bytes = await getFileBytes(target);
    const text = new TextDecoder().decode(bytes);
    const cleaned = text.replace(new RegExp(ZW_START + `[${ZW_ZERO}${ZW_ONE}]+` + ZW_END, "g"), "");
    const dest = await save({ defaultPath: name });
    if (!dest) return;
    await invoke("save_bytes", { dest, bytes: toArrayBuffer(new TextEncoder().encode(cleaned + encodeZeroWidth(id))) });
  } catch (e) {
    console.error("嵌入文本暗水印失败", e);
  }
}

async function extractTextInvisibleWatermark(target: { path: string; repo?: string; sha?: string }) {
  try {
    const bytes = await getFileBytes(target);
    const text = new TextDecoder().decode(bytes);
    const id = decodeZeroWidth(text);
    if (id) {
      await message(`${t("settings.wmUserId")}: ${id}`, { title: t("ctx.extractWatermark"), kind: "info" });
    } else {
      await message(t("wm.notFound"), { title: t("ctx.extractWatermark"), kind: "info" });
    }
  } catch (e) {
    console.error("提取文本暗水印失败", e);
  }
}

// 暗水印分派：图片(DCT) / docx(不可见文本) / pdf(元数据+白字) / 文本(零宽字符)
async function embedWatermark(target: { path: string; repo?: string; sha?: string }) {
  if (isPdf(target.path)) await embedPdfWatermark(target);
  else if (isDocx(target.path)) await embedDocxWatermark(target);
  else if (IMAGE_EXTS.has(extOf(target.path))) await embedImageWatermark(target);
  else await embedTextInvisibleWatermark(target);
}
async function extractWatermark(target: { path: string; repo?: string; sha?: string }) {
  if (isPdf(target.path)) await extractPdfWatermark(target);
  else if (isDocx(target.path)) await extractDocxWatermark(target);
  else if (IMAGE_EXTS.has(extOf(target.path))) await extractImageWatermark(target);
  else await extractTextInvisibleWatermark(target);
}
// 去除水印分派：文本(marker行+零宽) / docx(不可见文本+VML) / pdf(元数据)
async function removeWatermark(target: { path: string; repo?: string; sha?: string }) {
  if (isPdf(target.path)) await removePdfWatermark(target);
  else if (isDocx(target.path)) await removeDocxWatermark(target);
  else await removeTextWatermark(target);
}

// 嵌入可去除明水印分派：文本(marker行) / docx(VML 斜水印)
async function embedRemovableWatermark(target: { path: string; repo?: string; sha?: string }) {
  if (isDocx(target.path)) await embedDocxVisibleWatermark(target);
  else await embedTextWatermark(target);
}

function syncSettingsUI() {
  const seg = (id: string, val: string | number) => {
    document.querySelectorAll(`#${id} .opt`).forEach((el) => {
      el.classList.toggle("on", (el as HTMLElement).dataset.v === String(val));
    });
  };
  seg("set-language", settings.language);
  seg("set-theme", settings.theme);
  seg("set-font", settings.fontSize);
  seg("set-density", settings.density);
  seg("set-wm-enabled", settings.wmEnabled ? "1" : "0");
  seg("set-wm-density", settings.wmDensity);
  const setInput = (id: string, v: string) => {
    const el = $(id) as HTMLInputElement | null;
    if (el) el.value = v;
  };
  setInput("set-wm-text", settings.wmText);
  setInput("set-wm-font", settings.wmFont);
  setInput("set-wm-size", String(settings.wmSize));
  setInput("set-wm-color", settings.wmColor);
  setInput("set-wm-opacity", String(settings.wmOpacity));
  setInput("set-wm-angle", String(settings.wmAngle));
  setInput("set-wm-userid", settings.wmUserId);
  seg("set-wm-screen", settings.wmScreen ? "1" : "0");
  renderZipPasswords();
  setInput("set-dl-concurrency", String(settings.dlConcurrency));
  const chunk = $("set-chunk") as HTMLInputElement | null;
  if (chunk) chunk.value = String(settings.chunkMb);
  renderPalettes();
}

function saveSettings() {
  applySettings();
  syncSettingsUI();
  persistState();
}

async function refreshCacheSize() {
  try {
    const size = await invoke<number>("cache_size");
    const el = $("cache-size");
    if (el) el.textContent = formatSize(size);
  } catch (e) {
    console.warn("缓存大小读取失败", e);
  }
}

function renderZipPasswords() {
  const sel = $("set-zip-password") as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("settings.zipPassword.none");
  sel.appendChild(none);
  for (const pw of settings.zipPasswords) {
    const opt = document.createElement("option");
    opt.value = pw;
    opt.textContent = pw;
    sel.appendChild(opt);
  }
  sel.value = settings.zipPassword;
}

function setupZipPasswords() {
  renderZipPasswords();
  $("set-zip-password")?.addEventListener("change", () => {
    settings.zipPassword = ($("set-zip-password") as HTMLSelectElement).value;
    persistState();
  });
  $("zip-pw-add")?.addEventListener("click", () => {
    const inp = $("zip-pw-new") as HTMLInputElement;
    const v = inp.value.trim();
    if (!v) return;
    if (!settings.zipPasswords.includes(v)) settings.zipPasswords.push(v);
    settings.zipPassword = v;
    inp.value = "";
    renderZipPasswords();
    persistState();
  });
  $("zip-pw-del")?.addEventListener("click", () => {
    const cur = settings.zipPassword;
    settings.zipPasswords = settings.zipPasswords.filter((p) => p !== cur);
    settings.zipPassword = "";
    renderZipPasswords();
    persistState();
  });
}

function setupSettingsModal() {
  const modal = $("settings-modal");
  if (!modal) return;
  setupSettingsTabs();
  $("check-update")?.addEventListener("click", async () => {
    try {
      const info = await invoke<{ latest: string; current: string; url: string; notes: string; newer: boolean }>("check_update");
      if (info.newer) {
        const go = await confirm(t("settings.about.newer").replace("{v}", info.latest), {
          title: t("settings.about.checkUpdate"),
          kind: "info",
          okLabel: t("settings.about.download"),
          cancelLabel: t("settings.about.later"),
        });
        if (go) await openUrl(info.url);
      } else {
        await message(t("settings.about.latest"), { title: t("settings.about.checkUpdate"), kind: "info" });
      }
    } catch (e) {
      console.error("检查更新失败", e);
      await message(t("settings.about.checkFailed"), { title: t("settings.about.checkUpdate"), kind: "error" });
    }
  });
  const bind = (id: string, key: keyof Settings, num: boolean) => {
    document.querySelectorAll(`#${id} .opt`).forEach((el) => {
      el.addEventListener("click", () => {
        const v = (el as HTMLElement).dataset.v;
        if (v == null) return;
        (settings as any)[key] = num ? Number(v) : v;
        saveSettings();
      });
    });
  };
  bind("set-language", "language", false);
  bind("set-theme", "theme", false);
  bind("set-font", "fontSize", true);
  bind("set-density", "density", false);
  bind("set-wm-density", "wmDensity", false);
  document.querySelectorAll("#set-wm-enabled .opt").forEach((el) => {
    el.addEventListener("click", () => {
      settings.wmEnabled = (el as HTMLElement).dataset.v === "1";
      saveSettings();
    });
  });
  const wmInput = (id: string, key: keyof Settings, parse: (v: string) => number | string) => {
    const el = $(id) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;
    el.addEventListener("change", () => {
      (settings as any)[key] = parse(el.value);
      saveSettings();
    });
  };
  wmInput("set-wm-text", "wmText", (v) => v);
  wmInput("set-wm-font", "wmFont", (v) => v);
  wmInput("set-wm-size", "wmSize", (v) => Math.max(8, Math.min(120, parseInt(v, 10) || 24)));
  wmInput("set-wm-color", "wmColor", (v) => v);
  wmInput("set-wm-opacity", "wmOpacity", (v) => Math.max(1, Math.min(100, parseInt(v, 10) || 12)));
  wmInput("set-wm-angle", "wmAngle", (v) => Math.max(-90, Math.min(90, parseInt(v, 10) || 0)));
  wmInput("set-wm-userid", "wmUserId", (v) => v);
  document.querySelectorAll("#set-wm-screen .opt").forEach((el) => {
    el.addEventListener("click", () => {
      settings.wmScreen = (el as HTMLElement).dataset.v === "1";
      saveSettings();
    });
  });
  setupPalettes();
  setupZipPasswords();
  wmInput("set-dl-concurrency", "dlConcurrency", (v) => Math.max(1, Math.min(16, parseInt(v, 10) || 4)));
  $("set-chunk")?.addEventListener("change", () => {
    const v = parseInt(($("set-chunk") as HTMLInputElement).value, 10);
    if (!isNaN(v) && v >= 1 && v <= 64) {
      settings.chunkMb = v;
      saveSettings();
    }
  });
  $("cache-clear")?.addEventListener("click", async () => {
    try {
      await invoke("cache_clear");
      await refreshCacheSize();
    } catch (e) {
      console.error("清空缓存失败", e);
    }
  });
  $("wm-decode-btn")?.addEventListener("click", () => {
    $("wm-decode-file")?.click();
  });
  $("wm-decode-file")?.addEventListener("change", async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    const resultEl = $("wm-decode-result");
    if (!file || !resultEl) return;
    try {
      const bmp = await createImageBitmap(file);
      const id = decodeScreenWatermarkFromImage(bmp);
      bmp.close();
      resultEl.textContent = id ?? t("settings.wmDecodeFail");
    } catch (err) {
      console.error("解码屏幕水印失败", err);
      resultEl.textContent = t("settings.wmDecodeFail");
    }
    input.value = "";
  });
  $("settings-close")?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });
}

function configureViewer() {
  const viewer = $("viewer") as FileViewerElement | null;
  if (!viewer) return;
  const current = (viewer.options ?? {}) as Record<string, unknown>;
  viewer.options = {
    ...current,
    messages: unsupportedMessages(),
    // 把明水印配置映射给 file-viewer 的原生水印（导出/打印时烘焙）
    watermark:
      settings.wmEnabled && settings.wmText
        ? {
            enabled: true,
            text: settings.wmText,
            opacity: settings.wmOpacity / 100,
            rotate: settings.wmAngle,
            gapX: WM_SPACING[settings.wmDensity] ?? 220,
            gapY: Math.round((WM_SPACING[settings.wmDensity] ?? 220) * 0.7),
            fontSize: settings.wmSize,
            color: settings.wmColor,
            fontFamily: WM_FONTS[settings.wmFont] ?? WM_FONTS.sans,
          }
        : false,
  };
}

// 给 file-viewer 的压缩包 renderer 注入密码：password=记忆的密码（首次尝试），
// requestPassword=自定义回调（未记忆或密码错时弹窗 + 记住新密码）。
function applyArchiveOptions(key: string) {
  const viewer = $("viewer") as FileViewerElement | null;
  if (!viewer) return;
  const remembered = archivePasswords[key];
  viewer.options = {
    ...(viewer.options ?? {}),
    archive: {
      password: remembered || undefined,
      requestPassword: (payload: { attempt: number; error?: unknown }) => archivePasswordPrompt(payload),
    },
  };
}

function archivePasswordPrompt(payload: { attempt: number; error?: unknown }): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = $("archive-password-modal");
    const input = $("archive-password-input") as HTMLInputElement | null;
    const errEl = $("archive-password-error");
    if (!modal || !input) {
      resolve(null);
      return;
    }
    if (errEl) errEl.textContent = payload.attempt > 1 || payload.error ? t("archivePw.invalid") : "";
    input.value = "";
    modal.style.display = "flex";
    setTimeout(() => input.focus(), 0);
    archivePwResolve = (pw) => {
      modal.style.display = "none";
      if (pw && currentArchiveKey) {
        archivePasswords[currentArchiveKey] = pw;
        persistState();
      }
      archivePwResolve = null;
      resolve(pw);
    };
  });
}

function setupArchivePasswordModal() {
  const modal = $("archive-password-modal");
  const input = $("archive-password-input") as HTMLInputElement | null;
  if (!modal) return;
  $("archive-password-ok")?.addEventListener("click", () => {
    const pw = input?.value ?? "";
    if (pw) archivePwResolve?.(pw);
  });
  $("archive-password-cancel")?.addEventListener("click", () => {
    archivePwResolve?.(null);
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) archivePwResolve?.(null);
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const pw = input.value;
      if (pw) archivePwResolve?.(pw);
    }
  });
}

let downloadCancelled = false;

function showProgress() {
  downloadCancelled = false;
  const modal = $("progress-modal");
  if (!modal) return;
  const text = $("progress-text");
  if (text) text.textContent = t("progress.preparing");
  const fill = $("progress-fill");
  if (fill) fill.style.width = "0%";
  modal.style.display = "flex";
}

function updateProgress(done: number, total: number) {
  const text = $("progress-text");
  if (text) text.textContent = t("progress.files").replace("{done}", String(done)).replace("{total}", String(total));
  const fill = $("progress-fill");
  if (fill) fill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

function hideProgress() {
  const modal = $("progress-modal");
  if (modal) modal.style.display = "none";
}

function setupProgressModal() {
  $("progress-cancel")?.addEventListener("click", () => {
    downloadCancelled = true;
    hideProgress();
  });
}

let nameSearchMode = false;
let nameSearchTimer: ReturnType<typeof setTimeout> | null = null;

function setupSearch() {
  const input = document.querySelector<HTMLInputElement>("#search-input");
  if (!input) return;
  const clearBtn = $("search-clear");
  const toggleClear = () => {
    if (clearBtn) clearBtn.style.display = input.value ? "flex" : "none";
  };
  input.addEventListener("input", () => {
    toggleClear();
    const q = input.value.trim();
    if (!q) {
      if (nameSearchTimer) {
        clearTimeout(nameSearchTimer);
        nameSearchTimer = null;
      }
      clearSearch();
      return;
    }
    if (nameSearchTimer) clearTimeout(nameSearchTimer);
    nameSearchTimer = setTimeout(() => runNameSearch(q), 200);
  });
  clearBtn?.addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (nameSearchTimer) {
        clearTimeout(nameSearchTimer);
        nameSearchTimer = null;
      }
      const q = input.value.trim();
      if (q) runFullTextSearch(q);
    } else if (e.key === "Escape") {
      clearSearch();
    }
  });
}

// 文件名模糊搜索：本地递归（精准/前缀/子串/模糊子序列），远程退回渲染行过滤
async function runNameSearch(query: string) {
  if (activeSource.kind !== "local" || !currentRoot) {
    nameSearchMode = true;
    filterRenderedRows(query);
    return;
  }
  nameSearchMode = true;
  const body = $("tree-body");
  if (!body) return;
  const label = $("tree-head-label");
  if (label) label.textContent = t("search.searching");
  setTreeBusy(true);
  try {
    const matches = await invoke<{ path: string; name: string; is_dir: boolean }[]>("search_names", {
      root: currentRoot,
      query,
    });
    if (!nameSearchMode) return;
    setTreeBusy(false);
    if (label) label.textContent = t("search.title");
    body.innerHTML = "";
    const empty = $("tree-empty");
    if (empty) empty.style.display = "none";
    setTreeCount(matches.length, "items");
    if (matches.length === 0) {
      const div = document.createElement("div");
      div.className = "tree-empty";
      div.style.display = "flex";
      div.textContent = t("search.noResults");
      body.appendChild(div);
      return;
    }
    const root = currentRoot;
    const frag = document.createDocumentFragment();
    for (const m of matches) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.path = m.path;
      row.dataset.dir = m.is_dir ? "1" : "0";
      const ico = document.createElement("span");
      ico.className = "ico";
      ico.innerHTML = iconFor({ name: m.name, path: m.path, is_dir: m.is_dir, size: 0, modified: 0, sha: "" });
      const name = document.createElement("span");
      name.className = m.is_dir ? "name dir" : "name";
      name.textContent = m.name;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = m.is_dir ? t("search.dir") : relParent(m.path, root);
      row.appendChild(ico);
      row.appendChild(name);
      row.appendChild(meta);
      row.title = m.path;
      row.addEventListener("click", () => {
        document.querySelectorAll(".tree .row").forEach((r) => r.classList.remove("sel"));
        row.classList.add("sel");
        if (m.is_dir) {
          currentRoot = m.path;
          setCrumbSource("local");
          const crumbPath = $("crumb-path");
          if (crumbPath) crumbPath.textContent = m.path;
          clearSearch();
        } else {
          registerTab(m.name, { path: m.path });
          previewFile(m.path);
        }
      });
      frag.appendChild(row);
    }
    body.appendChild(frag);
  } catch (e) {
    console.error("文件名搜索失败", e);
    setTreeBusy(false);
    showError(e);
  }
}

// 远程源：无递归文件名命令，退回过滤已渲染行（子串匹配）
function filterRenderedRows(query: string) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll<HTMLElement>(".tree .row").forEach((r) => {
    const name = (r.querySelector(".name")?.textContent ?? "").toLowerCase();
    r.style.display = name.includes(q) ? "" : "none";
  });
}

// 相对父目录（搜索结果 meta 显示文件所在位置）
function relParent(path: string, root: string): string {
  let p = path;
  if (root && p.startsWith(root)) p = p.slice(root.length);
  p = p.replace(/^[/\\]+/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

async function runFullTextSearch(query: string) {
  const body = $("tree-body");
  const empty = $("tree-empty");
  if (!body) return;
  const headLabel = $("tree-head-label");
  if (headLabel) headLabel.textContent = t("search.searching");
  try {
    let hits: { path: string; line: number; text: string }[] = [];
    if (activeSource.kind === "local" && currentRoot) {
      hits = await invoke<{ path: string; line: number; text: string }[]>("search_index", { query, root: currentRoot });
    }
    try {
      const remoteHits = await invoke<{ path: string; line: number; text: string }[]>("search_remote", { query });
      hits = hits.concat(remoteHits);
    } catch (e) {
      console.warn("远程检索失败", e);
    }
    body.innerHTML = "";
    if (empty) empty.style.display = "none";
    const label = $("tree-head-label");
    if (label) label.textContent = t("search.title");
    setTreeCount(hits.length, "items");
    if (hits.length === 0) {
      const div = document.createElement("div");
      div.className = "tree-empty";
      div.style.display = "flex";
      div.textContent = t("search.noResults");
      body.appendChild(div);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const h of hits) {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.path = h.path;
      row.dataset.dir = "0";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = h.path;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = h.line > 0 ? `${h.line}: ${h.text}` : h.text;
      row.appendChild(name);
      row.appendChild(meta);
      row.title = `${h.path}:${h.line}\n${h.text}`;
      row.addEventListener("click", () => {
        document.querySelectorAll(".tree .row").forEach((r) => r.classList.remove("sel"));
        row.classList.add("sel");
        if (isRemoteLabel(h.path)) previewRemoteLabel(h.path);
        else if (activeSource.kind === "local") previewFile(h.path);
      });
      frag.appendChild(row);
    }
    body.appendChild(frag);
  } catch (e) {
    console.error("全文搜索失败", e);
  }
}

function clearSearch() {
  nameSearchMode = false;
  if (nameSearchTimer) {
    clearTimeout(nameSearchTimer);
    nameSearchTimer = null;
  }
  const input = document.querySelector<HTMLInputElement>("#search-input");
  if (input) input.value = "";
  const clearBtn = $("search-clear");
  if (clearBtn) clearBtn.style.display = "none";
  const label = $("tree-head-label");
  if (label) label.textContent = t("tree.files");
  if (currentRoot) {
    renderDir(currentRoot, true);
  } else {
    const body = $("tree-body");
    if (body) body.innerHTML = "";
    const empty = $("tree-empty");
    if (empty) empty.style.display = "flex";
  }
}

// 左右键切换文件（浏览树或搜索结果都适用）
function navigateFile(dir: 1 | -1) {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".tree .row[data-dir='0']"));
  if (rows.length === 0) return;
  const cur = rows.findIndex((r) => r.classList.contains("sel"));
  const next = cur < 0 ? 0 : (cur + dir + rows.length) % rows.length;
  rows[next].click();
}

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
  if (e.key === "ArrowLeft") navigateFile(-1);
  else if (e.key === "ArrowRight") navigateFile(1);
});

async function printWithWatermark() {
  const viewer = $("viewer") as unknown as { printWithMask?: (o?: unknown) => Promise<void> } | null;
  await viewer?.printWithMask?.();
}

function setupInteractions() {
  // 本地目录：多目录树 + 折叠分组
  renderLocalConns();
  setupGroupToggle();

  // 关闭标签
  document.querySelectorAll<HTMLElement>(".tabstrip .tab .x").forEach((x) => {
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      x.closest(".tab")?.remove();
    });
  });

  $("open-file")?.addEventListener("click", openFileDialog);
  $("open-folder")?.addEventListener("click", openFolderDialog);
  $("preview-download")?.addEventListener("click", () => {
    if (currentPreviewPath) saveAsFile({ path: currentPreviewPath, is_dir: false });
  });
  setupToolbar();
  setupSettingsModal();
  $("open-settings")?.addEventListener("click", () => {
    const modal = $("settings-modal");
    if (modal) {
      syncSettingsUI();
      refreshCacheSize();
      fillAbout();
      modal.style.display = "flex";
    }
  });
  setupDividers();
  setupContextMenu();
  setupConnMenu();
  setupTextScroll();
  setupConnModal();
  setupArchivePasswordModal();
  setupProgressModal();
  setupSearch();
  window.addEventListener("resize", renderWatermark);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "PB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

function formatTime(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatCompactTime(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const datePart = d.getFullYear() === new Date().getFullYear()
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${datePart} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 内容嗅探：有效 UTF-8 且不含 NUL 字节 → 判定为纯文本。
function isText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 1024 * 256));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function setStatusInfo(fmt: string, size: number, extra = "") {
  const el = $("status-info");
  if (!el) return;
  const parts = [fmt || "?"];
  if (extra) parts.push(extra);
  parts.push(formatSize(size));
  el.textContent = parts.join(" · ");
}

function updateBar(ext: string, name: string, bytesLen: number) {
  const fmtEl = $("preview-format");
  const nameEl = $("preview-name");
  if (fmtEl) fmtEl.textContent = ext || "?";
  if (nameEl) nameEl.textContent = `${name} · ${formatSize(bytesLen)}`;
  setStatusInfo(ext.toUpperCase(), bytesLen);
}

function updateTextBar(ext: string, name: string, size: number) {
  const fmtEl = $("preview-format");
  if (fmtEl) fmtEl.textContent = ext ? `${ext} · ${t("text.text")}` : t("text.text");
  const nameEl = $("preview-name");
  if (nameEl) nameEl.textContent = `${name} · ${formatSize(size)}`;
  setStatusInfo(ext.toUpperCase(), size, "UTF-8");
}

function setupTextPreview(): HTMLElement | null {
  const viewer = $("viewer");
  const empty = $("preview-empty");
  const textView = $("text-view");
  if (viewer) viewer.style.display = "none";
  if (empty) empty.style.display = "none";
  if (textView) textView.style.display = "block";
  renderWatermark();
  return textView;
}

function showFullText(bytes: Uint8Array, name: string, ext: string) {
  const textView = setupTextPreview();
  const text = new TextDecoder("utf-8").decode(bytes);
  if (textView) {
    textView.textContent = "";
    textView.appendChild(document.createTextNode(text));
  }
  textLoadMore = null;
  updateTextBar(ext, name, bytes.length);
  const lines = text.split("\n").length;
  setStatusInfo(ext.toUpperCase(), bytes.length, `UTF-8 · ${t("status.lines")} ${lines} · ${t("status.chars")} ${text.length}`);
}

function showChunkedText(path: string, name: string, ext: string, firstBytes: Uint8Array, size: number) {
  const textView = setupTextPreview();
  if (!textView) return;
  const decoder = new TextDecoder("utf-8");
  textView.textContent = "";
  textView.appendChild(document.createTextNode(decoder.decode(firstBytes, { stream: true })));
  updateTextBar(ext, name, size);

  let offset = firstBytes.length;
  let loading = false;

  textLoadMore = async () => {
    if (loading || offset >= size) return;
    loading = true;
    try {
      const buf = await invoke<ArrayBuffer>("read_file_range", { path, offset, length: CHUNK_SIZE });
      const bytes = new Uint8Array(buf);
      offset += bytes.length;
      const end = offset >= size;
      textView.appendChild(document.createTextNode(decoder.decode(bytes, { stream: !end })));
    } catch (e) {
      console.error("分块读取失败", e);
    }
    loading = false;
  };
}

function showStructuredPreview(text: string, name: string, ext: string) {
  const textView = setupTextPreview();
  if (textView) {
    textView.textContent = "";
    textView.appendChild(document.createTextNode(text));
  }
  textLoadMore = null;
  const fmtEl = $("preview-format");
  if (fmtEl) fmtEl.textContent = ext ? `${ext} · 结构` : "结构";
  const nameEl = $("preview-name");
  if (nameEl) nameEl.textContent = name;
  setStatusInfo(ext.toUpperCase(), text.length, "结构化");
}

function showUnsupported(name: string, ext: string) {
  const viewer = $("viewer");
  const textView = $("text-view");
  const empty = $("preview-empty");
  if (viewer) viewer.style.display = "none";
  if (textView) textView.style.display = "none";
  if (empty) {
    empty.style.display = "flex";
    const mark = empty.querySelector(".mark");
    const sub = empty.querySelector(".sub");
    if (mark) mark.textContent = t("unsupported.title");
    if (sub) sub.textContent = name;
  }
  textLoadMore = null;
  const fmtEl = $("preview-format");
  const nameEl = $("preview-name");
  if (fmtEl) fmtEl.textContent = ext || "?";
  if (nameEl) nameEl.textContent = name;
  renderWatermark();
}

function showFileViewer(bytes: number[], name: string, ext: string) {
  const viewer = $("viewer") as FileViewerElement | null;
  const textView = $("text-view");
  const empty = $("preview-empty");
  if (!viewer) return;
  if (textView) textView.style.display = "none";
  if (empty) empty.style.display = "none";
  textLoadMore = null;
  if (ARCHIVE_EXTS.has(ext)) applyArchiveOptions(currentArchiveKey);
  viewer.name = name;
  viewer.buffer = new Uint8Array(bytes).buffer;
  viewer.style.display = "block";
  // 渲染后 shadow root 才创建，主动触发主题注入（配合 watchViewerCodeTheme 的 rAF 轮询）
  setTimeout(() => ensureViewerThemeObserver(), 0);
  updateBar(ext, name, bytes.length);
  if (IMAGE_EXTS.has(ext)) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
    const img = new Image();
    img.onload = () => {
      setStatusInfo(ext.toUpperCase(), bytes.length, `${img.naturalWidth}×${img.naturalHeight}`);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }
  renderWatermark();
}

async function previewText(path: string, name: string, ext: string) {
  const size = await invoke<number>("file_size", { path });
  const first = await invoke<ArrayBuffer>("read_file_range", { path, offset: 0, length: CHUNK_SIZE });
  const firstBytes = new Uint8Array(first);
  if (firstBytes.length >= size) {
    showFullText(firstBytes, name, ext);
  } else {
    showChunkedText(path, name, ext, firstBytes, size);
  }
}

async function previewFile(path: string) {
  setPreviewBusy(true);
  try {
    const name = path.split(/[\\/]/).pop() ?? path;
    registerTab(name, { path });
    const dl = $("preview-download");
    if (dl) dl.style.display = "inline-flex";
    const ext = extOf(name);
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = path;
    currentArchiveKey = "local:" + path;
    currentPreviewPath = path;
    textFallbackDone = false;

    if (TEXT_EXTS.has(ext)) {
      const size = await invoke<number>("file_size", { path });
      if (size > LARGE_FILE) {
        await previewText(path, name, ext);
      } else {
        const bytes = await invoke<number[]>("read_file", { path });
        showFileViewer(bytes, name, ext);
      }
      return;
    }

    if (STRUCTURED_EXTS.has(ext)) {
      const desc = await invoke<string>("describe_structured", { path });
      showStructuredPreview(desc, name, ext);
      return;
    }

    if (!KNOWN_EXTS.has(ext)) {
      const head = await invoke<ArrayBuffer>("read_file_range", { path, offset: 0, length: SNIFF_BYTES });
      if (isText(new Uint8Array(head))) {
        await previewText(path, name, ext);
        return;
      }
      showUnsupported(name, ext);
      return;
    }

    const bytes = await invoke<number[]>("read_file", { path });
    showFileViewer(bytes, name, ext);
  } catch (e) {
    console.error("预览文件失败", e);
    showError(e);
  } finally {
    setPreviewBusy(false);
  }
}

// 已读到的完整字节 → 统一预览（远程文件用，无分块）
function previewBytes(bytes: Uint8Array, name: string) {
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) {
    showFileViewer(Array.from(bytes), name, ext);
  } else if (isText(bytes)) {
    showFullText(bytes, name, ext);
  } else if (KNOWN_EXTS.has(ext)) {
    showFileViewer(Array.from(bytes), name, ext);
  } else {
    showUnsupported(name, ext);
  }
}

// 远程文件本地缓存：先查缓存，未命中则拉取并写缓存。
async function cachedGet(key: string, fetchBytes: () => Promise<Uint8Array>): Promise<Uint8Array> {
  // 记录源身份映射（hash → key），供远程全文检索回显源路径
  invoke("cache_put_label", { key }).catch(() => {});
  try {
    const cached = await invoke<ArrayBuffer>("cache_get", { key });
    if (cached && cached.byteLength > 0) {
      return new Uint8Array(cached);
    }
  } catch (e) {
    console.warn("缓存读取失败，直接拉取", e);
  }
  const bytes = await fetchBytes();
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await invoke("cache_put", { key, bytes: buf });
  } catch (e) {
    console.warn("缓存写入失败", e);
  }
  return bytes;
}

const REMOTE_LABEL_PREFIXES = ["github:", "gitlab:", "http:", "webdav:", "sftp:", "s3:"];

function isRemoteLabel(path: string): boolean {
  return REMOTE_LABEL_PREFIXES.some((p) => path.startsWith(p));
}

// 从源标识串提取文件名（最后一段路径，去掉可能的 :sha 等后缀）
function remoteLabelName(label: string): string {
  const lastSlash = label.lastIndexOf("/");
  const tail = lastSlash >= 0 ? label.slice(lastSlash + 1) : label;
  const colon = tail.indexOf(":");
  return colon >= 0 ? tail.slice(0, colon) : tail;
}

async function previewRemoteLabel(label: string) {
  try {
    const bytes = await invoke<ArrayBuffer>("cache_get", { key: label });
    if (!bytes || bytes.byteLength === 0) {
      await message(t("search.notCached"), { title: t("search.title"), kind: "info" });
      return;
    }
    const name = remoteLabelName(label);
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = label;
    previewBytes(new Uint8Array(bytes), name);
  } catch (e) {
    console.error("预览远程检索结果失败", e);
  }
}

async function openFileDialog() {
  try {
    const selected = await open({ multiple: false, directory: false, title: t("dialog.openFile") });
    if (!selected) return;
    activeSource = { kind: "local" };
    const file = Array.isArray(selected) ? selected[0] : selected;
    if (!openLocalFiles.includes(file)) openLocalFiles.push(file);
    renderLocalConns();
    persistState();
    await previewFile(file);
  } catch (e) {
    console.error("打开文件失败", e);
  }
}

async function openFolderDialog() {
  try {
    const selected = await open({ multiple: false, directory: true, title: t("dialog.openFolder") });
    if (!selected) return;
    activeSource = { kind: "local" };
    const dir = Array.isArray(selected) ? selected[0] : selected;
    currentRoot = dir;
    if (!openLocalFolders.includes(dir)) openLocalFolders.push(dir);
    renderLocalConns();
    persistState();
    setCrumbSource("local");
    const crumbPath = $("crumb-path");
    if (crumbPath) crumbPath.textContent = dir;
    setTreeBusy(true);
    try {
      await renderDir(dir, true);
    } catch (e) {
      console.error("打开文件夹失败", e);
      showError(e);
    } finally {
      setTreeBusy(false);
    }
  } catch (e) {
    console.error("打开文件夹失败", e);
  }
}

// ---------- 远程源 ----------
function encodePath(path: string): string {
  return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

async function githubJson(url: string, token: string): Promise<any> {
  const headers: Record<string, string> = { "User-Agent": "Omniviewer", Accept: "application/vnd.github+json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
  return resp.json();
}

async function gitlabJson(url: string, token: string): Promise<any> {
  const resp = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!resp.ok) throw new Error(`GitLab API ${resp.status}`);
  return resp.json();
}

function gitlabProjectId(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

async function gitlabListDir(owner: string, repo: string, path: string, token: string): Promise<TreeEntry[]> {
  const pid = gitlabProjectId(owner, repo);
  const url = path
    ? `https://gitlab.com/api/v4/projects/${pid}/repository/tree?path=${encodeURIComponent(path)}&per_page=100`
    : `https://gitlab.com/api/v4/projects/${pid}/repository/tree?per_page=100`;
  const json = await gitlabJson(url, token);
  if (!Array.isArray(json)) return [];
  return (json as any[]).map((item) => ({
    name: item.name,
    path: item.path,
    is_dir: item.type === "tree",
    size: 0,
    modified: 0,
    sha: "",
  }));
}

async function gitlabGetFileBytes(owner: string, repo: string, path: string, token: string): Promise<Uint8Array> {
  const pid = gitlabProjectId(owner, repo);
  const url = `https://gitlab.com/api/v4/projects/${pid}/repository/files/${encodeURIComponent(path)}/raw`;
  const resp = await fetch(url, { headers: { "PRIVATE-TOKEN": token } });
  if (!resp.ok) throw new Error(`GitLab API ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// 源感知的目录列出
async function listEntries(path: string, repo: string): Promise<TreeEntry[]> {
  if (activeSource.kind === "github") {
    const src = activeSource;
    if (!repo) {
      const json = await githubJson(`https://api.github.com/users/${src.owner}/repos?per_page=100&sort=updated`, src.token);
      const arr = Array.isArray(json) ? json : [];
      return arr.map((r: any) => ({ name: r.name, path: r.name, is_dir: true, size: 0, modified: 0, sha: "" }));
    }
    const url = path
      ? `https://api.github.com/repos/${src.owner}/${repo}/contents/${encodePath(path)}`
      : `https://api.github.com/repos/${src.owner}/${repo}/contents/`;
    const json = await githubJson(url, src.token);
    if (!Array.isArray(json)) return [];
    return (json as any[]).map((item) => ({
      name: item.name,
      path: item.path,
      is_dir: item.type === "dir",
      size: item.size ?? 0,
      modified: 0,
      sha: item.sha ?? "",
    }));
  }
  if (activeSource.kind === "gitlab") {
    return gitlabListDir(activeSource.owner, activeSource.repo, path, activeSource.token);
  }
  if (activeSource.kind === "http") {
    const entries = await invoke<{ name: string; path: string; is_dir: boolean; size: number; sha: string }[]>("http_list", { url: path });
    return entries.map((e) => ({ ...e, modified: 0 }));
  }
  if (activeSource.kind === "webdav") {
    const entries = await invoke<{ name: string; path: string; is_dir: boolean; size: number; sha: string }[]>("webdav_list", { url: path, user: activeSource.user, pass: activeSource.pass });
    return entries.map((e) => ({ ...e, modified: 0 }));
  }
  if (activeSource.kind === "sftp") {
    const entries = await invoke<{ name: string; path: string; is_dir: boolean; size: number; sha: string }[]>("sftp_list", { host: activeSource.host, port: activeSource.port, user: activeSource.user, pass: activeSource.pass, path });
    return entries.map((e) => ({ ...e, modified: 0 }));
  }
  if (activeSource.kind === "s3") {
    const entries = await invoke<{ name: string; path: string; is_dir: boolean; size: number; sha: string }[]>("s3_list", {
      endpoint: activeSource.endpoint,
      region: activeSource.region,
      accessKey: activeSource.accessKey,
      secretKey: activeSource.secretKey,
      bucket: activeSource.bucket,
      prefix: path,
    });
    return entries.map((e) => ({ ...e, modified: 0 }));
  }
  const entries = await invoke<{ name: string; path: string; is_dir: boolean; size: number; modified: number }[]>("list_dir", { path });
  return entries.map((e) => ({ ...e, sha: "" }));
}

async function githubGetFileBytes(owner: string, repo: string, path: string, sha: string, token: string): Promise<Uint8Array> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}`;
  const json = await githubJson(url, token);
  let b64 = typeof json.content === "string" ? json.content : "";
  if (!b64 && sha) {
    const blob = await githubJson(`https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`, token);
    b64 = typeof blob.content === "string" ? blob.content : "";
  }
  if (!b64) throw new Error("无法获取文件内容");
  const bin = atob(b64.replace(/\s/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function previewGitHubFile(repo: string, path: string, sha: string, name: string) {
  try {
    const src = activeSource as { kind: "github"; owner: string; repo: string; token: string };
    const key = `github:${src.owner}/${repo}:${path}:${sha}`;
    currentArchiveKey = key;
    const bytes = await cachedGet(key, () => githubGetFileBytes(src.owner, repo, path, sha, src.token));
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = `${src.owner}/${repo}/${path}`;
    previewBytes(bytes, name);
  } catch (e) {
    console.error("GitHub 文件读取失败", e);
    showUnsupported(name, extOf(name));
  }
}

async function previewGitLabFile(path: string, name: string) {
  try {
    const src = activeSource as { kind: "gitlab"; owner: string; repo: string; token: string };
    const key = `gitlab:${src.owner}/${src.repo}:${path}`;
    currentArchiveKey = key;
    const bytes = await cachedGet(key, () => gitlabGetFileBytes(src.owner, src.repo, path, src.token));
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = `${src.owner}/${src.repo}/${path}`;
    previewBytes(bytes, name);
  } catch (e) {
    console.error("GitLab 文件读取失败", e);
    showUnsupported(name, extOf(name));
  }
}

async function previewHttpFile(url: string, name: string) {
  try {
    const key = `http:${url}`;
    currentArchiveKey = key;
    const bytes = await cachedGet(key, async () => new Uint8Array(await invoke<ArrayBuffer>("http_get", { url })));
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = url;
    previewBytes(bytes, name);
  } catch (e) {
    console.error("HTTP 读取失败", e);
    showUnsupported(name, extOf(name));
  }
}

async function previewWebdavFile(url: string, name: string) {
  try {
    const src = activeSource as { kind: "webdav"; base: string; user: string; pass: string };
    const key = `webdav:${url}`;
    currentArchiveKey = key;
    const bytes = await cachedGet(key, async () => new Uint8Array(await invoke<ArrayBuffer>("webdav_get", { url, user: src.user, pass: src.pass })));
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = url;
    previewBytes(bytes, name);
  } catch (e) {
    console.error("WebDAV 读取失败", e);
    showUnsupported(name, extOf(name));
  }
}

async function previewSftpFile(path: string, name: string) {
  try {
    const src = activeSource as { kind: "sftp"; host: string; port: number; user: string; pass: string };
    const key = `sftp:${src.host}:${src.port}:${path}`;
    currentArchiveKey = key;
    const bytes = await cachedGet(key, async () => new Uint8Array(await invoke<ArrayBuffer>("sftp_get", { host: src.host, port: src.port, user: src.user, pass: src.pass, path })));
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = `sftp://${src.host}${path}`;
    previewBytes(bytes, name);
  } catch (e) {
    console.error("SFTP 读取失败", e);
    showUnsupported(name, extOf(name));
  }
}

async function previewS3File(path: string, name: string) {
  try {
    const src = activeSource as { kind: "s3"; endpoint: string; region: string; accessKey: string; secretKey: string; bucket: string };
    const key = `s3:${src.endpoint}:${src.bucket}:${path}`;
    currentArchiveKey = key;
    const bytes = await cachedGet(key, async () =>
      new Uint8Array(
        await invoke<ArrayBuffer>("s3_get", {
          endpoint: src.endpoint,
          region: src.region,
          accessKey: src.accessKey,
          secretKey: src.secretKey,
          bucket: src.bucket,
          path,
        }),
      ),
    );
    const crumb = $("crumb-path");
    if (crumb) crumb.textContent = `s3://${src.bucket}/${path}`;
    previewBytes(bytes, name);
  } catch (e) {
    console.error("S3 读取失败", e);
    showUnsupported(name, extOf(name));
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function fetchRemoteBytes(target: { path: string; repo?: string; sha?: string }): Promise<Uint8Array> {
  const path = target.path;
  const src = activeSource;
  if (src.kind === "github") {
    const repo = target.repo ?? "";
    return cachedGet(`github:${src.owner}/${repo}:${path}:${target.sha ?? ""}`, () => githubGetFileBytes(src.owner, repo, path, target.sha ?? "", src.token));
  }
  if (src.kind === "gitlab") {
    return cachedGet(`gitlab:${src.owner}/${src.repo}:${path}`, () => gitlabGetFileBytes(src.owner, src.repo, path, src.token));
  }
  if (src.kind === "http") {
    return cachedGet(`http:${path}`, async () => new Uint8Array(await invoke<ArrayBuffer>("http_get", { url: path })));
  }
  if (src.kind === "webdav") {
    return cachedGet(`webdav:${path}`, async () => new Uint8Array(await invoke<ArrayBuffer>("webdav_get", { url: path, user: src.user, pass: src.pass })));
  }
  if (src.kind === "sftp") {
    return cachedGet(`sftp:${src.host}:${src.port}:${path}`, async () => new Uint8Array(await invoke<ArrayBuffer>("sftp_get", { host: src.host, port: src.port, user: src.user, pass: src.pass, path })));
  }
  if (src.kind === "s3") {
    return cachedGet(`s3:${src.endpoint}:${src.bucket}:${path}`, async () => new Uint8Array(await invoke<ArrayBuffer>("s3_get", { endpoint: src.endpoint, region: src.region, accessKey: src.accessKey, secretKey: src.secretKey, bucket: src.bucket, path })));
  }
  throw new Error("未知数据源");
}

// 网络拉取重试（3 次），用于文件夹下载/单文件拉取容错。
async function fetchWithRetry(fn: () => Promise<Uint8Array>, retries = 3): Promise<Uint8Array> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 用户可见错误提示（关键流程失败时弹出，而非只 console.error）
async function showError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  await message(msg, { title: t("error.title"), kind: "error" }).catch(() => {});
}

// 递归枚举 + 有界并发下载远程文件夹到 destDir（保留相对目录结构）。
async function downloadRemoteFolderTo(target: { path: string; repo?: string; sha?: string }, destDir: string) {
  const src = activeSource;
  const repo = target.repo ?? "";
  let rootPath = target.path;
  if (src.kind === "github" && target.path === repo) rootPath = ""; // 仓库根
  const files: string[] = [];
  const walk = async (p: string) => {
    if (downloadCancelled) throw new Error("cancelled");
    const entries = await listEntries(p, repo);
    for (const e of entries) {
      if (e.is_dir) await walk(e.path);
      else files.push(e.path);
    }
  };
  await walk(rootPath);
  let done = 0;
  let idx = 0;
  const CONCURRENCY = Math.max(1, Math.min(16, settings.dlConcurrency || 4));
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      if (downloadCancelled) break;
      const i = idx++;
      if (i >= files.length) break;
      const f = files[i];
      const rel = rootPath ? f.slice(rootPath.length).replace(/^\/+/, "") : f;
      const bytes = await fetchWithRetry(() => fetchRemoteBytes({ path: f, repo }));
      await invoke("save_bytes", { dest: `${destDir}/${rel}`, bytes: toArrayBuffer(bytes) });
      done++;
      updateProgress(done, files.length);
    }
  });
  await Promise.all(workers);
}

async function zipRemoteFolder(target: { path: string; repo?: string; sha?: string }, dest: string, password: string | null) {
  const tmp = await invoke<string>("make_temp_dir");
  const name = target.path.split(/[\\/]/).pop() ?? "archive";
  try {
    await downloadRemoteFolderTo(target, `${tmp}/${name}`);
    await invoke("zip_paths", { paths: [`${tmp}/${name}`], dest, password });
  } finally {
    invoke("remove_path", { path: tmp }).catch(() => {});
  }
}

async function saveAsFile(target: { path: string; is_dir: boolean; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "file";
  try {
    if (target.is_dir) {
      const picked = await open({ directory: true, title: t("dl.chooseDir") });
      if (!picked) return;
      const destDir = Array.isArray(picked) ? picked[0] : picked;
      showProgress();
      try {
        if (activeSource.kind === "local") {
          await invoke("copy_path", { src: target.path, dest: `${destDir}/${name}` });
        } else {
          await downloadRemoteFolderTo(target, `${destDir}/${name}`);
        }
      } finally {
        hideProgress();
      }
    } else {
      const dest = await save({ defaultPath: name });
      if (!dest) return;
      if (activeSource.kind === "local") {
        await invoke("copy_file", { src: target.path, dest });
      } else if (activeSource.kind === "http") {
        await invoke("http_download", { url: target.path, dest, concurrency: settings.dlConcurrency || 4, user: null, pass: null });
      } else if (activeSource.kind === "webdav") {
        const src = activeSource;
        await invoke("http_download", { url: target.path, dest, concurrency: settings.dlConcurrency || 4, user: src.user, pass: src.pass });
      } else {
        const bytes = await fetchRemoteBytes(target);
        await invoke("save_bytes", { dest, bytes: toArrayBuffer(bytes) });
      }
    }
  } catch (e) {
    console.error("另存为失败", e);
    hideProgress();
    showError(e);
  }
}

async function zipTarget(target: { path: string; is_dir: boolean; repo?: string; sha?: string }) {
  const name = target.path.split(/[\\/]/).pop() ?? "archive";
  try {
    const dest = await save({ defaultPath: `${name}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!dest) return;
    const password = settings.zipPassword || null;
    if (activeSource.kind === "local") {
      await invoke("zip_paths", { paths: [target.path], dest, password });
    } else if (target.is_dir) {
      showProgress();
      try {
        await zipRemoteFolder(target, dest, password);
      } finally {
        hideProgress();
      }
    } else {
      const bytes = await fetchRemoteBytes(target);
      await invoke("zip_bytes", { name, bytes: toArrayBuffer(bytes), dest, password });
    }
  } catch (e) {
    console.error("压缩失败", e);
    hideProgress();
    showError(e);
  }
}

let busyTimer: ReturnType<typeof setTimeout> | null = null;
let previewBusyTimer: ReturnType<typeof setTimeout> | null = null;

function setPreviewBusy(loading: boolean) {
  const el = $("preview-loading");
  if (loading) {
    if (previewBusyTimer) {
      clearTimeout(previewBusyTimer);
      previewBusyTimer = null;
    }
    if (el) el.style.display = "flex";
  } else {
    if (!previewBusyTimer) {
      previewBusyTimer = setTimeout(() => {
        previewBusyTimer = null;
        if (el) el.style.display = "none";
      }, 200);
    }
  }
}

function setTreeBusy(loading: boolean) {
  const el = $("tree-loading");
  if (loading) {
    if (busyTimer) {
      clearTimeout(busyTimer);
      busyTimer = null;
    }
    if (el) el.style.display = "flex";
  } else {
    // 最短显示 250ms，避免快速操作时「一闪而过看不到」
    if (!busyTimer) {
      busyTimer = setTimeout(() => {
        busyTimer = null;
        if (el) el.style.display = "none";
      }, 250);
    }
  }
}

function connElementByIndex(index: number): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.rail .conn[data-cid="${index}"]`);
}

async function openRemoteConnection(conn: Conn, loadingEl?: HTMLElement | null) {
  if (conn.kind === "github") activeSource = { kind: "github", owner: conn.owner, repo: conn.repo, token: conn.token };
  else if (conn.kind === "gitlab") activeSource = { kind: "gitlab", owner: conn.owner, repo: conn.repo, token: conn.token };
  else if (conn.kind === "http") activeSource = { kind: "http", base: conn.url };
  else if (conn.kind === "webdav") activeSource = { kind: "webdav", base: conn.url, user: conn.user, pass: conn.token };
  else if (conn.kind === "sftp") activeSource = { kind: "sftp", host: conn.url, port: conn.port || 22, user: conn.user, pass: conn.token };
  else activeSource = { kind: "s3", endpoint: conn.url, region: conn.region || "auto", accessKey: conn.user, secretKey: conn.token, bucket: conn.root };
  const body = $("tree-body");
  if (!body) return;
  setCrumbSource(
    conn.kind === "github" ? "GitHub" : conn.kind === "gitlab" ? "GitLab" : conn.kind === "http" ? "HTTP" : conn.kind === "webdav" ? "WebDAV" : conn.kind === "sftp" ? "SFTP" : "S3",
  );
  const crumbPath = $("crumb-path");
  if (crumbPath) {
    if (conn.kind === "http" || conn.kind === "webdav") crumbPath.textContent = conn.url;
    else if (conn.kind === "sftp") crumbPath.textContent = `sftp://${conn.url}${conn.port && conn.port !== 22 ? `:${conn.port}` : ""}:${conn.root || "/"}`;
    else if (conn.kind === "s3") crumbPath.textContent = `s3://${conn.root}`;
    else if (conn.kind === "github") crumbPath.textContent = conn.repo ? `${conn.owner}/${conn.repo}` : `github.com/${conn.owner}`;
    else crumbPath.textContent = `gitlab.com/${conn.owner}/${conn.repo}`;
  }
  body.innerHTML = "";
  const empty = $("tree-empty");
  if (empty) empty.style.display = "none";
  loadingEl?.classList.add("loading");
  setTreeBusy(true);
  try {
    if (conn.kind === "github" && !conn.repo) {
      const repos = await listEntries("", "");
      const frag = document.createDocumentFragment();
      for (const r of repos) frag.appendChild(buildRow(r, 0, ""));
      body.appendChild(frag);
      setTreeCount(repos.length, "repos");
    } else if (conn.kind === "http" || conn.kind === "webdav") {
      await renderDir(conn.url, true);
    } else if (conn.kind === "sftp") {
      await renderDir(conn.root || "/", true);
    } else if (conn.kind === "s3") {
      await renderDir("", true);
    } else {
      await renderDir("", true, conn.kind === "github" ? conn.repo : "");
    }
  } catch (e) {
    console.error("远程连接失败", e);
    if (empty) {
      empty.style.display = "flex";
      empty.querySelector(".mark")!.textContent = t("error.connFailed");
      empty.querySelector(".sub")!.textContent = (e as Error).message;
    }
    showError(e);
  } finally {
    loadingEl?.classList.remove("loading");
    setTreeBusy(false);
  }
}

// 解析链接：支持 URL 或 owner[/repo]
function parseGitLink(input: string): { host: "github" | "gitlab" | null; owner: string; repo: string } {
  const s = input.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(github|gitlab)\.com\/(.+)$/i);
  if (m) {
    const parts = m[2].split("/").filter(Boolean);
    return { host: m[1].toLowerCase() as "github" | "gitlab", owner: parts[0] ?? "", repo: parts[1] ?? "" };
  }
  const parts = s.split("/").filter(Boolean);
  return { host: null, owner: parts[0] ?? "", repo: parts[1] ?? "" };
}

// ---------- 工具栏（设置 + 新建菜单） ----------
function setupToolbar() {
  const menu = $("add-menu");
  const btn = $("add-menu-btn");
  // tabstrip 横向滚轮
  const tabstrip = $("tabstrip");
  tabstrip?.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      tabstrip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  });
  if (!menu || !btn) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  menu.querySelectorAll(".ctx-item").forEach((item) => {
    item.addEventListener("click", () => {
      menu.style.display = "none";
      const action = item.getAttribute("data-action");
      if (action === "open-file") openFileDialog();
      else if (action === "open-folder") openFolderDialog();
      else if (action === "add-connection") openConnModal();
    });
  });
  document.addEventListener("click", () => {
    menu.style.display = "none";
  });
}

// ---------- 设置页多 tab ----------
function setupSettingsTabs() {
  document.querySelectorAll(".settings-tabs .stab").forEach((t) => {
    t.addEventListener("click", () => {
      const tab = (t as HTMLElement).dataset.tab;
      document.querySelectorAll(".settings-tabs .stab").forEach((x) => x.classList.toggle("on", x === t));
      document.querySelectorAll<HTMLElement>(".stab-pane").forEach((p) => {
        p.style.display = p.dataset.pane === tab ? "" : "none";
      });
    });
  });
}

async function fillAbout() {
  try {
    const info = await invoke<{ name: string; version: string }>("app_info");
    const v = $("about-version");
    if (v) v.textContent = `v${info.version}`;
  } catch {
    /* ignore */
  }
  refreshCliStatus();
}

async function refreshCliStatus() {
  const el = $("cli-status");
  if (!el) return;
  try {
    const installed = await invoke<boolean>("cli_status");
    el.textContent = installed ? "已安装" : "未安装";
  } catch {
    el.textContent = "—";
  }
}

const EYE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// 给所有密码输入框加「眼睛」切换（默认隐藏）
function setupPasswordToggles() {
  document.querySelectorAll<HTMLInputElement>("input[type='password']").forEach((input) => {
    if (input.closest(".pw-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "pw-wrap";
    input.parentNode?.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pw-eye";
    btn.title = t("pw.toggle");
    btn.innerHTML = EYE_SVG;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? EYE_OFF_SVG : EYE_SVG;
      btn.title = t(show ? "pw.hide" : "pw.toggle");
    });
    wrap.appendChild(btn);
  });
}

function setupCliInstall() {
  $("install-cli")?.addEventListener("click", async () => {
    const btn = $("install-cli") as HTMLButtonElement | null;
    const status = $("cli-status");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "安装中…";
    }
    try {
      const dest = await invoke<string>("install_cli");
      if (status) status.textContent = "已安装";
      await message(`${t("settings.about.cliHint")}\n\n${dest}`, { title: t("settings.about.cli"), kind: "info" });
    } catch (e) {
      if (status) status.textContent = "失败";
      await message(String(e), { title: t("error.title"), kind: "error" }).catch(() => {});
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = t("settings.about.installCli");
      }
    }
  });
}

// ---------- 连接弹窗 ----------
let editingConnIndex: number | null = null; // 编辑中的连接下标，null = 新增

function setField(id: string, v: string) {
  const el = $(id) as HTMLInputElement | null;
  if (el) el.value = v;
}
function getField(id: string): string {
  return (($(id) as HTMLInputElement | null)?.value ?? "").trim();
}

function switchConnTab(kind: string) {
  document.querySelectorAll<HTMLElement>(".conn-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.kind === kind);
  });
  document.querySelectorAll<HTMLElement>(".conn-pane").forEach((p) => {
    p.style.display = p.dataset.pane === kind ? "" : "none";
  });
}

function openConnModal(conn?: Conn, index?: number) {
  const modal = $("conn-modal");
  if (!modal) return;
  editingConnIndex = index ?? null;
  // 清空
  ["gh-repo", "gh-token", "gl-repo", "gl-token", "http-url", "http-user", "http-pass", "dav-url", "dav-user", "dav-pass", "sftp-host", "sftp-user", "sftp-pass", "sftp-root", "s3-endpoint", "s3-region", "s3-bucket", "s3-ak", "s3-sk"].forEach((id) => setField(id, ""));
  setField("sftp-port", "22");

  let kind: ConnKind = conn?.kind ?? "github";
  if (conn) {
    if (conn.kind === "github" || conn.kind === "gitlab") {
      const repoVal = conn.repo ? `${conn.owner}/${conn.repo}` : conn.owner;
      setField(conn.kind === "github" ? "gh-repo" : "gl-repo", repoVal);
      setField(conn.kind === "github" ? "gh-token" : "gl-token", conn.token);
    } else if (conn.kind === "http") {
      setField("http-url", conn.url); setField("http-user", conn.user); setField("http-pass", conn.token);
    } else if (conn.kind === "webdav") {
      setField("dav-url", conn.url); setField("dav-user", conn.user); setField("dav-pass", conn.token);
    } else if (conn.kind === "sftp") {
      setField("sftp-host", conn.url); setField("sftp-port", String(conn.port || 22));
      setField("sftp-user", conn.user); setField("sftp-pass", conn.token); setField("sftp-root", conn.root || "/");
    } else if (conn.kind === "s3") {
      setField("s3-endpoint", conn.url); setField("s3-region", conn.region); setField("s3-bucket", conn.root);
      setField("s3-ak", conn.user); setField("s3-sk", conn.token);
    }
  }

  switchConnTab(kind);
  const title = $("conn-modal-title");
  if (title) title.textContent = conn ? t("connModal.editTitle") : t("connModal.title");
  const ok = $("conn-ok");
  if (ok) ok.textContent = conn ? t("connModal.save") : t("connModal.ok");
  modal.style.display = "flex";
  modal.querySelector<HTMLInputElement>(`.conn-pane[data-pane="${kind}"] input`)?.focus();
}

function buildConnFromForm(kind: ConnKind): Conn | null {
  if (kind === "github" || kind === "gitlab") {
    const repo = getField(kind === "github" ? "gh-repo" : "gl-repo");
    const token = getField(kind === "github" ? "gh-token" : "gl-token");
    if (!repo) return null;
    const parsed = parseGitLink(repo);
    if (parsed.host && parsed.host !== kind) return null;
    if (!parsed.owner) return null;
    if (kind === "gitlab" && !parsed.repo) return null;
    return { kind, owner: parsed.owner, repo: parsed.repo, url: "", user: "", token, port: 22, root: "", region: "" };
  }
  if (kind === "http") {
    const url = getField("http-url");
    if (!url) return null;
    return { kind, owner: "", repo: "", url, user: getField("http-user"), token: getField("http-pass"), port: 22, root: "", region: "" };
  }
  if (kind === "webdav") {
    const url = getField("dav-url");
    if (!url) return null;
    return { kind, owner: "", repo: "", url, user: getField("dav-user"), token: getField("dav-pass"), port: 22, root: "", region: "" };
  }
  if (kind === "sftp") {
    const host = getField("sftp-host");
    if (!host) return null;
    const port = parseInt(getField("sftp-port"), 10) || 22;
    return { kind, owner: "", repo: "", url: host, user: getField("sftp-user"), token: getField("sftp-pass"), port, root: getField("sftp-root") || "/", region: "" };
  }
  if (kind === "s3") {
    const endpoint = getField("s3-endpoint");
    const bucket = getField("s3-bucket");
    if (!endpoint || !bucket) return null;
    return { kind, owner: "", repo: "", url: endpoint, user: getField("s3-ak"), token: getField("s3-sk"), port: 22, root: bucket, region: getField("s3-region") };
  }
  return null;
}

function setupConnModal() {
  const modal = $("conn-modal");
  if (!modal) return;

  document.querySelectorAll<HTMLElement>(".conn-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchConnTab(tab.dataset.kind!));
  });

  $("conn-cancel")?.addEventListener("click", () => {
    modal.style.display = "none";
  });

  $("conn-ok")?.addEventListener("click", () => {
    const kind = document.querySelector<HTMLElement>(".conn-tab.active")?.dataset.kind as ConnKind;
    const conn = buildConnFromForm(kind);
    if (!conn) return;
    if (editingConnIndex != null) {
      conns[editingConnIndex] = conn;
    } else {
      conns.push(conn);
    }
    renderConns();
    persistState();
    modal.style.display = "none";
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });
}

function deleteConn(index: number) {
  conns.splice(index, 1);
  renderConns();
  persistState();
}

function renderConns() {
  const ids: Record<ConnKind, [string, string, string]> = {
    github: ["github-conns", "github-count", "GH"],
    gitlab: ["gitlab-conns", "gitlab-count", "GL"],
    http: ["http-conns", "http-count", "H"],
    webdav: ["webdav-conns", "webdav-count", "W"],
    sftp: ["sftp-conns", "sftp-count", "SF"],
    s3: ["s3-conns", "s3-count", "S3"],
  };
  (Object.keys(ids) as ConnKind[]).forEach((k) => {
    const c = $(ids[k][0]);
    if (c) c.innerHTML = "";
  });
  conns.forEach((c, ci) => {
    const [containerId, , ico] = ids[c.kind];
    const container = $(containerId);
    if (!container) return;
    const conn = document.createElement("div");
    conn.className = "conn";
    conn.dataset.cid = String(ci);
    conn.innerHTML = `<span class="ico">${ico}</span><span class="name"></span>`;
    const label =
      c.kind === "http" || c.kind === "webdav"
        ? c.url
        : c.kind === "sftp"
          ? `${c.url}${c.port && c.port !== 22 ? `:${c.port}` : ""}:${c.root || "/"}`
          : c.kind === "s3"
            ? `s3://${c.root}`
            : c.repo
              ? `${c.owner}/${c.repo}`
              : c.owner;
    (conn.querySelector(".name") as HTMLElement).textContent = label;
    conn.title = label;
    conn.addEventListener("click", () => {
      document.querySelectorAll(".rail .conn").forEach((el) => el.classList.remove("active"));
      conn.classList.add("active");
      openRemoteConnection(c, conn);
    });
    container.appendChild(conn);
  });
  (Object.keys(ids) as ConnKind[]).forEach((k) => {
    const el = $(ids[k][1]);
    if (el) el.textContent = String(conns.filter((c) => c.kind === k).length);
  });
}

// ---------- 文件树 ----------
async function renderDir(path: string, clear: boolean, repo = "") {
  const body = $("tree-body");
  if (!body) return;
  const entries = await listEntries(path, repo);
  if (clear) body.innerHTML = "";
  const empty = $("tree-empty");
  if (empty) empty.style.display = "none";
  setTreeCount(entries.length, "items");
  const frag = document.createDocumentFragment();
  for (const entry of entries) frag.appendChild(buildRow(entry, 0, repo));
  body.appendChild(frag);
}

function buildRow(entry: TreeEntry, depth: number, repo: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.path = entry.path;
  row.dataset.level = String(depth);
  row.dataset.dir = entry.is_dir ? "1" : "0";
  if (activeSource.kind === "github") {
    if (!repo) {
      row.dataset.isrepo = "1";
      row.dataset.repo = entry.name;
      row.dataset.path = entry.name;
    } else {
      row.dataset.repo = repo;
      if (entry.sha) row.dataset.sha = entry.sha;
    }
  }
  row.title = entry.modified ? `${entry.path}\n${t("meta.modified")}${formatTime(entry.modified)}` : entry.path;

  for (let i = 0; i < depth; i++) {
    const guide = document.createElement("span");
    guide.className = "guide";
    row.appendChild(guide);
  }

  const g = document.createElement("span");
  g.className = "g";
  g.textContent = entry.is_dir ? "▸" : "　";
  row.appendChild(g);

  const ico = document.createElement("span");
  ico.className = "ico";
  ico.innerHTML = iconFor(entry);
  row.appendChild(ico);

  const name = document.createElement("span");
  name.className = entry.is_dir ? "name dir" : "name";
  name.textContent = entry.name;
  row.appendChild(name);

  const meta = document.createElement("span");
  meta.className = "meta";
  if (entry.is_dir) {
    meta.textContent = entry.modified ? formatCompactTime(entry.modified) : "";
  } else {
    meta.textContent = `${formatSize(entry.size)}${entry.modified ? ` · ${formatCompactTime(entry.modified)}` : ""}`;
  }
  row.appendChild(meta);

  row.addEventListener("click", () => onRowClick(row, entry));
  return row;
}

function onRowClick(row: HTMLElement, entry: TreeEntry) {
  document.querySelectorAll(".tree .row").forEach((r) => r.classList.remove("sel"));
  row.classList.add("sel");
  if (entry.is_dir) {
    toggleDir(row, entry);
    return;
  }
  registerTab(entry.name, { path: entry.path, repo: row.dataset.repo, sha: row.dataset.sha });
  if (activeSource.kind === "github") {
    previewGitHubFile(row.dataset.repo ?? "", entry.path, row.dataset.sha ?? "", entry.name);
  } else if (activeSource.kind === "gitlab") {
    previewGitLabFile(entry.path, entry.name);
  } else if (activeSource.kind === "http") {
    previewHttpFile(entry.path, entry.name);
  } else if (activeSource.kind === "webdav") {
    previewWebdavFile(entry.path, entry.name);
  } else if (activeSource.kind === "sftp") {
    previewSftpFile(entry.path, entry.name);
  } else if (activeSource.kind === "s3") {
    previewS3File(entry.path, entry.name);
  } else {
    previewFile(entry.path);
  }
}

function toggleDir(row: HTMLElement, entry: TreeEntry) {
  const level = parseInt(row.dataset.level ?? "0", 10);
  const g = row.querySelector(".g");
  if (row.dataset.expanded === "1") {
    row.dataset.expanded = "0";
    if (g) g.textContent = "▸";
    let next = row.nextElementSibling;
    while (next && parseInt((next as HTMLElement).dataset.level ?? "0", 10) > level) {
      const t = next.nextElementSibling;
      next.remove();
      next = t;
    }
  } else {
    row.dataset.expanded = "1";
    if (g) g.textContent = "▾";
    let listPath = entry.path;
    let listRepo = "";
    if (activeSource.kind === "github") {
      listPath = row.dataset.isrepo === "1" ? "" : entry.path;
      listRepo = row.dataset.repo ?? "";
    }
    listEntries(listPath, listRepo)
      .then((children) => {
        const frag = document.createDocumentFragment();
        for (const child of children) frag.appendChild(buildRow(child, level + 1, listRepo));
        row.after(frag);
      })
      .catch((e) => console.error("读取子目录失败", e));
  }
}

// ---------- 右键菜单 ----------
let ctxTarget: { path: string; is_dir: boolean; repo?: string; sha?: string } | null = null;

function setupContextMenu() {
  const menu = $("ctx-menu");
  if (!menu) return;

  document.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest?.(".tree .row") as HTMLElement | null;
    if (!row?.dataset.path) return;
    e.preventDefault();
    ctxTarget = { path: row.dataset.path, is_dir: row.dataset.dir === "1", repo: row.dataset.repo, sha: row.dataset.sha };
    const isImage = IMAGE_EXTS.has(extOf(ctxTarget.path));
    const isText = TEXT_EXTS.has(extOf(ctxTarget.path));
    const isDocx = ["docx", "docm", "dotx"].includes(extOf(ctxTarget.path));
    const isPdf = extOf(ctxTarget.path) === "pdf";
    menu.querySelectorAll<HTMLElement>("[data-wm-only]").forEach((el) => {
      el.style.display = isImage || isDocx || isPdf || isText ? "" : "none";
    });
    menu.querySelectorAll<HTMLElement>("[data-text-wm-only]").forEach((el) => {
      el.style.display = isText || isDocx ? "" : "none";
    });
    menu.querySelectorAll<HTMLElement>("[data-pdf-visible-only]").forEach((el) => {
      el.style.display = isPdf ? "" : "none";
    });
    menu.querySelectorAll<HTMLElement>("[data-remove-wm-only]").forEach((el) => {
      el.style.display = isText || isDocx || isPdf ? "" : "none";
    });
    const isDir = ctxTarget.is_dir;
    menu.querySelectorAll<HTMLElement>("[data-file-only]").forEach((el) => {
      el.style.display = isDir ? "none" : "";
    });
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = "block";
    // 视口边缘翻转：底部放不下向上弹，右侧放不下向左弹
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(4, e.clientY - rect.height)}px`;
    }
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(4, e.clientX - rect.width)}px`;
    }
  });

  document.addEventListener("click", () => {
    menu.style.display = "none";
  });

  menu.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
    item.addEventListener("click", () => {
      const action = item.dataset.action;
      const target = ctxTarget;
      menu.style.display = "none";
      if (!target) return;
      if (action === "refresh") refreshTarget(target);
      else if (action === "save-as") saveAsFile(target);
      else if (action === "zip") zipTarget(target);
      else if (action === "save-watermark") saveImageWithWatermark(target);
      else if (action === "embed-watermark") embedWatermark(target);
      else if (action === "extract-watermark") extractWatermark(target);
      else if (action === "print-watermark") printWithWatermark();
      else if (action === "embed-text-watermark") embedRemovableWatermark(target);
      else if (action === "embed-pdf-visible") embedPdfVisibleWatermark(target);
      else if (action === "remove-text-watermark") removeWatermark(target);
      else if (action === "copy-path") navigator.clipboard.writeText(target.path).catch((e) => console.error("复制失败", e));
      else if (action === "reveal" && activeSource.kind === "local") revealItemInDir(target.path).catch((e) => console.error("在访达中显示失败", e));
    });
  });
}

// ---------- 数据源右键菜单 ----------
type RailMenuTarget =
  | { type: "conn"; index: number }
  | { type: "localFolder"; path: string }
  | { type: "localFile"; path: string };
let railMenuTarget: RailMenuTarget | null = null;

function setupConnMenu() {
  const menu = $("conn-menu");
  if (!menu) return;

  document.addEventListener("contextmenu", (e) => {
    const railConn = (e.target as HTMLElement).closest?.(".rail .conn") as HTMLElement | null;
    if (!railConn) return;
    e.preventDefault();
    if (railConn.closest("#local-conns")) {
      const path = railConn.title;
      if (openLocalFolders.includes(path)) railMenuTarget = { type: "localFolder", path };
      else railMenuTarget = { type: "localFile", path };
    } else if (railConn.dataset.cid != null) {
      railMenuTarget = { type: "conn", index: Number(railConn.dataset.cid) };
    } else {
      return;
    }
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.style.display = "block";
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, e.clientY - rect.height)}px`;
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, e.clientX - rect.width)}px`;
  });

  document.addEventListener("click", () => {
    menu.style.display = "none";
  });

  menu.querySelectorAll<HTMLElement>(".ctx-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const action = item.dataset.action;
      const target = railMenuTarget;
      menu.style.display = "none";
      if (!target) return;
      if (action === "refresh") {
        if (target.type === "conn") openRemoteConnection(conns[target.index], connElementByIndex(target.index));
        else if (target.type === "localFolder") {
          currentRoot = target.path;
          setCrumbSource("local");
          await renderDir(target.path, true);
        } else previewFile(target.path);
      } else if (action === "edit") {
        if (target.type === "conn") openConnModal(conns[target.index], target.index);
        else revealItemInDir(target.path).catch((e) => console.error("在访达中显示失败", e));
      } else if (action === "update") {
        if (target.type === "conn") openRemoteConnection(conns[target.index], connElementByIndex(target.index));
        else if (target.type === "localFolder") {
          currentRoot = target.path;
          setCrumbSource("local");
          await renderDir(target.path, true);
        } else previewFile(target.path);
      } else if (action === "delete") {
        if (target.type === "conn") deleteConn(target.index);
        else if (target.type === "localFolder") {
          openLocalFolders = openLocalFolders.filter((d) => d !== target.path);
          renderLocalConns();
          persistState();
        } else {
          openLocalFiles = openLocalFiles.filter((f) => f !== target.path);
          renderLocalConns();
          persistState();
        }
      }
    });
  });
}

function refreshTarget(target: { path: string; is_dir: boolean; repo?: string; sha?: string }) {
  if (target.is_dir) {
    if (activeSource.kind === "github" || activeSource.kind === "gitlab") {
      const src = activeSource;
      const c = conns.find((x) => x.kind === src.kind && x.owner === src.owner && x.repo === src.repo);
      if (c) openRemoteConnection(c);
    } else if (activeSource.kind === "http" || activeSource.kind === "webdav") {
      const src = activeSource;
      const c = conns.find((x) => x.kind === src.kind && x.url === src.base);
      if (c) openRemoteConnection(c);
    } else if (activeSource.kind === "sftp" || activeSource.kind === "s3") {
      const src = activeSource;
      const c = conns.find((x) => x.kind === src.kind && x.url === (src.kind === "sftp" ? src.host : src.endpoint));
      if (c) openRemoteConnection(c);
    } else if (currentRoot) {
      renderDir(currentRoot, true);
    }
  } else if (activeSource.kind === "github" && target.repo) {
    previewGitHubFile(target.repo, target.path, target.sha ?? "", target.path.split("/").pop() ?? target.path);
  } else if (activeSource.kind === "gitlab") {
    previewGitLabFile(target.path, target.path.split("/").pop() ?? target.path);
  } else if (activeSource.kind === "http") {
    previewHttpFile(target.path, target.path.split("/").pop() ?? target.path);
  } else if (activeSource.kind === "webdav") {
    previewWebdavFile(target.path, target.path.split("/").pop() ?? target.path);
  } else if (activeSource.kind === "sftp") {
    previewSftpFile(target.path, target.path.split("/").pop() ?? target.path);
  } else if (activeSource.kind === "s3") {
    previewS3File(target.path, target.path.split("/").pop() ?? target.path);
  } else {
    previewFile(target.path);
  }
}

// 文本分块的滚动加载
function setupTextScroll() {
  const textView = $("text-view");
  if (!textView) return;
  textView.addEventListener("scroll", () => {
    if (textView.scrollTop + textView.clientHeight >= textView.scrollHeight - 300) {
      textLoadMore?.();
    }
  });
}

function setupDividers() {
  document.querySelectorAll<HTMLElement>(".divider").forEach((divider) => {
    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pane = $(divider.dataset.resize === "rail" ? "pane-rail" : "pane-tree");
      if (!pane) return;
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      divider.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: MouseEvent) => {
        const w = Math.min(600, Math.max(140, startW + (ev.clientX - startX)));
        pane.style.width = `${w}px`;
      };
      const onUp = () => {
        divider.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  });
}

async function initStatusBar() {
  const el = $("app-version");
  if (!el) return;
  try {
    const info = await invoke<{ name: string; version: string }>("app_info");
    el.textContent = `${info.name} v${info.version}`;
  } catch (e) {
    console.warn("app_info 调用失败（可能运行在纯浏览器环境）", e);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setupInteractions();
  configureViewer();
  watchViewerCodeTheme();
  initStatusBar();
  setupPasswordToggles();
  setupCliInstall();
  applySettings();
  loadState();
});
