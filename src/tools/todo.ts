/**
 * Todo list tool adapter.
 *
 * Exposes the host-agnostic todo state machine (`src/core/todo/`) as a host
 * tool so the orchestrator can keep a multi-phase task ledger across a long
 * turn: `init` / `start` / `done` / `drop` / `rm` / `block` / `unblock` /
 * `append` / `view`.
 *
 * The arguments are flat: one call carries one `op` plus that op's payload
 * fields directly at the top level (`list` / `items` / `phase` / `task` /
 * `reason`), never a nested batch array.  A call therefore always describes
 * exactly one state transition, and a target-less `done` / `drop` / `rm`
 * (which the core reads as "every task") cannot be produced by accident —
 * every one of them requires an explicit target at this boundary.
 *
 * The transcript is the single source of truth.  Every successful mutating
 * call writes a fresh `{ op, phases }` snapshot into the host-forwarded
 * `hostCtx.details` slot (the pi bridge persists tool-result details into the
 * session record), so a restart, a branch, or a compaction restores exactly
 * the state that was in effect at that point — and nothing is ever written to
 * a file.  The in-memory store is only a cache; it is the host-owned
 * `Deps.todoStore` instance, fed through the store's own single restore
 * path.
 *
 * A call is one read-modify-write cycle over that cache, so the whole cycle
 * runs inside the store's gate (`store.serialize`): concurrent calls cannot
 * lose updates, and the tool asks nothing of the host's scheduler, leaving
 * unrelated calls in the same turn concurrent.
 *
 * The unit contributes the `todo` tool ONLY when the host supplies both a
 * todo state store (`todoStore`) and tool services (`toolHost`).  A host
 * without them (OpenCode) gets zero tools — the tool never registers there
 * (fail-closed, the subagent precedent).  The optional `todoRenderer` port is
 * attached the same way `subagentRenderer` is.
 *
 * Each execution:
 * 1. Parses the raw arguments (op vocabulary, per-op field whitelist, field
 *    types, empty content) with loud Chinese guidance; every rejection names
 *    the offending field and ends with a copy-ready example call, and a
 *    rejected call never touches the state.
 * 2. Resolves the session ID from the tool context through the host.
 * 3. Reads the session's state from the host-owned store (restoring from
 *    the transcript on a cache miss).
 * 4. Applies the parsed entry — the parser produces exactly one entry per
 *    call, so the whole state transition is a single atomic step.
 * 5. On a clean mutating call, stores the new state, writes the snapshot
 *    detail, and returns the model-facing summary.  `view` is read-only: it
 *    neither stores nor writes a detail, because nothing changed to record.
 *
 * @module
 */

import type { ToolHost } from "../core/client/tool-host.js";
import type {
  Deps,
  ToolContribution,
  ToolUnitDescriptor,
} from "../core/slots.js";
import { applyEntries } from "../core/todo/apply.js";
import { serializeSnapshot } from "../core/todo/serialize.js";
import type { TodoStateStore } from "../core/todo/store.js";
import { formatSummary } from "../core/todo/summary.js";
import type {
  TodoEntry,
  TodoInitPhase,
  TodoOperation,
  TodoPhase,
} from "../core/todo/types.js";
import { log } from "../utils/logger.js";

/** The nine operations accepted by the state machine. */
const TODO_OPS: readonly TodoOperation[] = [
  "init",
  "start",
  "done",
  "drop",
  "rm",
  "block",
  "unblock",
  "append",
  "view",
];

/** Payload fields the flat arguments may carry at all (`op` is separate). */
const ARG_FIELDS: readonly string[] = [
  "list",
  "items",
  "phase",
  "task",
  "reason",
];

/**
 * Payload fields each op accepts at the top level.
 *
 * The global `ARG_FIELDS` whitelist alone is not enough: a field that is
 * valid for some other op is silently ignored by the state machine, and an
 * ignored target means "no target", which the core reads as "every task" —
 * one mistyped field would then wipe the whole list.  So every field outside
 * an op's own set is rejected at the argument boundary.  `view` carries no
 * payload at all.
 */
