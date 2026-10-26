//! 本地文件操作：读/列/区间读/另存/复制/临时目录。

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// 读取本地文件原始字节（超 512MB 拒绝，防读爆内存）。
pub fn read_file(path: &str) -> Result<Vec<u8>, String> {
    const MAX_READ: u64 = 512 * 1024 * 1024;
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ {
        return Err(format!("文件过大（{} 字节，超过 512MB 上限）", meta.len()));
    }
    std::fs::read(path).map_err(|e| e.to_string())
}

/// 列出目录内容（单层）。
pub fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 读取文件的字节区间（用于大文件分块加载）。
pub fn read_file_range(path: &str, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; length as usize];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    Ok(buf)
}

/// 文件大小（字节）。
pub fn file_size(path: &str) -> Result<u64, String> {
    std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// 另存为：把字节写入 dest（自动建父目录）。
pub fn save_bytes(dest: &str, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest, bytes).map_err(|e| e.to_string())
}

/// 另存为：本地文件复制到 dest。
pub fn copy_file(src: &str, dest: &str) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
}

fn copy_path_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_path_recursive(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// 另存为：本地文件或文件夹递归复制到 dest。
pub fn copy_path(src: &str, dest: &str) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_path_recursive(std::path::Path::new(src), std::path::Path::new(dest))
}

/// 新建临时目录（远程文件夹下载中转），返回绝对路径。先清理 24h 前的残留。
pub fn make_temp_dir() -> Result<String, String> {
    let tmp_root = crate::cache::cache_dir()?.join("tmp");
    sweep_stale_tmp(&tmp_root);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = tmp_root.join(format!("{nanos}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

fn sweep_stale_tmp(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            let age = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            if let Some(m) = age {
                if now.saturating_sub(m) > 24 * 3600 {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// 递归删除路径（清理临时目录）。
pub fn remove_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}
