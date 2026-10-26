use serde::Serialize;
use std::io::Write as _;
use zip::unstable::write::FileOptionsExt;

#[derive(Serialize)]
struct AppInfo {
    name: &'static str,
    version: &'static str,
}

/// 返回应用名与版本号，用于前端状态栏展示。
#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "Omniviewer",
        version: env!("CARGO_PKG_VERSION"),
    }
}

// ---- 本地文件（薄封装 core） ----

#[tauri::command]
async fn read_file(path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || omniviewer_core::fs::read_file(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<omniviewer_core::fs::DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || omniviewer_core::fs::list_dir(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_file_range(path: String, offset: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = omniviewer_core::fs::read_file_range(&path, offset, length)?;
        Ok::<Vec<u8>, String>(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    omniviewer_core::fs::file_size(&path)
}

#[tauri::command]
fn save_bytes(dest: String, bytes: Vec<u8>) -> Result<(), String> {
    omniviewer_core::fs::save_bytes(&dest, &bytes)
}

#[tauri::command]
fn copy_file(src: String, dest: String) -> Result<(), String> {
    omniviewer_core::fs::copy_file(&src, &dest)
}

#[tauri::command]
async fn copy_path(src: String, dest: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || omniviewer_core::fs::copy_path(&src, &dest))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn make_temp_dir() -> Result<String, String> {
    omniviewer_core::fs::make_temp_dir()
}

#[tauri::command]
fn remove_path(path: String) -> Result<(), String> {
    omniviewer_core::fs::remove_path(&path)
}

// ---- 状态 / 缓存 / 主题（薄封装 core） ----

#[tauri::command]
fn load_state() -> Result<String, String> {
    omniviewer_core::state::load_state()
}

#[tauri::command]
fn save_state(json: String) -> Result<(), String> {
    omniviewer_core::state::save_state(json)
}

#[tauri::command]
fn cache_get(key: String) -> Result<tauri::ipc::Response, String> {
    let bytes = omniviewer_core::cache::cache_get(&key)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn cache_put(key: String, bytes: Vec<u8>) -> Result<(), String> {
    omniviewer_core::cache::cache_put(&key, &bytes)
}

#[tauri::command]
fn cache_clear() -> Result<usize, String> {
    omniviewer_core::cache::cache_clear()
}

#[tauri::command]
fn cache_size() -> Result<u64, String> {
    omniviewer_core::cache::cache_size()
}

#[tauri::command]
fn cache_put_label(key: String) -> Result<(), String> {
    omniviewer_core::cache::cache_put_label(&key)
}

#[tauri::command]
fn list_themes() -> Result<Vec<String>, String> {
    omniviewer_core::state::list_themes()
}

#[tauri::command]
fn read_theme(name: String) -> Result<String, String> {
    omniviewer_core::state::read_theme(&name)
}

#[tauri::command]
fn ensure_themes() -> Result<(), String> {
    omniviewer_core::state::ensure_themes()
}

#[tauri::command]
async fn describe_structured(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || omniviewer_core::structured::describe_structured(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extract_file_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        omniviewer_core::extract::extract_file_text(std::path::Path::new(&path))
            .ok_or_else(|| "无法抽取文本".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- CLI 安装（sidecar 复制到 ~/.local/bin）----

fn cli_home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .map_err(|_| "无法定位用户主目录".to_string())
}

fn cli_bin_dir() -> Result<std::path::PathBuf, String> {
    Ok(cli_home_dir()?.join(".local").join("bin"))
}

#[tauri::command]
fn cli_status() -> Result<bool, String> {
    Ok(cli_bin_dir()?.join("omniviewer").exists())
}

#[tauri::command]
fn install_cli(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    // sidecar 可能在资源根或 binaries 子目录
    let candidates = [
        res.join("omniviewer-cli"),
        res.join("binaries").join("omniviewer-cli"),
        res.join("omniviewer-cli.exe"),
        res.join("binaries").join("omniviewer-cli.exe"),
    ];
    let src = candidates
        .iter()
        .find(|p| p.exists())
        .ok_or("未找到内置 CLI 二进制".to_string())?;
    let bindir = cli_bin_dir()?;
    std::fs::create_dir_all(&bindir).map_err(|e| e.to_string())?;
    let dest = bindir.join("omniviewer");
    std::fs::copy(src, &dest).map_err(|e| format!("复制失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(dest.to_string_lossy().to_string())
}

// ---- 检索 / 水印（薄封装 core） ----

#[tauri::command]
fn search_index(query: String, root: String) -> Result<Vec<omniviewer_core::search::SearchHit>, String> {
    omniviewer_core::search::search_index(&query, &root)
}

#[tauri::command]
fn search_remote(query: String) -> Result<Vec<omniviewer_core::search::SearchHit>, String> {
    omniviewer_core::search::search_remote(&query)
}

#[tauri::command]
async fn search_names(root: String, query: String) -> Result<Vec<omniviewer_core::search::NameMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || omniviewer_core::search::search_names(&root, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn docx_embed_watermark(src: String, dest: String, id: String) -> Result<(), String> {
    omniviewer_core::watermark::docx_embed_watermark(&src, &dest, &id)
}

#[tauri::command]
fn docx_extract_watermark(src: String) -> Result<Option<String>, String> {
    omniviewer_core::watermark::docx_extract_watermark(&src)
}

#[tauri::command]
fn docx_remove_watermark(src: String, dest: String) -> Result<bool, String> {
    omniviewer_core::watermark::docx_remove_watermark(&src, &dest)
}

#[tauri::command]
fn docx_embed_visible_watermark(src: String, dest: String, text: String) -> Result<(), String> {
    omniviewer_core::watermark::docx_embed_visible_watermark(&src, &dest, &text)
}

// ---- 远程源（GUI 专属，reqwest/ssh2/s3） ----

#[derive(Serialize)]
struct RemoteEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    sha: String,
}

/// 通用 HTTP GET，返回原始字节（绕过浏览器 CORS）。
#[tauri::command]
async fn http_get(url: String) -> Result<tauri::ipc::Response, String> {
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Omniviewer")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// 解析 autoindex HTML 目录列表（nginx autoindex / python http.server，best-effort）。
#[tauri::command]
async fn http_list(url: String) -> Result<Vec<RemoteEntry>, String> {
    let resp = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "Omniviewer")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let html = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_autoindex(&html, &url))
}

fn parse_autoindex(html: &str, base: &str) -> Vec<RemoteEntry> {
    let re = regex::Regex::new(r#"<a[^>]+href="([^"]*)"[^>]*>([^<]*)</a>"#).unwrap();
    let base = if base.ends_with('/') { base.to_string() } else { format!("{base}/") };
    let mut out = Vec::new();
    for cap in re.captures_iter(html) {
        let href = cap[1].trim().to_string();
        let name = cap[2].trim().to_string();
        if name.is_empty() || href == "../" || href == "/" || href == "./" {
            continue;
        }
        let is_dir = href.ends_with('/');
        let full = if href.starts_with("http") { href.clone() } else { format!("{base}{href}") };
        out.push(RemoteEntry {
            name: name.trim_end_matches('/').to_string(),
            path: full,
            is_dir,
            size: 0,
            sha: String::new(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// WebDAV PROPFIND 列目录（Depth: 1）。
#[tauri::command]
async fn webdav_list(url: String, user: String, pass: String) -> Result<Vec<RemoteEntry>, String> {
    let mut req = reqwest::Client::new()
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &url)
        .header("Depth", "1")
        .header("User-Agent", "Omniviewer");
    if !user.is_empty() {
        req = req.basic_auth(user, Some(pass));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("WebDAV {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_propfind(&body, &url))
}

fn parse_propfind(xml: &str, base: &str) -> Vec<RemoteEntry> {
    let re_resp = regex::Regex::new(r"(?is)<(?:D:)?response>.*?</(?:D:)?response>").unwrap();
    let re_href = regex::Regex::new(r"(?is)<(?:D:)?href>([^<]+)</(?:D:)?href>").unwrap();
    let re_coll = regex::Regex::new(r"(?is)<(?:D:)?collection\s*/?>").unwrap();
    let base_trim = base.trim_end_matches('/');
    let mut out = Vec::new();
    for cap in re_resp.captures_iter(xml) {
        let block = cap.get(0).unwrap().as_str();
        let Some(h) = re_href.captures(block) else { continue };
        let href = h[1].trim().to_string();
        let href_trim = href.trim_end_matches('/');
        if href_trim == base_trim {
            continue; // 目录自身
        }
        let name = href_trim.rsplit('/').next().unwrap_or(&href).to_string();
        if name.is_empty() {
            continue;
        }
        let full = if href.starts_with("http") { href.clone() } else { format!("{base_trim}{href}") };
        out.push(RemoteEntry {
            name,
            path: full,
            is_dir: re_coll.is_match(block),
            size: 0,
            sha: String::new(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// WebDAV GET 文件。
#[tauri::command]
async fn webdav_get(url: String, user: String, pass: String) -> Result<tauri::ipc::Response, String> {
    let mut req = reqwest::Client::new().get(&url).header("User-Agent", "Omniviewer");
    if !user.is_empty() {
        req = req.basic_auth(user, Some(pass));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// 单文件分块并行下载（HTTP/WebDAV，Range 请求），加速大文件。
#[tauri::command]
async fn http_download(url: String, dest: String, concurrency: usize, user: Option<String>, pass: Option<String>) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let client = reqwest::Client::new();
    let mut first_req = client.get(&url);
    if let (Some(u), Some(p)) = (user.as_deref(), pass.as_deref()) {
        first_req = first_req.basic_auth(u, Some(p));
    }
    let resp = first_req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    if total == 0 {
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let file = std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&dest).map_err(|e| e.to_string())?;
    file.set_len(total).map_err(|e| e.to_string())?;
    drop(file);
    let concurrency = concurrency.max(1).min(16);
    let chunk = total.div_ceil(concurrency as u64);
    let mut handles = Vec::new();
    let mut start = 0u64;
    while start < total {
        let end = std::cmp::min(start + chunk - 1, total - 1);
        let url = url.clone();
        let dest = dest.clone();
        let client = client.clone();
        let user = user.clone();
        let pass = pass.clone();
        handles.push(tauri::async_runtime::spawn(async move {
            let mut last_err = String::new();
            for _attempt in 0..3 {
                match fetch_range(&client, &url, &user, &pass, start, end).await {
                    Ok(bytes) => {
                        let mut f = std::fs::OpenOptions::new().write(true).open(&dest).map_err(|e| e.to_string())?;
                        f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
                        f.write_all(&bytes).map_err(|e| e.to_string())?;
                        return Ok::<(), String>(());
                    }
                    Err(e) => last_err = e,
                }
            }
            Err(format!("分块下载失败（重试 3 次后）: {last_err}"))
        }));
        start = end + 1;
    }
    for h in handles {
        h.await.map_err(|e| e.to_string())??;
    }
    Ok(())
}

async fn fetch_range(client: &reqwest::Client, url: &str, user: &Option<String>, pass: &Option<String>, start: u64, end: u64) -> Result<Vec<u8>, String> {
    let mut req = client.get(url);
    if let (Some(u), Some(p)) = (user.as_deref(), pass.as_deref()) {
        req = req.basic_auth(u, Some(p));
    }
    let resp = req.header("Range", format!("bytes={start}-{end}")).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status != reqwest::StatusCode::PARTIAL_CONTENT && status != reqwest::StatusCode::OK {
        return Err(format!("HTTP {status}"));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

fn sftp_connect(host: &str, port: u16, user: &str, pass: &str) -> Result<(ssh2::Session, ssh2::Sftp), String> {
    use std::net::TcpStream;
    let tcp = TcpStream::connect((host, port)).map_err(|e| format!("连接失败: {e}"))?;
    let mut sess = ssh2::Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| e.to_string())?;
    sess.userauth_password(user, pass).map_err(|e| e.to_string())?;
    if !sess.authenticated() {
        return Err("认证失败".to_string());
    }
    let sftp = sess.sftp().map_err(|e| e.to_string())?;
    Ok((sess, sftp))
}

/// SFTP 列目录（阻塞操作放线程池，避免卡住主线程/UI）。
#[tauri::command]
async fn sftp_list(host: String, port: u16, user: String, pass: String, path: String) -> Result<Vec<RemoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_sess, sftp) = sftp_connect(&host, port, &user, &pass)?;
        let dir = if path.is_empty() { "/".to_string() } else { path };
        let entries = sftp.readdir(std::path::Path::new(&dir)).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for (p, stat) in entries {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            let is_dir = stat.is_dir();
            let full = format!("{}/{}", dir.trim_end_matches('/'), name);
            out.push(RemoteEntry {
                name,
                path: full,
                is_dir,
                size: stat.size.unwrap_or(0),
                sha: String::new(),
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// SFTP 读取文件（阻塞操作放线程池）。
#[tauri::command]
async fn sftp_get(host: String, port: u16, user: String, pass: String, path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use std::io::Read;
        let (_sess, sftp) = sftp_connect(&host, port, &user, &pass)?;
        let mut file = sftp.open(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

fn s3_bucket(endpoint: &str, region: &str, access_key: &str, secret_key: &str, bucket: &str) -> Result<Box<s3::Bucket>, String> {
    let region = s3::Region::Custom {
        region: region.to_string(),
        endpoint: endpoint.to_string(),
    };
    let creds = s3::creds::Credentials::new(Some(access_key), Some(secret_key), None, None, None).map_err(|e| e.to_string())?;
    s3::Bucket::new(bucket, region, creds).map_err(|e| e.to_string())
}

/// S3 列对象（前缀 + 分隔符 "/" 模拟目录）。
#[tauri::command]
async fn s3_list(endpoint: String, region: String, access_key: String, secret_key: String, bucket: String, prefix: String) -> Result<Vec<RemoteEntry>, String> {
    let b = s3_bucket(&endpoint, &region, &access_key, &secret_key, &bucket)?;
    let pages = b.list(prefix, Some("/".to_string())).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for page in pages {
        for cp in page.common_prefixes.unwrap_or_default() {
            let name = cp.prefix.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            out.push(RemoteEntry { name, path: cp.prefix, is_dir: true, size: 0, sha: String::new() });
        }
        for obj in page.contents {
            if obj.key.ends_with('/') {
                continue; // 目录占位对象
            }
            let name = obj.key.rsplit('/').next().unwrap_or(&obj.key).to_string();
            if name.is_empty() {
                continue;
            }
            out.push(RemoteEntry { name, path: obj.key, is_dir: false, size: obj.size, sha: String::new() });
        }
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// S3 读取对象。
#[tauri::command]
async fn s3_get(endpoint: String, region: String, access_key: String, secret_key: String, bucket: String, path: String) -> Result<tauri::ipc::Response, String> {
    let b = s3_bucket(&endpoint, &region, &access_key, &secret_key, &bucket)?;
    let data = b.get_object(&path).await.map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data.bytes().to_vec()))
}

// ---- 压缩（GUI 专属） ----

fn add_file_to_zip<W: std::io::Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    path: &std::path::Path,
    name: &str,
    password: &Option<String>,
) -> Result<(), String> {
    use std::io::Read;
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let options = match password {
        Some(p) if !p.is_empty() => options.with_deprecated_encryption(p.as_bytes()).map_err(|e| e.to_string())?,
        _ => options,
    };
    writer.start_file(name, options).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn add_dir_to_zip<W: std::io::Write + std::io::Seek>(
    writer: &mut zip::ZipWriter<W>,
    dir: &std::path::Path,
    prefix: &str,
    password: &Option<String>,
) -> Result<(), String> {
    writer.add_directory(prefix, zip::write::SimpleFileOptions::default()).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = format!("{}/{}", prefix.trim_end_matches('/'), entry.file_name().to_string_lossy());
        if path.is_dir() {
            add_dir_to_zip(writer, &path, &name, password)?;
        } else {
            add_file_to_zip(writer, &path, &name, password)?;
        }
    }
    Ok(())
}

/// 压缩本地路径（文件或文件夹，递归）为 zip，可 ZipCrypto 加密。
#[tauri::command]
async fn zip_paths(paths: Vec<String>, dest: String, password: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = std::path::Path::new(&dest).parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        let mut writer = zip::ZipWriter::new(file);
        for path in &paths {
            let p = std::path::Path::new(path);
            let top = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "archive".to_string());
            if p.is_dir() {
                add_dir_to_zip(&mut writer, p, &top, &password)?;
            } else {
                add_file_to_zip(&mut writer, p, &top, &password)?;
            }
        }
        writer.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 压缩单个内存字节为 zip（用于远程文件），可 ZipCrypto 加密。
#[tauri::command]
fn zip_bytes(name: String, bytes: Vec<u8>, dest: String, password: Option<String>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let options = match &password {
        Some(p) if !p.is_empty() => options.with_deprecated_encryption(p.as_bytes()).map_err(|e| e.to_string())?,
        _ => options,
    };
    writer.start_file(name, options).map_err(|e| e.to_string())?;
    writer.write_all(&bytes).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            read_file,
            list_dir,
            read_file_range,
            file_size,
            http_get,
            http_list,
            webdav_list,
            webdav_get,
            load_state,
            save_state,
            sftp_list,
            sftp_get,
            s3_list,
            s3_get,
            cache_get,
            cache_put,
            cache_clear,
            cache_size,
            cache_put_label,
            save_bytes,
            search_index,
            search_remote,
            search_names,
            describe_structured,
            extract_file_text,
            cli_status,
            install_cli,
            docx_embed_watermark,
            docx_extract_watermark,
            docx_remove_watermark,
            docx_embed_visible_watermark,
            copy_file,
            copy_path,
            make_temp_dir,
            remove_path,
            list_themes,
            read_theme,
            ensure_themes,
            http_download,
            zip_paths,
            zip_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
