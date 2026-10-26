//! 生成 parquet / arrow / feather 表格测试文件，并打印 describe_structured 输出。
//! 用法：cargo run -p omniviewer-core --example gen_data_files -- <目标目录>

use std::fs::File;
use std::sync::Arc;

fn make_batch() -> (Arc<arrow::datatypes::Schema>, arrow::record_batch::RecordBatch) {
    use arrow::array::{Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, false),
        Field::new("age", DataType::Int64, false),
        Field::new("score", DataType::Float64, false),
    ]));
    let batch = arrow::record_batch::RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4, 5])),
            Arc::new(StringArray::from(vec!["alice", "bob", "carol", "dave", "eve"])),
            Arc::new(Int64Array::from(vec![30, 25, 35, 28, 32])),
            Arc::new(Float64Array::from(vec![98.5, 87.0, 92.3, 75.8, 88.1])),
        ],
    )
    .unwrap();
    (schema, batch)
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| "/tmp".to_string());
    std::fs::create_dir_all(&dir).unwrap();
    let (schema, batch) = make_batch();

    {
        use parquet::arrow::ArrowWriter;
        let p = format!("{dir}/sample_table.parquet");
        let file = File::create(&p).unwrap();
        let mut w = ArrowWriter::try_new(file, schema.clone(), None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();
    }
    for name in ["sample.arrow", "sample.feather"] {
        use arrow::ipc::writer::FileWriter;
        let p = format!("{dir}/{name}");
        let file = File::create(&p).unwrap();
        let mut w = FileWriter::try_new(file, &schema).unwrap();
        w.write(&batch).unwrap();
        w.finish().unwrap();
    }

    for f in ["sample_table.parquet", "sample.arrow", "sample.feather"] {
        let path = format!("{dir}/{f}");
        println!("===== {path} =====");
        match omniviewer_core::structured::describe_structured(&path) {
            Ok(s) => println!("{s}"),
            Err(e) => println!("ERR: {e}"),
        }
        println!();
    }
}
