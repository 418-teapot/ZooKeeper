# 编排框架横向对比：技术路线分析

> 调研范围：oh-my-openagent、oh-my-opencode-slim、oh-my-pi (omp)、opencode-dynamic-context-pruning、superpowers、skills  
> 对比对象：ZooKeeper（OpenCode 编排器插件）  
> 日期：2026-06-09

## 一、调研对象定位

```
                          高（编排复杂度）
                            │
          oh-my-openagent ● │ ● oh-my-pi (omp)
          (313k LOC, 11代理, │  (27k LOC Rust, 完整编码代理)
           55 hooks, Team Mode)│
                            │
    运行时动态 ◄────────────┼────────────► 静态声明式
                            │
        oh-my-opencode-slim● │ ● ZooKeeper
        (插件+预设+回退链)    │  (config.toml+prompt注入)
                            │
                            │ ● opencode-dynamic-context-pruning
                            │   (上下文裁剪, 可组合插件)
                            │
                         低（编排复杂度）
                            │
                            │ ● superpowers / skills
                            │   (纯方法论, 零代码, 行为塑形)
```

| 框架 | 一句话定位 | 语言 | 与 OpenCode 关系 |
|------|-----------|------|-----------------|
| **oh-my-openagent** | OpenCode 上的完整多 agent 编排框架 | TypeScript (Bun) | 插件，深度集成 |
| **oh-my-opencode-slim** | OpenCode 上的轻量 agent 编排层 | TypeScript (Bun) | 插件，中等集成 |
| **oh-my-pi (omp)** | 独立的全栈编码代理 | TypeScript + Rust | 独立产品，不依赖 OpenCode |
| **DCP** | OpenCode 的动态上下文裁剪插件 | TypeScript | 可组合插件 |
| **superpowers** | 跨平台 agent 方法论框架 | 纯 Markdown + 轻量适配 | 多平台，含 OpenCode 适配 |
| **skills** | 可复用 skill 文件库 | 纯 Markdown | 通过 Claude Code 插件 |

oh-my-pi 是独立编码代理（类 Cursor/Claude Code），有自己的 agent loop、工具系统、TUI。其余五个都是 OpenCode 的插件或扩展。ZooKeeper 与 oh-my-opencode-slim、oh-my-openagent 定位最接近。

---

## 二、权限控制：三种哲学

### 2.1 方案对比

| 维度 | A. 代码内嵌 (oh-my-openagent) | B. 声明式配置 (ZooKeeper / oh-my-opencode-slim) | C. 运行时协商 (oh-my-pi) |
|---|---|---|---|
| 核心思路 | 权限写死在 TypeScript 常量 | 权限写在配置文件中，编译/加载后生效 | 工具自声明危险等级，运行时按审批模式决策 |
| 谁能改权限 | 只有改代码的开发者 | 改配置文件的用户 | 用户选审批模式 |
| 检查时机 | session 创建时注入 `tools` 参数 | OpenCode 加载时从工具列表移除 | 工具 `execute()` 调用时通过 Proxy 拦截 |
| 子 agent 继承 | 父 session 通过 Map store 传递更严格限制 | 各 agent 配置独立 | 持久化决策缓存跨 session 复用 |
| 意图感知 | ❌ 不区分操作类型 | ❌ 不区分操作类型 | ✅ 检查参数区分破坏性操作 |
| 安全上限 | 最高——代码即真相 | 中——用户可配错 | 最低——yolo 模式基本无限制 |
| 灵活上限 | 最低——加功能需改代码 | 中——改配置即可 | 最高——运行时动态决策 |

### 2.2 oh-my-openagent 的实现

权限硬编码在 `src/shared/agent-tool-restrictions.ts` 的 `AGENT_RESTRICTIONS` 常量中：

```ts
const AGENT_RESTRICTIONS: Record<string, Record<string, boolean>> = {
  explore: { write: false, edit: false, task: false },
  oracle:  { write: false, edit: false, task: false },
  "multimodal-looker": { read: true },  // allowlist 模式
};
```

子 agent session 创建时通过 `buildSyncPromptTools()` 合并到 `session.prompt` 的 `tools` 参数。额外全局注入 `TEAM_TOOL_DENYLIST`，所有 agent 都禁止团队工具。

**特点**：权限完全由源码控制，不会被用户误配置绕过。但添加新 agent 必须修改 TypeScript 源码。

### 2.3 oh-my-opencode-slim 的实现

每个 agent 在工厂函数中显式声明 permission，使用 OpenCode 原生的 `"allow"|"deny"|"ask"` 格式：

```ts
// councillor agent
permission: {
  '*': 'deny',          // 通配符：默认禁止一切
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
}
```

权限来自三层：
1. **工具权限**——agent 工厂中硬编码
2. **Skill 权限**——动态生成，orchestrator 获得 `"*": "allow"`，其他 agent 仅 allow 特定 skill
3. **MCP 权限**——`config` hook 中自动生成，遍历 agent 的 MCP 列表生成 `<server>_*` 的 allow/deny 规则

