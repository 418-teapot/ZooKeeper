/**
 * Todo list tool adapter.
 *
 * Exposes the host-agnostic todo state machine (`src/core/todo/`) as a host
 * tool so the orchestrator can keep a multi-phase task ledger across a long
 * turn: `init` / `start` / `done` / `drop` / `rm` / `block` / `unblock` /
 * `append` / `view`, one operation plus a batch of entries per call.
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
 * The unit contributes the `todo` tool ONLY when the host supplies both a
 * todo state store (`todoStore`) and tool services (`toolHost`).  A host
 * without them (OpenCode) gets zero tools — the tool never registers there
 * (fail-closed, the subagent precedent).  The optional `todoRenderer` port is
 * attached the same way `subagentRenderer` is.
 *
 * Each execution:
 * 1. Validates the raw arguments (op vocabulary, per-op entry shape, field
 *    types, empty content) with loud Chinese guidance; a rejected call never
 *    touches the state.
 * 2. Resolves the session ID from the tool context through the host.
 * 3. Reads the session's state from the host-owned store (restoring from
 *    the transcript on a cache miss).
 * 4. Stamps the top-level `op` onto each entry and applies the batch — batch
 *    atomic: any error discards the whole batch, so nothing is stored and no
 *    snapshot is written when errors come back.
 * 5. On a clean mutating batch, stores the new state, writes the snapshot
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

/** Payload fields an entry may carry at all (any op, the op is top-level). */
const ENTRY_FIELDS: readonly string[] = [
  "list",
  "items",
  "phase",
  "task",
  "tasks",
  "reason",
];

/**
 * Payload fields each op accepts on its entries, mirroring the op table in
 * the tool description.
 *
 * The global `ENTRY_FIELDS` whitelist alone is not enough: a field that is
 * valid for some other op is silently ignored by the state machine here, and
 * for `rm`/`done`/`drop` an ignored target means "no target", which the core
 * reads as "every task" — one mistyped field would then wipe the whole list.
 * So every field outside an op's own set is rejected at the argument
 * boundary.  `view` carries no payload at all (it never reaches the entry
 * validator, but the row keeps the table total).
 */
const ALLOWED_FIELDS: Record<TodoOperation, readonly string[]> = {
  init: ["list", "items", "phase"],
  start: ["task"],
  done: ["task", "tasks", "phase"],
  drop: ["task", "tasks", "phase"],
  rm: ["task", "tasks", "phase"],
  block: ["task", "tasks", "phase", "reason"],
  unblock: ["task", "tasks", "phase"],
  append: ["phase", "items"],
  view: [],
};

/** Ops whose target-less entry is the destructive "every task" default. */
const DEFAULTING_TARGET_OPS: readonly TodoOperation[] = ["done", "drop", "rm"];

/** Ops that address existing work by task / tasks / phase. */
const TARGET_OPS: readonly TodoOperation[] = [
  "done",
  "drop",
  "rm",
  "block",
  "unblock",
];

/**
 * Corrective guidance for a field the op does not accept.
 *
 * The common confusion is handing a task-content list to a target op under
 * the wrong field name (`items`), so that branch points at `tasks`; for
 * `rm`/`done`/`drop` it also warns that the overlooked payload would have
 * silently narrowed the op to its "every task" default.
 */
function fieldGuidance(op: TodoOperation, field: string): string {
  if ((field === "items" || field === "list") && TARGET_OPS.includes(op)) {
    const parts = [
      `${op} 的目标字段是 task/tasks/phase；`,
      "若目标是清单里的这些任务，请改用 tasks 逐字列出它们的 content。",
    ];
    if (DEFAULTING_TARGET_OPS.includes(op)) {
      parts.push(
        `（不带目标的 ${op} 会作用于全部任务` +
          `${op === "rm" ? "——即清空整个清单" : ""}。）`,
      );
    }
    return parts.join("");
  }
  switch (op) {
    case "init":
      return "init 的载荷是 list（分阶段清单）或 items + 可选 phase（扁平清单）。";
    case "start":
      return "start 一次只能指定一个任务，字段是 task（该任务的完整 content）。";
    case "append":
      return "append 的载荷是 phase（目标阶段）+ items（该阶段的新任务清单）。";
    case "unblock":
      return "unblock 只需要目标（task/tasks/phase），阻塞原因是 block 的字段。";
    default:
      return `"${field}" 对 ${op} 没有语义，请去掉该字段后重试。`;
  }
}

