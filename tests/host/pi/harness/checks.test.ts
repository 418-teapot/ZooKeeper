/**
 * Self-tests for the result model: checks, scenario timing, the suite exit
 * code and artifact retention.
 *
 * A harness that cannot fail is worthless, so the negative paths are
 * asserted directly: a failed check must fail the suite, must name the
 * artifacts to keep, and must be visible in the report.
 */

import { describe, expect, test } from "bun:test";
import type { ScenarioReport, SuiteHost } from "./checks.js";
import {
  CheckSink,
  renderArtifactNotice,
  renderReport,
  shouldRetainArtifacts,
  suiteExitCode,
  summarize,
} from "./checks.js";

/** Host marker used in the report banner. */
const HOST: SuiteHost = {
  piBinary: "/usr/local/bin/pi",
};

/** Build one scenario report with the given checks. */
function scenario(
  id: string,
  checks: ScenarioReport["checks"],
  overrides: Partial<ScenarioReport> = {},
): ScenarioReport {
  const failed = checks.some((check) => check.status === "fail");
  return {
    id,
    title: `${id} title`,
    risk: `${id} risk`,
    durationMs: 1_234,
    status: failed ? "fail" : "pass",
    artifactsDir: `/tmp/root/${id}`,
    checks,
    ...overrides,
  };
}

describe("CheckSink", () => {
  test("records status, detail and evidence", () => {
    const sink = new CheckSink("demo");
    sink.add({
      id: "demo_one",
      title: "一项检查",
      status: "pass",
      detail: "all good",
      evidence: ["demo-rpc.jsonl"],
    });
    sink.info("demo_info", "一条信息", "observed");
    expect(sink.checks.length).toBe(2);
    expect(sink.checks[0]?.scenario).toBe("demo");
    expect(sink.checks[1]?.status).toBe("info");
    expect(sink.checks[0]?.evidence).toEqual(["demo-rpc.jsonl"]);
  });

  test("treats a boolean shorthand as pass/fail", () => {
    const sink = new CheckSink("demo");
    sink.add({ id: "yes", title: "t", status: true, detail: "" });
    sink.add({ id: "no", title: "t", status: false, detail: "" });
    expect(sink.checks.map((check) => check.status)).toEqual(["pass", "fail"]);
    expect(sink.failed).toBe(true);
  });
});

describe("summarize", () => {
  test("counts checks and scenarios, and keeps per-scenario timing", () => {
    const sinkA = new CheckSink("a");
    sinkA.add({ id: "a1", title: "t", status: "pass", detail: "" });
    sinkA.add({ id: "a2", title: "t", status: "info", detail: "" });
    const report = summarize({
      host: HOST,
      scenarios: [
        scenario("a", sinkA.checks),
        scenario("b", [
          {
            scenario: "b",
            id: "b1",
            title: "t",
            status: "fail",
            detail: "boom",
            evidence: ["b-rpc.jsonl"],
          },
        ]),
      ],
      durationMs: 4_000,
    });
    expect(report.totals.pass).toBe(1);
    expect(report.totals.info).toBe(1);
    expect(report.totals.fail).toBe(1);
    expect(report.scenarios[0]?.durationMs).toBe(1_234);
    expect(report.durationMs).toBe(4_000);
  });
});

describe("suiteExitCode", () => {
  test("is zero only when no check failed", () => {
    const passing = summarize({
      host: HOST,
      scenarios: [
        scenario("a", [
          {
            scenario: "a",
            id: "a1",
            title: "t",
            status: "info",
            detail: "",
            evidence: [],
          },
        ]),
      ],
      durationMs: 1,
    });
    expect(suiteExitCode(passing)).toBe(0);

    const failing = summarize({
      host: HOST,
      scenarios: [scenario("b", [], { status: "fail" })],
      durationMs: 1,
    });
    expect(suiteExitCode(failing)).toBe(1);
  });
});