**特点**：支持 `*` 通配符作为 fallback，运行时通过 `messages.transform` hook 过滤 skill 展示。

### 2.4 oh-my-pi 的审批分级

工具自声明危险等级（`ToolTier: "read" | "write" | "exec"`），用户选择审批模式：

| 审批模式 | 自动允许的等级 |
|---------|--------------|
| `always-ask` | 仅 read |
| `write` | read + write |
| `yolo` | 全部（仍可被 user policy 拦截） |

ACP 协议模式下，对 `bash`、`edit`、`delete`、`move` 四个工具做 Proxy 拦截，向 IDE 发权限请求，用户可选 `allow_once / allow_always / reject_once / reject_always`，决策持久化缓存。

**特点**：对 edit 工具检查参数内容，区分 delete/move 操作与普通编辑。只有破坏性操作触发权限请求。

### 2.5 对 ZooKeeper 的启示

ZooKeeper 的声明式配置（方案 B）是好平衡点。两个进化方向：

1. **加通配符支持**：oh-my-opencode-slim 的 `*` 通配符 + 显式 allow/deny 混合能大幅减少配置噪音。现在 config.toml 每加一个 MCP 就要手动加 `"tool_xxx" = "deny"`。
2. **C 方案不适用**：oh-my-pi 的审批分级的前提是它拥有自己的 agent loop 和工具执行层。ZooKeeper 作为 OpenCode 插件无法控制工具执行机制，Proxy 拦截不可行。

---

## 三、Prompt 管理：五种注入策略

### 3.1 策略对比

| 策略 | 代表 | 注入时机 | Token 效率 | 灵活性 | 可维护性 |
|---|---|---|---|---|---|
| A. 纯静态文件 | ZooKeeper | config hook | 中 | 低 | ★★★★ |
| B. 代码内联 + 文件覆盖 | oh-my-opencode-slim | agent 创建时 | 中 | 中 | ★★★ |
| C. 动态代码拼接 | oh-my-openagent | agent 创建 + 运行时 | 高 | 高 | ★★ |
| D. 模板变量 + 前缀缓存 | oh-my-pi | 每次 LLM 调用前 | 最高 | 中 | ★★★ |
| E. 按需触发注入 | superpowers / DCP | 会话启动 / 条件触发 | 高 | 高 | ★★★★ |

### 3.2 各策略详解

**A. ZooKeeper**：`core/prompts/{name}.md` → config hook 直接赋值 `agent.prompt = loadPrompt(name)`。改 prompt 后下一轮调用生效。build.md 永远 67 行全量注入。

**B. oh-my-opencode-slim**：基础 prompt 是 TypeScript 常量字符串，外部 `.md` 文件可覆盖/追加。通过 `resolvePrompt()` 三元合并：完全替换 > 追加 > 默认。支持 preset 子目录隔离多套 prompt。

**C. oh-my-openagent**：Sisyphus 的 prompt 由 14 个独立函数在运行时刻计算拼接：`agentIdentity`、`delegationTable`、`keyTriggers`、`toolSelection`、`oracleSection`、`librarianSection`、`hardBlocks`、`antiPatterns` 等。每个函数根据当前可用 agent、工具、技能动态生成对应内容。好处是可以根据上下文精确调整；坏处是 prompt 变成了一个"程序"。

**D. oh-my-pi**：双重 token 优化机制：
- **StablePrefix**——冻结 system prompt + tool spec，指纹不变则复用，最大化 DeepSeek/Anthropic 前缀缓存命中
- **AppendOnlyLog**——消息只增长不复序列化，每轮只有用户消息 delta 是缓存未命中
- 12 个 `.md` 模板用于 compaction（摘要、分支总结、交接文档），用 Handlebars 风格的 `{{variable}}` 渲染

**E. superpowers**：`using-superpowers/SKILL.md` 仅在会话开始注入一次（bootstrap），告诉 LLM "当你需要某个能力时，调用 Skill 工具检查"。技能内容只在 LLM 决定加载时才注入。OpenCode 适配中特意注入到**第一条用户消息**而非 system prompt，避免多 system message 的模型兼容问题。

**E. DCP**：token 低于阈值时不注入任何内容；在 min~max 区间时注入温和提醒（turn-nudge）；超过上限时注入紧急提示（context-limit-nudge）。

### 3.3 SKILL.md 文件格式

superpowers 和 skills 统一使用 YAML frontmatter + Markdown 的标准格式：

```markdown
---
name: brainstorming
description: "Use before any creative work. Triggers when user says 'let's build X' or 'I want to create Y'."
---

# Skill 名称

## Red Flags（思维陷阱表）
| 想法 | 现实 |
|------|------|
| "太简单不需要设计" | 简单项目正是未检查假设最浪费的地方 |

## Checklist（要求创建 TodoWrite 任务）

## HARD-GATE（不可逾越的门禁）
```

关键设计元素：
- **description 是选择机制**——agent 决定加载哪个 skill 时只能看到 description，必须具有可区分性
- **Red Flags 表**——列出 agent 常见的"理性化跳过"借口，直接对抗行为惯性
- **HARD-GATE**——不可逾越的规则门禁（如"未经设计批准不得写任何代码"）

