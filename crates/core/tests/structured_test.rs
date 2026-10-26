//! 结构化描述解析的冒烟测试：生成最小样例文件并验证 describe_structured 输出。

use std::fs;

fn w(name: &str, bytes: &[u8]) -> String {
    let p = format!("/tmp/{}", name);
    fs::write(&p, bytes).unwrap();
    p
}

fn make_safetensors() -> String {
    let header = br#"{"weight":{"dtype":"F32","shape":[2,3],"data_offsets":[0,24]},"bias":{"dtype":"F32","shape":[3],"data_offsets":[24,36]},"__metadata__":{"format":"pt"}}"#;
    let mut buf = Vec::new();
    buf.extend_from_slice(&(header.len() as u64).to_le_bytes());
    buf.extend_from_slice(header);
    buf.extend_from_slice(&[0u8; 36]); // 数据区占位
    w("test.safetensors", &buf)
}

fn make_gguf() -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"GGUF");
    buf.extend_from_slice(&2u32.to_le_bytes()); // version
    buf.extend_from_slice(&1u64.to_le_bytes()); // tensor_count
    buf.extend_from_slice(&2u64.to_le_bytes()); // kv_count
    // kv 1: general.name = "test" (STRING)
    let key = b"general.name";
    buf.extend_from_slice(&(key.len() as u64).to_le_bytes());
    buf.extend_from_slice(key);
    buf.extend_from_slice(&8u32.to_le_bytes()); // STRING
    buf.extend_from_slice(&4u64.to_le_bytes());
    buf.extend_from_slice(b"test");
    // kv 2: general.architecture = "llama" (STRING)
    let key = b"general.architecture";
    buf.extend_from_slice(&(key.len() as u64).to_le_bytes());
    buf.extend_from_slice(key);
    buf.extend_from_slice(&8u32.to_le_bytes());
    buf.extend_from_slice(&5u64.to_le_bytes());
    buf.extend_from_slice(b"llama");
    // tensor 1: name "token_embd.weight", dims [2,3], type F32=6, offset 0
    let tname = b"token_embd.weight";
    buf.extend_from_slice(&(tname.len() as u64).to_le_bytes());
    buf.extend_from_slice(tname);
    buf.extend_from_slice(&2u32.to_le_bytes()); // n_dims
    buf.extend_from_slice(&2u64.to_le_bytes());
    buf.extend_from_slice(&3u64.to_le_bytes());
    buf.extend_from_slice(&6u32.to_le_bytes()); // FLOAT32
    buf.extend_from_slice(&0u64.to_le_bytes()); // offset
    w("test.gguf", &buf)
}

fn make_parquet() -> String {
    use parquet::column::writer::ColumnWriter;
    use parquet::file::properties::WriterProperties;
    use parquet::file::writer::SerializedFileWriter;
    use parquet::schema::parser::parse_message_type;
    use std::sync::Arc;

    let p = "/tmp/test.parquet";
    let schema = parse_message_type("message t { REQUIRED INT64 id; OPTIONAL BYTE_ARRAY name (UTF8); }").unwrap();
    let file = fs::File::create(p).unwrap();
    let props = Arc::new(WriterProperties::builder().build());
    let mut writer = SerializedFileWriter::new(file, schema.into(), props).unwrap();
    let mut rg = writer.next_row_group().unwrap();
    while let Some(mut col) = rg.next_column().unwrap() {
        match col.untyped() {
            ColumnWriter::Int64ColumnWriter(cw) => {
                cw.write_batch(&[1i64, 2, 3], Some(&[1i16, 1, 1]), None).unwrap();
            }
            ColumnWriter::ByteArrayColumnWriter(cw) => {
                let vals = vec![
                    parquet::data_type::ByteArray::from("alice"),
                    parquet::data_type::ByteArray::from("bob"),
                    parquet::data_type::ByteArray::from("carol"),
                ];
                cw.write_batch(&vals, Some(&[1i16, 1, 1]), None).unwrap();
            }
            _ => {}
        }
        col.close().unwrap();
    }
    rg.close().unwrap();
    writer.close().unwrap();
    p.to_string()
}

/// 手搓一个最小 ONNX ModelProto：graph(7) { node(1) { input(1)="x","y" output(2)="z" op_type(4)="Add" } }
fn make_onnx() -> String {
    fn ld(bytes: &[u8]) -> Vec<u8> {
        // key (field=?, wire=2) + len + payload
        bytes.to_vec()
    }
    // NodeProto
    let mut node = Vec::new();
    node.push(0x0A); node.push(1); node.push(b'x'); // input "x"
    node.push(0x0A); node.push(1); node.push(b'y'); // input "y"
    node.push(0x12); node.push(1); node.push(b'z'); // output "z"
    node.push(0x22); node.push(3); node.extend_from_slice(b"Add"); // op_type
    // GraphProto = field1(node)
    let mut graph = Vec::new();
    graph.push(0x0A); graph.push(node.len() as u8); graph.extend_from_slice(&node);
    // ModelProto: ir_version(1,varint)=7, producer_name(2)="test", graph(7)
    let mut model = Vec::new();
    model.push(0x08); model.push(7); // ir_version
    model.push(0x12); model.push(4); model.extend_from_slice(b"test"); // producer
    model.push(0x3A); model.push(graph.len() as u8); model.extend_from_slice(&graph); // graph
    let _ = ld; // 保持签名，实际已内联
    w("test.onnx", &model)
}

#[test]
fn describe_structured_smoke() {
    for (f, expect) in [
        (make_safetensors(), "safetensors"),
        (make_gguf(), "GGUF"),
        (make_parquet(), "Parquet"),
        (make_onnx(), "ONNX"),
    ] {
        let out = omniviewer_core::structured::describe_structured(&f).expect(&format!("描述 {f} 失败"));
        println!("===== {f} =====\n{out}\n");
        assert!(out.contains(expect), "{f} 输出缺少 {expect}:\n{out}");
    }
    // 深度断言：具体结构是否解析出
    let st = omniviewer_core::structured::describe_structured(&"/tmp/test.safetensors").unwrap();
    assert!(st.contains("weight") && st.contains("F32"), "safetensors 张量未解析:\n{st}");
    let gguf = omniviewer_core::structured::describe_structured(&"/tmp/test.gguf").unwrap();
    assert!(gguf.contains("general.architecture") && gguf.contains("token_embd.weight"), "GGUF 未解析:\n{gguf}");
    let onnx = omniviewer_core::structured::describe_structured(&"/tmp/test.onnx").unwrap();
    assert!(onnx.contains("Add") && onnx.contains("x, y") && onnx.contains("z"), "ONNX 图未解析:\n{onnx}");
    let pq = omniviewer_core::structured::describe_structured(&"/tmp/test.parquet").unwrap();
    assert!(pq.contains("id") && pq.contains("name") && pq.contains("Int64"), "parquet schema 未解析:\n{pq}");
    assert!(pq.contains("alice") && pq.contains("carol"), "parquet 数据预览缺失:\n{pq}");
}
