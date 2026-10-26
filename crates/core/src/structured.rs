//! 结构化数据 / 模型文件的结构预览：Parquet、safetensors、GGUF、ONNX 等。
//! 返回纯文本描述，前端渲染到文本预览区。

use std::fs::File;
use std::io::Read;

/// 按扩展名分发结构化描述。
pub fn describe_structured(path: &str) -> Result<String, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    match ext.as_str() {
        "parquet" => describe_parquet(path),
        "arrow" | "feather" => describe_arrow(path),
        "safetensors" => describe_safetensors(&read_bytes(path)?),
        "gguf" => describe_gguf(&read_bytes(path)?),
        "onnx" => describe_onnx(&read_bytes(path)?),
        "pt" | "pth" => Ok(model_basic("PyTorch", &ext, size)),
        "h5" | "hdf5" | "keras" => Ok(model_basic("TensorFlow / HDF5", &ext, size)),
        "tflite" => Ok(model_basic("TensorFlow Lite", &ext, size)),
        _ => Err(format!("不支持的描述格式: {ext}")),
    }
}

fn read_bytes(path: &str) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn model_basic(fmt: &str, ext: &str, size: u64) -> String {
    format!(
        "{fmt} 模型文件（.{ext}）\n大小: {size} 字节\n\n该格式的深度结构解析（网络图 / 张量列表）尚未接入，当前仅识别格式。\n导出为 ONNX / GGUF / safetensors 可获得完整结构化预览。"
    )
}

// ---- Parquet / Arrow（表格数据预览）----

/// 把一个或多个 RecordBatch 格式化成 ASCII 表格。
fn format_batches(batches: &[arrow::record_batch::RecordBatch]) -> String {
    use std::fmt::Write as _;
    match arrow::util::pretty::pretty_format_batches(batches) {
        Ok(t) => t.to_string(),
        Err(_) => {
            let mut out = String::new();
            for b in batches {
                for (i, f) in b.schema().fields().iter().enumerate() {
                    let _ = writeln!(out, "{}: {:?}", f.name(), b.column(i));
                }
            }
            out
        }
    }
}

fn describe_parquet(path: &str) -> Result<String, String> {
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    let file = File::open(path).map_err(|e| e.to_string())?;
    let builder = ParquetRecordBatchReaderBuilder::try_new(file).map_err(|e| e.to_string())?;
    let schema = builder.schema().clone();
    let metadata = builder.metadata().clone();
    let fm = metadata.file_metadata();
    let mut out = String::new();
    out.push_str("Apache Parquet 文件\n");
    out.push_str(&format!("总行数: {}\n", fm.num_rows()));
    out.push_str(&format!("行组数: {}\n", metadata.num_row_groups()));
    out.push_str(&format!("列数: {}\n", schema.fields().len()));
    if let Some(cb) = fm.created_by() {
        out.push_str(&format!("创建者: {cb}\n"));
    }
    out.push_str("\n== 列 (schema) ==\n");
    for f in schema.fields() {
        out.push_str(&format!("{} : {}\n", f.name(), f.data_type()));
    }
    // 读前 20 行
    let mut reader = builder.with_batch_size(20).build().map_err(|e| e.to_string())?;
    let mut batches = Vec::new();
    if let Some(b) = reader.next() {
        batches.push(b.map_err(|e| e.to_string())?);
    }
    if !batches.is_empty() {
        out.push_str("\n== 数据预览（前 20 行）==\n");
        out.push_str(&format_batches(&batches));
    }
    Ok(out)
}

fn describe_arrow(path: &str) -> Result<String, String> {
    use std::io::BufReader;
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = arrow::ipc::reader::FileReader::try_new(BufReader::new(file), None)
        .map_err(|e| e.to_string())?;
    let schema = reader.schema().clone();
    let mut out = String::new();
    out.push_str("Arrow IPC / Feather 文件\n");
    out.push_str(&format!("列数: {}\n", schema.fields().len()));
    out.push_str("\n== 列 (schema) ==\n");
    for f in schema.fields() {
        out.push_str(&format!("{} : {}\n", f.name(), f.data_type()));
    }
    let mut batches = Vec::new();
    for b in reader.take(20) {
        batches.push(b.map_err(|e| e.to_string())?);
    }
    if !batches.is_empty() {
        out.push_str("\n== 数据预览 ==\n");
        out.push_str(&format_batches(&batches));
    }
    Ok(out)
}