// ---------------------------------------------------------------------------
// Description manual
// ---------------------------------------------------------------------------

/**
 * The tool's own operation manual, shown to the model as `description`.
 *
 * Distilled from the oh-my-pi `prompts/tools/todo.md` handbook (9-op table,
 * content-phrasing anatomy, the `<critical>` per-item commitment rule, and
 * the "never a solo turn" rule).
 */
const TODO_DESCRIPTION = `维护一份分阶段的 todo 清单，用于跟踪跨多步骤的工作。每次调用提交一个 op 和一批 entries，整批原子生效：任何一条出错则全部回滚、状态不变。

op:
- init     重建整个清单（替换现有全部内容）。entries: [{list: [{phase, items}]}] 或扁平 [{items, phase?}]
- start    开始任务（同一时间只允许一个）。entries: [{task}]
- done     完成任务。entries: [{task}] / [{tasks}] / [{phase}]，不带目标＝全部
- drop     放弃任务。entries 同 done，不带目标=全部
- rm       删除任务。entries 同 done，不带目标=全部
- block    阻塞任务，必须带 reason。entries: [{task|tasks|phase, reason}]
- unblock  解除阻塞，回到待办。entries: [{task|tasks|phase}]
- append   往某个 phase 追加新任务（phase 不存在则创建）。entries: [{phase, items}]
- view     只读查看当前任务清单，不需要 entries

任务写法：
- content 用 5-10 个词、动词开头的短语，写"做什么"而不是"怎么做"
- content 就是标识符：后续 op 必须逐字复用上一次结果里的 content 文本，绝不编造 ID（如 task-1）
- 同一清单内 content 不能重复，重复即不可寻址
- phase 名用短名词短语，不要加 "1." / "A)" / "Phase 1:" 这类前缀

规则：
- 任务一完成就立刻 done，不要攒着批量勾
- 忘了清单内容就 view 取回，绝不凭记忆猜
- block 只用于卡在无法自主推进的外部依赖（等用户确认、等外部系统）；能自己推进的就 append 一个解阻任务，而不是一直 block

<critical>
- 用户列出多步计划时，必须先逐条 init 该计划的每一步，**永不**合并成更少的任务、**永不**只挑"重要的几步"、**永不**凭记忆跟踪
- todo 调用**永不**独占一轮：同一轮必须继续做真正的工作（init 与首批读取/编辑一起发出）
</critical>`;

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which payload fields an op requires on every one of its entries.
 *
 * A group lists alternatives (the entry satisfies the op by carrying any one
 * of them).  Ops absent from the map need no mandatory field — `done` /
 * `drop` / `rm` take an optional target.
 */
const REQUIRED_FIELDS: Partial<
  Record<TodoOperation, ReadonlyArray<readonly string[]>>
> = {
  init: [["list", "items"]],
  start: [["task"]],
  block: [["task", "tasks", "phase"]],
  unblock: [["task", "tasks", "phase"]],
  append: [["phase"], ["items"]],
};

/** Reject with the Chinese guidance prefix, always naming `where`. */
function fail(where: string, message: string): never {
  const at = where === "" ? "" : `${where} `;
  throw new Error(`todo 工具参数格式错误：${at}${message}`);
}

/** Read a required string field, rejecting a missing / empty value. */
function stringField(
  entry: Record<string, unknown>,
  name: string,
  desc: string,
  where: string,
): string {
  const value = entry[name];
  if (typeof value !== "string") {
    fail(where, `的 ${name} 必须是字符串（${desc}）。`);
  }
  if (value.trim() === "") {
    fail(where, `的 ${name} 不能是空字符串（${desc}）——请填入实际内容后重试。`);
  }
  return value;
}

/** Read an optional string field. */
function optionalStringField(
  entry: Record<string, unknown>,
  name: string,
  desc: string,
  where: string,
): string | undefined {
  if (entry[name] === undefined) return undefined;
  return stringField(entry, name, desc, where);
}

/** Read a required array of non-empty strings. */
function stringArrayField(
  entry: Record<string, unknown>,
  name: string,
  desc: string,
  where: string,
): string[] {
  const value = entry[name];
  if (!Array.isArray(value)) {
    fail(where, `的 ${name} 必须是字符串数组（${desc}）。`);
  }
  if (value.length === 0) {
    fail(
      where,
      `的 ${name} 不能是空数组（${desc}）——请至少提供一个条目后重试。`,
    );
  }
  return value.map((item, i) => {
    if (typeof item !== "string" || item.trim() === "") {
      fail(where, `的 ${name}[${i + 1}] 必须是非空字符串（${desc}）。`);
    }
    return item;
  });
}

