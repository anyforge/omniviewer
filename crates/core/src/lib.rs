//! Omniviewer 核心库：GUI（Tauri）与 CLI 共用的所有文件/搜索/水印/缓存逻辑。
//! 不含任何 Tauri / reqwest / ssh2 / s3 依赖（远程源与压缩打包留在 GUI 侧）。

pub mod cache;
pub mod extract;
pub mod fs;
pub mod search;
pub mod state;
pub mod structured;
pub mod watermark;