// ---- safetensors ----

fn describe_safetensors(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 8 {
        return Err("safetensors 文件太小".into());
    }
    let hlen = u64::from_le_bytes(bytes[..8].try_into().map_err(|_| "读取头长度失败")?) as usize;
    if hlen > bytes.len() - 8 {
        return Err("safetensors 头长度异常".into());
    }
    let header: serde_json::Value =
        serde_json::from_slice(&bytes[8..8 + hlen]).map_err(|e| format!("解析 JSON 头失败: {e}"))?;
    let mut out = String::from("safetensors 模型\n\n== 张量 ==\n");
    if let Some(obj) = header.as_object() {
        for (name, meta) in obj {
            if name == "__metadata__" {
                continue;
            }
            let dtype = meta.get("dtype").and_then(|v| v.as_str()).unwrap_or("?");
            let shape = meta.get("shape").map(|v| v.to_string()).unwrap_or_default();
            out.push_str(&format!("{name} : {dtype} {shape}\n"));
        }
        if let Some(meta) = obj.get("__metadata__").and_then(|v| v.as_object()) {
            out.push_str("\n== 元数据 ==\n");
            for (k, v) in meta {
                out.push_str(&format!("{k}: {}\n", v.as_str().unwrap_or(&v.to_string())));
            }
        }
    }
    Ok(out)
}

// ---- GGUF ----

fn gguf_type_name(t: u32) -> &'static str {
    match t {
        0 => "UINT8",
        1 => "INT8",
        2 => "UINT16",
        3 => "INT16",
        4 => "UINT32",
        5 => "INT32",
        6 => "FLOAT32",
        7 => "BOOL",
        8 => "STRING",
        9 => "ARRAY",
        10 => "UINT64",
        11 => "INT64",
        12 => "FLOAT64",
        _ => "UNKNOWN",
    }
}

