//! MCP server：暴露 Omniviewer 的检索/读取/列目录能力给 AI 智能体。

use rmcp::handler::server::wrapper::Parameters;
use rmcp::{schemars, tool, tool_router};

#[derive(Debug, Clone)]
pub struct OmniviewerMcp;

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct SearchRequest {
    /// 搜索关键词（中英文）
    #[schemars(description = "搜索关键词（中英文）")]
    pub query: String,
    /// 搜索目录，默认当前目录
    #[schemars(description = "搜索目录，默认当前目录")]
    pub path: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct PathRequest {
    /// 路径
    #[schemars(description = "路径")]
    pub path: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ReadRequest {
    /// 文件路径
    #[schemars(description = "文件路径")]
    pub path: String,
    /// 起始行（从 1 开始，默认 1）
    #[schemars(description = "起始行（从 1 开始，默认 1）")]
    pub offset: Option<usize>,
    /// 读取行数（默认 200，上限 2000）
    #[schemars(description = "读取行数（默认 200，上限 2000）")]
    pub limit: Option<usize>,
}

#[tool_router(server_handler)]
impl OmniviewerMcp {
    /// 全文检索：FTS5 + jieba 索引（中英三通道分词），BM25 相关度排序。
    #[tool(description = "全文检索本地目录（FTS5+jieba 索引，BM25 排序），返回文件路径与匹配片段")]
    fn search(&self, Parameters(SearchRequest { query, path }): Parameters<SearchRequest>) -> String {
        let root = path.unwrap_or_else(|| ".".to_string());
        let hits = match omniviewer_core::search::search_index(&query, &root) {
            Ok(h) => h,
            Err(e) => return format!("搜索失败：{e}"),
        };
        if hits.is_empty() {
            return "无匹配结果".to_string();
        }
        let mut out = String::new();
        for (i, h) in hits.iter().take(50).enumerate() {
            out.push_str(&format!("{}. {}\n   {}\n", i + 1, h.path, h.text));
        }
        if hits.len() > 50 {
            out.push_str(&format!("（另有 {} 条结果未列出）\n", hits.len() - 50));
        }
        out
    }

    /// 列出目录内容。
    #[tool(description = "列出目录内容，返回名称与类型")]
    fn list_files(&self, Parameters(PathRequest { path }): Parameters<PathRequest>) -> String {
        let entries = match omniviewer_core::fs::list_dir(&path) {
            Ok(e) => e,
            Err(e) => return format!("列目录失败：{e}"),
        };
        if entries.is_empty() {
            return "（空目录）".to_string();
        }
        let mut out = String::new();
        for e in entries {
            out.push_str(&format!("{}  {}{}\n", if e.is_dir { "d" } else { "f" }, e.name, if e.is_dir { "/" } else { "" }));
        }
        out
    }

    /// 读取文件内容（文本或 Office 抽取）。
    #[tool(description = "读取文件文本（支持 docx/xlsx/pptx 抽取），返回带行号内容")]
    fn read_file(&self, Parameters(ReadRequest { path, offset, limit }): Parameters<ReadRequest>) -> String {
        let text = omniviewer_core::extract::extract_file_text(std::path::Path::new(&path))
            .or_else(|| std::fs::read_to_string(&path).ok());
        let Some(text) = text else {
            return format!("无法读取文件（可能非文本或超过 10MB）：{path}");
        };
        let lines: Vec<&str> = text.lines().collect();
        let offset = offset.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(200).clamp(1, 2000);
        let start = (offset - 1).min(lines.len());
        let end = (offset - 1 + limit).min(lines.len());
        if start >= lines.len() {
            return "（超出文件行数）".to_string();
        }
        let mut out = String::new();
        for (i, line) in lines[start..end].iter().enumerate() {
            out.push_str(&format!("{:6}  {}\n", start + i + 1, line));
        }
        if end < lines.len() {
            out.push_str(&format!("（共 {} 行，剩余 {} 行未显示）\n", lines.len(), lines.len() - end));
        }
        out
    }

    /// 文件元数据。
    #[tool(description = "获取文件元数据：类型 / 扩展名 / 大小 / 修改时间")]
    fn get_file_info(&self, Parameters(PathRequest { path }): Parameters<PathRequest>) -> String {
        match std::fs::metadata(&path) {
            Ok(meta) => {
                let ext = std::path::Path::new(&path).extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                format!(
                    "路径: {path}\n类型: {}\n扩展名: {ext}\n大小: {} 字节\n修改时间(epoch): {modified}",
                    if meta.is_dir() { "目录" } else { "文件" },
                    meta.len()
                )
            }
            Err(e) => format!("获取元数据失败：{e}"),
        }
    }
}

/// stdio 模式（本地智能体 spawn 子进程）。
pub async fn serve_stdio() -> Result<(), String> {
    use rmcp::{ServiceExt, transport::stdio};
    let service = OmniviewerMcp
        .serve(stdio())
        .await
        .map_err(|e| format!("MCP serve 错误: {e:?}"))?;
    service.waiting().await.map_err(|e| format!("MCP 运行错误: {e:?}"))?;
    Ok(())
}

/// Streamable HTTP 模式（本地 + 远程智能体）。
pub async fn serve_http(host: &str, port: u16, key: Option<String>) -> Result<(), String> {
    use axum::response::IntoResponse;
    use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
    use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};

    let ct = tokio_util::sync::CancellationToken::new();
    let service = StreamableHttpService::new(
        || Ok(OmniviewerMcp),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_cancellation_token(ct.child_token()),
    );

    let mut router = axum::Router::new().nest_service("/mcp", service);

    if let Some(k) = key {
        router = router.layer(axum::middleware::from_fn(move |req: axum::extract::Request, next: axum::middleware::Next| {
            let expect = format!("Bearer {k}");
            async move {
                let authorized = req
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v == expect)
                    .unwrap_or(false);
                if authorized {
                    next.run(req).await
                } else {
                    (axum::http::StatusCode::UNAUTHORIZED, "unauthorized").into_response()
                }
            }
        }));
    }

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.map_err(|e| e.to_string())?;
    eprintln!("Omniviewer MCP server 已启动: http://{addr}/mcp");
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            ct.cancel();
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
