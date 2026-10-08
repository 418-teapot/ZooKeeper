//! Contract tests for [`ztest::parse_stdout_json`].

use ztest::TestEnv;

#[test]
fn parses_trimmed_stdout_as_json() {
    let env = TestEnv::new();
    let output = env
        .command("sh")
        .args(["-c", "printf '  {\"a\": 1}\\n'"])
        .output()
        .expect("spawn sh");
    let value = ztest::parse_stdout_json(&output);
    assert_eq!(value["a"], 1);
}

#[test]
#[should_panic(expected = "stdout should be valid JSON")]
fn panics_when_stdout_is_not_json() {
    let env = TestEnv::new();
    let output = env
        .command("sh")
        .args(["-c", "printf 'not json'"])
        .output()
        .expect("spawn sh");
    let _ = ztest::parse_stdout_json(&output);
}
