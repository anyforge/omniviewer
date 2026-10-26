use clap::{Parser, Subcommand};

mod mcp;

#[derive(Parser)]
#[command(name = "omniviewer", version, about = "Omniviewer CLI：跨源万能文件查看 + 检索 + 水印 + MCP", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 全文检索（FTS5+jieba 索引，BM25 排序；短查询回退 grep）
    Search {
        /// 搜索关键词（中英文）
        query: String,
        /// 搜索目录（默认当前目录）
        #[arg(default_value = ".")]
        path: String,
        /// 同时检索已缓存过的远程文件
        #[arg(long)]
        remote: bool,
    },
    /// 建/重建索引（增量：未变文件跳过）
    Index {
        /// 要索引的目录（默认当前目录）
        #[arg(default_value = ".")]
        path: String,
    },
    /// 读取文件文本（自动抽取 docx/xlsx/pptx）
    Cat {
        /// 文件路径
        file: String,
    },
    /// 列出目录内容
    Ls {
        /// 目录路径
        path: String,
    },
    /// 预览缓存管理
    Cache {
        #[command(subcommand)]
        sub: CacheCmd,
    },
    /// 水印（docx 嵌入/提取/去除）
    Wm {
        #[command(subcommand)]
        sub: WmCmd,
    },
    /// 数据源连接（只读）
    Conn {
        #[command(subcommand)]
        sub: ConnCmd,
    },
    /// 启动 MCP server（默认 stdio；--http 走 Streamable HTTP）
    Mcp {
        /// 使用 Streamable HTTP 传输（默认 stdio）
        #[arg(long)]
        http: bool,
        /// 监听端口（默认 8765）
        #[arg(long, default_value_t = 8765)]
        port: u16,
        /// 监听地址（默认 127.0.0.1，仅本机）
        #[arg(long, default_value = "127.0.0.1")]
        host: String,
        /// 鉴权 key（仅 --http 有效；提供后要求 Authorization: Bearer <key>）
        #[arg(long)]
        key: Option<String>,
    },
    /// 自检（版本 / 数据目录 / 缓存 / 索引状态）
    Status,
    /// 输出版本号
    Version,
}

#[derive(Subcommand)]
enum CacheCmd {
    /// 缓存总大小
    Size,
    /// 清空缓存
    Clear,
}

#[derive(Subcommand)]
enum WmCmd {
    /// 嵌入不可见暗水印（marker，可提取/去除）
    Embed {
        /// 源 docx
        src: String,
        /// 输出 docx
        dest: String,
        /// 标识（如用户 ID / 工号）
        id: String,
    },
    /// 嵌入可见明水印（VML 斜水印，可去除）
    Visible {
        /// 源 docx
        src: String,
        /// 输出 docx
        dest: String,
        /// 水印文字
        text: String,
    },
    /// 提取暗水印标识
    Extract {
        /// 源 docx
        src: String,
    },
    /// 去除本软件加入的水印（明+暗）
    Remove {
        /// 源 docx
        src: String,
        /// 输出 docx
        dest: String,
    },
}

#[derive(Subcommand)]
enum ConnCmd {
    /// 列出已配置的数据源连接
    List,
}