fn describe_gguf(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 24 || &bytes[..4] != b"GGUF" {
        return Err("不是合法的 GGUF 文件".into());
    }
    let u32_at = |p: usize| -> u32 { u32::from_le_bytes(bytes[p..p + 4].try_into().unwrap()) };
    let u64_at = |p: usize| -> u64 { u64::from_le_bytes(bytes[p..p + 8].try_into().unwrap()) };

    let version = u32_at(4);
    let tensor_count = u64_at(8);
    let kv_count = u64_at(16);

    let mut out = String::new();
    out.push_str("GGUF 模型\n");
    out.push_str(&format!("版本: {version}\n"));
    out.push_str(&format!("张量数: {tensor_count}\n"));
    out.push_str(&format!("元数据项: {kv_count}\n"));

    let mut pos = 24usize;
    let read_string = |pos: &mut usize, bytes: &[u8]| -> Result<String, String> {
        let len = u64_at(*pos) as usize;
        *pos += 8;
        if *pos + len > bytes.len() {
            return Err("GGUF 字符串越界".into());
        }
        let s = String::from_utf8_lossy(&bytes[*pos..*pos + len]).to_string();
        *pos += len;
        Ok(s)
    };

    out.push_str("\n== 元数据 ==\n");
    for _ in 0..kv_count.min(200) {
        if pos + 8 > bytes.len() {
            break;
        }
        let key = read_string(&mut pos, bytes)?;
        if pos + 4 > bytes.len() {
            break;
        }
        let vtype = u32_at(pos);
        pos += 4;
        let val = match vtype {
            0 | 1 | 7 => {
                let v = bytes.get(pos).copied().unwrap_or(0);
                pos += 1;
                if vtype == 7 {
                    (v != 0).to_string()
                } else {
                    v.to_string()
                }
            }
            2 | 3 => {
                let v = bytes
                    .get(pos..pos + 2)
                    .and_then(|s| s.try_into().ok())
                    .map(u16::from_le_bytes)
                    .unwrap_or(0);
                pos += 2;
                v.to_string()
            }
            4 | 5 => {
                let v = bytes
                    .get(pos..pos + 4)
                    .and_then(|s| s.try_into().ok())
                    .map(u32::from_le_bytes)
                    .unwrap_or(0);
                pos += 4;
                v.to_string()
            }
            6 => {
                let v = bytes
                    .get(pos..pos + 4)
                    .and_then(|s| s.try_into().ok())
                    .map(f32::from_le_bytes)
                    .unwrap_or(0.0);
                pos += 4;
                v.to_string()
            }
            10 | 11 => {
                let v = bytes
                    .get(pos..pos + 8)
                    .and_then(|s| s.try_into().ok())
                    .map(u64::from_le_bytes)
                    .unwrap_or(0);
                pos += 8;
                v.to_string()
            }
            12 => {
                let v = bytes
                    .get(pos..pos + 8)
                    .and_then(|s| s.try_into().ok())
                    .map(f64::from_le_bytes)
                    .unwrap_or(0.0);
                pos += 8;
                v.to_string()
            }
            8 => {
                let s = read_string(&mut pos, bytes)?;
                format!("\"{s}\"")
            }
            9 => {
                // 数组：元素类型(u32) + 数量(u64) + 元素（按 8 字节估算跳过）
                if pos + 12 > bytes.len() {
                    break;
                }
                pos += 4; // elem_type
                let n = u64_at(pos) as usize;
                pos += 8;
                pos = pos.saturating_add(n * 8).min(bytes.len());
                "[array]".to_string()
            }
            _ => {
                pos += 8;
                "?".to_string()
            }
        };
        out.push_str(&format!("{key} ({}) = {val}\n", gguf_type_name(vtype)));
    }

    out.push_str("\n== 张量 ==\n");
    for _ in 0..tensor_count.min(1000) {
        if pos + 8 > bytes.len() {
            break;
        }
        let name = read_string(&mut pos, bytes)?;
        if pos + 4 > bytes.len() {
            break;
        }
        let n_dims = u32_at(pos);
        pos += 4;
        if pos + n_dims as usize * 8 > bytes.len() {
            break;
        }
        let mut dims = Vec::new();
        for _ in 0..n_dims {
            dims.push(u64_at(pos));
            pos += 8;
        }
        if pos + 12 > bytes.len() {
            break;
        }
        let ttype = u32_at(pos);
        pos += 4;
        let offset = u64_at(pos);
        pos += 8;
        out.push_str(&format!(
            "{name} : {} {:?} (offset {offset})\n",
            gguf_type_name(ttype),
            dims
        ));
    }

    Ok(out)
}

// ---- ONNX（最小 protobuf wire 解析）----

/// 读取一个 varint，返回 (值, 新偏移)。
fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut val = 0u64;
    let mut shift = 0u32;
    loop {
        let b = *buf.get(*pos)?;
        *pos += 1;
        val |= ((b & 0x7f) as u64) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    Some(val)
}

/// 找到第一个 field_num 的长度分隔字段，返回其 payload。
fn find_field<'a>(buf: &'a [u8], field_num: u64, wire_type: u64) -> Option<&'a [u8]> {
    let mut pos = 0usize;
    while pos < buf.len() {
        let key = read_varint(buf, &mut pos)?;
        let fnum = key >> 3;
        let wt = key & 7;
        match wt {
            0 => {
                read_varint(buf, &mut pos)?;
            }
            1 => {
                pos += 8;
            }
            2 => {
                let len = read_varint(buf, &mut pos)? as usize;
                let payload = buf.get(pos..pos + len)?;
                pos += len;
                if fnum == field_num && wt == wire_type {
                    return Some(payload);
                }
            }
            5 => {
                pos += 4;
            }
            _ => return None,
        }
    }
    None
}

/// 找到所有 field_num 的长度分隔字段 payload。
fn find_all_fields<'a>(buf: &'a [u8], field_num: u64) -> Vec<&'a [u8]> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        let Some(key) = read_varint(buf, &mut pos) else { break };
        let fnum = key >> 3;
        let wt = key & 7;
        match wt {
            0 => {
                if read_varint(buf, &mut pos).is_none() {
                    break;
                }
            }
            1 => pos += 8,
            2 => {
                let Some(len) = read_varint(buf, &mut pos) else { break };
                let len = len as usize;
                let Some(payload) = buf.get(pos..pos + len) else { break };
                pos += len;
                if fnum == field_num {
                    out.push(payload);
                }
            }
            5 => pos += 4,
            _ => break,
        }
    }
    out
}

