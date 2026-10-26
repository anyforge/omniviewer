// 构建 CLI 并复制为 Tauri sidecar（beforeBuildCommand 调用）。
// 目标 triple 优先取 Tauri 构建环境传入的 target（支持 macOS x86_64 交叉编译），
// 否则回退 rustc host。
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";

const envTarget =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  process.env.CARGO_BUILD_TARGET ||
  process.env.TAURI_ENV_TARGET;

const host = envTarget || execSync("rustc -vV").toString().match(/host: (\S+)/)?.[1];
if (!host) {
  console.error("无法确定 rustc target triple");
  process.exit(1);
}

const targetArgs = envTarget ? [`--target=${envTarget}`] : [];

// 1. 构建 CLI（release，与 App 同一 target）
execSync(
  ["cargo", "build", "--release", ...targetArgs, "--manifest-path", "crates/cli/Cargo.toml"].join(" "),
  { stdio: "inherit" }
);

// 2. 复制到 sidecar 目录（Tauri externalBin 约定：<name>-<triple>）
const ext = process.platform === "win32" ? ".exe" : "";
const targetSub = envTarget ? `${envTarget}/` : "";
const src = `crates/cli/target/${targetSub}release/omniviewer${ext}`;
const destDir = "src-tauri/binaries";
const dest = `${destDir}/omniviewer-cli-${host}${ext}`;

if (!existsSync(src)) {
  console.error("CLI 未构建成功，缺少: " + src);
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("CLI sidecar 已就绪:", dest);