### 3.4 对 ZooKeeper 的启示

build.md 混了三类内容：
1. **身份声明**（"你是 orchestrator"）——每轮都需要
2. **委派规则**（"task() 委派代码修改"）——每轮都需要
3. **verify-iterate 模式**（"修改后必须验证"）——只在委派后需要

把 (3) 拆出来，通过 `tool.execute.after` hook 在 `task()` 返回后注入验证提示，token 节省不大（约 200 词），但**行为效果更好**——指令在需要时才出现，LLM 更可能遵循。这是 E 策略的轻量版实现。

---

## 四、错误恢复：四个层级

### 4.1 层级对比

| 层级 | 方法 | 代表 | 效果 | 代码量 |
|---|---|---|---|---|
| L0 无恢复 | 错误直接暴露 | ZooKeeper 现状 | API 限流=系统挂了 | 0 |
| L1 输出修饰 | `tool.execute.after` 追加修正提示 | oh-my-opencode-slim | 引导 LLM 自我修正 | ~80 行 |
| L2 模型回退链 | 限流时自动切模型 | oh-my-opencode-slim | API 故障不中断 | ~400 行 |
| L3 全面恢复 | session recovery + 结构修复 + 压缩恢复 | oh-my-openagent | 处理几乎所有故障 | 50+ 文件 |

### 4.2 L3 详解（oh-my-openagent）

六个独立恢复子系统，总计 50+ 文件：

| 子系统 | 文件数 | 触发条件 | 恢复策略 |
|--------|--------|---------|---------|
| `runtime-fallback/` | 50+ | `session.error`、`message.updated`（带错误） | 基于链的模型回退，可配置重试状态码 + 错误模式（正则），60+ 检测模式 |
| `session-recovery/` | ~10 | 7 种结构性错误 | 每个错误类型有专用恢复器：合成 tool_result 注入、thinking block 重排、thinking block 剥离 |
| `anthropic-context-window-limit/` | ~8 | Anthropic token 限制错误 | 两阶段：激进截断 → 摘要重试（指数退避，120s 窗口，3 次上限） |
| `preemptive-compaction/` | ~5 | 工具执行后 token 超阈值 | 主动触发 compaction，含退化监控（连续 3 条无文本助手消息 → 恢复压缩） |
| `json-error-nudge/` | 1 | JSON 解析错误 | 输出追加 `[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]` |
| `edit-error-recovery/` | 1 | `oldString not found` / `found multiple times` | 输出追加 `[EDIT ERROR - IMMEDIATE ACTION REQUIRED]`，指示先 read |

**错误分类器** (`error-classifier.ts`) 是核心组件，能识别 `missing_api_key`、`model_not_found`、`quota_exceeded`（含中文/本地化配额消息）、`rate_limit` 等类型。支持可配置的重试状态码列表和正则表达式模式匹配。

### 4.3 L1+L2 详解（oh-my-opencode-slim）

三个恢复机制，总代码量远小于 L3：

**ForegroundFallbackManager**（`~386 行单文件`）：
- 监听 `session.error`、`message.updated`（带错误）、`session.status`（type: "retry"）
- 11 个正则模式覆盖 429、rate limit、quota、budget、overloaded、`resource_exhausted`
- 5 秒去重窗口防止同一限流事件多次触发
- 回退链：agent 配置中模型数组 + `fallback.chains` 配置
- 执行：中止受限 session → 获取最后用户消息 → 用新模型通过 `promptAsync` 重排队
- 链解析 4 种策略：已知 agent→直接链；agent 未知但模型已知→搜索匹配链；最后手段→扁平化所有链

**JSON Error Recovery**（~80 行）：
- 21 个 JSON 错误模式检测
- 排除 bash/read/glob/webfetch 等工具（可能合法产生类似 JSON 输出）
- 追加修正提示到工具输出

**Delegate-Task Retry**（~60 行）：
- 子 agent 失败时匹配已知错误模式
- 从输出中提取可用 agent 列表
- 提供结构化修复建议块

### 4.4 oh-my-pi 的 HTTP 重试层

`packages/utils/src/fetch-retry.ts`——通用 HTTP 重试，为 LLM API 调用定制：

- 重试状态码：408、429、5xx
- 服务器提示解析：从 `Retry-After`、`x-ratelimit-reset` 头部提取；从响应体提取配额重置模式和"请稍后重试"模式
- 退避：指数 `500ms * 2^attempt`，上限 60s
- 配置：`maxAttempts`（默认 5）、`maxDelayMs`（默认 60s）
- 动态初始化：`prepareInit` hook 支持每次重试刷新认证 token

### 4.5 对 ZooKeeper 的启示

从 L0 到 L1 的投入产出比最高。在 `tool.execute.after` hook 里加 JSON error recovery（~80 行），能解决 LLM 输出格式错误导致后续工具失败的问题。

L2（模型回退链）是第二步。config.toml 的 `{env:CAMBRICON_SMALL_MODEL}` 可扩展为 `model = ["model-a", "model-b"]`，但需要插件监听事件并做切换，实现复杂度上升。

