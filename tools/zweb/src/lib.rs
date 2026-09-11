//! HTML to Markdown conversion exposed to Node via N-API.
//!
//! Terminal users run behind a private network and cannot install npm
//! packages, so the conversion is compiled into a native addon instead of a
//! JavaScript dependency. The addon exposes a single synchronous function,
//! [`html_to_markdown`], and is loaded by the pi host at runtime.

// `deny` rather than `forbid`: the `#[napi]` macro expansion registers its
// own allow(unsafe_code) attribute, which is incompatible with `forbid`
// (E0453).
#![deny(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

use html_to_markdown_rs::{
    ConversionOptions, PreprocessingOptions, PreprocessingPreset, TierStrategy,
    WarningKind, convert,
};
use napi_derive::napi;

/// Convert an HTML document into Markdown.
///
/// Noise such as navigation, forms, headers and footers is stripped before
/// conversion. Conversion failures and depth-limit warnings surface as
/// JavaScript errors.
///
/// # Errors
///
/// Returns an error when the HTML cannot be converted or the output would be
/// truncated because the document nesting exceeds the parser depth limit.
#[napi]
pub fn html_to_markdown(html: String) -> napi::Result<String> {
    // `#[napi]` hands the JS string over as an owned `String`, while the
    // conversion only needs a borrow.  Consume the owned value explicitly so
    // the signature matches the boundary's ownership contract.
    let markdown = convert_html(&html);
    drop(html);
    markdown.map_err(napi::Error::from_reason)
}

/// Convert HTML to Markdown with the fixed fetch-friendly options.
///
/// Kept separate from the N-API wrapper so it can be unit tested without a
/// Node runtime.
fn convert_html(html: &str) -> Result<String, String> {
    let options = ConversionOptions {
        preprocessing: PreprocessingOptions {
            enabled: true,
            preset: PreprocessingPreset::Aggressive,
            remove_navigation: true,
            remove_forms: true,
        },
        tier_strategy: TierStrategy::Tier2,
        ..Default::default()
    };

    let result = convert(html, Some(options))
        .map_err(|err| format!("Conversion error: {err}"))?;
    if let Some(warning) = result
        .warnings
        .iter()
        .find(|warning| warning.kind == WarningKind::DepthLimitExceeded)
    {
        return Err(format!("Conversion error: {}", warning.message));
    }
    Ok(result.content.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::convert_html;

    #[test]
    fn converts_simple_html() {
        let markdown = convert_html("<h1>Title</h1><p>Hello <b>world</b>.</p>")
            .expect("simple html should convert");
        assert!(markdown.contains("# Title"), "got: {markdown}");
        assert!(markdown.contains("Hello **world**."), "got: {markdown}");
    }

    #[test]
    fn strips_script_and_style_noise() {
        let html = "<html><head><title>T</title><style>body{ color:red }</style>\
            <script>console.log('noise')</script></head>\
            <body><p>Visible text</p></body></html>";
        let markdown = convert_html(html).expect("noisy html should convert");
        assert!(markdown.contains("Visible text"), "got: {markdown}");
        assert!(!markdown.contains("console.log"), "got: {markdown}");
        assert!(!markdown.contains("color:red"), "got: {markdown}");
    }

    #[test]
    fn empty_input_does_not_panic() {
        let markdown = convert_html("").expect("empty html should convert");
        assert!(markdown.trim().is_empty(), "got: {markdown}");
    }

    #[test]
    fn malformed_html_does_not_panic() {
        let markdown = convert_html("<div><p>unclosed <b>tags")
            .expect("malformed html should convert");
        assert!(markdown.contains("unclosed"), "got: {markdown}");
    }
}