/** Passing scenario whose checks carry a detail and an evidence file. */
function passingScenario(id: string): ScenarioReport {
  const sink = new CheckSink(id);
  sink.add({
    id: `${id}_ok`,
    title: "通过项",
    status: "pass",
    detail: `detail-of-${id}`,
    evidence: `${id}-rpc.jsonl`,
  });
  sink.info(`${id}_info`, "信息项", `info-of-${id}`);
  return scenario(id, sink.checks);
}

/** Failing scenario whose check carries a detail and an evidence file. */
function failingScenario(
  id: string,
  overrides: Partial<ScenarioReport> = {},
): ScenarioReport {
  const sink = new CheckSink(id);
  sink.add({
    id: `${id}_fail`,
    title: "失败项",
    status: "fail",
    detail: `boom-of-${id}`,
    evidence: `${id}-rpc.jsonl`,
  });
  return scenario(id, sink.checks, overrides);
}

describe("renderReport", () => {
  test("prints only a quiet summary with both timings on success", () => {
    const report = summarize({
      host: HOST,
      scenarios: [passingScenario("demo")],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: false });
    expect(text).toBe(
      "场景 1 通过 / 0 失败 · 断言 1 通过 / 0 失败\n总耗时：2.00s",
    );
    expect(text).not.toContain("/usr/local/bin/pi");
    expect(text).not.toContain("demo risk");
    expect(text).not.toContain("detail-of-demo");
    expect(text).not.toContain("信息");
    expect(text).not.toContain("证据");
    expect(text).not.toContain("/tmp/root/demo");
  });

  test("lists only the failing checks, each attributed to its scenario", () => {
    const report = summarize({
      host: HOST,
      scenarios: [failingScenario("demo")],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: false });
    expect(text).toBe(
      [
        "✗ [demo] demo_fail 失败项",
        "   boom-of-demo",
        "",
        "场景 0 通过 / 1 失败 · 断言 0 通过 / 1 失败",
        "总耗时：2.00s",
      ].join("\n"),
    );
  });

  test("does not repeat the scenario title, risk or artefacts of a failure", () => {
    const report = summarize({
      host: HOST,
      scenarios: [failingScenario("demo")],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: false });
    expect(text).not.toContain("宿主 pi");
    expect(text).not.toContain("[1/1]");
    expect(text).not.toContain("demo title");
    expect(text).not.toContain("风险：demo risk");
    expect(text).not.toContain("证据：demo-rpc.jsonl");
    expect(text).not.toContain("/tmp/root/demo");
    expect(text).not.toContain("保留");
  });

  test("does not print an exception that a failing check already carries", () => {
    const report = summarize({
      host: HOST,
      scenarios: [failingScenario("demo", { error: "boom-of-demo" })],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: false });
    expect(text.split("boom-of-demo").length - 1).toBe(1);
    expect(text).not.toContain("异常");
  });

  test("prints one concise exception line when no check carries it", () => {
    const report = summarize({
      host: HOST,
      scenarios: [failingScenario("demo", { error: "spawn failed" })],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: false });
    expect(text).toContain("✗ [demo] 异常：spawn failed");
    expect(text).toContain("✗ [demo] demo_fail 失败项");
  });

  test("skips a passing scenario next to a failing one", () => {
    const report = summarize({
      host: HOST,
      scenarios: [passingScenario("green"), failingScenario("red")],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: false });
    expect(text).not.toContain("detail-of-green");
    expect(text).not.toContain("green-rpc.jsonl");
    expect(text).toContain("✗ [red] red_fail 失败项");
    expect(text).toContain("boom-of-red");
  });

  test("keeps the full report, timings and info count under --verbose", () => {
    const report = summarize({
      host: HOST,
      scenarios: [failingScenario("demo")],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: true });
    expect(text.split("\n")[0]).toBe("宿主 pi：/usr/local/bin/pi");
    expect(text).not.toContain("node");
    expect(text).not.toContain("1.4.0");
    expect(text).toContain("[1/1] demo — demo title · 失败 (1.23s)");
    expect(text).toContain("风险：demo risk");
    expect(text).toContain("✗ demo_fail 失败项");
    expect(text).toContain("boom-of-demo");
    expect(text).toContain("证据：demo-rpc.jsonl");
    expect(text).toContain("产物：/tmp/root/demo");
    expect(text).toContain("断言 0 通过 / 1 失败 / 0 信息");
    expect(text).toContain("总耗时：2.00s");
  });

  test("expands a passing scenario under --verbose", () => {
    const report = summarize({
      host: HOST,
      scenarios: [passingScenario("demo")],
      durationMs: 2_000,
    });
    const text = renderReport(report, { verbose: true });
    expect(text).toContain("[1/1] demo — demo title · 通过 (1.23s)");
    expect(text).toContain("风险：demo risk");
    expect(text).toContain("✓ demo_ok 通过项");
    expect(text).toContain("detail-of-demo");
    expect(text).toContain("证据：demo-rpc.jsonl");
    expect(text).toContain("i demo_info 信息项");
    expect(text).toContain("产物：/tmp/root/demo");
    expect(text).toContain("断言 1 通过 / 0 失败 / 1 信息");
    expect(text).toContain("总耗时：2.00s");
  });
});