L3 不建议碰——oh-my-openagent 的 50+ 文件恢复系统是多年迭代结果，ROI 对当前阶段太低。

---

## 五、Hook 架构：从 3 个到 25 个

### 5.1 各项目 Hook 使用总览

| Hook 点 | ZooKeeper | oh-my-opencode-slim | oh-my-openagent | DCP |
|---|:-:|:-:|:-:|:-:|
| `config` | ✅ prompt 注入 | ✅ agent+MCP+权限+命令 | ✅ 代理+工具+MCP+命令 | ✅ 工具注册+命令+权限 |
| `tool` (自定义工具) | ❌ | ❌ | ✅ | ✅ compress |
| `tool.definition` | ✅ task 追加提示 | ❌ | ✅ | ❌ |
| `tool.execute.before` | ✅ task 格式验证 | ✅ patch 净化+会话管理 | ✅ 20+ 守卫 | ❌ |
| `tool.execute.after` | ❌ | ✅ JSON 恢复+重试引导 | ✅ | ❌ |
| `event` | ❌ | ✅ 回退+会话生命周期 | ✅ 25 handler 分发 | ✅ 压缩计时 |
| `chat.message` | ❌ | ✅ agent 显示名+映射 | ✅ | ❌ |
| `chat.headers` | ❌ | ✅ | ✅ | ❌ |
| `experimental.chat.system.transform` | ❌ | ✅ serve-mode 注入 | ✅ | ✅ DCP 系统提示 |
| `experimental.chat.messages.transform` | ❌ | ✅ 消息变换+技能过滤 | ✅ 5 步变换 | ✅ 15 步裁剪管线 |
| `experimental.text.complete` | ❌ | ❌ | ❌ | ✅ 幻觉清洗 |
| `command.execute.before` | ❌ | ✅ preset+面试+命令 | ✅ | ✅ /dcp 8 子命令 |
| `experimental.session.compacting` | ❌ | ❌ | ✅ | ❌ |
| `dispose` | ❌ | ❌ | ✅ | ❌ |
| **合计** | **3** | **10** | **11+** | **7** |

### 5.2 三种 Hook 组织模式

**模式 A：手写串联（oh-my-opencode-slim）**

```ts
// 主函数内：
async (input, output) => {
  for (const handler of handlers) {
    try { await handler(input, output); } catch {}
  }
}
```

- 优点：简单直接，所有调度逻辑可见
- 缺点：主文件膨胀到 1237 行，添加新 handler 要改主文件

**模式 B：工厂化注册表（oh-my-openagent）**

```ts
createCoreHooks()      → [sessionHooks, toolGuards, transformHooks]
createContinuationHooks() → [todo, autoSlash, runtimeFallback]
createSkillHooks()     → [skillContext]
```

每个 hook 通过 `safeCreateHook()` + `isHookEnabled()` 独立可开关，创建时 try/catch 隔离。事件分发器 `createEventHookDispatcher()` 按硬编码顺序调度 25 个 handler。

- 优点：模块化，每个 hook 独立可开关
- 缺点：抽象层次多，追踪执行路径需跳多个文件，25 个事件 handler 顺序硬编码

**模式 C：管道-过滤器（DCP）**

```
messages.transform → stripHallucinations → assignMessageRefs → syncCompressionBlocks
  → syncToolCache → buildToolIdList → prune → injectSubAgentResults
  → buildPriorityMap → injectNudges → injectMessageIds → stripStaleMetadata
```

15 步管线，每步操作同一个 `output.messages` 引用。

- 优点：数据变换流程清晰
- 缺点：流控制依赖异常抛出（`throw Error("__DCP_*_HANDLED__")`），全量处理在每次 LLM 调用前执行

### 5.3 对 ZooKeeper 的启示

3 个 hook 的模式 A 是正确的起点。建议走渐进路线：

1. 保持在模式 A，但每个 hook 内的子逻辑拆成独立函数文件
2. 当 hook 内子逻辑超过 5 个时，引入轻量 handler 数组：

```ts
const beforeHandlers = [validateTaskPrompt, recoverJsonError, ...];
for (const h of beforeHandlers) { try { await h(); } catch {} }
```

这比 oh-my-openagent 的工厂化简单得多，但比纯手写串联好维护。**不要直接跳到模式 B**——那是 313k LOC 项目的配套架构。

---

## 六、上下文管理：被忽略的关键维度

### 6.1 各框架的上下文管理

| 框架 | 策略 |
|---|---|
| **ZooKeeper** | 无——完全依赖 OpenCode 原生 compaction |
| **oh-my-opencode-slim** | 无独立系统，依赖 OpenCode 原生 |
| **superpowers** | 无——技能按需加载本身就是上下文管理 |
| **oh-my-openagent** | preemptive-compaction + Anthropic 专用恢复 + session-recovery |
| **oh-my-pi** | StablePrefix + AppendOnlyLog + compaction 系统（12 个 prompt 模板） |
| **DCP** | 完整的上下文裁剪系统（compress 工具 + nudge + 压缩块嵌套 + 消息 ID） |

