//! 状态与配置目录：~/.omniviewer/ 下的 config.json 与 themes 目录。
//! 凭证明文存 config.json（权限收紧到 600）；OS 钥匙串待签名发布后再接。

/// 配置目录：~/.omniviewer/
pub fn omniviewer_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(std::path::PathBuf::from(home).join(".omniviewer"))
}

fn config_path() -> Result<std::path::PathBuf, String> {
    Ok(omniviewer_dir()?.join("config.json"))
}

/// 原子写 config.json（先写临时文件再 rename，防崩溃截断），并收紧权限到 600。
fn write_config(content: &str) -> Result<(), String> {
    let dir = omniviewer_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("config.json");
    let tmp = dir.join("config.json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 读取持久化状态（含凭证）。
pub fn load_state() -> Result<String, String> {
    let path = config_path()?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 保存持久化状态（含凭证，明文存 config.json，权限 600）。
pub fn save_state(json: String) -> Result<(), String> {
    write_config(&json)
}

pub fn themes_dir() -> Result<std::path::PathBuf, String> {
    Ok(omniviewer_dir()?.join("themes"))
}

/// 列出主题目录下的主题文件（.css / .yaml），返回完整文件名（含扩展名）。
pub fn list_themes() -> Result<Vec<String>, String> {
    let dir = themes_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if path.is_file() && (ext == "css" || ext == "yaml" || ext == "yml") {
            names.push(path.file_name().unwrap_or_default().to_string_lossy().to_string());
        }
    }
    names.sort();
    Ok(names)
}

/// 读取主题文件内容（name 为完整文件名，含扩展名）。
pub fn read_theme(name: &str) -> Result<String, String> {
    let path = themes_dir()?.join(name);
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

const DEFAULT_THEME_YAML: &str = r##"# Omniviewer 主题配置示例（YAML）
# ui.dark / ui.light = 暗色/亮色界面配色（缺省字段回退到内置默认值）
# code.dark / code.light = 暗色/亮色代码主题
name: Default
ui:
  dark:
    win_bg: "#14171b"
    panel: "#171a1f"
    raised: "#1d2126"
    border: "#262b31"
    text: "#f2f4f7"
    muted: "#b4bbc4"
    faint: "#9099a5"
    accent: "#e6a23c"
    accent_soft: "rgba(230, 162, 60, 0.14)"
    green: "#58c77c"
    code_bg: "#101318"
  light:
    win_bg: "#f7f8fa"
    panel: "#ffffff"
    raised: "#f0f2f5"
    border: "#d8dce2"
    text: "#1d1d1f"
    muted: "#3f454e"
    faint: "#565e69"
    accent: "#d68a1e"
    accent_soft: "rgba(214, 138, 30, 0.12)"
    green: "#2fa35b"
    code_bg: "#eef0f3"
code:
  dark: "dracula"
  light: "github-light"
"##;

/// 写入预置主题文件（若不存在），供用户参照/自定义。
pub fn ensure_themes() -> Result<(), String> {
    let dir = themes_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("default.yaml");
    if !path.exists() {
        std::fs::write(&path, DEFAULT_THEME_YAML).map_err(|e| e.to_string())?;
    }
    Ok(())
}