describe("shouldRetainArtifacts", () => {
  test("keeps artifacts on failure and drops them on success", () => {
    const failing = summarize({
      host: HOST,
      scenarios: [scenario("a", [], { status: "fail" })],
      durationMs: 1,
    });
    const passing = summarize({
      host: HOST,
      scenarios: [scenario("a", [])],
      durationMs: 1,
    });
    expect(shouldRetainArtifacts(failing, false)).toBe(true);
    expect(shouldRetainArtifacts(passing, false)).toBe(false);
    expect(shouldRetainArtifacts(passing, true)).toBe(true);
  });
});

describe("renderArtifactNotice", () => {
  /** Summary path used in the notices. */
  const SUMMARY = "/tmp/suite/summary.json";

  test("stays silent once a successful default run deleted its root", () => {
    const passing = summarize({
      host: HOST,
      scenarios: [passingScenario("a")],
      durationMs: 1,
    });
    const text = renderArtifactNotice({
      report: passing,
      keep: false,
      summaryPath: SUMMARY,
      verbose: false,
    });
    expect(text).toBe("");
  });

  test("reports the cleanup under --verbose", () => {
    const passing = summarize({
      host: HOST,
      scenarios: [passingScenario("a")],
      durationMs: 1,
    });
    const text = renderArtifactNotice({
      report: passing,
      keep: false,
      summaryPath: SUMMARY,
      verbose: true,
    });
    expect(text).toContain("已清理");
    expect(text).not.toContain(SUMMARY);
  });

  test("names summary and retained roots when a failing run keeps them", () => {
    const failing = summarize({
      host: HOST,
      scenarios: [failingScenario("a")],
      durationMs: 1,
    });
    const text = renderArtifactNotice({
      report: failing,
      keep: false,
      summaryPath: SUMMARY,
      verbose: false,
    });
    expect(text).toBe(`产物与报告：${SUMMARY}\n场景目录：/tmp/root/a`);
  });

  test("names summary and scenario roots when --keep retains a pass", () => {
    const passing = summarize({
      host: HOST,
      scenarios: [passingScenario("a")],
      durationMs: 1,
    });
    const text = renderArtifactNotice({
      report: passing,
      keep: true,
      summaryPath: SUMMARY,
      verbose: false,
    });
    expect(text).toBe(`产物与报告：${SUMMARY}\n场景目录：/tmp/root/a`);
  });

  test("leaves the roots to the expanded report under --verbose", () => {
    const passing = summarize({
      host: HOST,
      scenarios: [passingScenario("a")],
      durationMs: 1,
    });
    const text = renderArtifactNotice({
      report: passing,
      keep: true,
      summaryPath: SUMMARY,
      verbose: true,
    });
    expect(text).toBe(`产物与报告：${SUMMARY}`);
  });
});