### 6.2 DCP 的核心设计

DCP 的上下文管理是目前调研中最完整的实现。核心机制：

**消息 ID 系统**：为每条消息分配稳定的 `mNNNN` 引用 ID，通过 `<dcp-message-id>m0001</dcp-message-id>` XML 标签注入到 LLM 可见上下文中。压缩块使用 `bN` 格式。

**LLM 驱动的压缩**：不是"自动裁剪"，而是注册了一个 `compress` 工具让 LLM 自己决定压缩什么：

```
LLM 调用 compress({ startId: "m0003", endId: "m0012", summary: "实现了 X 功能..." })
  → DCP 用占位符替换被压缩的消息
  → 注入 LLM 提供的摘要
  → 压缩块可嵌套：新压缩覆盖旧压缩时，旧信息通过 (b1) 引用保留
```

**Nudge 三层阈值模型**：

```
超过 maxContextLimit  → contextLimitNudge（紧急，要求立即压缩）
在 min~max 之间       → turnNudge（每次用户消息后）+ iterationNudge（长时间迭代后）
低于 minContextLimit  → 无 nudge
```

Nudge 按可配置频率（默认每 5 次）注入，避免过度打扰。

**自动裁剪策略**（在 compress 执行时触发）：
- **去重**：相同工具名+参数的工具调用，只保留最新一次
- **错误清除**：失败的工具调用，经过 N 轮后清除输入（只移除大输入，保留错误消息）

**受保护内容系统**（6 层）：
- 工具名精确匹配 + glob 通配符
- 文件路径 glob 保护
- `<protect>...</protect>` 标签保护
- 用户消息原文保留
- 子 agent 结果合并

### 6.3 oh-my-pi 的 StablePrefix 机制

oh-my-pi 的上下文管理侧重 token 效率：

- **StablePrefix**：system prompt + tool spec 冻结不变，用指纹（fingerprint）检测是否变更。未变更则跳过重建，最大化 DeepSeek/Anthropic 的前缀缓存命中率
- **AppendOnlyLog**：消息只增长不复序列化，每轮只有用户消息 delta 是缓存未命中
- **Tool output 剪枝**：从后往前遍历，保留最近 40K token 不被剪枝，保护关键工具的完整输出

### 6.4 为什么上下文管理重要

OpenCode 的原生 compaction 是黑盒——你不知道它什么时候触发、保留什么、丢弃什么。当 build agent 委派 5 个子 agent、每个返回结果时，上下文窗口快速膨胀。如果原生 compaction 把子 agent 的关键返回值压缩掉，后续验证逻辑就会出错。

### 6.5 对 ZooKeeper 的启示

DCP 本身是一个独立插件，**不需要自己实现**。ZooKeeper 的方向应该是与 DCP 共存——确保 ZooKeeper 的 hook 不与 DCP 的 `messages.transform` 冲突。

但 DCP 的两个设计思想值得借鉴：
1. **消息 ID 系统**：给子 agent 返回的结果分配引用 ID，使后续 turn 能精确引用而不依赖 compaction 保留
2. **受保护内容**：标记哪些工具输出（如 `task`、`edit`）在 compaction 中应该被保留

---

## 七、测试策略：关键分歧

### 7.1 测试对象的分野

| 框架 | 测试什么 | 怎么测 | 调用真实 LLM |
|---|---|---|---|
| **oh-my-openagent** | 代码逻辑（prompt 内容包含关键词、工具权限正确、mock 调用顺序） | bun:test + Module Mock Lifecycle（200+ test 文件） | ❌ |
| **oh-my-opencode-slim** | 代码逻辑 | bun:test + Biome lint | ❌ |
| **oh-my-pi** | 代码逻辑（TS + Rust + Python） | bun:test + cargo test + pytest | ❌ |
| **superpowers** | **agent 行为**（prompt 驱动的 LLM 是否真的按计划执行） | bash + `claude -p` headless + JSONL 分析 | ✅ |
| **ZooKeeper** | **agent 行为**（编排器是否委派、是否验证） | Python runner + JSONL 回放 + 10+ 命名断言 | ✅（非 replay） |

**核心发现**：只有 superpowers 和 ZooKeeper 做了真正的 LLM 行为测试。其他三个框架只测试代码正确性（类型/逻辑/输出），不测试 prompt 对行为的实际影响。

### 7.2 superpowers 的四种 LLM 行为测试模式

**模式 A：技能内容验证**
- 调用 `claude -p "What is the <skill>?"`
- 断言输出包含特定关键词和顺序（`assert_order`）
- 验证 prompt 中蕴含的行为规则被 LLM 理解

**模式 B：端到端行为注入**
1. 创建真实项目 + 植入具体 bug（SQL 注入、明文密码）
2. 调用 `claude -p` 执行 skill
3. 从 `~/.claude/projects/` 读取 session JSONL
4. 验证 session 中技能被触发
5. 验证输出包含具体技术术语（"sql injection"、"password"）
6. 验证 reviewer **没有批准**（anti-sycophancy check）

