//! 全文检索：grep 回退 + FTS5/jieba 索引（中英三通道分词 + BM25）。

use serde::Serialize;

use crate::extract::extract_file_text;

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

// ---- 文件名模糊搜索（递归 + 精准/前缀/子串/模糊子序列 四级匹配） ----

#[derive(Serialize)]
pub struct NameMatch {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

/// 匹配评分：0 精准（完全相等）> 1 前缀 > 2 子串 > 3 模糊子序列（字符按序跳过）。
/// 例：`onfig` 子串命中 `config`；`cnfg`/`cfg` 子序列命中 `config`。
fn match_name(name_lower: &str, q: &str) -> Option<u8> {
    if name_lower == q {
        return Some(0);
    }
    if name_lower.starts_with(q) {
        return Some(1);
    }
    if name_lower.contains(q) {
        return Some(2);
    }
    if is_subsequence(q, name_lower) {
        return Some(3);
    }
    None
}

fn is_subsequence(q: &str, name: &str) -> bool {
    let mut chars = name.chars();
    for c in q.chars() {
        if !chars.any(|x| x == c) {
            return false;
        }
    }
    true
}

fn walk_names(dir: &str, q: &str, out: &mut Vec<(u8, String, String, bool)>, depth: usize) -> Result<(), String> {
    if out.len() >= 500 || depth > 20 {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path().to_string_lossy().to_string();
        let name = entry.file_name().to_string_lossy().to_string();
        let nl = name.to_lowercase();
        if let Some(score) = match_name(&nl, q) {
            out.push((score, name.clone(), path.clone(), ft.is_dir()));
        }
        if ft.is_dir() {
            walk_names(&path, q, out, depth + 1)?;
        }
    }
    Ok(())
}

/// 递归文件名搜索：按匹配精度排序（精准 → 前缀 → 子串 → 模糊），最多 500 条。
pub fn search_names(root: &str, query: &str) -> Result<Vec<NameMatch>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut out: Vec<(u8, String, String, bool)> = Vec::new();
    walk_names(root, &q, &mut out, 0)?;
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(out
        .into_iter()
        .take(500)
        .map(|(_, name, path, is_dir)| NameMatch { path, name, is_dir })
        .collect())
}

// ---- grep 回退 ----
fn search_dir(dir: &str, q: &str, hits: &mut Vec<SearchHit>, depth: usize) -> Result<(), String> {
    if hits.len() >= 200 || depth > 20 {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if ft.is_dir() {
            search_dir(&path.to_string_lossy(), q, hits, depth + 1)?;
        } else if ft.is_file() {
            if let Some(text) = extract_file_text(&path) {
                search_text(&text, &path, q, hits);
            }
        }
        if hits.len() >= 200 {
            break;
        }
    }
    Ok(())
}

fn search_text(text: &str, path: &std::path::Path, q: &str, hits: &mut Vec<SearchHit>) {
    for (i, line) in text.lines().enumerate() {
        if line.to_lowercase().contains(q) {
            let snippet: String = line.chars().take(200).collect();
            hits.push(SearchHit {
                path: path.to_string_lossy().to_string(),
                line: i + 1,
                text: snippet,
            });
            if hits.len() >= 200 {
                break;
            }
        }
    }
}

/// grep 全文搜索（回退路径）。
pub fn search_local(query: &str, root: &str) -> Result<Vec<SearchHit>, String> {
    let q = query.to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    search_dir(root, &q, &mut hits, 0)?;
    hits.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    Ok(hits)
}

// ---- FTS5 + jieba 索引（中英同等） ----
fn jieba() -> &'static jieba_rs::Jieba {
    static J: std::sync::OnceLock<jieba_rs::Jieba> = std::sync::OnceLock::new();
    J.get_or_init(jieba_rs::Jieba::new)
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}')
}

fn latin_runs(text: &str) -> Vec<String> {
    let mut runs = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            cur.push(c);
        } else if !cur.is_empty() {
            runs.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        runs.push(cur);
    }
    runs
}

