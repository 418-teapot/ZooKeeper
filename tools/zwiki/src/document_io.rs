//! Page document file access.
//!
//! The document model does not know where pages live.  This module connects
//! it to the filesystem: every write goes through [`PageDocument::render`]
//! and the atomic writer.

use std::fs;
use std::path::Path;

use zwiki::document::PageDocument;

/// Read and parse the page at `page`.
pub fn load(page: &Path) -> Result<PageDocument, String> {
    let text =
        fs::read_to_string(page).map_err(|e| format!("无法读取文件: {e}"))?;
    PageDocument::parse(&text).map_err(|e| e.to_string())
}

/// Render `document` and write it to `page` atomically.
pub fn store(page: &Path, document: &PageDocument) -> Result<(), String> {
    let text = document.render().map_err(|e| e.to_string())?;
    zutil::fileio::write_atomic(page, &text)
        .map_err(|e| format!("写入文件失败: {e}"))
}
