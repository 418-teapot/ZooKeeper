//! Verifies that [`ztest::TestEnv`] pins the child process environment.

use ztest::TestEnv;

/// Spawn `sh` through `env` and read one environment variable from it.
fn read_env(env: &TestEnv, name: &str) -> String {
    let script = format!("printf %s \"${{{name}}}\"");
    let output =
        env.command("sh").args(["-c", &script]).output().expect("spawn sh");
    assert!(output.status.success(), "sh should exit 0");
    String::from_utf8_lossy(&output.stdout).to_string()
}

#[test]
fn pins_home_to_the_temp_dir() {
    let env = TestEnv::new();
    assert_eq!(read_env(&env, "HOME"), env.home().to_string_lossy());
}

#[test]
fn pins_data_dirs_to_temp_dirs() {
    let env = TestEnv::new();
    assert_eq!(
        read_env(&env, "ZOO_OPENCODE_DATA_DIR"),
        env.opencode_data().to_string_lossy()
    );
    assert_eq!(
        read_env(&env, "ZOO_PI_DATA_DIR"),
        env.pi_data().to_string_lossy()
    );
}

#[test]
fn pins_columns_to_80_by_default() {
    let env = TestEnv::new();
    assert_eq!(read_env(&env, "COLUMNS"), "80");
}

#[test]
fn with_columns_overrides_the_default() {
    let env = TestEnv::new().with_columns(200);
    assert_eq!(read_env(&env, "COLUMNS"), "200");
}

#[test]
fn explicit_env_overrides_win() {
    let env = TestEnv::new();
    let output = env
        .command("sh")
        .env("COLUMNS", "120")
        .args(["-c", "printf %s \"$COLUMNS\""])
        .output()
        .expect("spawn sh");
    assert_eq!(String::from_utf8_lossy(&output.stdout), "120");
}

#[test]
fn zoo_log_dir_appends_dot_zoo_log_to_home() {
    let env = TestEnv::new();
    assert_eq!(env.zoo_log_dir(), env.home().join(".zoo").join("log"));
}

#[test]
fn temp_dir_is_unique_per_call_and_keeps_the_name_segment() {
    let a = ztest::temp_dir("case");
    let b = ztest::temp_dir("case");
    assert_ne!(a, b, "two calls must not share a directory");
    assert_eq!(a.file_name().and_then(|n| n.to_str()), Some("case"));
    assert!(a.is_dir() && b.is_dir());
}