**模式 C：AB 压力测试（RED-GREEN-PRESSURE）**
- RED：无优化 skill → 记录基线行为
- GREEN：有优化 → 验证行为改变
- PRESSURE：生产紧急场景 → 验证优化不会被压力冲掉
- 可配置运行次数（`RUNS=n`），多次运行验证稳定性

**模式 D：技能触发自然度**
- 显式触发：用户说 "please use brainstorming" → 验证 brainstorming 被加载
- 隐式触发：用户说 "I'm stuck debugging" → 验证 systematic-debugging 被自动触发
- 解析 stream-json 日志，检查 Skill 工具调用
- 检查 premature tool invocation（在加载 skill 之前就开始干活——失败模式）

### 7.3 ZooKeeper vs superpowers 测试对比

| 维度 | ZooKeeper | superpowers |
|---|---|---|
| 回放能力 | ✅ JSONL 回放（--replay） | ❌ 每次都要调 LLM |
| 场景数 | 9 个场景 | ~30 个 shell 脚本 |
| 断言类型 | 10+ 命名断言 | 5 个 shell helper |
| 压力测试 | 3 个独立压力场景 | RED-GREEN-PRESSURE 同场景三阶段 |
| 植入 Bug | ❌ | ✅ SQL 注入 + 明文密码 |
| 反谄媚检查 | ❌ | ✅ reviewer 不批准有问题的代码 |
| 已知失败处理 | dolphin-pressure-2 排除 | `RUNS=n` 多次运行验证 |

ZooKeeper 的 JSONL 回放能力是独特优势（superpowers 没有），但缺少植入 Bug 和反谄媚检查。

### 7.4 oh-my-openagent 的测试基础设施

虽然不测试 LLM 行为，但其测试基础设施值得参考：

- **Module Mock Lifecycle**（300+ 行）：支持 preserve/restore 跨测试文件的 mock 状态，避免泄漏
- **Plugin Module Factory**：注入全部 dependencies 的 mock 版本，可覆盖各个特性开关
- **安全测试**：检查 lockfile 版本、禁止特定库被 import（`dependency-security.test.ts`）
- **字节精确测试**：prompt 逐字节不变性测试（`byte-exactness.test.ts`）
- **CI 覆盖**：3 OS × 3 jobs（test + typecheck + codex-compatibility）

### 7.5 对 ZooKeeper 的启示

1. **从 superpowers 借鉴"植入 Bug"模式**：在测试场景中植入已知代码缺陷，验证 build agent 委派 general 后是否真的修复了 bug
2. **从 superpowers 借鉴"同场景三阶段"**：同场景测试 RED→GREEN→PRESSURE，比分散场景更清晰
3. **从 oh-my-openagent 借鉴"字节精确测试"**：prompt 变更时确保不会意外删除关键指令
4. **没有项目使用 LLM-as-Judge**——这是整个领域的空白，ZooKeeper 的现有断言策略（确定性规则检查）实际上是最务实的选择

---

## 八、Agent 编排模型

### 8.1 Agent 角色图谱

**oh-my-openagent（11 个 agent）**：

| Agent | 角色 | 权限模式 |
|---|---|---|
| Sisyphus | 主编排器 | 完整工具 |
| Hephaestus | 自主深度工作者 | 完整工具；deny `task` |
| Oracle | 顾问/架构师 | 只读 |
| Librarian | 代码/文档搜索 | 只读 |
| Explore | 快速代码库 grep | 只读 |
| Multimodal-Looker | 截图/图像 | 仅 `read` |
| Metis | 规划顾问 | 只读；允许 `task` |
| Momus | 计划审查员 | 只读；允许 `task` |
| Atlas | 引导/副驾驶 | 完整工具 |
| Prometheus | 战略规划师 | 仅 .md 编辑 |
| Sisyphus-Junior | 轻量版 Sisyphus | 完整工具 |

**oh-my-opencode-slim（8 个 agent）**：

| Agent | 角色 | 委托规则 |
|---|---|---|
| orchestrator | 编排器 | 可委派所有子 agent |
| explorer | 代码探索 | 叶节点 |
| librarian | 知识管理 | 叶节点 |
| oracle | 深度分析 | 叶节点 |
| designer | 架构设计 | 叶节点 |
| fixer | 快速实现 | 叶节点 |
| observer | 观察者 | 叶节点 |
| council | 多 LLM 共识 | 叶节点（但 council 工具生成委员子会话） |

**ZooKeeper（5 个 agent）**：

| Agent | 角色 | deny 工具 |
|---|---|---|
| build | 编排器 | grep, glob, webfetch, websearch |
| general | 代码实现 | task, webfetch, websearch |
| explore | 代码搜索 | edit, write, task |
| spider | 网络调研 | edit, write, bash, task, read, glob, grep |

### 8.2 委托模型对比

**oh-my-openagent**：
- 域→触发器→代理的委派表嵌入 Sisyphus 的 prompt 中
- 支持并行委派（`parallelDelegationSection`）
- Team Mode 支持 1-8 个并行 agent，通过 tmux 布局可视化
- 后台 agent 有 5 个并行 slot 限制，FIFO 队列