const ALLOWED_FIELDS: Record<TodoOperation, readonly string[]> = {
  init: ["list", "items", "phase"],
  start: ["task"],
  done: ["task"],
  drop: ["task", "phase"],
  rm: ["task"],
  block: ["task", "phase", "reason"],
  unblock: ["task", "phase"],
  append: ["phase", "items"],
  view: [],
};

/** The whole vocabulary, spelled out for error messages. */
const OP_VOCABULARY = TODO_OPS.join("/");

/**
 * The smallest legal call for each op, used verbatim as the example tail of
 * every rejection and as the example section of the tool description — so
 * what the model is shown can never drift from what is accepted.
 */
const OP_EXAMPLE: Record<TodoOperation, string> = {
  init: '{"op":"init","list":[{"phase":"实现","items":["改 schema","补测试"]}]}',
  start: '{"op":"start","task":"改 schema"}',
  done: '{"op":"done","task":"改 schema"}',
  drop: '{"op":"drop","task":"改 schema"}',
  rm: '{"op":"rm","task":"改 schema"}',
  block: '{"op":"block","task":"改 schema","reason":"等用户确认方案"}',
  unblock: '{"op":"unblock","task":"改 schema"}',
  append: '{"op":"append","phase":"实现","items":["补文档"]}',
  view: '{"op":"view"}',
};

/** How an op's accepted fields are spelled out in an error message. */
function fieldsHint(op: TodoOperation): string {
  const allowed = ALLOWED_FIELDS[op];
  return allowed.length === 0
    ? `${op} 是只读操作，不带任何字段`
    : `${op} 只接受 ${allowed.join("/")}`;
}

/**
 * Corrective guidance for a field the op does not accept.
 *
 * `done`/`rm` only ever carry a single `task`, so a batch-shaped payload
 * (`items`/`list`) is pointed at repeated single-task calls rather than at a
 * field that would widen the blast radius.
 */
function fieldGuidance(op: TodoOperation, field: string): string {
  // A field outside the whole schema has no per-op reading of it; the generic
  // unknown-field error already names the fields the op accepts.
  if (!ARG_FIELDS.includes(field)) {
    return "";
  }
  if (op === "view") {
    return `"${field}" 对 view 没有语义，请去掉该字段后重试。`;
  }
  switch (op) {
    case "init":
      return "init 需要 list（分阶段清单）或 items（扁平清单，可配 phase），只带其一。";
    case "start":
      return "start 一次只指定一个任务，字段是 task（该任务的完整 content 原文）。";
    case "done":
    case "rm":
      return field === "items" || field === "list"
        ? `一次 ${op} 只处理一个任务：请拆成多条 ${op} 调用，每条只带一个 task。` +
            (op === "rm"
              ? "不带 task 的 rm 等于清空整个清单，因此在参数层就被拒绝。"
              : "")
        : `${op} 的字段是 task（清单里该任务的完整 content 原文）。`;
    case "drop":
      return field === "items" || field === "list"
        ? "drop 不接受批量字段：个别任务放弃用 task，整阶段放弃用 phase。"
        : "drop 的目标是 task（单个任务）或 phase（整阶段），二选一。";
    case "block":
      return "block 需要目标（task 或 phase，二选一）加 reason（阻塞原因）。";
    case "unblock":
      return "unblock 只需要目标（task 或 phase，二选一）；阻塞原因是 block 的字段。";
    case "append":
      return "append 需要 phase（目标阶段）和 items（新任务清单）。";
    default:
      return `"${field}" 对 ${op} 没有语义，请去掉该字段后重试。`;
  }
}
// ---------------------------------------------------------------------------
// Description manual
// ---------------------------------------------------------------------------

