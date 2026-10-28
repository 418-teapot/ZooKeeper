/**
 * Minimal JSONL RPC client for `pi --mode rpc`.
 *
 * Framing follows the protocol contract: records split on LF only (never on
 * Unicode line separators), commands correlate by id, and session events are
 * kept in arrival order so a waiter can match a future or an already
 * recorded event.  Timeouts and unexpected exits surface as
 * {@link HarnessError} codes instead of hanging the suite.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HarnessError } from "./errors.js";

/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Grace period for the process to disappear after a kill. */
const KILL_GRACE_MS = 5_000;

/** One protocol record (command response or session event). */
export interface RpcRecord {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: any;
  [key: string]: any;
}

/** How a child process ended. */
export interface RpcExit {
  code: number | string | null;
  signal: NodeJS.Signals | null;
}

/** One pending request. */
interface PendingRequest {
  resolve(record: RpcRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

/** One pending record wait. */
interface RecordWaiter {
  predicate(record: RpcRecord): boolean;
  from: number;
  label: string;
  resolve(record: RpcRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Client construction options. */
export interface RpcClientOptions {
  /** Log name of this process (`startup-todo`, ...). */
  label: string;
  /** Executable to spawn (the PATH-resolved pi, or a stub in tests). */
  binary: string;
  /** Executable arguments. */
  args?: string[];
  /** Working directory of the child. */
  cwd: string;
  /** Full child environment. */
  env: Record<string, string>;
  /** JSONL file receiving every stdout record. */
  recordsPath: string;
  /** File receiving stderr diagnostics. */
  stderrPath: string;
  /** Default request/wait timeout. */
  defaultTimeoutMs?: number;
}

/**
 * Split buffered stdout into complete LF-terminated records.
 *
 * @param buffer - Bytes not yet consumed.
 * @param chunk - Newly received text.
 * @returns Complete lines (blank lines dropped) and the remaining buffer.
 */
export function splitRecords(
  buffer: string,
  chunk: string,
): { records: string[]; rest: string } {
  const combined = buffer + chunk;
  const records: string[] = [];
  let index = combined.indexOf("\n");
  let start = 0;
  while (index >= 0) {
    const line = combined.slice(start, index).replace(/\r$/, "");
    if (line.trim() !== "") records.push(line);
    start = index + 1;
    index = combined.indexOf("\n", start);
  }
  return { records, rest: combined.slice(start) };
}

/**
 * One pi RPC process.
 */
export class RpcClient {
  readonly label: string;
  readonly records: RpcRecord[] = [];
  private readonly options: RpcClientOptions;
  private readonly defaultTimeoutMs: number;
  private child: ChildProcess | undefined;
  private waiters: RecordWaiter[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private nextId = 0;
  private exited: RpcExit | null = null;
  private exitPromise: Promise<RpcExit> | undefined;
  private closeResult: RpcExit | undefined;

  /**
   * @param options - Client options.
   */
  constructor(options: RpcClientOptions) {
    this.options = options;
    this.label = options.label;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    mkdirSync(dirname(options.recordsPath), { recursive: true });
    mkdirSync(dirname(options.stderrPath), { recursive: true });
    writeFileSync(options.recordsPath, "");
    writeFileSync(options.stderrPath, "");
  }

  /** Process id of the child, once started. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn the child and start consuming its output. */
  start(): this {
    const { binary, args = [], cwd, env, stderrPath } = this.options;
    let child: ChildProcess;
    try {
      child = spawn(binary, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new HarnessError(
        "rpc.spawn_failed",
        `无法启动 ${this.label} 进程：${binary}`,
        String(error),
      );
    }
    this.child = child;
    this.exitPromise = new Promise<RpcExit>((resolve) => {
      child.on("exit", (code, signal) => {
        this.exited = { code, signal };
        this.#rejectAll(
          new HarnessError(
            "rpc.exited",
            `${this.label} 进程在请求完成前退出`,
            `code=${code} signal=${signal}`,
          ),
        );
        resolve(this.exited);
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendFileSync(stderrPath, chunk);
    });
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stdin?.on("error", (error: Error) => {
      this.#rejectAll(
        new HarnessError(
          "rpc.exited",
          `${this.label} 的 stdin 不可写`,
          String(error),
        ),
      );
    });
    child.on("error", (error: Error) => {
      this.#rejectAll(
        new HarnessError(
          "rpc.spawn_failed",
          `${this.label} 进程启动失败`,
          String(error),
        ),
      );
    });
    return this;
  }

  /** Feed stdout bytes, writing every complete record to the log. */
  #onData(chunk: Buffer): void {
    const split = splitRecords(this.buffer, chunk.toString("utf8"));
    this.buffer = split.rest;
    for (const line of split.records) this.#onRecord(line);
  }

  /** Handle one protocol record. */
  #onRecord(line: string): void {
    let record: RpcRecord;
    try {
      record = JSON.parse(line) as RpcRecord;
    } catch {
      record = { type: "unparsed", raw: line };
    }
    this.records.push(record);
    appendFileSync(this.options.recordsPath, `${line}\n`);
    if (
      record.type === "response" &&
      typeof record.id === "string" &&
      this.pending.has(record.id)
    ) {
      const waiter = this.pending.get(record.id) as PendingRequest;
      this.pending.delete(record.id);
      clearTimeout(waiter.timer);
      waiter.resolve(record);
    }
    for (const waiter of [...this.waiters]) {
      const hit = this.records.slice(waiter.from).find(waiter.predicate);
      if (hit === undefined) continue;
      clearTimeout(waiter.timer);
      this.waiters = this.waiters.filter((entry) => entry !== waiter);
      waiter.resolve(hit);
    }
  }

  /** Reject every outstanding request and wait. */
  #rejectAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters = [];
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Send one command and await its correlated response.
   *
   * @param command - Command payload without `id`.
   * @param timeoutMs - Response deadline.
   * @returns The response record.
   */
  send(
    command: Record<string, unknown>,
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<RpcRecord> {
    const child = this.child;
    const type = String(command.type ?? "command");
    if (child === undefined) {
      return Promise.reject(
        new HarnessError("rpc.exited", `${this.label} 尚未启动`),
      );
    }
    if (this.exited !== null) {
      return Promise.reject(
        new HarnessError(
          "rpc.exited",
          `${this.label} 已退出，无法发送 ${type}`,
          `code=${this.exited.code} signal=${this.exited.signal}`,
        ),
      );
    }
    this.nextId += 1;
    const id = `req-${this.nextId}`;
    return new Promise<RpcRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HarnessError(
            "rpc.timeout",
            `等待 ${type} 响应超时（${timeoutMs}ms）`,
            `${this.label} ${id}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, label: type });
      try {
        child.stdin?.write(`${JSON.stringify({ id, ...command })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new HarnessError(
            "rpc.exited",
            `${this.label} 的 stdin 写入失败`,
            String(error),
          ),
        );
      }
    });
  }

  /**
   * Wait for a record matching `predicate`.
   *
   * @param predicate - Match test.
   * @param options - Optional timeout, label and start index.
   * @returns The first matching record.
   */
  waitFor(
    predicate: (record: RpcRecord) => boolean,
    options: { label?: string; timeoutMs?: number; fromIndex?: number } = {},
  ): Promise<RpcRecord> {
    const label = options.label ?? "record";
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const from = options.fromIndex ?? 0;
    const existing = this.records.slice(from).find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<RpcRecord>((resolve, reject) => {
      const waiter: RecordWaiter = {
        predicate,
        from,
        label,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(
            new HarnessError(
              "rpc.timeout",
              `等待 ${label} 超时（${timeoutMs}ms）`,
              this.label,
            ),
          );
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Records received at or after an index.
   *
   * @param fromIndex - Start index (see {@link mark}).
   * @returns The record slice.
   */
  since(fromIndex: number): RpcRecord[] {
    return this.records.slice(fromIndex);
  }

  /** Index to pass as `fromIndex` for a step that starts now. */
  mark(): number {
    return this.records.length;
  }

  /**
   * Close stdin (orderly shutdown) and wait for the exit.
   *
   * A process that ignores EOF past `timeoutMs` is killed, and the returned
   * exit keeps `code: "timeout"` so the scenario can fail with evidence.
   *
   * @param options - Shutdown deadline.
   * @returns How the process ended.
   */
  async close(options: { timeoutMs?: number } = {}): Promise<RpcExit> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (this.closeResult !== undefined) return this.closeResult;
    const child = this.child;
    if (child === undefined || this.exitPromise === undefined) {
      this.closeResult = { code: null, signal: null };
      return this.closeResult;
    }
    if (child.stdin?.writable === true) child.stdin.end();
    const first = (await this.#raceExit(timeoutMs)) ?? {
      code: "timeout",
      signal: null,
    };
    if (first.code === "timeout") {
      child.kill("SIGKILL");
      await this.#raceExit(KILL_GRACE_MS);
    }
    this.closeResult = first;
    return first;
  }

  /**
   * Wait for the exit, but only until the deadline.
   *
   * The timer is cleared when the exit wins, so a closed scenario cannot
   * keep the suite process alive until the deadline expires.
   *
   * @param timeoutMs - Maximum wait.
   * @returns The exit, or `null` on timeout.
   */
  async #raceExit(timeoutMs: number): Promise<RpcExit | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([
      this.exitPromise as Promise<RpcExit>,
      deadline,
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return result;
  }
}