/** Read an optional array of non-empty strings. */
function optionalStringArrayField(
  entry: Record<string, unknown>,
  name: string,
  desc: string,
  where: string,
): string[] | undefined {
  if (entry[name] === undefined) return undefined;
  return stringArrayField(entry, name, desc, where);
}

/** Read the canonical `init` list: an array of `{ phase, items }`. */
function initListField(
  entry: Record<string, unknown>,
  where: string,
): TodoInitPhase[] {
  const value = entry.list;
  if (!Array.isArray(value)) {
    fail(where, "的 list 必须是数组（init 的 [{phase, items}] 列表）。");
  }
  if (value.length === 0) {
    fail(
      where,
      "的 list 不能是空数组——init 至少需要一个 phase，或改用 items 提交扁平清单。",
    );
  }
  return value.map((raw, i) => {
    const at = `${where}.list[${i + 1}]`;
    if (!isRecord(raw)) {
      fail(at, "必须是 { phase: string, items: string[] } 对象。");
    }
    return {
      phase: stringField(raw, "phase", "init 的 phase 名", at),
      items: stringArrayField(raw, "items", "init phase 的任务清单", at),
    };
  });
}

/** Validate one raw entry object into a `TodoEntry` payload for `op`. */
function validateEntry(
  raw: unknown,
  index: number,
  op: TodoOperation,
): Omit<TodoEntry, "op"> {
  const where = `entries[${index + 1}]`;
  if (!isRecord(raw)) {
    fail(where, `必须是 ${ENTRY_FIELDS.join("/")} 组成的对象。`);
  }
  const allowed = ALLOWED_FIELDS[op];
  for (const key of Object.keys(raw)) {
    if (!ENTRY_FIELDS.includes(key)) {
      fail(
        where,
        `含未知字段 "${key}"：${op} 的条目只接受 ${allowed.join("/")}。`,
      );
    }
    if (!allowed.includes(key)) {
      fail(
        where,
        `含 ${op} 不接受的字段 "${key}"：${op} 的条目只接受 ${allowed.join("/")}——` +
          fieldGuidance(op, key),
      );
    }
  }
  // Two payloads on one init entry cannot both take effect (the core reads
  // `list` first and would discard `items` silently), so the ambiguity is
  // refused rather than resolved by precedence.
  if (op === "init" && raw.list !== undefined && raw.items !== undefined) {
    fail(
      where,
      "init 的条目不能同时带 list 和 items：两者都是完整清单，只会生效一个——请任选其一后重试。",
    );
  }

  const entry: Omit<TodoEntry, "op"> = {};
  if (op === "init" && raw.list !== undefined) {
    entry.list = initListField(raw, where);
  }
  const items = optionalStringArrayField(
    raw,
    "items",
    `${op} 的任务内容清单`,
    where,
  );
  if (items !== undefined) entry.items = items;
  const phase = optionalStringField(raw, "phase", "phase 名", where);
  if (phase !== undefined) entry.phase = phase;
  const task = optionalStringField(
    raw,
    "task",
    "任务的完整 content 文本",
    where,
  );
  if (task !== undefined) entry.task = task;
  const tasks = optionalStringArrayField(
    raw,
    "tasks",
    "任务的 content 文本清单",
    where,
  );
  if (tasks !== undefined) entry.tasks = tasks;
  const reason = optionalStringField(raw, "reason", "阻塞原因", where);
  if (reason !== undefined) entry.reason = reason;

  const needs = REQUIRED_FIELDS[op] ?? [];
  const payload = entry as Record<string, unknown>;
  for (const group of needs) {
    const missing = group.every((field) => payload[field] === undefined);
    if (missing) {
      fail(
        where,
        `缺少必填字段：${op} 需要提供 ${group.join(" 或 ")} 后才能重试。`,
      );
    }
  }
  if (op === "init" && entry.list === undefined && entry.items === undefined) {
    fail(where, "缺少必填字段：init 需要提供 list 或 items 后才能重试。");
  }
  // `block` is the one op whose reason cannot be defaulted away: the state
  // machine rejects a reasonless block, so say so at the argument boundary.
  if (op === "block" && entry.reason === undefined) {
    fail(
      where,
      "缺少必填字段：block 需要提供 reason（无法自主推进的外部依赖是什么）后才能重试。",
    );
  }
  return entry;
}

