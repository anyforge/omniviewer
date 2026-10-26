#[test]
fn remote_search_roundtrip() {
    let tmp = std::env::temp_dir().join(format!("ov-test-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    unsafe { std::env::set_var("HOME", &tmp); }

    let key = "github:owner/repo:docs/设计文档.md:abc123";
    let content = "这是一份远程设计文档，包含检索测试关键词。hello remote search keyword.";
    omniviewer_core::cache::cache_put_label(key).unwrap();
    let hash = omniviewer_core::cache::cache_filename(key);
    let dir = omniviewer_core::cache::cache_dir().unwrap();
    std::fs::write(dir.join(&hash), content.as_bytes()).unwrap();

    let hits = omniviewer_core::search::search_remote("检索").unwrap();
    let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
    assert!(hits.iter().any(|h| h.path == key), "中文查询未命中，结果: {:?}", paths);

    let hits2 = omniviewer_core::search::search_remote("remote").unwrap();
    assert!(hits2.iter().any(|h| h.path == key), "英文查询未命中");

    println!("OK: 中文+英文远程检索均命中源标识 {}", key);

    std::fs::remove_dir_all(&tmp).unwrap();
}
