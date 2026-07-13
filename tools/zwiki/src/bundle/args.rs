//! CLI argument structs for bundle subcommands.

use clap::{Args, Subcommand};

/// Arguments for `zwiki bundle init`.
#[derive(Args, Debug, Clone)]
pub struct InitArgs {
    /// Bundle name (default: basename of current working directory)
    #[arg(long)]
    pub name: Option<String>,

    /// Bundle version
    #[arg(long, default_value = "0.1.0")]
    pub version: String,

    /// Bundle kind — upstream, team, or org
    #[arg(long, default_value = "upstream")]
    pub kind: String,

    /// OKF schema version
    #[arg(long = "okf-version", default_value = "0.1")]
    pub okf_version: String,

    /// Team name (required when kind=team)
    #[arg(long)]
    pub team: Option<String>,

    /// Registry URL
    #[arg(long)]
    pub registry: Option<String>,

    /// Bundle description
    #[arg(long)]
    pub description: Option<String>,

    /// Include glob patterns (can be repeated)
    #[arg(long)]
    pub include: Vec<String>,

    /// Exclude glob patterns (can be repeated)
    #[arg(long)]
    pub exclude: Vec<String>,

    /// Output file path
    #[arg(long, short)]
    pub output: Option<String>,

    /// Output as JSON instead of YAML
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle export`.
#[derive(Args, Debug, Clone)]
pub struct ExportArgs {
    /// Bundle directory containing bundle.toml
    pub dir: String,

    /// Custom output path (default: <name>-<version>.tar.gz in CWD)
    #[arg(long)]
    pub output: Option<String>,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle install`.
#[derive(Args, Debug, Clone)]
pub struct InstallArgs {
    /// Source: local directory path, tar.gz path, or URL
    pub source: String,

    /// Overwrite existing bundle if already installed
    #[arg(long)]
    pub force: bool,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,

    /// Preview what would be installed without modifying files
    #[arg(long = "dry-run")]
    pub dry_run: bool,
}

/// Arguments for `zwiki bundle list`.
#[derive(Args, Debug, Clone)]
pub struct ListArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle check`.
#[derive(Args, Debug, Clone)]
pub struct CheckArgs {
    /// Output as JSON
    #[arg(long)]
    pub json: bool,

    /// Regenerate missing or stale root index.md
    #[arg(long)]
    pub fix: bool,

    /// Preview what would be cleaned up without modifying files (with --fix)
    #[arg(long = "dry-run")]
    pub dry_run: bool,
}

/// Arguments for `zwiki bundle uninstall`.
#[derive(Args, Debug, Clone)]
pub struct UninstallArgs {
    /// Bundle name to uninstall
    pub name: String,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,
}

/// Arguments for `zwiki bundle update`.
#[derive(Args, Debug, Clone)]
pub struct UpdateArgs {
    /// Filter by bundle name (update only this bundle)
    #[arg(long)]
    pub name: Option<String>,

    /// Allow downgrade when remote version is older than local
    #[arg(long)]
    pub force: bool,

    /// Output as JSON
    #[arg(long)]
    pub json: bool,

    /// Preview what would be updated without downloading or modifying files
    #[arg(long = "dry-run")]
    pub dry_run: bool,
}

/// Bundle distribution subcommands.
#[derive(Subcommand)]
pub enum BundleCommand {
    /// Initialize a new bundle manifest in the current directory.
    Init(Box<InitArgs>),

    /// Export bundle to a .tar.gz archive.
    Export(ExportArgs),

    /// Install a bundle from a local directory, tar.gz, or URL.
    Install(InstallArgs),

    /// List installed bundles.
    List(ListArgs),

    /// Check integrity of installed bundles.
    Check(CheckArgs),

    /// Update installed bundles from their registry.
    Update(UpdateArgs),

    /// Uninstall a bundle by name.
    Uninstall(UninstallArgs),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::testutil::BundleTestParser;
    use clap::Parser;

    #[test]
    fn test_export_args_parse() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "export",
            "/some/dir",
            "--output",
            "bundle.tar.gz",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Export(args) => {
                assert_eq!(args.dir, "/some/dir");
                assert_eq!(args.output, Some("bundle.tar.gz".to_string()));
            }
            _ => panic!("expected Export"),
        }
    }

    #[test]
    fn test_install_args_parse() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "install",
            "https://example.com/bundle.tar.gz",
            "--force",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Install(args) => {
                assert_eq!(args.source, "https://example.com/bundle.tar.gz");
                assert!(args.force);
            }
            _ => panic!("expected Install"),
        }
    }

    #[test]
    fn test_install_args_local_dir() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "install",
            "./my-bundle",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Install(args) => {
                assert_eq!(args.source, "./my-bundle");
                assert!(!args.force);
            }
            _ => panic!("expected Install"),
        }
    }

    #[test]
    fn test_export_args_default_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "export", "/some/dir"])
                .unwrap();
        match parser.cmd {
            BundleCommand::Export(args) => {
                assert!(!args.json);
                assert_eq!(args.output, None);
            }
            _ => panic!("expected Export"),
        }
    }

    #[test]
    fn test_list_args_parse_default() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "list"]).unwrap();
        match parser.cmd {
            BundleCommand::List(args) => {
                assert!(!args.json);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_list_args_parse_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "list", "--json"])
                .unwrap();
        match parser.cmd {
            BundleCommand::List(args) => {
                assert!(args.json);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn test_check_args_parse_default() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "check"]).unwrap();
        match parser.cmd {
            BundleCommand::Check(args) => {
                assert!(!args.json);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_check_args_parse_json() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "check", "--json"])
                .unwrap();
        match parser.cmd {
            BundleCommand::Check(args) => {
                assert!(args.json);
            }
            _ => panic!("expected Check"),
        }
    }

    #[test]
    fn test_update_args_parse_default() {
        let parser =
            BundleTestParser::try_parse_from(["bundle", "update"]).unwrap();
        match parser.cmd {
            BundleCommand::Update(args) => {
                assert!(args.name.is_none());
                assert!(!args.json);
            }
            _ => panic!("expected Update"),
        }
    }

    #[test]
    fn test_update_args_parse_name() {
        let parser = BundleTestParser::try_parse_from([
            "bundle",
            "update",
            "--name",
            "my-bundle",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Update(args) => {
                assert_eq!(args.name, Some("my-bundle".to_string()));
                assert!(!args.json);
            }
            _ => panic!("expected Update"),
        }
    }

    #[test]
    fn test_update_args_parse_json() {
        let parser = BundleTestParser::try_parse_from([
            "bundle", "update", "--name", "test", "--json",
        ])
        .unwrap();
        match parser.cmd {
            BundleCommand::Update(args) => {
                assert_eq!(args.name, Some("test".to_string()));
                assert!(args.json);
            }
            _ => panic!("expected Update"),
        }
    }
}