/** The nine-op table: fields and effect of every operation. */
const OP_TABLE = `每行列出该 op 要带的字段："或"表示只带其一，"可配"表示可选，表外字段一律不带。
- init     重建整个清单：list=[{phase, items}]，或 items（可配 phase）
- start    开始任务：task
- done     完成任务：task
- drop     放弃任务：task 或 phase
- rm       删除任务：task
- block    阻塞任务：task + reason 或 phase + reason
- unblock  解除阻塞（回到待办）：task 或 phase
- append   往 phase 追加新任务（phase 不存在则创建）：phase + items
- view     只读查看当前清单：不带字段`;

/** One copy-ready call per op, derived from the rejection examples. */
const EXAMPLE_BLOCK = TODO_OPS.map((op) => OP_EXAMPLE[op]).join("\n");

/**
 * The tool's own operation manual, shown to the model as `description`.
 *
 * Flat argument shape (one op per call), the auto-promote postcondition, the
 * 9-op table, the content-phrasing anatomy, the per-item commitment rules,
 * and a copy-ready example per op.
 */
const TODO_DESCRIPTION = `维护一份分阶段的 todo 清单，用于跟踪跨多步骤的工作。每次调用提交一个 op 和一个目标。

op:
${OP_TABLE}

任务写法：
- content 用 5-10 个词、动词开头的短语，写"做什么"而不是"怎么做"
- content 就是标识符：后续 op 必须逐字复用上一次结果里的 content 文本，绝不编造 ID（如 task-1）
- 同一清单内 content 不能重复，重复即不可寻址
- phase 名用短名词短语，不要加 "1." / "A)" / "Phase 1:" 这类前缀

规则：
- 任务一完成就立刻 done，不要攒着批量勾
- 忘了清单内容就 view 取回，绝不凭记忆猜
- block 只用于卡在无法自主推进的外部依赖（等用户确认、等外部系统）；能自己推进的就 append 一个解阻任务，而不是一直 block
- 用户列出多步计划时，必须先逐条 init 该计划的每一步，**永不**合并成更少的任务、**永不**只挑"重要的几步"、**永不**凭记忆跟踪
- todo 调用**永不**独占一轮：同一轮必须继续做真正的工作（init 与首批读取/编辑一起发出）

示例：
${EXAMPLE_BLOCK}`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reject with the Chinese guidance prefix.
 *
 * Every rejection ends with a copy-ready example call for the op in play: a
 * rule without an example has proven unable to steer a model that is already
 * failing, so the example is mandatory rather than best-effort.
 */
function fail(message: string, example: string): never {
  throw new Error(`todo 工具参数格式错误：${message}\n正确示例：${example}`);
}

/** Read a required string field, rejecting a missing / empty value. */
function stringField(
  source: Record<string, unknown>,
  name: string,
  desc: string,
  example: string,
): string {
  const value = source[name];
  if (typeof value !== "string") {
    fail(`${name} 必须是字符串（${desc}）。`, example);
  }
  if (value.trim() === "") {
    fail(`${name} 不能是空字符串（${desc}）——请填入实际内容后重试。`, example);
  }
  return value;
}

/** Read an optional string field. */
function optionalStringField(
  source: Record<string, unknown>,
  name: string,
  desc: string,
  example: string,
): string | undefined {
  if (source[name] === undefined) return undefined;
  return stringField(source, name, desc, example);
}

/** Read a required array of non-empty strings. */
function stringArrayField(
  source: Record<string, unknown>,
  name: string,
  desc: string,
  example: string,
): string[] {
  const value = source[name];
  if (!Array.isArray(value)) {
    fail(`${name} 必须是字符串数组（${desc}）。`, example);
  }
  if (value.length === 0) {
    fail(
      `${name} 不能是空数组（${desc}）——请至少提供一个条目后重试。`,
      example,
    );
  }
  return value.map((item, i) => {
    if (typeof item !== "string" || item.trim() === "") {
      fail(`${name}[${i + 1}] 必须是非空字符串（${desc}）。`, example);
    }
    return item;
  });
}

