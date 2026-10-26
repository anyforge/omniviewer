//! docx 水印：不可见暗水印（marker）+ 可见明水印（VML header），均可去除。

pub const DOCX_WM_MARKER: &str = "OMNIVIEWER-WATERMARK";

fn docx_read_part(src: &str, name: &str) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut part = archive.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = String::new();
    part.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn docx_write_part(src: &str, dest: &str, replace_name: &str, replace_content: &str) -> Result<(), String> {
    use std::io::Write;
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(out);
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.into_owned();
        if name == replace_name {
            writer.start_file(name, zip::write::SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            writer.write_all(replace_content.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            writer.raw_copy_file(entry).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// docx 嵌入不可见文本暗水印（marker + 标识 + 时间戳，白字 + 隐藏）。
pub fn docx_embed_watermark(src: &str, dest: &str, id: &str) -> Result<(), String> {
    let content = docx_read_part(src, "word/document.xml")?;
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs().to_string()).unwrap_or_default();
    let text = format!("{DOCX_WM_MARKER}: {id} {ts}");
    let para = format!("<w:p><w:r><w:rPr><w:color w:val=\"FFFFFF\"/><w:sz w:val=\"2\"/><w:vanish/></w:rPr><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>");
    let modified = match content.find("<w:body>") {
        Some(pos) => {
            let insert = pos + "<w:body>".len();
            format!("{}{}{}", &content[..insert], para, &content[insert..])
        }
        None => format!("{}{}", content, para),
    };
    docx_write_part(src, dest, "word/document.xml", &modified)
}

/// docx 提取暗水印（返回标识文本，无则 None）。
pub fn docx_extract_watermark(src: &str) -> Result<Option<String>, String> {
    let content = docx_read_part(src, "word/document.xml")?;
    match content.find(DOCX_WM_MARKER) {
        Some(pos) => {
            let rest = &content[pos + DOCX_WM_MARKER.len()..];
            let end = rest.find("</w:t>").unwrap_or(rest.len());
            let text = rest[..end].trim().trim_start_matches(':').trim().to_string();
            Ok(Some(text))
        }
        None => Ok(None),
    }
}

/// docx 去除水印（剥离不可见文本 marker 段落 + VML 明水印，返回是否改动）。
pub fn docx_remove_watermark(src: &str, dest: &str) -> Result<bool, String> {
    let content = docx_read_part(src, "word/document.xml")?;
    let mut removed = false;
    let mut result = String::new();
    let mut rest = content.as_str();
    while let Some(pos) = rest.find(DOCX_WM_MARKER) {
        let para_start = rest[..pos].rfind("<w:p>").or_else(|| rest[..pos].rfind("<w:p ")).unwrap_or(pos);
        let para_end = rest[pos..].find("</w:p>").map(|e| pos + e + "</w:p>".len()).unwrap_or(rest.len());
        result.push_str(&rest[..para_start]);
        rest = &rest[para_end..];
        removed = true;
    }
    result.push_str(rest);
    let doc2 = result.replace(r#"<w:headerReference w:type="default" r:id="rIdOmniviewer"/>"#, "");
    removed = removed || doc2 != result;

    let rels = docx_read_part(src, "word/_rels/document.xml.rels")?;
    let rels2 = rels.replace(r#"<Relationship Id="rIdOmniviewer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-omniviewer.xml"/>"#, "");
    removed = removed || rels2 != rels;

    let ct = docx_read_part(src, "[Content_Types].xml")?;
    let ct2 = ct.replace(r#"<Override PartName="/word/header-omniviewer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>"#, "");
    removed = removed || ct2 != ct;

    if removed {
        let mut replacements = std::collections::HashMap::new();
        replacements.insert("word/document.xml".to_string(), doc2);
        replacements.insert("word/_rels/document.xml.rels".to_string(), rels2);
        replacements.insert("[Content_Types].xml".to_string(), ct2);
        docx_transform(src, dest, &replacements, &std::collections::HashMap::new())?;
    }
    Ok(removed)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn docx_transform(src: &str, dest: &str, replacements: &std::collections::HashMap<String, String>, additions: &std::collections::HashMap<String, String>) -> Result<(), String> {
    use std::io::Write;
    let file = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let out = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut writer = zip::ZipWriter::new(out);
    let mut seen = std::collections::HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.into_owned();
        if let Some(content) = replacements.get(&name) {
            writer.start_file(name.clone(), zip::write::SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            writer.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        } else {
            writer.raw_copy_file(entry).map_err(|e| e.to_string())?;
        }
        seen.insert(name);
    }
    for (name, content) in additions {
        if !seen.contains(name) {
            writer.start_file(name.clone(), zip::write::SimpleFileOptions::default()).map_err(|e| e.to_string())?;
            writer.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    Ok(())
}

const DOCX_WM_HEADER_TEMPLATE: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:pict>
<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">
<v:f eqn="sum #0 0 10800"/><v:f eqn="prod #0 2 1"/><v:f eqn="sum 21600 0 @1"/><v:f eqn="sum 0 0 @2"/><v:f eqn="sum 21600 0 @3"/><v:f eqn="if @0 @3 0"/><v:f eqn="if @0 21600 @1"/><v:f eqn="if @0 0 @2"/><v:f eqn="if @0 @4 21600"/><v:f eqn="mid @5 @6"/><v:f eqn="mid @8 @5"/><v:f eqn="mid @7 @8"/><v:f eqn="mid @6 @7"/><v:f eqn="sum @6 0 @5"/><v:formulas/><v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/><v:textpath on="t" fitshape="t"/><v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles><o:lock v:ext="edit" text="t" shapetype="t"/>
</v:shapetype>
<v:shape id="OmniviewerWatermark" o:spid="_x0000_s2050" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;width:480pt;height:100pt;rotation:315;z-index:-251654144;mso-position-horizontal:center;mso-position-vertical:center" o:allowincell="f" fillcolor="silver" stroked="f"><v:fill opacity=".5"/><v:textpath style="font-family:'Microsoft YaHei';font-size:1pt" string="__WM_TEXT__"/></v:shape>
</w:pict></w:r></w:p>
</w:hdr>"##;

/// docx 嵌入可见明水印（header VML 斜水印，带 marker 可去除）。
pub fn docx_embed_visible_watermark(src: &str, dest: &str, text: &str) -> Result<(), String> {
    let doc = docx_read_part(src, "word/document.xml")?;
    let hdr_ref = r#"<w:headerReference w:type="default" r:id="rIdOmniviewer"/>"#;
    let doc2 = match doc.find("<w:sectPr") {
        Some(pos) => {
            let gt = doc[pos..].find('>').map(|e| pos + e + 1).unwrap_or(pos);
            format!("{}{}{}", &doc[..gt], hdr_ref, &doc[gt..])
        }
        None => doc.replacen("</w:body>", &format!("<w:sectPr>{hdr_ref}</w:sectPr></w:body>"), 1),
    };
    let rels = docx_read_part(src, "word/_rels/document.xml.rels")?;
    let rel = r#"<Relationship Id="rIdOmniviewer" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-omniviewer.xml"/>"#;
    let rels2 = rels.replacen("</Relationships>", &format!("{rel}</Relationships>"), 1);
    let ct = docx_read_part(src, "[Content_Types].xml")?;
    let ov = r#"<Override PartName="/word/header-omniviewer.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>"#;
    let ct2 = ct.replacen("</Types>", &format!("{ov}</Types>"), 1);
    let header = DOCX_WM_HEADER_TEMPLATE.replace("__WM_TEXT__", &xml_escape(text));

    let mut replacements = std::collections::HashMap::new();
    replacements.insert("word/document.xml".to_string(), doc2);
    replacements.insert("word/_rels/document.xml.rels".to_string(), rels2);
    replacements.insert("[Content_Types].xml".to_string(), ct2);
    let mut additions = std::collections::HashMap::new();
    additions.insert("word/header-omniviewer.xml".to_string(), header);
    docx_transform(src, dest, &replacements, &additions)
}