**oh-my-opencode-slim**：
- 编排器 prompt 运行时构建，包含每个启用子 agent 的动态描述
- 5 阶段工作流：理解 → 路径选择 → 委托检查 → 拆分与并行化 → 执行 → 验证
- 每个 agent 有明确的委托规则（`SUBAGENT_DELEGATION_RULES`）
- `SubagentDepthTracker` 防止超过 3 层递归

**ZooKeeper**：
- 委派规则在 build.md prompt 中文字描述
- 通过 `tool.execute.before` 验证 task prompt 格式
- 无并行委派支持
- 无递归深度限制

### 8.3 委员会系统（oh-my-opencode-slim 独有）

多 LLM 并行评估 + 综合：
1. 配置多个 councillor（如 gpt-5、claude、gemini）
2. 以并行模式运行，每个 councillor 作为子会话
3. 结果由 council agent 综合（审查每个委员、解决分歧、给出置信度评级）
4. 支持超时（默认 180s）和重试（默认 3 次）

这个设计的 token 成本极高（3× 并发），但提供了多模型共识的能力。

---

## 九、独特设计模式

### 9.1 Hashline 编辑（oh-my-openagent / oh-my-pi）

内容寻址行引用，解决 LLM 编辑时行号漂移的问题：

```
读取 → 行被标记为 LINE#ID 格式:  42#XJ|function hello() {
编辑 → 通过 LINE#ID 引用:        { op: "replace", pos: "42#XJ", lines: [...] }
验证 → 哈希必须匹配当前内容
拒绝 → 自读取以来文件已更改 → 无损坏
```

- 哈希算法：xxHash32，空白不敏感
- 2 字符哈希 ID，16 字符字母表
- 支持 replace、append、prepend 操作

oh-my-openagent 的基准测试：仅更改编辑工具，Grok Code Fast 1 从 6.7% 成功率提升到 68.3%。

### 9.2 TTSR 流规则匹配（oh-my-pi）

模型流的 token 被实时匹配，违反规则时中止并注入修正提示：

```
1. 用户定义规则（.clinerules、.cursorrules 等文件）
2. 模型流式输出时实时匹配
3. 匹配到违反规则 → 中止流
4. 注入规则作为 system reminder
5. 从同一位置重试
```

### 9.3 IntentGate 关键字检测（oh-my-openagent）

分析用户真实意图，路由到不同模式：
- `ultrawork` / `ulw` → 全面多 agent 模式
- `search` → 搜索模式
- `analyze` → 分析模式
- `team` → 团队模式

### 9.4 技能嵌入 MCP（oh-my-openagent）

MCP 服务器消耗上下文预算。技能带来自己的 MCP 服务器，按需启动，范围限定到任务，完成后消失。三层 MCP：内置 MCP → Claude Code 的 `.mcp.json` → 技能嵌入 MCP。

### 9.5 跨平台兼容层（oh-my-pi）

读取 Cursor MDC、Cline .clinerules、Codex AGENTS.md、Copilot 配置等 **8 种格式**，统一到自己的规则系统。

---

## 十、综合评估矩阵

| 维度 | ZooKeeper | oh-my-openagent | oh-my-opencode-slim | oh-my-pi | DCP | superpowers |
|------|:-:|:-:|:-:|:-:|:-:|:-:|
| **权限控制** | ★★★★ | ★★★★★ | ★★★★ | ★★★★★ | N/A | N/A |
| **Prompt 管理** | ★★★ | ★★★★★ | ★★★★ | ★★★★★ | ★★★★ | ★★★★ |
| **错误恢复** | ★ | ★★★★★ | ★★★★ | ★★★★ | ★★ | N/A |
| **Context 管理** | ★ | ★★★★★ | ★ | ★★★★★ | ★★★★★ | ★★★ |
| **编排骨架** | ★★★ | ★★★★★ | ★★★★ | ★★★★ | N/A | N/A |
| **测试策略** | ★★★★ | ★★★★★ | ★★ | ★★★ | ★★ | ★★★★★ |
| **可维护性** | ★★★★★ | ★★ | ★★★★ | ★★ | ★★★★ | ★★★★★ |
| **轻量性** | ★★★★★ | ★ | ★★★ | ★ | ★★★★ | ★★★★★ |
| **学习曲线** | ★★★★★ | ★★ | ★★★ | ★★ | ★★★ | ★★★★ |

ZooKeeper 的核心优势在**可维护性、轻量性和学习曲线**。劣势在**错误恢复和上下文管理**（完全空白）。

---

## 十一、技术路线建议

### 11.1 不建议照搬的方向

| 方向 | 来源 | 原因 |
|------|------|------|
| Team Mode | oh-my-openagent | 并行多 agent 需要大量运行时状态管理，与"静态声明式"哲学冲突 |
| Council（多 LLM 共识） | oh-my-opencode-slim | Token 成本极高（3× 并发），收益不清晰 |
| LSP/DAP 深度集成 | oh-my-pi | 超出编排框架范畴，应由底层 harness 提供 |
| 动态 Prompt 代码构建 | oh-my-openagent | `.md` 文件方式更易编辑和版本控制 |
| 全面 session recovery | oh-my-openagent | 50+ 文件的恢复系统，ROI 对当前阶段太低 |

