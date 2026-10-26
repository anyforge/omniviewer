//! search_names 文件名模糊搜索回归测试：精准/前缀/子串/模糊子序列。

use omniviewer_core::search::search_names;

#[test]
fn name_fuzzy_matching() {
    let dir = std::env::temp_dir().join("ov_name_search_test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("config.json"), "{}").unwrap();
    std::fs::write(dir.join("configure.toml"), "").unwrap();
    std::fs::write(dir.join("app-config.yml"), "").unwrap();
    std::fs::write(dir.join("sub/config.py"), "x = 1\n").unwrap();
    std::fs::write(dir.join("readme.txt"), "hello\n").unwrap();

    let root = dir.to_string_lossy().to_string();

    // 子串：onfig → config.json / configure.toml / app-config.yml / sub/config.py
    let hits = search_names(&root, "onfig").unwrap();
    let names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
    assert!(names.contains(&"config.json"), "onfig 应命中 config.json，实际 {:?}", names);
    assert!(names.contains(&"config.py"), "onfig 应递归命中子目录 sub/config.py，实际 {:?}", names);

    // 精准：config.json 完全等于查询（忽略大小写与扩展则需精准，这里用带扩展名验证前缀）
    let exact = search_names(&root, "config.json").unwrap();
    assert_eq!(exact.first().map(|h| h.name.as_str()), Some("config.json"), "精准匹配应排最前");

    // 模糊子序列：cnfg → config.json / configure.toml
    let fuzzy = search_names(&root, "cnfg").unwrap();
    let fuzzy_names: Vec<&str> = fuzzy.iter().map(|h| h.name.as_str()).collect();
    assert!(fuzzy_names.contains(&"config.json"), "cnfg 子序列应命中 config.json，实际 {:?}", fuzzy_names);
    assert!(fuzzy_names.contains(&"configure.toml"), "cnfg 子序列应命中 configure.toml，实际 {:?}", fuzzy_names);
    assert!(!fuzzy_names.contains(&"readme.txt"), "cnfg 不应命中 readme.txt");

    // 无匹配
    let none = search_names(&root, "zzz").unwrap();
    assert!(none.is_empty(), "zzz 应无匹配");

    let _ = std::fs::remove_dir_all(&dir);
}