/**
 * Validate raw tool arguments into an op plus its entry batch.
 *
 * @param args - The raw tool arguments.
 * @returns The operation and the entries with that op stamped on.
 * @throws A loud Chinese error for an unknown op, a missing/empty batch (or a
 *   batch handed to the read-only `view`), and any malformed entry field.
 */
export function validateTodoArgs(args: unknown): {
  op: TodoOperation;
  entries: TodoEntry[];
} {
  if (!isRecord(args)) {
    fail(
      "",
      "请提供 { op, entries } 两个参数的对象（op 为九个操作之一，entries 为载荷数组）后重试。",
    );
  }
  const rawOp = args.op;
  if (typeof rawOp !== "string" || !TODO_OPS.includes(rawOp as TodoOperation)) {
    fail(
      "op",
      `必须是 ${TODO_OPS.join("/")} 之一，收到 ${JSON.stringify(rawOp)}——请改正后重试。`,
    );
  }

  const op = rawOp as TodoOperation;
  const rawEntries = args.entries;

  if (op === "view") {
    if (rawEntries !== undefined && rawEntries !== null) {
      if (!Array.isArray(rawEntries) || rawEntries.length > 0) {
        fail("view", "是只读操作，不接受 entries——请去掉 entries 后重试。");
      }
    }
    return { op, entries: [{ op }] };
  }

  if (!Array.isArray(rawEntries)) {
    fail(
      "entries",
      `必须是数组（${op} 的载荷列表，每项由 ${ENTRY_FIELDS.join("/")} 组合而成）——请提供后重试。`,
    );
  }
  if (rawEntries.length === 0) {
    fail(
      "entries",
      `不能为空（${op} 至少需要一个条目）——请提供该操作的目标后重试。`,
    );
  }
  const entries = rawEntries.map(
    (raw, index) => ({ op, ...validateEntry(raw, index, op) }) as TodoEntry,
  );
  return { op, entries };
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
        description:
          "本次调用的操作：init/start/done/drop/rm/block/unblock/append/view。",
      },
      entries: {
        type: "array",
        description:
          "操作载荷数组，整批原子生效；view 不需要。每项按 op 取用下方字段。",
        items: {
          type: "object",
          description: "一条操作载荷。",
          properties: {
            list: {
              type: "array",
              description: "init 的分阶段清单：[{phase, items}]。",
            },
            items: {
              type: "array",
              description:
                "任务 content 清单（扁平 init 或 append 的新任务）。",
            },
            phase: {
              type: "string",
              description:
                "phase 名（扁平 init 的归属、append 的目标阶段、按阶段操作的目标）。",
            },
            task: {
              type: "string",
              description:
                "单个目标任务的完整 content 文本（逐字复用上一次结果）。",
            },
            tasks: {
              type: "array",
              description:
                "多个目标任务的 content 文本清单（done/drop/rm/block/unblock）。",
            },
            reason: {
              type: "string",
              description: "block 的阻塞原因（block 必填）。",
            },
          },
        },
      },
    },
    required: ["op"],
    // pi runs a turn's tool calls concurrently unless one of them is marked
    // sequential, and concurrent todo calls would lost-update the store
    // cache and write divergent snapshots — so every todo call runs alone
    // (the `ask` tool sets the same flag for the same reason).
    executionMode: "sequential",
    ...(renderer !== undefined
      ? { renderCall: renderer.renderCall, renderResult: renderer.renderResult }
      : {}),
    async execute(args, toolCtx, hostCtx) {
      const { op, entries } = validateTodoArgs(args);
      const sessionID = host.resolveSessionId(toolCtx);
      if (sessionID === undefined) {
        throw new Error("无法确定会话 ID：工具上下文缺少 sessionID。");
      }
      const state: TodoPhase[] = await store.get(sessionID);
      const result = applyEntries(state, entries);

      // Batch atomic: the core returned the input state untouched, so nothing
      // is stored and no snapshot is written — the transcript keeps pointing
      // at the last state that actually took effect.
      if (result.errors.length > 0) {
        log("todo-tool", "apply_failed", sessionID, undefined, "info", {
          op,
          errors: result.errors.length,
        });
        return formatSummary(state, result.errors);
      }

      // `view` is read-only by contract: the state is echoed back verbatim,
      // so there is no change to record and no detail to write.  Skipping the
      // write keeps the transcript's snapshot chain equal to the mutating
      // calls only (which is also what the restore scan walks back through).
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