/**
 * Read the canonical `init` list: an array of `{ phase, items }`.
 *
 * Every rejection here is an `init` shape problem, so the example is always
 * the `init` one regardless of which caller reached it.
 */
function initListField(source: Record<string, unknown>): TodoInitPhase[] {
  const value = source.list;
  if (!Array.isArray(value)) {
    fail("list 必须是数组（init 的 [{phase, items}] 列表）。", OP_EXAMPLE.init);
  }
  if (value.length === 0) {
    fail(
      "list 不能是空数组——init 至少需要一个 phase，或改用 items 提交扁平清单。",
      OP_EXAMPLE.init,
    );
  }
  return value.map((raw, i) => {
    if (!isRecord(raw)) {
      fail(
        `list[${i + 1}] 必须是 { phase: string, items: string[] } 对象。`,
        OP_EXAMPLE.init,
      );
    }
    const at = `list[${i + 1}]`;
    return {
      phase: stringField(raw, "phase", "init 的 phase 名", OP_EXAMPLE.init),
      items: stringArrayField(
        raw,
        "items",
        `init phase 的任务清单（${at}）`,
        OP_EXAMPLE.init,
      ),
    };
  });
}

/**
 * Determine the operation.
 *
 * An explicit `op` wins and is never second-guessed.  When it is absent the
 * shape is inferred only while it stays unambiguous: a `list` or a bare
 * `items` means `init`, `items` together with `phase` means `append`.
 * Anything else is refused with the vocabulary spelled out.
 */
function resolveOp(args: Record<string, unknown>): TodoOperation {
  const raw = args.op;
  if (raw !== undefined) {
    if (typeof raw !== "string" || !TODO_OPS.includes(raw as TodoOperation)) {
      fail(
        `op 必须是 ${OP_VOCABULARY} 之一，收到 ${JSON.stringify(raw)}。`,
        OP_EXAMPLE.init,
      );
    }
    return raw as TodoOperation;
  }
  if (args.list !== undefined) return "init";
  if (args.items !== undefined) {
    return args.phase !== undefined ? "append" : "init";
  }
  fail(
    `缺少 op：必须是 ${OP_VOCABULARY} 之一（init 重建清单 / start 开始 /` +
      " done 完成 / drop 放弃 / rm 删除 / block 阻塞 / unblock 解阻 /" +
      " append 追加 / view 查看）。",
    OP_EXAMPLE.init,
  );
}

/** Reject any field outside the op's whitelist, naming the right fields. */
function rejectForeignFields(
  args: Record<string, unknown>,
  op: TodoOperation,
  example: string,
): void {
  const allowed = ALLOWED_FIELDS[op];
  for (const key of Object.keys(args)) {
    if (key === "op" || allowed.includes(key)) continue;
    if (!ARG_FIELDS.includes(key)) {
      fail(
        `含未知字段 "${key}"：${fieldsHint(op)}。${fieldGuidance(op, key)}`,
        example,
      );
    }
    fail(
      `含 ${op} 不接受的字段 "${key}"：${fieldsHint(op)}——` +
        fieldGuidance(op, key),
      example,
    );
  }
}

/** Read the exactly-one-of `task` / `phase` target shared by drop/block/unblock. */
function readTarget(
  args: Record<string, unknown>,
  op: TodoOperation,
  example: string,
): Pick<TodoEntry, "task" | "phase"> {
  const hasTask = args.task !== undefined;
  const hasPhase = args.phase !== undefined;
  if (hasTask && hasPhase) {
    fail(`${op} 的目标不能同时给 task 和 phase：请只保留其中一个。`, example);
  }
  if (!hasTask && !hasPhase) {
    fail(
      `${op} 缺少目标：需要 task（单个任务的完整 content）或 phase（整阶段）。`,
      example,
    );
  }
  if (hasTask) {
    return {
      task: stringField(args, "task", "任务的完整 content 原文", example),
    };
  }
  return { phase: stringField(args, "phase", "phase 名", example) };
}

