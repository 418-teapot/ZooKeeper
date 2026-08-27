# pi 宿主 Subagent 支持：调研与决策

**版本:** 2.0
**日期:** 2026-08-25
**分类:** 调研报告 + 设计决策
**调研对象:** `~/Code/Agent/{oh-my-pi, pi-subagents, opencode, opencode2}`（opencode2 为 anomalyco/opencode 的 v2 重构分支，同 remote 两条开发线）+ pi 宿主本体（`~/Code/Agent/pi`，earendil-works/pi monorepo，`v0.84.1-110-g2e4d23959`）
**说明:** 本文合并原《subagent 机制横向对比》与《pi 宿主 subagent 路线决策》两份文档：§1-§5 为决策（决策优先，证据挂 file:line），§6 为四项目机制调研存档（压缩保留影响决策的细节）。

---

## 目录

1. [问题与约束](#1-问题与约束)
2. [候选路线](#2-候选路线)
3. [决策：进程内 SDK 工厂](#3-决策进程内-sdk-工厂)
4. [设计要点](#4-设计要点)
5. [风险登记与退路](#5-风险登记与退路)
6. [调研证据：四项目 subagent 机制对比](#6-调研证据四项目-subagent-机制对比)

---

## 1. 问题与约束

ZooKeeper 是双宿主编排器插件（OpenCode + pi）。OpenCode 侧编排器 dolphin 经内置 `task()` 工具委派给 beaver/lynx/spider/eagle/kiwi 等 subagent；pi 核心**不内置 subagent**（`packages/coding-agent/README.md:500`："No sub-agents... build your own with extensions"；`docs/usage.md:303`），dolphin 在 pi 上无法委派。

约束：

- **不 fork pi 源码**——fork 意味着永久维护一个上游分叉
- **单一事实来源**——agent prompt 复用 `src/agents/*.ts` 常量，权限复用 `config.toml` deny 列表，双宿主零分叉
- **fail-closed**——缺信息时拒绝而非放行

## 2. 候选路线

subagent 的执行载体只有三种选择，各有代表实现：

| 路线 | 执行载体 | 代表实现 | 一句话机制 |
|---|---|---|---|
| A. fork + 进程内 | 独立 `AgentSession` | oh-my-pi | 改 pi 源码，复用内部 API（MCP/模型注册表/OTEL）直接传对象 |
| B. 扩展 + 子进程 | 独立 OS 进程 | pi 官方 example、pi-subagents | `registerTool` 注册委派工具，spawn `pi --mode json -p` 子进程，解析 stdout JSONL 取结果 |
| C. 扩展 + 进程内 SDK | 独立 `AgentSession` | **无先例** | `registerTool` 注册委派工具，execute 内经公开导出的 `createAgentSession` 起第二个会话 |

路线 A 违反"不 fork"约束，排除。路线 B 有两个完整实现可抄（官方 example `examples/extensions/subagent/index.ts:15/300/344-421` 用 `node:child_process` spawn，2026-01-05 随扩展系统统一提交 c6fc08453 引入；pi-subagents v0.56.0，commit 071fb76a，57 个版本迭代）。路线 C 无人走过（examples/extensions/ 全量 grep `createAgentSession` 零匹配），但 API 是公开的。

## 3. 决策：进程内 SDK 工厂（路线 C）

**选择标准是能力上限与深度融合，不是稳妥。** 路线 B 里 subagent 对 ZooKeeper 是黑盒，父子通信只能走文本协议；路线 C 里 subagent 运行在 ZooKeeper 自己的模块图里，身份、权限、prompt、钩子、事件流全部内生。

关键证据（全部经源码核实）：

- **API 公开**：`src/index.ts:210` 导出 `createAgentSession`（工厂实现 `src/core/sdk.ts:169-398`，headless 无 TUI 依赖）；官方文档 `docs/sdk.md:11` 明列 "Build custom tools that spawn sub-agents" 为 SDK 典型场景
- **扩展可达**：扩展加载器把 `@earendil-works/pi-coding-agent` 别名到包入口（Bun 模式 `src/core/extensions/loader.ts:27/66`，Node/jiti 模式 loader.ts:90/105/119），扩展代码可直接 import
- **扩展 API 自带的会话原语不可用**：`ctx.newSession`（types.ts:361-365）仅 command context 且为替换语义——`agent-session-runtime.ts:226-260` 会先 abort+dispose 旧会话（167-178）；`pi.sendUserMessage`（types.ts:1312-1315）只作用于当前会话（agent-session.ts:1481-1511）。必须走 SDK 工厂而非扩展 API

  > **修正注记（2026-08-26）**：上述"会话原语不可用"的结论只适用于**非 command-context 的工具执行路径**。随本报告落地并已随产品发布的 `/go` handoff（`src/core/handoff.ts` + `src/adapters/pi/handoff-target.ts`）与 `/<agent>` 主 agent 切换（`src/commands/switch/`）均直接使用 command context 的 `ctx.newSession` 做会话替换（含 `withSession` 回调投递 plan reference / 执行工具裁剪），运行可用；后续 spike 结论 4-7 亦验证了该路径。即：SDK 工厂（路线 C）对"子会话委派"仍是唯一选择，但 command-context 的 `newSession` 替换语义已被证明可用于主 agent 切换与 handoff 类需求。
- **工具白名单可防递归**：`createAgentSession({ tools })` 统一过滤内置与扩展注册工具（sdk.ts:246；`agent-session.ts:2463-2478` 对 `_extensionRunner.getAllRegisteredTools()` 施加同一 isAllowedTool 过滤，2535-2539 只有名单内工具进 active 集合）——白名单不含委派工具名即关闭递归通道
- **终止原语完备**：`AgentSession.abort()`（agent-session.ts:1550，stopReason 置 "aborted"，底层 `packages/agent/src/agent.ts:319/519`）+ `dispose()`（agent-session.ts:839-845，全量拆除含 bash 子进程）

架构形态（纯逻辑与宿主适配分层，保留降级路线 B 的可能）：

```
config.toml（权限单一事实来源）
    │
src/core/subagent/          纯逻辑：policy.ts（deny→tools 白名单）
                            identity.ts（ALS 身份）result.ts（事件流→结果）
    │
src/adapters/pi/subagent.ts 薄适配：createAgentSession 调用、
                            ALS.run 包裹、abort 接线
    │
新工具单元入 src/registry.ts → src/compose-pi.ts 新增 tool 槽位
                            → pi.registerTool
```

## 4. 设计要点

### 4.1 身份机制：AsyncLocalStorage，不是 env

子进程时代用 `PI_SUBAGENT_CHILD=1` env 定角色（pi-subagents 的做法）；同进程 env 父子共享，不可用。改用模块级 `AsyncLocalStorage`——ZooKeeper 扩展在进程内是同一模块实例，task 工具 execute 内 `als.run({ agent }, () => session.prompt(...))`，`before_agent_start` 读 store 分发：无 store 则主会话注入主 agent prompt，有 store 则注入对应 subagent prompt。ALS 绑定异步调用链，并行 fan-out 时各子会话身份互不串扰；比 env 更细——env 只能表达"是子"，ALS 能表达"是哪个"。

子会话**不剥离** ZooKeeper 扩展：按身份注入不同 prompt，校验/nudge/JSON 恢复钩子继续保护子会话。

### 4.2 权限：白名单 + 拦截双层

- **第一层（工具面）**：`config.toml` 的 deny 列表翻译成 `createAgentSession({ tools })` 白名单，构造即生效，模型看不到被 deny 的工具
- **第二层（运行时）**：`core/delegation.ts` 委派权限判定在工具 execute 里执行；细粒度规则（如 mola 的 bash 只诊断）经 `tool_call` 事件钩子拦截——pi-subagents 已证明该钩子是真实拦截点

### 4.3 多主 agent：扩展自当注册表

pi 无 primary agent 概念（Tab 是自动补全，keybindings.ts:233），由扩展自维护 `currentPrimary` 状态（dolphin 执行编排 / mola 规划顾问，sticky plan mode）。`registerCommand` 注册 `/mola`、`/dolphin` 切换命令（官方 `preset.ts` 与 `plan-mode/` 是该模式的孤立先例）；切换时 `setActiveTools()` 裁剪工具面（mola 摘 edit/write）。mola→dolphin 的 `/go` handoff 在 pi 侧仅是状态切换，比 OpenCode 侧（需开子会话）更简单。

身份模型统一为：

```typescript
type Identity = { kind: "primary"; name: "dolphin" | "mola" }
              | { kind: "subagent"; name: string };
```

`before_agent_start` 对三种身份统一分发。

### 4.4 命名：subagent，不是 task

| 项目 | 工具名 |
|---|---|
| oh-my-pi / opencode v1 | `task` |
| pi-subagents / pi 官方 example / opencode v2 | `subagent` |

生态趋势是 `subagent`；opencode v2 的改名动机是 `task` 与 todo 任务、后台 job 概念撞车。OpenCode 侧内置工具名不可改，故 `src/agents/parts.ts` 共享 prompt 片段的工具名抽为宿主参数：OpenCode 注入 `task`，pi 注入 `subagent`，其余格式（SUMMARY/CONTEXT/ACCEPTANCE）不动。

### 4.5 终止与资源治理

终止是协作式的：唯一触发源是父工具的 signal，直接传播到子会话：

```typescript
// 用户 Ctrl+C：父工具的 signal 触发 → 传播子会话
signal.addEventListener("abort", () => void session.abort());
try {
  await session.prompt(taskText);
} finally {
  session.dispose();   // 无论成败，物理拆除
}
```

对比路线 B 的 SIGTERM→SIGKILL 进程树升级（pi-subagents `OwnedProcessTreeController`），进程内终止无进程树残留，但属协作式——残余风险见 §5。运行无并发上限、无超时、无上下文大小预算：父信号未触发时，一次 run 只会因会话自然结束而终止，MVP 不引入额外资源治理，需时再补。

### 4.6 可观测性与续跑

pi TUI 绑定单会话、切换为替换语义，opencode 式"进入子会话围观"不存在。替代方案：

- **实时**：工具 `onUpdate` 把子会话事件流渲染进主会话工具调用 UI（官方 example 已验证该模式：tool call 逐条流式 + Ctrl+O 展开）；进程内拿到的是类型化事件流，渲染上限高于 JSONL 文本解析
- **事后/旁路**：子会话持久化落盘（带 parentSession 指针），可另开终端 `pi --session <child>` 查看，并接入 zfind/ztrace 工具链

续跑近乎免费（持有会话对象即可继续 prompt），但**语义显式设计**：什么算同一任务、失败重试预算、provider 分发歧义——opencode v2 把续跑悬在未合入分支的教训（specs/v2/session.md:86-90 明确恢复需显式设计）不重演。

## 5. 风险登记与退路

| 风险 | 影响 | 对策 |
|---|---|---|
| ALS 单例依赖 jiti 模块缓存行为 | 身份分发根基不成立 | **spike 先行验证**；退路：按 `SessionManager.inMemory()` 等特征识别子会话 |
| 协作式 abort 无物理兜底 | 自定义工具无视 signal 时无法强杀 | 白名单只放受信工具；无超时升级兜底，需强杀时另加 dispose 路径 |
| 子会话未捕获异常带走主会话 | 用户主会话现场丢失 | 子会话全程 try/catch + finally dispose，错误收敛为工具返回值 |
| pi 升级改变包级 API/loader 行为 | 进程内假设悄悄失效 | 薄 adapter 封装：降级路线 B 只换 adapter 层，core/subagent 纯逻辑两路线共用 |
| 内存/事件循环共享 | 大上下文子会话拖垮父会话 | 暂无内置治理；必要时引入上下文预算配额（当前明确不设限） |

实施顺序：**① spike 验证 ALS 穿透与模块单例 → ② 身份/角色基础设施 + 双主切换 → ③ subagent 工具单元**。多主支持是前置依赖——身份机制是两者的共同地基。

---

## 6. 调研证据：四项目 subagent 机制对比

本节为决策的证据存档，保留影响过决策的机制细节与 file:line 证据。

### 6.1 项目身份与定位

| 项目 | 身份 | subagent 执行载体 | 委派工具 |
|---|---|---|---|
| oh-my-pi | pi 宿主的深度定制发行版（OMP） | 进程内独立 `AgentSession` | `task` |
| pi-subagents | pi 宿主的扩展 | 独立 OS 子进程（`pi --mode json -p`） | `subagent` |
| opencode v1 | anomalyco/opencode v1.18.18 主线 | 进程内子 session（Effect job） | `task` |
| opencode v2 | 同仓库 v2 重构分支 | 同 v1（plugin 化） | `subagent` |

opencode v1（`cc4b456129`）与 v2（`56973e0ca4`）架构差异巨大：v1 单包 `packages/opencode`；v2 拆为 schema/ai/core 的 effect/Schema 驱动架构。

### 6.2 六维对比

**定义与声明**：四项目殊途同归选 markdown + YAML frontmatter 作为用户自定义 agent 格式（body 即 system prompt）。判别字段各异：oh-my-pi 用 `tools:`/`spawns:` 白名单，pi-subagents 用 `systemPromptMode`/`permissions`，opencode 用 `mode: subagent`。ZooKeeper 不引入新格式——agent 声明复用 config.toml + `src/agents/*.ts` 常量。

**发现与注册**：oh-my-pi `discoverAgents()`（task/discovery.ts:70-138）按优先级扫描去重；pi-subagents 四源扫描且**每次调用重新发现**；opencode v1 启动时合并进内存 map 并静态注入 task 工具描述（tool/registry.ts:260-273）；v2 改为 context hook 每次请求动态注入（subagent.ts:247-271）。ZooKeeper 对应物是 `src/registry.ts` 单元名单。

**调用与委派**：统一模式为"委派工具 → 权限/深度预检 → 创建子执行单元 → 驱动至完成"。防递归手段各有侧重：oh-my-pi 用 `maxRecursionDepth`+`spawns` 白名单；opencode v1 默认 deny 子会话的 task/todowrite；v2 靠深度限制+内置 subagent 显式 deny；pi-subagents 用深度检查+capability ceiling+进程边界指令。ZooKeeper 用 tools 白名单（§3 证据第四条）。

**上下文隔离**：oh-my-pi 进程内全新 AgentSession（可选 git worktree 文件系统隔离）；pi-subagents OS 进程级隔离，独有 fork 模式（fork-context.ts:180 从父会话 leaf 真实分叉，fork-context.ts:73-84 剔除不可重放的 provider 签名 thinking block；oracle.md:30 点明价值——用干净 fork 上下文对抗主会话的 context rot）；opencode 独立 session 无继承。ZooKeeper 进程内方案的隔离强度介于 oh-my-pi 与 pi-subagents 之间。

**权限与工具限制**——四种哲学：

1. **oh-my-pi**：静态白名单 + 集中预检（`resolveEffectiveSubagentPolicy`，structured-subagent.ts:245-327），fail-fast；"授权在父、执行在子"，子代理强制 yolo（headless 无审批 UI，executor.ts:897）
2. **pi-subagents**：三层 defense in depth——`--tools` 启动白名单（OS 边界）→ capability ceiling 父子求交单调向下（策略边界）→ `PERMISSION_POLICY_ENV` 传入子进程内 `tool_call` 钩子执行 allow/ask/deny（运行时边界）。**注意**：`ask` 由子进程内 watchdog 的单次 LLM 仲裁器裁决（fail-closed，watchdog.md:162 明确不通知父会话），父会话决策通道是独立的 `contact_supervisor`
3. **opencode v1**：声明式 ruleset（last-match-wins），`deriveSubagentSessionPermission`（subagent-permissions.ts:14-27）继承父 deny、不继承 allow——"父不能授予子能力"；DeniedError 把规则原文回喂模型（"规则即对话"）
4. **opencode v2**：agent 自我治理，权限读时从 `session.agent` 解析（permission.ts:155-160），未知 agent fail-closed（permission.ts:18）；父权限继承未移植（subagent.ts:174-175 TODO）

**结果返回**——契约强度从弱到强：opencode 取子会话最后一条 assistant 文本（弱）；pi-subagents 子进程 stdout JSONL 逐行解析 + 输出文件落盘（中）；oh-my-pi 强制 `yield` 工具 + outputSchema 编译进工具参数（强——严格模式下模型根本发不出不符 schema 的结构，yield.ts:154-193），支持增量 yield。ZooKeeper 进程内的事件流契约介于文本约定与 JSONL 之间，具备向 yield 强契约演进的地基。

### 6.3 设计哲学

- **oh-my-pi**：「受管工作单元 + 类型化结果契约」——"No prose to parse, no merge conflicts between siblings, no orphaned edits"（README.md:165）；"Subagents start blank" 是并行安全先决条件；子代理不维护 todo（"Todos are parent-owned bookkeeping"，executor.ts:3198）
- **pi-subagents**：「进程边界即信任边界」——能力在进程边界收缩、崩溃不拖累父、模型/工具可异构；capability ceiling 只能向下压；文档刻意声明"this is a same-process policy boundary, not a sandbox"；intercom 只用于升级决策
- **opencode v1**：「委派 = 带权限快照的子会话」——一切 LLM 调用都是 agent 运行（compaction/title 也建模为 hidden agent）；task 权限只约束模型，用户 @mention 永远豁免
- **opencode v2**：「schema 单一事实来源 + agent 自我治理」——权限从"写时物化"改为"读时解析"；subagent 是与 read/shell 同构的普通插件（"safe subagent slice"）

### 6.4 主/子 agent 同构性

**四项目共识：主 agent 与 subagent 共享同一套执行引擎，差异只在配置与驱动方式。** oh-my-pi 主/子共用同一 `AgentSession` 类与构造点（sdk.ts:3359），分叉在 prompt/工具面/yolo/驱动方式；pi-subagents 主 agent 就是 pi 本体，`PI_SUBAGENT_CHILD=1` env 决定角色；opencode v1 主/子跑同一 runLoop，唯一判别字段是 `mode`；v2 共享程度最高，"主 agent 只是 mode 字段"，无任何独立执行路径。

pi 宿主侧的两处关键查证：**pi 不内置多主 agent 但非硬性限制**（Tab 是自动补全，keybindings.ts:233；扩展积木齐全——before_agent_start + setActiveTools/setModel + registerCommand/Shortcut，examples 的 preset.ts 与 plan-mode/ 合起来功能等价 opencode 的 build/plan）；**pi 可以整体替换主 agent prompt**（静态：`--system-prompt`/SYSTEM.md 使内置模板路径整个跳过，system-prompt.ts:46-72；动态：before_agent_start 返回 systemPrompt 经 `_systemPromptOverride` 整体替换，agent-session.ts:1254-1256）。pi 与 opencode 的真实差距不在 prompt 替换能力，而在无多 agent 注册表、无内置切换 UI、工具/权限不随角色绑定。

### 6.5 关键实现取舍

- **T1. oh-my-pi 选进程内会话而非子进程**：复用父的 MCP 连接、模型注册表、LSP、OTEL span（传对象即可，子进程需序列化整套协议）；代价是崩溃不隔离，用严格 finally 清理链补偿
- **T2. oh-my-pi 的 quiescence barrier**：run 的终结条件 = 异步树上无未决工作且 yield 最新，而非"模型说完了"；晚到的后台结果使旧 yield 失效
- **T3. oh-my-pi 的 provider 级信号量按请求持锁**（不按 agent 生命周期）：否则宽度超限的 spawn 树必然死锁（父持锁等子、子等锁，issue #3749）
- **T4. pi-subagents 的防 EDR 设计**：task 文本走 `@task.md` 文件投递而非 argv（端点保护扫描长自然语言 argv 会 SIGKILL）；对零活动 SIGKILL 重试 3 次但故意 fail-closed
- **T5. pi-subagents 的 fork 上下文卫生**：剔除 provider 签名 thinking block，anthropic 时 fork 强制 thinking: off；`alignForkedSessionCwd` 防 cwd 串扰
- **T6. opencode v1 的 job 注册表刻意不持久化**（background-job.ts:113-119）：恢复能力靠会话持久化而非 job 状态
- **T7. opencode v2 砍掉 task_id 续跑的设计立场**（specs/v2/session.md:86-90）：自动续跑需显式设计（provider 分发歧义、工具幂等、重试预算），先守 fresh context 纪律

### 6.6 修正记录

调研过程中修正了三处先入为主的错误认知：

1. **pi-subagents 的 ask 仲裁**：`ask` 由子进程内 watchdog 的单次 LLM 仲裁器裁决（fail-closed，watchdog.md:162），而非转发父会话批准
2. **pi 的 prompt 替换能力**：pi 可整体替换主 agent prompt（agent-session.ts:1254-1256），此前误判为只能 append
3. **oh-my-pi 的 per-agent 模型**：实为支持（discovery/helpers.ts:301 解析 frontmatter `model`；test/eval/agent-bridge-policy.test.ts:318 引 issue #6438 "agent's own frontmatter model applies"）——两条落地路线在 per-agent 模型上打平，子进程独有的是环境级异构（不同 provider 配置/API key/pi 版本）

2026-08-25 对真实 pi 0.84.2（nix 安装，Node 24 / jiti 扩展加载，非 Bun 模式）跑了四个 spike 假设（`spikes/pi-subagent/`，已删除）。spike 复用 ZooKeeper 扩展形态：`DefaultResourceLoader` 加载一个注册 `before_agent_start`/`session_start`/自定义工具 `zoo_spike_probe` 的扩展，`createAgentSession` 起子会话；LLM 用配置的 Volces provider（`volces/deepseek-v4-flash`），每会话一条极短 prompt（"reply with the word ok"）。四假设全部 PASS，结论如下：

4. **扩展模块单例成立（PASS）**：同一进程内两次 `createAgentSession` 后，扩展模块顶层只求值一次（`moduleEvalCount=1`）；换成两个独立的 `DefaultResourceLoader` 加载同一扩展路径仍只求值一次（factory 按 loader 各跑一次，模块作用域共享）。因此扩展模块级的 `AsyncLocalStorage` 在父子全部扩展调用间是同一个实例——身份分发的地基成立（与 §5 风险表第一行 "ALS 单例依赖 jiti 模块缓存行为" 对应，实测为模块级 `extensionCache`，非 jiti moduleCache）
5. **ALS 穿透子会话成立（PASS）**：父侧 `als.run({agent:"X"}, () => session.prompt(...))` 包裹的 prompt，子会话 `before_agent_start` 读得到 X；并发第二个 `als.run({agent:"Y"}, ...)` 只读到 Y，无串扰（session→identity 一一对应）。§4.1 的 ALS 身份机制在 Node/jiti 模式实测可行
6. **SDK 会话扩展事件行为（PASS）**：裸 SDK 会话（不调 `bindExtensions`）`before_agent_start` 照常触发（扩展随 `DefaultResourceLoader` 挂载，agent-session.ts:885 每次 prompt 发射），但 `session_start` 不触发（bindExtensions 内才 emit，agent-session.ts:1761）——与调研判断一致：SDK headless 会话与交互式启动的扩展事件面不同
7. **工具白名单防递归成立（PASS）**：`createAgentSession({ tools: [...] })` 白名单同时过滤内置与扩展注册工具（agent-session.ts:1945-2000 对 `_extensionRunner.getAllRegisteredTools()` 施加同一 `isAllowedTool`）。`zoo_spike_probe`（委派工具替身）不在白名单时子会话 active 工具集不含它，在白名单时才出现——构造即生效，模型不可见被 deny 的工具

补充：`getActiveToolNames()` 与 `getAllTools()` 均反映白名单过滤；in-memory 会话 id 用 uuidv7（时间序，前缀看似相同但全局唯一）。

---

## 附：调研方法与证据说明

本报告由六轮调研综合而成：① oh-my-pi/pi-subagents 机制调研；② opencode v1/v2 机制调研；③ 四项目设计哲学与架构深挖；④ 四项目主 agent 实现调研；⑤ pi 多主 agent 能力与 prompt 替换专项查证；⑥ pi 落地路线专项调研（2026-08-25，§1-§5 的决策依据）。关键引述均经编排器直接 grep/read 抽查验证，file:line 证据分散在各章节正文中。
