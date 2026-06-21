# 核心逻辑框架无关化：规划与讨论

**版本:** 1.0
**日期:** 2026-06-21
**分类:** 设计规划

---

## 目录

1. [动机](#1-动机)
2. [现状分析](#2-现状分析)
   - 2.1 [架构分层现状](#21-架构分层现状)
   - 2.2 [已纯的函数](#22-已纯的函数)
   - 2.3 [唯一的框架耦合点](#23-唯一的框架耦合点)
3. [重构目标](#3-重构目标)
4. [建议的重构方案](#4-建议的重构方案)
   - 4.1 [目录结构变化](#41-目录结构变化)
   - 4.2 [各模块归属](#42-各模块归属)
   - 4.3 [src/index.ts 变化](#43-srcindexts-变化)
5. [长期收益](#5-长期收益)
   - 5.1 [对 Pi 适配的铺垫](#51-对-pi-适配的铺垫)
   - 5.2 [对 OMO 对齐的铺垫](#52-对-omo-对齐的铺垫)
6. [参考资料](#6-参考资料)

---

## 1. 动机

ZooKeeper 长期目标是向 OMO 看齐（参见 `docs/hook-system-comparison.md`）。OMO 的 59 个 Hook 覆盖了 OpenCode 的全部可扩展点，但如果 ZooKeeper 的核心逻辑与 OpenCode 插件类型深度耦合，未来每增加一个挂载点、每迁移到一个新平台（如 oh-my-pi），都需要重写业务逻辑。

**原则：把"做什么"和"怎么挂"分开。**

- **"做什么"** — 权限校验、prompt 格式验证、阈值检查、错误恢复、nudge 注入。这些是框架无关的纯逻辑。
- **"怎么挂"** — 注册到 OpenCode 的哪个 hook point、解包 `input`/`output` 对象、调用 OpenCode 的 `client` API。这些是薄接线层。

即使不做 pi 兼容，分离也有直接好处：单元测试不需要 mock OpenCode 框架、Hook 模块可以独立迭代、新同事只看 `src/core/` 就理解 ZooKeeper 做了什么。

---

## 2. 现状分析

### 2.1 架构分层现状

```
src/index.ts          ← 薄接线层（236 行）
  │                     注释已声明 "thin wiring layer"
  │                     第 16 行已有 TODO: Add pi / oh-my-pi adapter
  │
  ├── loadPrompt()        ← 纯函数：读取 .md 文件
  ├── config hook         ← 接线：注入 prompt 到 OpenCode agent 对象
  ├── tool.definition     ← 接线：改写 task 工具描述
  ├── tool.execute.before ← 接线：调用 validateBeforeExec
  └── tool.execute.after  ← 接线：调用多个 nudge 函数

src/hooks/
  ├── task-prompt/hook.ts    ← 包含纯函数 validateTaskPrompt
  ├── json-error-nudge/      ← recoverJsonError 已是纯函数
  ├── context-metrics/       ← measureContext 已是纯函数
  ├── direct-work-nudge/     ← nudgeDirectWork，仅依赖抽象的 Clientish 接口
  ├── post-task-nudge/       ← nudgePostTask，仅依赖内联客户端接口
  └── utils/
       ├── prompts.ts        ← 纯字符串常量
       ├── agent.ts          ← Clientish 接口（1 方法，已抽象）
       ├── todo-state.ts     ← TinyClient 接口（已抽象）
       └── logger.ts         ← 纯 Node.js fs 操作
```

**关键发现：没有任何一个 TypeScript 文件从 `@opencode-ai/plugin` 导入类型。** 代码库使用松散类型（`any` 或自定内联接口）来处理框架对象。这意味着不是类型泄漏问题，而是**组织问题**——纯函数和接线代码混在同一文件中。

### 2.2 已纯的函数

以下函数零框架依赖，可直接提取到独立模块：

| 函数 | 所在文件 | 签名 |
|------|---------|------|
| `validateTaskPrompt` | `src/hooks/task-prompt/hook.ts` | `(prompt: string, limits?) → { valid, errors, warnings, ctx_words, total_words }` |
| `extractSections` | 同上 | `(prompt: string) → Record<string, string>` |
| `wordCount` | 同上 | `(text: string) → number` |
| `buildContextNudges` | 同上 | `(context: string) → string[]` |
| `recoverJsonError` | `src/hooks/json-error-nudge/hook.ts` | `(input: {tool, sessionID?, callID?}, output: {output?}) → void` |
| `measureContext` | `src/hooks/context-metrics/hook.ts` | `(output: ContextMetricsOutput) → ContextMetricsResult` |
| `estimateMessageHeuristic` | 同上 | `(msg: ContextMessageEntry) → number` |
| `getTodoState` | `src/hooks/utils/todo-state.ts` | `(client: TinyClient, sessionID: string) → Promise<TodoState>` |
| `getAgentName` | `src/hooks/utils/agent.ts` | `(client: Clientish, sessionID: string) → Promise<string>` |
| `isBuildAgent` | 同上 | `(client: Clientish, sessionID: string) → Promise<boolean>` |

**常量（零依赖）：**
- `TASK_PROMPT_HINT` — task 工具描述模板
- `JSON_ERROR_PATTERNS` — JSON 错误正则数组
- `JSON_ERROR_REMINDER` — 错误恢复提示文本
- `DIRECT_WORK_NUDGE` — 直接编辑提醒文本
- `SEARCH_DELEGATE_NUDGE` — 搜索委托提醒文本
- `VERIFY_REMINDER` — 验证提醒文本
- `TODO_GENERAL` / `TODO_FINAL_ACTIVE` — todo 引导文本

### 2.3 唯一的框架耦合点

`src/index.ts` 中的 5 个 hook 注册回调：

```typescript
// 这些是纯接线——解包 OpenCode 框架传来的 (input, output)，
// 调用纯函数，没有业务逻辑
config: async (opencodeConfig) => { ... }     // 直接变异 config.agent
"tool.definition": async (input, output) => { ... }  // 改写 task 描述
"tool.execute.before": async (input, output) => { ... } // 调 validateBeforeExec
"tool.execute.after": async (input, output) => { ... }  // 调 nudge 函数
"experimental.chat.messages.transform": async (...) => { ... } // 调 context metrics
```

`validateBeforeExec`、`nudgeTaskOutput`、`enhanceTaskDefinition` 等包装函数也在此文件中，它们本身不含业务逻辑——只是从 OpenCode 的 `input`/`output` 对象中解包参数，传给纯函数。

---

## 3. 重构目标

1. **`src/core/` 目录** — 全部零框架依赖。任何 TypeScript 运行时都可以 `import` 使用，不管底层是 OpenCode、pi 还是别的什么。
2. **`src/index.ts` 缩至 ~80 行** — 只剩 5 个 hook 注册 + `loadPrompt`，不含任何业务逻辑。
3. **`src/hooks/` 变为薄适配层** — 每个文件只做一件事：解包框架的 `(input, output)` → 调 `src/core/` → 写回 `output`。
4. **单元测试直接测 `src/core/`** — 不需要 mock OpenCode 框架，不需要构造 `PluginInput`。

---

## 4. 建议的重构方案

### 4.1 目录结构变化

```
重构前                              重构后
──                                 ──
src/                               src/
├── index.ts  (236 行)             ├── index.ts  (~80 行)     ← 只剩接线
├── hooks/                         │
│   ├── task-prompt/               ├── core/                  ← 新增：框架无关纯逻辑
│   │   └── hook.ts                │   ├── validate.ts        ← validateTaskPrompt + 子函数
│   ├── json-error-nudge/          │   ├── nudge.ts           ← recoverJsonError + 回调函数
│   │   └── hook.ts                │   ├── metrics.ts         ← measureContext
│   ├── context-metrics/           │   ├── prompts.ts         ← 所有常量
│   │   └── hook.ts                │   ├── agent.ts           ← Clientish + getAgentName
│   ├── direct-work-nudge/         │   └── todo.ts            ← TinyClient + getTodoState
│   │   └── hook.ts                │
│   ├── post-task-nudge/           ├── hooks/                 ← 薄适配层
│   │   └── hook.ts                │   ├── task-prompt.ts     ← 解包 → 调 core/validate.ts
│   └── utils/                     │   ├── json-error.ts      ← 解包 → 调 core/nudge.ts
│       ├── agent.ts               │   ├── context-metrics.ts
│       ├── prompts.ts             │   ├── direct-work.ts
│       ├── todo-state.ts          │   └── post-task.ts
│       └── logger.ts              │
│                                  └── utils/
│                                      └── logger.ts
```

### 4.2 各模块归属

| 当前文件 | 纯逻辑 → 目标 | 适配代码 → 目标 |
|---------|-------------|---------------|
| `hooks/task-prompt/hook.ts` | `validateTaskPrompt`、`extractSections`、`wordCount`、`buildContextNudges`、`TASK_PROMPT_HINT`、`ValidationLimits` → `core/validate.ts` | `validateBeforeExec`、`nudgeTaskOutput`、`enhanceTaskDefinition` → `hooks/task-prompt.ts` |
| `hooks/json-error-nudge/hook.ts` | `recoverJsonError`、`JSON_ERROR_PATTERNS`、`JSON_ERROR_REMINDER` → `core/nudge.ts` | 适配代码 → `hooks/json-error.ts` |
| `hooks/context-metrics/hook.ts` | `measureContext`、`estimateMessageHeuristic`、7 个上下文指标接口 → `core/metrics.ts` | 适配代码 → `hooks/context-metrics.ts` |
| `hooks/direct-work-nudge/hook.ts` | `DIRECT_WORK_NUDGE`、`SEARCH_DELEGATE_NUDGE` → `core/prompts.ts` | `nudgeDirectWork` → `hooks/direct-work.ts` |
| `hooks/post-task-nudge/hook.ts` | `VERIFY_REMINDER` → `core/prompts.ts` | `nudgePostTask` → `hooks/post-task.ts` |
| `utils/agent.ts` | `Clientish`、`getAgentName`、`isBuildAgent` → `core/agent.ts` | 保持不变 |
| `utils/todo-state.ts` | `TinyClient`、`getTodoState` → `core/todo.ts` | 保持不变 |
| `utils/prompts.ts` | `TODO_GENERAL`、`TODO_FINAL_ACTIVE` → `core/prompts.ts` | 保持不变 |
| `utils/logger.ts` | 全部 → `utils/logger.ts` | 已是纯 Node.js，位置不变 |

### 4.3 `src/index.ts` 变化

**重构前**（236 行）：混杂了 `loadPrompt`、hook 注册、`validateBeforeExec` 包装函数、`nudgeTaskOutput` 包装函数、`enhanceTaskDefinition` 包装函数。

**重构后**（~80 行）：

```typescript
// 只做三件事：
// 1. 加载 prompt 文件
// 2. 读取 config.toml 阈值
// 3. 注册 5 个 hook，每个内部只解包 + 调 core 函数

export async function zookeeper(input: any) {
  const limits = { ... };

  return {
    config: async (opencodeConfig: any) => {
      // 遍历 agent，注入 prompt
      for (const [name, agent] of Object.entries(opencodeConfig.agent ?? {})) {
        const prompt = loadPrompt(name);
        if (prompt) (agent as any).prompt = prompt;
      }
    },

    "tool.definition": async (input: any, output: any) => {
      if (input.toolID !== "task") return;
      output.description = injectHint(output.description);
    },

    "tool.execute.before": async (input: any, output: any) => {
      if (input.tool !== "task") return;
      const result = validateTaskPrompt(output.args?.prompt ?? "", limits);
      if (!result.valid) throw new Error(result.errors.join("; "));
    },

    "tool.execute.after": async (input: any, output: any) => {
      recoverJsonError(input, output);
      await nudgePostTask(client, input, output);
      await nudgeDirectWork(client, input, output);
    },

    "experimental.chat.messages.transform": async (_: any, output: any) => {
      const metrics = measureContext(output);
      attachMetrics(output, metrics);
    },
  };
}
```

---

## 5. 长期收益

### 5.1 对 Pi 适配的铺垫

ZooKeeper 长期路线（参见 `docs/hook-system-comparison.md` §8.1）以 OMO 为终局目标，但 pi 框架的扩展 API 也是潜在宿主。`src/core/` 全部框架无关后：

```
src/
├── core/          ← 框架无关纯逻辑（不变）
├── adapters/
│   ├── opencode.ts  ← 当前实现：OpenCode hook → core 函数
│   └── pi.ts        ← 未来实现：pi.on("tool_call") → core 函数
└── index.ts       ← 入口，根据环境选适配器
```

Pi 的 `tool_call` 事件可以直接调 `validateTaskPrompt`——因为函数签名里没有 OpenCode 的任何类型。Pi 的 `tool_result` 事件可以直接调 `recoverJsonError`——同上。

### 5.2 对 OMO 对齐的铺垫

当 ZooKeeper 从 4 个 Hook 模块扩展到 25-40 个（参见 §8.9 分阶段目标），`src/core/` 的分组结构天然支持 OMO 式的工厂注册模式：

```typescript
// 短期（SLIM 式）：直接 import 纯函数
import { validateTaskPrompt } from "../core/validate";

// 中期（过渡）：包装 isEnabled 开关
const guard = safeCreateHook("task-prompt-validate", () => validateTaskPrompt, {
  isEnabled: (config) => config.guards.taskPrompt !== false,
});

// 长期（OMO 式）：工厂函数分组
const guardHooks = createGuardHooks(core, config);
const injectionHooks = createInjectionHooks(core, config);
const recoveryHooks = createRecoveryHooks(core, config);
```

每一步都不会改 `src/core/` 里的纯函数——只改外面的接线方式。

---

## 6. 参考资料

- `docs/hook-system-comparison.md` — OMO / SLIM / OMP Hook 体系横向对比与 ZooKeeper 分阶段路线图
- `docs/opencode-plugin-mechanism.md` — OpenCode 插件机制与 OMO 参考实现
- `docs/task-prompt-validation-evolution.md` — task prompt 验证机制从阻断到引导的演进