/** Read the op's payload into a state-machine entry body. */
function readPayload(
  args: Record<string, unknown>,
  op: TodoOperation,
  example: string,
): Omit<TodoEntry, "op"> {
  switch (op) {
    case "init": {
      const hasList = args.list !== undefined;
      const hasItems = args.items !== undefined;
      // Two payloads cannot both take effect (the core reads `list` first and
      // would discard `items` silently), so the ambiguity is refused rather
      // than resolved by precedence.
      if (hasList && hasItems) {
        fail(
          "init 不能同时带 list 和 items：两者都是完整清单，只会生效一个——请任选其一后重试。",
          OP_EXAMPLE.init,
        );
      }
      if (!hasList && !hasItems) {
        fail(
          "init 缺少清单：需要 list（分阶段清单）或 items（扁平清单）。",
          OP_EXAMPLE.init,
        );
      }
      if (hasList) {
        // `phase` only pairs with the flat `items` payload; a phased `list`
        // carries its own phase names, so a top-level `phase` beside `list`
        // would have no effect — refuse rather than ignore it.
        if (args.phase !== undefined) {
          fail(
            "init 带 list 时不能带 phase：phase 只与 items（扁平清单）搭配使用，list 的每个 phase 各自带 phase 名。",
            OP_EXAMPLE.init,
          );
        }
        return { list: initListField(args) };
      }
      const phase = optionalStringField(
        args,
        "phase",
        "扁平 init 的 phase 名",
        OP_EXAMPLE.init,
      );
      return {
        items: stringArrayField(
          args,
          "items",
          "init 的任务清单",
          OP_EXAMPLE.init,
        ),
        ...(phase !== undefined ? { phase } : {}),
      };
    }
    case "append":
      return {
        phase: stringField(args, "phase", "append 的目标阶段", example),
        items: stringArrayField(args, "items", "append 的新任务清单", example),
      };
    case "start":
    case "done":
    case "rm":
      return {
        task: stringField(
          args,
          "task",
          "清单里该任务的完整 content 原文（逐字复用上一次结果）",
          example,
        ),
      };
    case "drop":
      return readTarget(args, op, example);
    case "block":
      return {
        ...readTarget(args, op, example),
        reason: stringField(
          args,
          "reason",
          "无法自主推进的外部依赖是什么",
          example,
        ),
      };
    case "unblock":
      return readTarget(args, op, example);
    default:
      return {};
  }
}

/**
 * Parse raw tool arguments into the entries to apply.
 *
 * @param args - The flat raw tool arguments (`{ op, ...payload }`).
 * @returns The entries to hand the state machine — always exactly one, since
 *   one call is one operation.
 * @throws A loud Chinese error (always with an example) for an unknown op, an
 *   unresolvable missing op, a field the op does not accept, or a missing or
 *   malformed payload.
 */