### 11.2 值得采纳的渐进改进

**短期（1-2 周）**：

1. **L1 错误恢复**：在 `tool.execute.after` 加 JSON error recovery（~80 行），引导 LLM 自我修正输出格式错误 → ✅ **已实现**（`src/hooks/json-error-nudge/`）
2. **配置增强**：config.toml 支持通配符（`"mcp_*" = "deny"`），减少 MCP 权限的配置噪音 → ❌ 未实现
3. **测试补强**：添加"植入 Bug"测试场景和 anti-sycophancy 检查 → ❌ 未实现

**中期（2-4 周）**：

4. **L2 模型回退链**：config.toml 的 model 字段支持数组，插件监听 `session.error` 事件做模型切换 → ❌ 未实现
5. **Prompt 按需注入**：把 verify-iterate 规则从 build.md 拆出来，通过 `tool.execute.after` 在 `task()` 返回后注入 → ✅ **已实现**（`src/hooks/post-task-nudge/`）
6. **DCP 兼容性**：确保 ZooKeeper 的 hook 不与 DCP 的 `messages.transform` 冲突，写兼容性测试 → ❌ 未实现

**长期（4-8 周）**：

7. **Plan Mode**：引入 plan agent（只读），强制编排器在动手前先规划 → ❌ 未实现
8. **子 agent 行为测试**：借鉴 superpowers 的隐式触发测试，验证子 agent 是否真正遵循 prompt 约束 → ❌ 未实现
9. **Skill 体系**：把方法论指令（verify-iterate、task-prompt-format）拆为独立 skill 文件，按需触发 → ❌ 未实现

### 11.3 核心原则

每一步都必须保持 ZooKeeper 现在的设计本质——**声明式、可预测、轻量**。新增的功能应该是"在配置里加一行就能启用"，而不是"在 plugin 代码里加 100 行"。

---

## 附录 A：调研中读取的关键文件索引

### oh-my-openagent

| 文件 | 内容 |
|------|------|
| `src/index.ts` | 插件入口 |
| `src/testing/create-plugin-module.ts` | 初始化编排 |
| `src/plugin-interface.ts` | 12 个 OpenCode hook 处理程序 |
| `src/agents/sisyphus-agent-factory.ts` | 主 agent 工厂 |
| `src/agents/dynamic-agent-prompt-builder.ts` | 14 节 prompt 构建 |
| `src/shared/agent-tool-restrictions.ts` | 权限常量 |
| `src/tools/hashline-edit/` | 哈希编辑 |
| `src/hooks/runtime-fallback/` | 运行时回退（50+ 文件） |
| `src/hooks/session-recovery/` | 会话恢复 |
| `src/features/team-mode/` | 团队模式 |

### oh-my-opencode-slim

| 文件 | 内容 |
|------|------|
| `src/index.ts` | 组合根（1237 行） |
| `src/agents/orchestrator.ts` | 编排器 prompt 构建 |
| `src/hooks/foreground-fallback/` | 前台模型回退（~386 行） |
| `src/hooks/json-error-nudge/` | JSON 错误恢复 |
| `src/hooks/delegate-task-retry/` | 委托重试 |
| `src/config/loader.ts` | 分层配置加载 |
| `src/council/council-manager.ts` | 多 LLM 共识 |

### oh-my-pi

| 文件 | 内容 |
|------|------|
| `packages/agent/src/agent-loop.ts` | 核心 agent 循环 |
| `packages/agent/src/append-only-context.ts` | StablePrefix + AppendOnlyLog |
| `packages/coding-agent/src/tools/approval.ts` | 审批分级 |
| `packages/utils/src/fetch-retry.ts` | HTTP 重试层 |
| `packages/coding-agent/src/session/agent-session.ts` | ACP 权限门控 |
| `packages/hashline/` | 哈希编辑 |

### DCP

| 文件 | 内容 |
|------|------|
| `index.ts` | 插件入口 |
| `lib/compress/range.ts` | Range 压缩 |
| `lib/compress/state.ts` | 压缩块嵌套状态管理 |
| `lib/messages/prune.ts` | 消息裁剪执行 |
| `lib/messages/inject/inject.ts` | Nudge 系统 |
| `lib/strategies/deduplication.ts` | 去重策略 |
| `lib/config.ts` | 多层配置 |

### superpowers

| 文件 | 内容 |
|------|------|
| `skills/using-superpowers/SKILL.md` | Bootstrap 入口 |
| `skills/brainstorming/SKILL.md` | 头脑风暴技能 |
| `skills/subagent-driven-development/SKILL.md` | 子 agent 驱动开发 |
| `.opencode/plugins/superpowers.js` | OpenCode 适配 |
| `hooks/session-start` | 会话启动 hook |
| `tests/` | 7 套 LLM 行为测试 |
