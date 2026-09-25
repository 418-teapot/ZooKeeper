#![forbid(unsafe_code)]
#![deny(clippy::all)]
#![deny(dead_code)]
#![warn(clippy::pedantic)]
#![warn(clippy::nursery)]

//! Binary entry point for `zdebug`.
//!
//! All command parsing and execution live in [`cli`]; `main` only forwards
//! the process exit code.

mod cli;

fn main() -> std::process::ExitCode {
    cli::run()
}