fn split_identifier(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    for c in s.chars() {
        if c == '_' {
            if !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
        } else if c.is_ascii_uppercase() && !cur.is_empty() && !cur.chars().all(|x| x.is_ascii_uppercase()) {
            parts.push(std::mem::take(&mut cur));
            cur.push(c);
        } else {
            cur.push(c);
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

// 索引分词：jieba 词 + 英文标识符拆分 + 中文 2-gram
fn tokenize_index(text: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    for t in jieba().cut_for_search(text, true) {
        tokens.push(t.word.to_lowercase());
    }
    for run in latin_runs(text) {
        for p in split_identifier(&run) {
            if !p.is_empty() {
                tokens.push(p.to_lowercase());
            }
        }
    }
    let chars: Vec<char> = text.chars().collect();
    for i in 0..chars.len().saturating_sub(1) {
        if is_cjk(chars[i]) && is_cjk(chars[i + 1]) {
            tokens.push(format!("{}{}", chars[i], chars[i + 1]));
        }
    }
    tokens.join(" ")
}

// 查询分词：jieba 词 + 英文标识符拆分（不加 2-gram）
fn tokenize_query(text: &str) -> String {
    let mut tokens: Vec<String> = Vec::new();
    for t in jieba().cut_for_search(text, true) {
        tokens.push(t.word.to_lowercase());
    }
    for run in latin_runs(text) {
        for p in split_identifier(&run) {
            if !p.is_empty() {
                tokens.push(p.to_lowercase());
            }
        }
    }
    tokens.join(" ")
}

const INDEX_SCHEMA_VERSION: i32 = 1;

fn index_conn() -> Result<rusqlite::Connection, String> {
    let dir = crate::state::omniviewer_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let conn = rusqlite::Connection::open(dir.join("index.sqlite")).map_err(|e| e.to_string())?;
    // 索引是可重建缓存：schema 版本不符直接重建，不做迁移
    let ver: i32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
    if ver != INDEX_SCHEMA_VERSION {
        conn.execute_batch(
            "DROP TABLE IF EXISTS meta;
             DROP TABLE IF EXISTS docs;
             DROP TABLE IF EXISTS fts;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("PRAGMA user_version = {INDEX_SCHEMA_VERSION};"))
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta(path TEXT PRIMARY KEY, mtime INTEGER, rowid INTEGER);
         CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, content TEXT);
         CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(path UNINDEXED, content, tokenize='unicode61');",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn index_file(conn: &rusqlite::Connection, path: &str, mtime: i64, text: &str) -> Result<(), String> {
    let cached: Option<(i64, i64)> = conn
        .query_row("SELECT mtime, rowid FROM meta WHERE path = ?1", [path], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok();
    if let Some((mt, rid)) = cached {
        if mt == mtime {
            return Ok(()); // 未变，跳过
        }
        conn.execute("DELETE FROM fts WHERE rowid = ?1", [rid]).map_err(|e| e.to_string())?;
    }
    let tokens = tokenize_index(text);
    conn.execute("INSERT INTO fts(path, content) VALUES (?1, ?2)", rusqlite::params![path, tokens]).map_err(|e| e.to_string())?;
    let rid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO meta(path, mtime, rowid) VALUES (?1, ?2, ?3) ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, rowid=excluded.rowid",
        rusqlite::params![path, mtime, rid],
    )
    .map_err(|e| e.to_string())?;
    // 原始文本（用于生成干净 snippet）
    conn.execute(
        "INSERT INTO docs(path, content) VALUES (?1, ?2) ON CONFLICT(path) DO UPDATE SET content=excluded.content",
        rusqlite::params![path, text],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn index_dir(conn: &rusqlite::Connection, dir: &str, depth: usize, seen: &mut std::collections::HashSet<String>) -> Result<(), String> {
    if depth > 20 {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if ft.is_dir() {
            index_dir(conn, &path.to_string_lossy(), depth + 1, seen)?;
        } else if ft.is_file() {
            let pstr = path.to_string_lossy().to_string();
            seen.insert(pstr.clone()); // 标记文件存在，供 GC 用
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if let Some(text) = extract_file_text(&path) {
                index_file(conn, &pstr, mtime, &text)?;
            }
        }
    }
    Ok(())
}

/// 清理 root 下已删除文件的陈旧索引条目（防误报 + 防膨胀）。
fn gc_stale(conn: &rusqlite::Connection, root: &str, seen: &std::collections::HashSet<String>) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT path, rowid FROM meta").map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for (path, rid) in rows {
        if path.starts_with(root) && !seen.contains(&path) {
            conn.execute("DELETE FROM fts WHERE rowid = ?1", [rid]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM meta WHERE path = ?1", [&path]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM docs WHERE path = ?1", [&path]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 建/重建索引（增量：mtime 未变跳过；含陈旧条目清理）。
pub fn build_index(root: &str) -> Result<(), String> {
    let conn = index_conn()?;
    let mut seen = std::collections::HashSet::new();
    index_dir(&conn, root, 0, &mut seen)?;
    gc_stale(&conn, root, &seen)
}

fn make_snippet(original: &str, query: &str) -> String {
    const WINDOW: usize = 120; // 字节窗口
    let q_lower = query.trim().to_lowercase();
    let orig_lower = original.to_lowercase();
    let q_len = q_lower.len();
    let total = original.len();
    let (mut start, mut end) = match orig_lower.find(&q_lower) {
        Some(p) => (p.saturating_sub(WINDOW), (p + q_len + WINDOW).min(total)),
        None => (0, total.min(WINDOW * 2)),
    };
    // 对齐 UTF-8 字符边界
    while start > 0 && !original.is_char_boundary(start) {
        start += 1;
    }
    while end < total && !original.is_char_boundary(end) {
        end += 1;
    }
    let snip = original[start..end].replace(['\n', '\r', '\t'], " ");
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(&snip);
    if end < total {
        out.push('…');
    }
    out
}

fn query_fts(conn: &rusqlite::Connection, q: &str) -> Result<Vec<SearchHit>, String> {
    let tokens = tokenize_query(q);
    if tokens.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare("SELECT path FROM fts WHERE content MATCH ?1 ORDER BY bm25(fts) LIMIT 200")
        .map_err(|e| e.to_string())?;
    let paths: Vec<String> = stmt
        .query_map([&tokens], |r| r.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for path in paths {
        let content: Option<String> = conn
            .query_row("SELECT content FROM docs WHERE path = ?1", [&path], |r| r.get(0))
            .ok();
        let snippet = content.map(|c| make_snippet(&c, q)).unwrap_or_default();
        out.push(SearchHit { path, line: 0, text: snippet });
    }
    Ok(out)
}

/// 全文搜索（FTS5 + jieba 索引，BM25 排序；短查询/空结果回退 grep）。
pub fn search_index(query: &str, root: &str) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // 单字符查询：jieba/bigram 覆盖不了，直接 grep
    if q.chars().count() < 2 {
        return search_local(&q, root);
    }
    let conn = index_conn()?;
    let mut seen = std::collections::HashSet::new();
    index_dir(&conn, root, 0, &mut seen)?;
    gc_stale(&conn, root, &seen)?;
    let mut hits = query_fts(&conn, &q)?;
    // 只保留当前 root 下的结果
    hits.retain(|h| h.path.starts_with(root));
    if hits.is_empty() {
        return search_local(&q, root);
    }
    Ok(hits)
}

/// 已索引文件数（用于 status）。
pub fn indexed_count() -> Result<usize, String> {
    let conn = index_conn()?;
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM meta", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(n as usize)
}

// ---- 远程全文检索（4g 层1：检索已缓存过的远程文件） ----

/// 从源标识串（label）提取扩展名（最后一个 `.ext`，1-8 位字母数字）。
fn ext_from_label(label: &str) -> Option<String> {
    for i in (0..label.len()).rev() {
        if label.as_bytes()[i] == b'.' {
            let rest = &label[i + 1..];
            let ext: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if !ext.is_empty() && ext.len() <= 8 {
                return Some(ext.to_lowercase());
            }
            return None;
        }
    }
    None
}

fn is_remote_label(path: &str) -> bool {
    const PREFIXES: [&str; 6] = ["github:", "gitlab:", "http:", "webdav:", "sftp:", "s3:"];
    PREFIXES.iter().any(|p| path.starts_with(p))
}

fn index_remote(conn: &rusqlite::Connection) -> Result<(), String> {
    let labels = crate::cache::cache_labels()?;
    if labels.is_empty() {
        return Ok(());
    }
    let dir = crate::cache::cache_dir()?;
    for (hash, key) in labels {
        let path = dir.join(&hash);
        let mtime = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let Some(ext) = ext_from_label(&key) else { continue };
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if let Some(text) = crate::extract::extract_text_from_bytes(&bytes, &ext) {
            // 用源标识串作为索引 path，检索结果直接回显源路径
            index_file(conn, &key, mtime, &text)?;
        }
    }
    Ok(())
}

/// 全文检索已缓存过的远程文件（4g 层1）。
pub fn search_remote(query: &str) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    if q.chars().count() < 2 {
        // 单字符：jieba/bigram 覆盖不了，对缓存文件做 contains 回退
        let labels = crate::cache::cache_labels()?;
        let dir = crate::cache::cache_dir()?;
        let ql = q.to_lowercase();
        let mut out = Vec::new();
        for (hash, key) in labels {
            let path = dir.join(&hash);
            let Some(ext) = ext_from_label(&key) else { continue };
            let Ok(bytes) = std::fs::read(&path) else { continue };
            if let Some(text) = crate::extract::extract_text_from_bytes(&bytes, &ext) {
                for (i, line) in text.lines().enumerate() {
                    if line.to_lowercase().contains(&ql) {
                        out.push(SearchHit { path: key.clone(), line: i + 1, text: line.chars().take(200).collect() });
                        if out.len() >= 200 {
                            break;
                        }
                    }
                }
            }
        }
        return Ok(out);
    }
    let conn = index_conn()?;
    index_remote(&conn)?;
    let mut hits = query_fts(&conn, &q)?;
    hits.retain(|h| is_remote_label(&h.path));
    Ok(hits)
}
