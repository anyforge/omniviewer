//! 文本抽取：文本文件读取 + Office（docx/xlsx/pptx）ZIP+XML 抽文本 + PDF。
//! 提供字节级抽取（供缓存文件等无扩展名场景用）。

pub const SEARCH_TEXT_EXTS: &[&str] = &["txt", "md", "markdown", "log", "lrc", "json", "jsonc", "json5", "xml", "yaml", "yml", "toml", "ini", "conf", "cfg", "html", "htm", "css", "vue", "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "java", "go", "rs", "c", "cpp", "cc", "h", "hpp", "cs", "php", "rb", "swift", "kt", "sh", "bash", "zsh", "sql", "proto", "hcl", "tex", "diff", "patch", "csv", "tsv"];

pub const OFFICE_EXTS: &[&str] = &["docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx"];

fn zip_read_part_to_string(bytes: &[u8], part: &str) -> Option<String> {
    use std::io::Read;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).ok()?;
    let mut p = archive.by_name(part).ok()?;
    let mut buf = String::new();
    p.read_to_string(&mut buf).ok()?;
    Some(buf)
}

fn strip_xml_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn extract_office_text_from_bytes(bytes: &[u8], ext: &str) -> Option<String> {
    match ext {
        "docx" | "docm" | "dotx" => zip_read_part_to_string(bytes, "word/document.xml").map(|x| strip_xml_tags(&x)),
        "xlsx" | "xlsm" | "xltx" => zip_read_part_to_string(bytes, "xl/sharedStrings.xml").map(|x| strip_xml_tags(&x)),
        "pptx" | "pptm" | "potx" => {
            use std::io::Read;
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes.to_vec())).ok()?;
            let mut out = String::new();
            let mut count = 0;
            for i in 0..archive.len() {
                let mut e = archive.by_index(i).ok()?;
                let name = e.name().ok()?.to_string();
                if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                    let mut buf = String::new();
                    e.read_to_string(&mut buf).ok()?;
                    out.push_str(&strip_xml_tags(&buf));
                    out.push(' ');
                    count += 1;
                    if count > 100 {
                        break;
                    }
                }
            }
            Some(out)
        }
        _ => None,
    }
}

/// 从字节抽取文本（ext 决定类型），失败返回 None。
pub fn extract_text_from_bytes(bytes: &[u8], ext: &str) -> Option<String> {
    const MAX_TEXT_SIZE: usize = 10 * 1024 * 1024;
    let ext = ext.to_lowercase();
    if OFFICE_EXTS.contains(&ext.as_str()) {
        return extract_office_text_from_bytes(bytes, &ext);
    }
    if ext == "pdf" {
        // pdf-extract 对不支持的字体编码（如未嵌入 CJK 的 UniGB-UTF16-H）会 panic，
        // 用 catch_unwind 兜底，避免拖垮检索索引/预览回退。
        return std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(bytes))
            .ok()
            .and_then(|r| r.ok())
            .filter(|s| !s.trim().is_empty());
    }
    if SEARCH_TEXT_EXTS.contains(&ext.as_str()) {
        if bytes.len() > MAX_TEXT_SIZE {
            return None;
        }
        return String::from_utf8(bytes.to_vec()).ok();
    }
    None
}

/// 抽取任意可索引文件的文本（按扩展名分派），失败返回 None。
pub fn extract_file_text(path: &std::path::Path) -> Option<String> {
    const MAX_FILE_SIZE: u64 = 50 * 1024 * 1024; // 整体上限，避免读爆内存
    let ext = path.extension().and_then(|e| e.to_str())?.to_lowercase();
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    extract_text_from_bytes(&bytes, &ext)
}