fn describe_onnx(bytes: &[u8]) -> Result<String, String> {
    let mut out = String::from("ONNX 模型\n");

    // ModelProto: ir_version=1, producer_name=2, graph=7, opset_import=8
    if let Some(v) = find_field(bytes, 1, 0).and_then(|_| {
        let mut p = 0usize;
        read_varint(bytes, &mut p)
    }) {
        out.push_str(&format!("IR 版本: {v}\n"));
    }
    if let Some(p) = find_field(bytes, 2, 2) {
        out.push_str(&format!("生成器: {}\n", String::from_utf8_lossy(p)));
    }
    if let Some(opset) = find_field(bytes, 8, 2) {
        // OperatorSetIdProto: domain=1, version=2
        let ver = find_field(opset, 2, 0).and_then(|_| {
            let mut p = 0usize;
            read_varint(opset, &mut p)
        });
        if let Some(v) = ver {
            out.push_str(&format!("Opset 版本: {v}\n"));
        }
    }

    let Some(graph) = find_field(bytes, 7, 2) else {
        return Err("ONNX 文件中未找到计算图".into());
    };

    // 节点（op_type）
    let mut node_count = 0usize;
    let mut node_lines = String::new();
    for node in find_all_fields(graph, 1) {
        node_count += 1;
        // NodeProto: input=1(repeated str), output=2(repeated str), name=3, op_type=4
        let op = find_field(node, 4, 2)
            .map(|s| String::from_utf8_lossy(s).to_string())
            .unwrap_or_else(|| "?".into());
        let name = find_field(node, 3, 2)
            .map(|s| String::from_utf8_lossy(s).to_string())
            .unwrap_or_default();
        let inputs: Vec<String> = find_all_fields(node, 1)
            .iter()
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect();
        let outputs: Vec<String> = find_all_fields(node, 2)
            .iter()
            .map(|s| String::from_utf8_lossy(s).to_string())
            .collect();
        let label = if name.is_empty() { op.clone() } else { name.clone() };
        node_lines.push_str(&format!("{op}  {label}  ({}) -> ({})\n", inputs.join(", "), outputs.join(", ")));
    }
    out.push_str(&format!("\n== 节点（{node_count} 个）==\n"));
    out.push_str(&node_lines);

    // 初始化权重（TensorProto: dims=1, data_type=2, name=8）
    let inits = find_all_fields(graph, 5);
    out.push_str(&format!("\n== 权重（{} 个）==\n", inits.len()));
    for init in inits {
        let name = find_field(init, 8, 2)
            .map(|s| String::from_utf8_lossy(s).to_string())
            .unwrap_or_else(|| "?".into());
        let dtype = find_field(init, 2, 0).and_then(|_| {
            let mut p = 0usize;
            read_varint(init, &mut p)
        });
        let mut dims = Vec::new();
        for d in find_all_fields(init, 1) {
            let mut p = 0usize;
            if let Some(v) = read_varint(d, &mut p) {
                dims.push(v.to_string());
            }
        }
        out.push_str(&format!("{name} : [{dims}] (dtype {dtype:?})\n", dims = dims.join(", ")));
    }

    // 输入 / 输出
    let graph_inputs: Vec<String> = find_all_fields(graph, 11)
        .iter()
        .filter_map(|v| find_field(v, 1, 2))
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();
    let graph_outputs: Vec<String> = find_all_fields(graph, 12)
        .iter()
        .filter_map(|v| find_field(v, 1, 2))
        .map(|s| String::from_utf8_lossy(s).to_string())
        .collect();
    if !graph_inputs.is_empty() {
        out.push_str(&format!("\n== 图输入 ==\n{}\n", graph_inputs.join(", ")));
    }
    if !graph_outputs.is_empty() {
        out.push_str(&format!("\n== 图输出 ==\n{}\n", graph_outputs.join(", ")));
    }

    Ok(out)
}
