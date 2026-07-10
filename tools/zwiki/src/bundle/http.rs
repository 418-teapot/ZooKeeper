//! HTTP client helpers for bundle download.

use std::sync::OnceLock;
use std::time::Duration;

/// Maximum allowed size for a downloaded bundle response (256 MiB).
pub const MAX_BUNDLE_SIZE: u64 = 256 * 1024 * 1024;

/// Shared HTTP client with a 30-second timeout.
pub fn http_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest blocking client")
    })
}

/// Read the response body into a `Vec<u8>`, pre-allocating based on the
/// Content-Length header (clamped to `MAX_BUNDLE_SIZE`).  Uses
/// `take(MAX_BUNDLE_SIZE + 1)` to bound the stream as a defense-in-depth
/// measure against oversized responses.
pub fn read_body_capped(
    resp: reqwest::blocking::Response,
) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let cap = resp.content_length().map_or(0, |c| c.min(MAX_BUNDLE_SIZE));
    let mut capped = resp.take(MAX_BUNDLE_SIZE + 1);
    let mut body = Vec::with_capacity(usize::try_from(cap).unwrap_or(0));
    capped
        .read_to_end(&mut body)
        .map_err(|e| format!("cannot read response body: {e}"))?;
    Ok(body)
}

/// Read the response body as a `String`, pre-allocating based on the
/// Content-Length header (clamped to `MAX_BUNDLE_SIZE`).
pub fn read_body_capped_string(
    resp: reqwest::blocking::Response,
) -> Result<String, String> {
    let bytes = read_body_capped(resp)?;
    String::from_utf8(bytes)
        .map_err(|e| format!("invalid UTF-8 in response: {e}"))
}
