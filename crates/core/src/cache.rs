//! 预览缓存：~/.omniviewer/cache/，文件名 = key 的稳定哈希。

use crate::state::omniviewer_dir;

/// 缓存上限：超此大小自动淘汰最旧文件。
pub const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

static LABELS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn cache_dir() -> Result<std::path::PathBuf, String> {
    Ok(omniviewer_dir()?.join("cache"))
}

/// 缓存文件名：对 key 做稳定哈希。
pub fn cache_filename(key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// 读缓存（命中返回字节，未命中返回空 Vec）。
pub fn cache_get(key: &str) -> Result<Vec<u8>, String> {
    let path = cache_dir()?.join(cache_filename(key));
    match std::fs::read(&path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 写缓存（超上限自动淘汰最旧文件）。
pub fn cache_put(key: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(cache_filename(key)), bytes).map_err(|e| e.to_string())?;
    enforce_cache_limit()
}

fn enforce_cache_limit() -> Result<(), String> {
    let dir = cache_dir()?;
    if !dir.exists() {
        return Ok(());
    }
    let mut files: Vec<(std::path::PathBuf, u64, u64)> = Vec::new();
    let mut total = 0u64;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_labels = path.file_name().and_then(|n| n.to_str()) == Some("labels.json");
        if path.is_file() && !is_labels {
            if let Ok(meta) = entry.metadata() {
                let size = meta.len();
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                total += size;
                files.push((path, size, mtime));
            }
        }
    }
    if total <= MAX_CACHE_BYTES {
        return Ok(());
    }
    files.sort_by_key(|f| f.2); // 最旧在前
    for (path, size, _) in files {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        let _ = std::fs::remove_file(&path);
        total = total.saturating_sub(size);
    }
    Ok(())
}

/// 清空缓存（含源身份映射与临时目录），返回删除的顶层条目数。
pub fn cache_clear() -> Result<usize, String> {
    let dir = cache_dir()?;
    if !dir.exists() {
        return Ok(0);
    }
    let count = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.count();
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(count)
}

/// 缓存总大小（字节）。
pub fn cache_size() -> Result<u64, String> {
    let dir = cache_dir()?;
    if !dir.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                total += meta.len();
            }
        }
    }
    Ok(total)
}

// ---- 源身份映射（hash 文件名 → 原始 key，供远程检索回显源路径） ----

fn labels_path() -> Result<std::path::PathBuf, String> {
    Ok(cache_dir()?.join("labels.json"))
}

/// 记录缓存文件的源身份（hash → key，key 即远程源的原始标识串）。加锁防并发读改写丢更新。
pub fn cache_put_label(key: &str) -> Result<(), String> {
    let _guard = LABELS_LOCK.lock().map_err(|_| "缓存标签锁失败".to_string())?;
    let path = labels_path()?;
    let mut map: std::collections::HashMap<String, String> = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::collections::HashMap::new(),
        Err(_) => std::collections::HashMap::new(),
    };
    map.insert(cache_filename(key), key.to_string());
    let dir = cache_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string());
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// 读取全部源身份映射（hash 文件名 → 原始 key）。
pub fn cache_labels() -> Result<std::collections::HashMap<String, String>, String> {
    let path = labels_path()?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(std::collections::HashMap::new()),
        Err(e) => Err(e.to_string()),
    }
}