fn human_size(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

fn cmd_search(query: &str, path: &str, remote: bool) -> Result<(), String> {
    let mut hits = omniviewer_core::search::search_index(query, path)?;
    if remote {
        hits.extend(omniviewer_core::search::search_remote(query)?);
    }
    if hits.is_empty() {
        println!("无匹配结果");
        return Ok(());
    }
    println!("{} 条结果（按相关度排序）：", hits.len());
    for (i, h) in hits.iter().enumerate() {
        println!("{}. {}", i + 1, h.path);
        println!("   {}", h.text);
    }
    Ok(())
}

fn cmd_index(path: &str) -> Result<(), String> {
    omniviewer_core::search::build_index(path)?;
    let n = omniviewer_core::search::indexed_count()?;
    println!("索引完成：{} 个文件已索引（含历史）", n);
    Ok(())
}

fn cmd_cat(file: &str) -> Result<(), String> {
    let text = omniviewer_core::extract::extract_file_text(std::path::Path::new(file))
        .or_else(|| std::fs::read_to_string(file).ok())
        .ok_or_else(|| format!("无法读取文件（可能非文本或过大）：{file}"))?;
    print!("{text}");
    if !text.ends_with('\n') {
        println!();
    }
    Ok(())
}

fn cmd_ls(path: &str) -> Result<(), String> {
    let entries = omniviewer_core::fs::list_dir(path)?;
    for e in entries {
        if e.is_dir {
            println!("{}/", e.name);
        } else {
            println!("{}\t{}", e.name, human_size(e.size));
        }
    }
    Ok(())
}

fn cmd_conn_list() -> Result<(), String> {
    let raw = omniviewer_core::state::load_state()?;
    if raw.trim().is_empty() {
        println!("无已配置连接");
        return Ok(());
    }
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let conns = v.get("conns").and_then(|c| c.as_array());
    match conns {
        Some(arr) if !arr.is_empty() => {
            for c in arr {
                let ty = c.get("type").and_then(|t| t.as_str()).unwrap_or("?");
                let name = c
                    .get("name")
                    .and_then(|n| n.as_str())
                    .or_else(|| c.get("root").and_then(|r| r.as_str()))
                    .or_else(|| c.get("url").and_then(|u| u.as_str()))
                    .unwrap_or("");
                if name.is_empty() {
                    println!("{ty}");
                } else {
                    println!("{ty}\t{name}");
                }
            }
        }
        _ => println!("无已配置连接"),
    }
    Ok(())
}

fn cmd_status() -> Result<(), String> {
    println!("Omniviewer {}", env!("CARGO_PKG_VERSION"));
    println!("数据目录：{}", omniviewer_core::state::omniviewer_dir()?.display());
    println!("缓存大小：{}", human_size(omniviewer_core::cache::cache_size()?));
    match omniviewer_core::search::indexed_count() {
        Ok(n) => println!("已索引文件：{}", n),
        Err(_) => println!("已索引文件：0（尚未建索引）"),
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        Command::Search { query, path, remote } => cmd_search(&query, &path, remote),
        Command::Index { path } => cmd_index(&path),
        Command::Cat { file } => cmd_cat(&file),
        Command::Ls { path } => cmd_ls(&path),
        Command::Cache { sub } => match sub {
            CacheCmd::Size => {
                println!("{}", human_size(omniviewer_core::cache::cache_size()?));
                Ok(())
            }
            CacheCmd::Clear => {
                let n = omniviewer_core::cache::cache_clear()?;
                println!("已删除 {} 个缓存文件", n);
                Ok(())
            }
        },
        Command::Wm { sub } => match sub {
            WmCmd::Embed { src, dest, id } => {
                omniviewer_core::watermark::docx_embed_watermark(&src, &dest, &id)?;
                println!("已嵌入暗水印：{dest}");
                Ok(())
            }
            WmCmd::Visible { src, dest, text } => {
                omniviewer_core::watermark::docx_embed_visible_watermark(&src, &dest, &text)?;
                println!("已嵌入明水印：{dest}");
                Ok(())
            }
            WmCmd::Extract { src } => {
                match omniviewer_core::watermark::docx_extract_watermark(&src)? {
                    Some(id) => println!("{id}"),
                    None => println!("（未检测到本软件水印）"),
                }
                Ok(())
            }
            WmCmd::Remove { src, dest } => {
                let changed = omniviewer_core::watermark::docx_remove_watermark(&src, &dest)?;
                if changed {
                    println!("已去除水印：{dest}");
                } else {
                    println!("（未检测到本软件水印，未改动）");
                }
                Ok(())
            }
        },
        Command::Conn { sub } => match sub {
            ConnCmd::List => cmd_conn_list(),
        },
        Command::Mcp { http, port, host, key } => {
            if http {
                // 安全：非本机监听强制要求鉴权 key
                let is_local = host == "127.0.0.1" || host == "localhost" || host == "::1";
                if !is_local && key.is_none() {
                    return Err("非本机监听必须提供 --key 鉴权".to_string());
                }
                if let Some(k) = &key {
                    if k.len() < 8 {
                        return Err("--key 过短（至少 8 字符）".to_string());
                    }
                }
                mcp::serve_http(&host, port, key).await
            } else {
                mcp::serve_stdio().await
            }
        }
        Command::Status => cmd_status(),
        Command::Version => {
            println!("omniviewer {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}