export function parseTodoArgs(args: unknown): TodoEntry[] {
  if (!isRecord(args)) {
    fail(
      `参数必须是扁平对象 { op, ${ARG_FIELDS.join(", ")} }，` +
        `op 为 ${OP_VOCABULARY} 之一。`,
      OP_EXAMPLE.init,
    );
  }
  const op = resolveOp(args);
  const example = OP_EXAMPLE[op];
  rejectForeignFields(args, op, example);
  return [{ op, ...readPayload(args, op, example) }];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the `todo` tool contribution over the host's tool services.
 *
 * @param host - Host tool services (session resolution).
 * @param store - The host-owned todo state store (this session's cache).
 * @param renderer - Optional host transcript-card renderer port.
 * @returns The todo tool contribution.
 */
export function createTodoTool(
  host: ToolHost,
  store: TodoStateStore,
  renderer?: {
    renderCall(args: unknown, theme: unknown, context?: unknown): unknown;
    renderResult(
      result: unknown,
      options: unknown,
      theme: unknown,
      context?: unknown,
    ): unknown;
  },
): ToolContribution {
  return {
    name: "todo",
    description: TODO_DESCRIPTION,
    args: {
      op: {
        type: "string",
        enum: [...TODO_OPS],
        description: `调用的操作：${OP_VOCABULARY}。`,
      },
      list: {
        type: "array",
        description: "分阶段的任务清单（init）",
        items: { type: "object" },
      },
      items: {
        type: "array",
        description: "单阶段初始化或新增的任务。",
        items: { type: "string" },
      },
      phase: {
        type: "string",
        description: "阶段名。",
      },
      task: {
        type: "string",
        description: "任务内容。",
      },
      reason: {
        type: "string",
        description: "阻塞原因（block）。",
      },
    },
    // Schema stays fully permissive: every field is optional so a
    // missing-`op` call reaches the runtime, where the shape inference
    // and the example-carrying errors live — a harness-level required
    // rejection would make that unreachable.
    required: [],
    ...(renderer !== undefined
      ? { renderCall: renderer.renderCall, renderResult: renderer.renderResult }
      : {}),
    async execute(args, toolCtx, hostCtx) {
      // Every todo call is a read-modify-write cycle over the store cache,
      // so the cycle runs through the store's own gate: one call at a time
      // per store, with no host-level restriction on what else may run in
      // the same turn.
      return store.serialize(async () => {
        if (hostCtx?.signal?.aborted) {
          throw new Error("todo 调用在排队期间已被中断。");
        }
        const entries = parseTodoArgs(args);
        const op = entries[0].op;
        const sessionID = host.resolveSessionId(toolCtx);
        if (sessionID === undefined) {
          throw new Error("无法确定会话 ID：工具上下文缺少 sessionID。");
        }
        const state: TodoPhase[] = await store.get(sessionID);
        const result = applyEntries(state, entries);

        // The core returned the input state untouched, so nothing is stored
        // and no snapshot is written — the transcript keeps pointing at the
        // last state that actually took effect.
        if (result.errors.length > 0) {
          log("todo-tool", "apply_failed", sessionID, undefined, "info", {
            op,
            errors: result.errors.length,
          });
          return formatSummary(state, result.errors);
        }

        // `view` is read-only by contract: the state is echoed back
        // verbatim, so there is no change to record and no detail to write.
        // Skipping the write keeps the transcript's snapshot chain equal to
        // the mutating calls only (which is also what the restore scan walks
        // back through).
        if (op === "view") {
          log("todo-tool", "view", sessionID, undefined, "info", {
            tasks: result.phases.reduce((n, p) => n + p.tasks.length, 0),
          });
          return formatSummary(result.phases, [], true);
        }

        store.set(sessionID, result.phases);
        if (hostCtx !== undefined) {
          hostCtx.details = serializeSnapshot(op, result.phases);
        }
        log("todo-tool", "applied", sessionID, undefined, "info", { op });
        return formatSummary(result.phases, []);
      });
    },
  };
}

/**
 * Todo tool unit descriptor.
 *
 * `name` doubles as the registry key and the tool key.  The unit is
 * fail-closed: without the host's todo state store or tool services it
 * contributes no tools, so the `todo` tool never registers on a host that
 * cannot restore todo state from its transcript.
 */
export const unit: ToolUnitDescriptor = {
  name: "todo",
  kind: "tool",
  create(deps: Deps) {
    const host = deps.toolHost;
    const store = deps.todoStore;
    if (host === undefined || store === undefined) {
      return { kind: "tool", tools: [] };
    }
    return {
      kind: "tool",
      tools: [createTodoTool(host, store, deps.todoRenderer)],
    };
  },
};
