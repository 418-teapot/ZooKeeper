# Hook 体系横向对比：OMO vs SLIM vs OMP

**版本:** 1.0  
**日期:** 2026-06-21  
**分类:** 技术调研报告

---

## 目录

1. [概述](#1-概述)
2. [三个项目的 Hook 架构总览](#2-三个项目的-hook-架构总览)
   - 2.1 [OMO (oh-my-openagent)](#21-omo-oh-my-openagent)
   - 2.2 [SLIM (oh-my-opencode-slim)](#22-slim-oh-my-opencode-slim)
   - 2.3 [OMP (oh-my-pi)](#23-omp-oh-my-pi)
   - 2.4 [架构哲学对比总表](#24-架构哲学对比总表)
3. [OMO Hook 体系详解](#3-omo-hook-体系详解)
   - 3.1 [Session 生命周期与延续 (7 个)](#31-session-生命周期与延续-7-个)
   - 3.2 [通知与监控 (3 个)](#32-通知与监控-3-个)
   - 3.3 [工具输出处理 (7 个)](#33-工具输出处理-7-个)
   - 3.4 [工具预执行守卫 (10 个)](#34-工具预执行守卫-10-个)
   - 3.5 [上下文与 Prompt 注入 (7 个)](#35-上下文与-prompt-注入-7-个)
   - 3.6 [Agent 与模型管理 (5 个)](#36-agent-与模型管理-5-个)
   - 3.7 [编排器与 Agent 行为 (5 个)](#37-编排器与-agent-行为-5-个)
   - 3.8 [团队与多 Agent (3 个)](#38-团队与多-agent-3-个)
   - 3.9 [引导与初始化 (2 个)](#39-引导与初始化-2-个)
   - 3.10 [命令与 Slash (2 个)](#310-命令与-slash-2-个)
   - 3.11 [验证与其他 (5 个)](#311-验证与其他-5-个)
   - 3.12 [claude-code-hooks 外部调度系统](#312-claude-code-hooks-外部调度系统)
4. [SLIM Hook 体系详解](#4-slim-hook-体系详解)
   - 4.1 [挂载点 `config` — Agent 定义与配置合并](#41-挂载点-config--agent-定义与配置合并)
   - 4.2 [挂载点 `event` — 中央事件路由器](#42-挂载点-event--中央事件路由器)
   - 4.3 [挂载点 `tool.execute.before` — 预处理管道](#43-挂载点-toolexecutebefore--预处理管道)
   - 4.4 [挂载点 `command.execute.before` — 命令路由](#44-挂载点-commandexecutebefore--命令路由)
   - 4.5 [挂载点 `chat.headers` — chat-headers 模块](#45-挂载点-chatheaders--chat-headers-模块)
   - 4.6 [挂载点 `chat.message` — 会话映射](#46-挂载点-chatmessage--会话映射)
   - 4.7 [挂载点 `experimental.chat.system.transform` — 系统消息变换](#47-挂载点-experimentalchatsystemtransform--系统消息变换)
   - 4.8 [挂载点 `experimental.chat.messages.transform` — 消息变换管线](#48-挂载点-experimentalchatmessagestransform--消息变换管线)
   - 4.9 [挂载点 `tool.execute.after` — 后处理管道](#49-挂载点-toolexecuteafter--后处理管道)
   - 4.10 [Hook 模块详解（13 个）](#410-hook-模块详解13-个)
   - 4.11 [额外消费者模块](#411-额外消费者模块)
5. [OMP Hook 体系详解](#5-omp-hook-体系详解)
   - 5.1 [HookAPI 核心事件体系](#51-hookapi-核心事件体系)
   - 5.2 [Session 生命周期事件 (11 个)](#52-session-生命周期事件-11-个)
   - 5.3 [Agent/Turn 生命周期事件 (7 个)](#53-agentturn-生命周期事件-7-个)
   - 5.4 [自动压缩/重试事件 (4 个)](#54-自动压缩重试事件-4-个)
   - 5.5 [TTSR/提醒事件 (2 个)](#55-ttsr提醒事件-2-个)
   - 5.6 [工具事件 (2 个)](#56-工具事件-2-个)
   - 5.7 [扩展事件体系 (15 个)](#57-扩展事件体系-15-个)
   - 5.8 [遥测回调体系 (6 个)](#58-遥测回调体系-6-个)
   - 5.9 [TUI 集成接口](#59-tui-集成接口)
6. [横向对比](#6-横向对比)
   - 6.1 [Hook 模型对比](#61-hook-模型对比)
   - 6.2 [生命周期覆盖对比](#62-生命周期覆盖对比)
   - 6.3 [工具拦截能力对比](#63-工具拦截能力对比)
   - 6.4 [Compaction 处理对比](#64-compaction-处理对比)
   - 6.5 [模型管理对比](#65-模型管理对比)
   - 6.6 [通知机制对比](#66-通知机制对比)
   - 6.7 [团队/多 Agent 支持对比](#67-团队多-agent-支持对比)
   - 6.8 [TUI 集成对比](#68-tui-集成对比)
   - 6.9 [Hook 数量与覆盖率总表](#69-hook-数量与覆盖率总表)
7. [设计哲学对比](#7-设计哲学对比)
   - 7.1 [OMO: "全部拦截"哲学](#71-omo-全部拦截哲学)
   - 7.2 [SLIM: "核心聚焦"哲学](#72-slim-核心聚焦哲学)
   - 7.3 [OMP: "原生深度集成"哲学](#73-omp-原生深度集成哲学)
   - 7.4 [哲学对比总表](#74-哲学对比总表)
8. [对 ZooKeeper 的启示](#8-对-zookeeper-的启示)
   - 8.1 [总路线图](#81-总路线图)
   - 8.2 [Hook 注册模式](#82-hook-注册模式)
   - 8.3 [挂载点覆盖](#83-挂载点覆盖)
   - 8.4 [错误恢复策略](#84-错误恢复策略)
   - 8.5 [Compaction 协作](#85-compaction-协作)
   - 8.6 [多 Agent 支持](#86-多-agent-支持)
   - 8.7 [上下文注入管线](#87-上下文注入管线)
   - 8.8 [安全架构纵深](#88-安全架构纵深)
   - 8.9 [分阶段 Hook 数量目标](#89-分阶段-hook-数量目标)
9. [总结](#9-总结)
10. [参考资料](#10-参考资料)

---

## 1. 概述

在 AI 编码代理领域，Hook 体系是决定框架扩展能力、拦截粒度和运行时控制深度的核心基础设施。不同的 Hook 设计哲学直接影响框架的能力边界、可维护性和与宿主平台的集成方式。

本文档对三个具有代表性的项目进行深入的 Hook 体系对比分析：

| 项目 | 全称 | 定位 | 与 OpenCode 的关系 | 代码规模 |
|------|------|------|-------------------|---------|
| **OMO** | oh-my-openagent | 全功能多 Agent 编排框架 | OpenCode 插件，深度集成 | ~313k LOC, TypeScript |
| **SLIM** | oh-my-opencode-slim | 轻量 Agent 编排层 | OpenCode 插件，中等集成 | ~数十 k LOC, TypeScript |
| **OMP** | oh-my-pi | 独立的全栈编码代理 | 独立产品，不依赖 OpenCode | ~27k LOC Rust + TS |

OMO 拥有 59 个注册的 OpenCode 插件 Hook，是当前生态中最庞大的 Hook 体系。SLIM 采用 9 个挂载点 + 13 个 Hook 模块的聚焦策略——每个挂载点上串联少量模块，以轻量管道代替全量注册。OMP 则从零构建了一套独立的事件驱动 Hook 系统，包含 26 个核心 HookAPI 事件、15 个扩展事件和 6 个遥测回调。

本文档逐一枚举所有 Hook，按功能分类详细描述，并在多个维度进行横向对比，最后提炼对 ZooKeeper 项目的设计启示。

---

## 2. 三个项目的 Hook 架构总览

### 2.1 OMO (oh-my-openagent)

OMO 的 Hook 体系注册在 `packages/omo-opencode/src/config/schema/hooks.ts` 中，总计 **59 个** OpenCode 插件 Hook。全部作为 OpenCode 的 `Hooks` 对象成员导出，通过 `server()` 函数统一组装。

**架构特征：**

- **全量注册：** 几乎所有 OpenCode 支持的 Hook 点都被使用，从 `config`、`tool.execute.before/after`、`event`、`chat.message` 到实验性 Hook
- **工厂化组装：** 通过 `createCoreHooks()`、`createContinuationHooks()`、`createSkillHooks()` 等工厂函数分组创建
- **可开关性：** 每个 Hook 通过 `safeCreateHook()` + `isHookEnabled()` 独立控制启用/禁用
- **5 层安全架构：** L0 配置层 → L1 SDK 权限层 → L2 Hook 守卫层 → L3 工具定义层 → L4 Agent 限制层
- **事件分发器：** `createEventHookDispatcher()` 按硬编码顺序调度 25 个事件 handler

**Hook 分类统计：**

| 类别 | 数量 | 覆盖范围 |
|------|:----:|---------|
| Session 生命周期与延续 | 7 | 会话恢复、压缩、延续守卫 |
| 通知与监控 | 3 | 会话通知、后台通知、更新检查 |
| 工具输出处理 | 7 | 截断、错误检测、恢复引导 |
| 工具预执行守卫 | 10 | 文件操作守卫、环境守卫 |
| 上下文与 Prompt 注入 | 7 | Agent 注入、规则注入、团队注入 |
| Agent 与模型管理 | 5 | Think 模式、模型回退 |
| 编排器与 Agent 行为 | 5 | 关键字检测、Skill 提示 |
| 团队与多 Agent | 3 | 工具门控、保姆、写禁 |
| 引导与初始化 | 2 | CodeGraph、AST-Grep |
| 命令与 Slash | 2 | 自动命令、工作启动 |
| 验证与其他 | 5 | 格式验证、图片处理 |
| **合计** | **59** | |

OMO 同时维护了一套 **claude-code-hooks** 系统，通过 `hooks.ts` 配置将 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`PreCompact` 等事件分发到外部 `hooks.json` 配置文件，实现插件化的 Hook 扩展。

### 2.2 SLIM (oh-my-opencode-slim)

SLIM 的 Hook 体系注册在 `src/index.ts` 中，采用**组合根**模式。需要区分两个概念：

- **OpenCode 挂载点（hook point）：** OpenCode 插件 API 提供的拦截时机，是 SLIM 代码"挂"上去的地方
- **Hook 模块：** SLIM 自身实现的业务逻辑，通过 `create*Hook()` 工厂函数创建，注册到对应的挂载点上

**架构特征：**

- **9 个挂载点：** 使用 OpenCode 提供的 9 个 hook point 作为拦截时机
- **13 个 Hook 模块：** 真正的业务逻辑，分布在 `src/hooks/` 目录下，每个模块专注一个功能
- **组合根式注册：** 所有 Hook 模块的创建和挂载点绑定集中在 `src/index.ts` 一个文件中，约 1237 行
- **子 Handler 顺序执行：** 大部分挂载点内部维护多个 Hook 模块，用 try/catch 串联（fail-open）

**挂载点 → Hook 模块映射：**

| 挂载点（OpenCode hook point） | 注册的 Hook 模块 |
|------------------------------|-----------------|
| `config` | 直接内联逻辑：Agent 配置合并、MCP 注册、权限规则、命令注册 |
| `event` | auto-update-checker、foreground-fallback、task-session-manager（此外还有 companion-manager、multiplexer-session-manager、depth-tracker 等消费者） |
| `tool.execute.before` | apply-patch、task-session-manager |
| `command.execute.before` | deepwork、reflect、interview-manager、preset-manager |
| `chat.headers` | chat-headers |
| `chat.message` | 内联逻辑：sessionID→agentName 映射 + 别名解析 |
| `experimental.chat.system.transform` | 内联逻辑：编排器 prompt 注入 + 系统消息折叠 |
| `experimental.chat.messages.transform` | image-hook、task-session-manager、phase-reminder、filter-available-skills（另有 display-name 重写内联逻辑） |
| `tool.execute.after` | delegate-task-retry、json-error-recovery、post-file-tool-nudge、task-session-manager |

**13 个 Hook 模块：**

apply-patch, auto-update-checker, chat-headers, deepwork, delegate-task-retry, foreground-fallback, filter-available-skills, image-hook, json-error-recovery, phase-reminder, post-file-tool-nudge, reflect, task-session-manager

**其他消费者模块（非 `src/hooks/` 目录，但在挂载点中被调用）：**

preset-manager, interview-manager, companion-manager, multiplexer-session-manager, SubagentDepthTracker

### 2.3 OMP (oh-my-pi)

OMP 的 Hook 体系与 OMO/SLIM 有本质区别——它是独立产品，不从属于 OpenCode 插件体系。OMP 自己拥有 Agent 循环、工具系统和 TUI，因此其 Hook 系统是**自建的事件驱动架构**。

**架构特征：**

- **发射式事件模型：** 核心引擎在特定生命周期点 `emit()` 事件，消费者通过 `pi.on(eventName, handler)` 订阅
- **细粒度事件：** 26 个核心 HookAPI 事件，15 个扩展事件，6 个遥测回调
- **深度上下文集成：** 事件 handler 通过 `ctx` 上下文对象访问 TUI、会话、LLM 等全部运行时能力
- **端到端覆盖：** 从 Session 创建到销毁的完整生命周期、Agent/Turn 级别、工具调用、自动压缩、TTSR 流匹配

**事件层次：**

```
核心 HookAPI 事件 (26)
├── Session 生命周期 (11)
├── Agent/Turn 生命周期 (7)
├── 自动压缩/重试 (4)
├── TTSR/提醒 (2)
└── 工具 (2)

扩展事件 (15)
├── LLM 流 (4)
├── 工具流 (2)
├── 消息流 (3)
├── 用户交互 (3)
├── 凭证 (1)
└── 其他 (2)

遥测回调 (6)
├── 成本 (1)
├── Token 用量 (1)
├── 追踪 (2)
├── 运行结束 (1)
└── 警告 (1)
```

### 2.4 架构哲学对比总表

| 维度 | OMO | SLIM | OMP |
|------|:---:|:----:|:---:|
| Hook 总数 | 59 | 9 + 13 子 + 5 消费者 | 26 + 15 + 6 |
| 宿主平台 | OpenCode 插件 | OpenCode 插件 | 独立产品 |
| 注册模式 | 工厂化分组注册 | 组合根单文件串联 | 事件发射/订阅 |
| 可开关性 | ✅ 每个 Hook 独立开关 | ✅ 按子模块加载 | ✅ 按需订阅 |
| 抽象层级 | 多层（工厂→管理器→Handler） | 单层（主函数→子 Handler 数组） | 单层（emit→on） |
| 学习曲线 | 陡峭 | 中等 | 中等 |
| 代码组织 | 分布式（跨多个文件/目录） | 集中式（主文件 + 子模块） | 集中式（事件定义 + 订阅） |

---

## 3. OMO Hook 体系详解

### 3.1 Session 生命周期与延续 (7 个)

这组 Hook 管理会话的持续运行、上下文压缩和延续保障，确保长会话不会因上下文窗口限制或意外中断而丢失进度。

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **todo-continuation-enforcer** | event/tool.execute.after | 会话恢复时 | 恢复未完成的 TODO 列表，确保中断后任务能继续 |
| **stop-continuation-guard** | tool.execute.before | 停止操作前 | 拦截会话停止请求，确认无未完成任务 |
| **compaction-context-injector** | event | 压缩发生时 | 在上下文压缩时注入压缩状态信息，保持 LLM 对压缩的感知 |
| **compaction-todo-preserver** | event | 压缩发生时 | 在压缩过程中保护 TODO 条目不被丢弃 |
| **preemptive-compaction** | event/tool.execute.after | 工具执行后 token 超阈值 | 主动触发 compaction，含退化监控（连续 3 条无文本助手消息→恢复压缩） |
| **anthropic-context-window-limit-recovery** | event | Anthropic token 限制错误时 | 两阶段恢复：激进截断→摘要重试（指数退避，120s 窗口，3 次上限） |
| **ralph-loop** | event | 循环检测触发时 | Ralph 循环检测与恢复机制，防止 Agent 陷入无限循环 |

**设计特点：** 这组 Hook 体现了 OMO 对**长会话可靠性**的高度重视。preemptive-compaction 在工具执行后检测 token 用量，在接近限制前主动触发压缩，而不是等待 LLM 返回上下文超限错误。anthropic-context-window-limit-recovery 专门针对 Anthropic 模型的上下文限制错误设计了两阶段恢复策略。

### 3.2 通知与监控 (3 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **session-notification** | event | 会话状态变化时 | 向用户推送会话启动、结束、错误等通知 |
| **background-notification** | event | 后台任务完成时 | 后台 Agent 任务完成时通知用户 |
| **auto-update-checker** | event | 定期/启动时 | 检查 OMO 插件版本更新并提示用户 |

### 3.3 工具输出处理 (7 个)

这组 Hook 在工具执行完成后介入，检查并修正工具输出中的问题。

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **tool-output-truncator** | tool.execute.after | 工具返回后 | 截断过大的工具输出，防止上下文窗口溢出 |
| **empty-task-response-detector** | tool.execute.after | task() 返回后 | 检测子 Agent 返回空结果，触发重试或提示 |
| **edit-error-recovery** | tool.execute.after | edit 工具返回错误时 | 检测 `oldString not found` / `found multiple times` 错误，追加 `[EDIT ERROR - IMMEDIATE ACTION REQUIRED]` 修正提示 |
| **json-error-recovery** | tool.execute.after | 工具返回 JSON 解析错误时 | 检测 JSON 格式错误，追加 `[JSON PARSE ERROR - IMMEDIATE ACTION REQUIRED]` 指示 |
| **delegate-task-retry** | tool.execute.after | task() 返回失败时 | 子 Agent 失败时匹配已知错误模式，从输出提取可用 Agent 列表，提供结构化修复建议块 |
| **task-resume-info** | tool.execute.after | task() 返回后 | 在 task 结果后注入恢复信息，便于后续 turn 继续未完成任务 |
| **hashline-read-enhancer** | tool.execute.after | read 工具返回后 | 增强 hashline 格式的读取输出，添加行哈希信息便于后续编辑 |

### 3.4 工具预执行守卫 (10 个)

这组 Hook 在工具执行前进行安全检查，是 OMO 5 层安全架构中的 L2（运行时动态守卫层）。

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **comment-checker** | tool.execute.before | 任意工具调用前 | 检查工具调用是否有对应的注释说明（行为追踪审计） |
| **question-label-truncator** | tool.execute.before | question 工具调用前 | 截断过长的用户问题标签 |
| **non-interactive-env** | tool.execute.before | bash 工具调用前 | 检测非交互式环境中的 bash 执行限制 |
| **interactive-bash-session** | tool.execute.before | bash 工具调用前 | 管理交互式 bash 会话的生命周期 |
| **write-existing-file-guard** | tool.execute.before | write/edit 调用前 | 检查写入已存在文件的操作，防止意外覆盖 |
| **notepad-write-guard** | tool.execute.before | notepad 写操作前 | 限制 notepad 工具的写入范围 |
| **bash-file-read-guard** | tool.execute.before | bash 调用读取文件时 | 阻止通过 bash 命令读取敏感文件 |
| **webfetch-redirect-guard** | tool.execute.before | webfetch 调用前 | 检查 webfetch 的 URL 重定向安全 |
| **fsync-skip-warning** | tool.execute.before | 文件操作前 | 当文件同步被跳过时发出警告 |
| **prometheus-md-only** | tool.execute.before | Prometheus Agent 写操作前 | 限制 Prometheus Agent 只能写入 `.omo/*.md` 文件 |

**设计特点：** 这组守卫覆盖了从文件操作到网络请求的多个维度。其中 `prometheus-md-only` 展示了如何通过 Hook 实现 **per-Agent 的差异化约束**——它首先解析当前 session 所属的 Agent，然后根据 Agent 类型应用不同的拦截规则。

### 3.5 上下文与 Prompt 注入 (7 个)

这组 Hook 在配置加载和消息提交时注入上下文信息。

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **directory-agents-injector** | config/chat.message | 配置加载/消息提交时 | 注入目录级别的 Agent 配置信息 |
| **directory-readme-injector** | chat.message | 消息提交时 | 注入目录 README 作为上下文 |
| **rules-injector** | chat.message | 消息提交时 | 注入项目规则文件（如 .clinerules） |
| **hephaestus-agents-md-injector** | config | Agent 创建时 | 注入 Hephaestus Agent 的 .md 配置文件 |
| **team-mode-status-injector** | chat.message | 消息提交时 | 注入团队模式的状态信息 |
| **team-mailbox-injector** | chat.message | 消息提交时 | 注入团队邮箱（agent 间消息传递） |
| **monitor-status-injector** | chat.message | 消息提交时 | 注入监控 Agent 的状态报告 |

### 3.6 Agent 与模型管理 (5 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **think-mode** | tool.execute.before | 工具调用前 | 控制 Think 模式（让 LLM 先思考再行动）的启用/禁用 |
| **model-fallback** | event | 模型调用失败时 | 当前模型失败时切换到备用模型 |
| **runtime-fallback** | event | 运行时错误时 | 监听 `session.error`、`message.updated`（带错误）、`session.status`（type: "retry"），执行基于链的模型回退。60+ 检测模式，可配置重试状态码和正则错误匹配 |
| **no-sisyphus-gpt** | config | 配置加载时 | 防止 Sisyphus Agent 使用 GPT 系列模型 |
| **no-hephaestus-non-gpt** | config | 配置加载时 | 防止 Hephaestus Agent 使用非 GPT 模型 |

**设计特点：** `model-fallback` 和 `runtime-fallback` 构成了 OMO 的 L2 错误恢复能力，覆盖了 API 限流、模型不可用、配额耗尽等场景。`no-sisyphus-gpt` 和 `no-hephaestus-non-gpt` 展示了通过 config Hook 实现 **per-Agent per-Model 的约束**。

### 3.7 编排器与 Agent 行为 (5 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **keyword-detector** | event | 用户消息提交时 | IntentGate 关键字检测，分析用户意图并路由到对应模式（ultrawork/search/analyze/team） |
| **agent-usage-reminder** | chat.message/event | 消息处理时 | 提醒编排器可用的 Agent 列表和使用策略 |
| **category-skill-reminder** | chat.message | 消息处理时 | 提醒编排器可用的 Skill 分类 |
| **sisyphus-junior-notepad** | tool.execute.before/after | 工具调用时 | 管理 Sisyphus-Junior 的记事本读写 |
| **atlas** | command/tool | 引导模式 | Atlas 引导/副驾驶 Agent 的 Hook 集合 |

### 3.8 团队与多 Agent (3 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **team-tool-gating** | tool.execute.before | 工具调用前 | 团队模式下工具访问门控，管理 1-8 个并行 Agent 的工具隔离 |
| **unstable-agent-babysitter** | event | Agent 不稳定时 | 监视不稳定 Agent 的行为，必要时重启或隔离 |
| **tasks-todowrite-disabler** | config | 配置加载时 | 在团队模式下禁用子 Agent 的 task/todowrite 能力 |

### 3.9 引导与初始化 (2 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **codegraph-bootstrap** | event | 首次启动时 | 初始化 CodeGraph（代码图索引系统） |
| **ast-grep-sg-provision** | event | 首次启动时 | 初始化 AST-Grep 结构化搜索的语法索引 |

### 3.10 命令与 Slash (2 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **auto-slash-command** | command.execute.before | 用户输入 slash 命令时 | 自动补全和路由 slash 命令 |
| **start-work** | command | 工作开始时 | 工作启动钩子，初始化工件和状态 |

### 3.11 验证与其他 (5 个)

| Hook 名称 | 类型 | 触发时机 | 职责 |
|-----------|------|---------|------|
| **tool-pair-validator** | tool.execute.before | 工具调用前 | 验证工具参数对（如 read 后的 edit 必须引用正确行） |
| **plan-format-validator** | tool.execute.before | task() 调用前 | 验证 plan 格式是否符合预期结构 |
| **read-image-resizer** | tool.execute.before | read 工具读取图片时 | 自动调整图片大小以减少 token 消耗 |
| **todo-description-override** | tool.definition | 工具定义时 | 覆盖 TodoWrite 工具的描述文本 |
| **legacy-plugin-toast** | config | 兼容旧插件时 | 向使用旧版插件接口的用户显示升级提示 |

### 3.12 claude-code-hooks 外部调度系统

除 59 个 OpenCode Hook 外，OMO 还维护了一套 **claude-code-hooks** 兼容层，通过 `hooks.ts` 配置文件将 Claude Code 的原生事件模型映射到外部 `hooks.json` 配置。

**支持的事件类型：**

| 事件 | 触发时机 | 对应 OpenCode Hook |
|------|---------|-------------------|
| `PreToolUse` | 工具执行前 | tool.execute.before |
| `PostToolUse` | 工具执行后 | tool.execute.after |
| `UserPromptSubmit` | 用户消息提交时 | chat.message |
| `Stop` | 会话停止时 | event |
| `PreCompact` | 上下文压缩前 | event |

外部 `hooks.json` 配置允许第三方开发者以声明式 JSON 文件注册 Hook Handler，无需修改 OMO 核心代码。这种设计将 OMO 的内部 Hook 体系开放给外部生态，类似于 OMO 的"插件中的插件"。

---

## 4. SLIM Hook 体系详解

### 4.1 挂载点 `config` — Agent 定义与配置合并

**位置：** `src/index.ts`  
**职责：** 在 OpenCode 配置加载阶段，合并所有 Agent 定义、模型配置、MCP 服务器、权限规则和自定义命令。

**处理流程：**

```
config(config)
  │
  ├─ 1. 遍历所有 Agent 定义
  │      ├─ 设置 Agent 角色和描述
  │      ├─ 设置 Agent 模型
  │      ├─ 注入 per-Agent 权限（allow/deny/ask）
  │      └─ 注入 Agent prompt
  │
  ├─ 2. 注册 MCP 服务器
  │      ├─ 遍历 Agent MCP 配置
  │      └─ 自动生成 MCP 权限规则
  │
  ├─ 3. 合并权限规则
  │      ├─ 通配符 `*` 处理
  │      └─ Skill 权限动态生成
  │
  └─ 4. 注册自定义命令
         ├─ /interview
         ├─ /preset
         ├─ /deepwork
         └─ /reflect
```

**关键设计：**

- 权限使用 OpenCode 原生的 `"allow"|"deny"|"ask"` 三级格式
- 支持 `*` 通配符作为 fallback：`'*': 'deny'` 表示默认拒绝所有工具
- orchestrator Agent 获得 `"*": "allow"`，其他 Agent 显式 allow 特定工具
- MCP 权限自动生成：遍历 Agent 的 MCP 列表生成 `<server>_*` 的 allow/deny 规则

### 4.2 挂载点 `event` — 中央事件路由器

**位置：** `src/index.ts`  
**职责：** 作为所有运行时事件的路由中心，将 OpenCode 的 `event` Hook 分发到多个子管理器。

**路由目标：**

| 事件类型 | 路由目标 | 职责 |
|---------|---------|------|
| `session.created` | SessionManager | 创建新的会话追踪记录 |
| `session.updated` | SessionManager / FallbackManager | 更新会话状态，检查是否需要回退 |
| `session.error` | FallbackManager | 触发模型回退逻辑 |
| `message.updated` | FallbackManager / TaskSessionManager | 检查错误模式，追踪 task 会话 |
| `session.status` (type: "retry") | FallbackManager | 重试事件处理 |
| 更新事件 | AutoUpdateChecker | 检查插件更新 |
| 其他事件 | MultiplexerSessionManager | 多路复用会话管理 |

**中央路由器实现模式：**

```typescript
// 示意：event hook 内部的路由逻辑
async function eventHook(event, context) {
  // 顺序执行，每个 handler try/catch 隔离
  await sessionManager.handleEvent(event, context)  // 会话追踪
  await fallbackManager.handleEvent(event, context)  // 模型回退
  await updateChecker.handleEvent(event, context)    // 更新检查
  await interviewManager.handleEvent(event, context) // 面试管理
  await taskSessionManager.handleEvent(event, context) // 任务追踪
  await companionManager.handleEvent(event, context) // 伴侣模式
}
```

### 4.3 挂载点 `tool.execute.before` — 预处理管道

**位置：** `src/index.ts`  
**职责：** 在工具执行前进行预处理和参数重写。

| 子处理 | 目标工具 | 职责 |
|-------|---------|------|
| apply_patch 重写 | `apply_patch` | 重写 patch 格式为 OpenCode 兼容格式 |
| task() 别名解析 | `task` | 解析 Agent 别名到完整 Agent 类型名 |

### 4.4 挂载点 `command.execute.before` — 命令路由

**位置：** `src/index.ts`  
**职责：** 路由用户输入的 /slash 命令到对应的处理模块。

| 命令 | 路由目标 | 职责 |
|------|---------|------|
| `/interview` | InterviewManager | 启动面试模式，收集用户项目需求 |
| `/preset` | PresetManager | 加载预设配置模板 |
| `/deepwork` | DeepworkHandler | 进入深度工作模式 |
| `/reflect` | ReflectHandler | 反思当前会话状态 |

### 4.5 挂载点 `chat.headers` — 身份注入（chat-headers Hook 模块）

**位置：** `src/hooks/chat-headers/`（子模块）  
**职责：** 为 GitHub Copilot 兼容模式注入 `x-initiator: agent` 头部，标记消息来源为 Agent 而非用户。

### 4.6 挂载点 `chat.message` — 会话映射

**位置：** `src/index.ts`  
**职责：** 追踪 sessionID 到 agentName 的映射关系，解析 Agent 别名到标准名称。

```typescript
// 核心映射：sessionID → agentName
const sessionAgentMap = new Map<string, string>()

async function chatMessageHook(messages) {
  const sessionId = getCurrentSessionId()
  const agentName = resolveAgentName(sessionId)
  sessionAgentMap.set(sessionId, agentName)
  // 别名解析：如 "orchestrator" → "build"
}
```

### 4.7 挂载点 `experimental.chat.system.transform` — 系统消息变换

**位置：** `src/index.ts`  
**职责：** 在系统消息构造时执行变换，是 SLIM 最关键的 Prompt 注入点。

| 变换操作 | 职责 |
|---------|------|
| 编排器 Prompt 注入 | 根据当前 Agent 类型注入对应的编排指令 prompt |
| 系统消息折叠 | 合并多条系统消息为一条，避免模型兼容问题 |

### 4.8 挂载点 `experimental.chat.messages.transform` — 消息变换管线

**位置：** `src/index.ts`  
**职责：** 在每次 LLM 调用前对消息列表进行全量变换，是 SLIM 最复杂的 Hook。

**变换管线：**

```
messages.transform
  │
  ├─ 1. 提及重写 (MentionRewrite)
  │      └─ 将 @agent 格式的提及转换为 task() 调用
  │
  ├─ 2. 图片剥离 (ImageHook)
  │      └─ 对不支持多模态的模型移除图片消息
  │
  ├─ 3. 任务板注入 (JobBoard)
  │      └─ 向编排器注入当前的任务板状态
  │
  ├─ 4. 阶段提醒注入 (PhaseReminder)
  │      └─ 在特定阶段注入工作流阶段提示
  │
  └─ 5. Skill 过滤 (FilterAvailableSkills)
         └─ 过滤当前 Agent 不可用的 Skill 列表
```

### 4.9 挂载点 `tool.execute.after` — 后处理管道

**位置：** `src/index.ts`  
**职责：** 在工具执行完成后进行结果检查和后处理。

| 子处理 | 目标工具 | 职责 |
|-------|---------|------|
| delegate-task-retry | `task` | 子 Agent 失败时匹配错误模式，提供修复建议 |
| json-error-recovery | 多种工具 | 检测 JSON 格式错误，追加修正提示 |
| post-file-tool-nudge | `write`/`edit` | 文件修改后提示用户检查差异 |
| task-session-manager | `task` | 追踪 task 调用的子会话生命周期 |

### 4.10 Hook 模块详解（13 个）

SLIM 将复杂逻辑拆分为 13 个独立子模块，每个模块聚焦一个功能点。

| 模块 | 关联顶层 Hook | 代码量估计 | 职责 |
|------|-------------|:---------:|------|
| **apply-patch** | tool.execute.before | ~50 行 | 重写 apply_patch 工具的格式 |
| **auto-update-checker** | event | ~100 行 | 定期检查插件更新 |
| **chat-headers** | chat.headers | ~30 行 | 注入 Agent 身份头部 |
| **deepwork** | command.execute.before | ~150 行 | 深度工作模式管理 |
| **delegate-task-retry** | tool.execute.after | ~60 行 | 子 Agent 失败重试引导 |
| **foreground-fallback** | event | ~386 行 | 前台模型回退管理器：11 个正则模式覆盖 429/rate limit/quota/budget/overloaded/resource_exhausted，5 秒去重窗口，4 种链解析策略 |
| **filter-available-skills** | messages.transform | ~80 行 | 过滤 Agent 不可用的 Skill |
| **image-hook** | messages.transform | ~50 行 | 图片消息剥离/降级 |
| **json-error-recovery** | tool.execute.after | ~80 行 | 21 个 JSON 错误模式检测，排除 bash/read/glob/webfetch |
| **phase-reminder** | messages.transform | ~100 行 | 工作流阶段提醒注入 |
| **post-file-tool-nudge** | tool.execute.after | ~50 行 | 文件修改后差异检查提示 |
| **reflect** | command.execute.before | ~100 行 | 会话反思命令处理 |
| **task-session-manager** | tool.execute.after + event | ~120 行 | 子会话生命周期追踪 |

### 4.11 额外消费者模块

这些模块不直接注册到 OpenCode Hook，而是被 `event` 中央路由器或其他 Hook 调用的独立消费者。

| 模块 | 消费方式 | 职责 |
|------|---------|------|
| **PresetManager** | 被 command.execute.before 调用 | 管理预设配置模板的加载、切换、保存 |
| **InterviewManager** | 被 command.execute.before + event 调用 | 管理用户面试流程（需求收集、项目分析） |
| **CompanionManager** | 被 event 调用 | 陪伴模式（持续背景对话助手） |
| **MultiplexerSessionManager** | 被 event 调用 | 多路复用会话管理（多个 Agent 共享同一 UI 会话） |
| **SubagentDepthTracker** | 被 tool.execute.before/after 调用 | 追踪子 Agent 委派深度，防止超过 3 层递归 |

---

## 5. OMP Hook 体系详解

### 5.1 HookAPI 核心事件体系

OMP 的 Hook 体系基于一个自定义的事件发射/订阅系统。核心类型定义如下：

```typescript
// 示意：OMP HookAPI 类型定义
interface HookAPI {
  // Session 生命周期
  on(event: 'session_start', handler: (ctx: Context) => void): void
  on(event: 'session_before_switch', handler: (ctx: Context) => void): void
  on(event: 'session_switch', handler: (ctx: Context) => void): void
  on(event: 'session_before_branch', handler: (ctx: Context) => void): void
  on(event: 'session_branch', handler: (ctx: Context) => void): void
  on(event: 'session_before_compact', handler: (ctx: Context) => void): void
  on(event: 'session_compacting', handler: (ctx: Context) => void): void
  on(event: 'session_compact', handler: (ctx: Context) => void): void
  on(event: 'session_shutdown', handler: (ctx: Context) => void): void
  on(event: 'session_before_tree', handler: (ctx: Context) => void): void
  on(event: 'session_tree', handler: (ctx: Context) => void): void

  // Agent/Turn 生命周期
  on(event: 'before_agent_start', handler: (ctx: Context) => void): void
  on(event: 'agent_start', handler: (ctx: Context) => void): void
  on(event: 'agent_end', handler: (ctx: Context) => void): void
  on(event: 'turn_start', handler: (ctx: Context) => void): void
  on(event: 'turn_end', handler: (ctx: Context) => void): void
  on(event: 'context', handler: (ctx: Context) => void): void
  on(event: 'goal_updated', handler: (ctx: Context) => void): void

  // 自动压缩/重试
  on(event: 'auto_compaction_start', handler: (ctx: Context) => void): void
  on(event: 'auto_compaction_end', handler: (ctx: Context) => void): void
  on(event: 'auto_retry_start', handler: (ctx: Context) => void): void
  on(event: 'auto_retry_end', handler: (ctx: Context) => void): void

  // TTSR/提醒
  on(event: 'ttsr_triggered', handler: (ctx: Context) => void): void
  on(event: 'todo_reminder', handler: (ctx: Context) => void): void

  // 工具
  on(event: 'tool_call', handler: (ctx: ToolCallContext) => void): void
  on(event: 'tool_result', handler: (ctx: ToolResultContext) => void): void
}
```

**`ctx` 上下文对象：** 所有事件 handler 接收的 `ctx` 对象提供对 TUI、会话、LLM 引擎等全部运行时能力的访问：

```
ctx.ui — TUI 接口（select, confirm, input, notify, setStatus, component）
ctx.session — 当前会话
ctx.llm — LLM 引擎引用
ctx.config — 配置对象
ctx.storage — 持久化存储
ctx.log — 日志记录器
```

### 5.2 Session 生命周期事件 (11 个)

OMP 的 Session 生命周期事件是三个项目中最**细粒度**的，覆盖了从创建到销毁的完整路径，包括分支、切换、压缩和树视图操作。

| 事件 | 触发时机 | 处理上下文 |
|------|---------|-----------|
| **session_start** | 新会话创建时 | 可获取初始配置、项目根目录 |
| **session_before_switch** | 会话切换前（从 A 切到 B） | 可获取当前 session 和目标 session、可阻断切换 |
| **session_switch** | 会话切换完成后 | 可获取新 session 的上下文 |
| **session_before_branch** | 会话分支前 | 可获取分支点、可阻断分支 |
| **session_branch** | 会话分支完成后 | 可获取新分支的 session ID |
| **session_before_compact** | 上下文压缩前 | 可获取即将被压缩的消息范围、可保护特定消息不被压缩 |
| **session_compacting** | 上下文压缩进行中 | 可获取当前压缩进度 |
| **session_compact** | 上下文压缩完成后 | 可获取压缩摘要、可检查被丢弃的内容 |
| **session_shutdown** | 会话关闭时 | 可执行清理操作、保存状态 |
| **session_before_tree** | 会话树视图显示前 | 可修改树的结构和元数据 |
| **session_tree** | 会话树视图显示后 | 可对树视图做后处理 |

**设计特点：** `session_before_switch` 和 `session_before_branch` 支持**阻断操作**，允许插件在特定条件不满足时阻止会话切换或分支。`session_compact` 系列事件（before/compacting/compact）提供了压缩全过程的可见性和控制权。

### 5.3 Agent/Turn 生命周期事件 (7 个)

| 事件 | 触发时机 | 处理上下文 |
|------|---------|-----------|
| **before_agent_start** | Agent 启动前 | 可获取 Agent 配置、可修改配置、可阻断启动 |
| **agent_start** | Agent 启动完成 | 可获取 Agent 实例和初始状态 |
| **agent_end** | Agent 结束时 | 可获取 Agent 最终状态、执行清理 |
| **turn_start** | 单个 Turn 开始时 | 可获取用户消息、可修改消息 |
| **turn_end** | 单个 Turn 结束时 | 可获取 Assistant 响应、可执行后处理 |
| **context** | 上下文构建时 | 可修改上下文内容（注入/删除消息） |
| **goal_updated** | 目标任务变化时 | 可获取新旧目标、可触发后续动作 |

**设计特点：** `before_agent_start` 与 `agent_start`/`agent_end` 形成完整的 Agent 生命周期钩子（before→start→end），支持在启动前修改配置。`turn_start`/`turn_end` 提供 Turn 级别的细粒度控制，这是 OMO/SLIM 不直接提供的粒度。

### 5.4 自动压缩/重试事件 (4 个)

| 事件 | 触发时机 | 处理上下文 |
|------|---------|-----------|
| **auto_compaction_start** | 自动上下文压缩开始时 | 可获取当前上下文指标（token 用量、消息数）、可修改压缩策略 |
| **auto_compaction_end** | 自动上下文压缩完成时 | 可获取压缩结果、token 节省量 |
| **auto_retry_start** | 自动重试开始时 | 可获取错误信息、已尝试次数、可修改重试策略 |
| **auto_retry_end** | 自动重试完成时 | 可获取最终结果（成功/失败） |

**设计特点：** OMP 将自动压缩和自动重试都作为一等事件暴露。`auto_retry_start` 允许修改重试策略（如切换模型、调整参数），`auto_compaction_start` 允许基于当前指标动态调整压缩策略。

### 5.5 TTSR/提醒事件 (2 个)

| 事件 | 触发时机 | 处理上下文 |
|------|---------|-----------|
| **ttsr_triggered** | Token 流违反规则时 | 可获取触发的规则、违规 token 序列、可注入修正提示 |
| **todo_reminder** | TODO 提醒触发时 | 可获取待办列表、可标记完成项 |

**设计特点：** `ttsr_triggered` 是 OMP 独有的创新事件——它在模型流式输出时实时检测 token 流是否违反预定义规则（如"不要使用某些 API"），一旦匹配立即触发中断并注入修正提示。这是其他两个项目没有的能力。

### 5.6 工具事件 (2 个)

| 事件 | 触发时机 | 处理上下文 |
|------|---------|-----------|
| **tool_call** | 工具调用时 | 可获取工具名、参数；支持 `block`（阻断）和 `reason`（阻断原因）；可修改参数 |
| **tool_result** | 工具返回结果时 | 可获取结果内容；可修改输出结果后再返回给 LLM |

**设计特点：** OMP 的 `tool_call` 事件支持两种阻断模式：`block` 用于无条件阻断，`reason` 用于带原因的阻断（类似 OMO SLIM 的 throw Error）。`tool_result` 允许修改结果，类似 SLIM 的 `tool.execute.after` 但粒度更细——可以精确修改特定工具的特定调用结果。

### 5.7 扩展事件体系 (15 个)

扩展事件提供了更细粒度的 LLM、工具和消息流控制。

| 类别 | 事件 | 触发时机 | 职责 |
|------|------|---------|------|
| **LLM 流** | `llm_stream_start` | LLM 开始输出流时 | 初始化流处理 |
| | `llm_stream_chunk` | LLM 输出每个 chunk 时 | 实时处理 token |
| | `llm_stream_end` | LLM 输出流结束时 | 最终化流处理 |
| | `llm_stream_error` | LLM 流输出错误时 | 错误处理 |
| **工具流** | `tool_stream_start` | 工具开始输出流时 | 初始化工具流 |
| | `tool_stream_chunk` | 工具输出每个 chunk 时 | 实时处理工具输出 |
| **消息流** | `message_start` | 消息处理开始时 | 消息预处理 |
| | `message_stream_chunk` | 消息流中 | 消息分段处理 |
| | `message_end` | 消息处理完成时 | 消息后处理 |
| **用户交互** | `user_bash` | 用户执行 bash 命令时 | 审计/拦截 bash 命令 |
| | `user_python` | 用户执行 python 代码时 | 审计/拦截 python 代码 |
| | `tool_approval` | 工具审批请求时 | 自定义审批逻辑 |
| **凭证** | `credentials` | 需要凭证时 | 自定义凭证获取逻辑 |
| **其他** | `config_reload` | 配置重载时 | 配置更新通知 |
| | `custom_event` | 用户自定义事件 | 通用扩展点 |

### 5.8 遥测回调体系 (6 个)

OMP 提供了 6 个专门用于遥测的 callback，独立于核心事件体系。

| 回调 | 触发时机 | 数据类型 |
|------|---------|---------|
| **onCostDelta** | 每次 LLM 调用后 | 成本增量（输入/输出 token 数 × 单价） |
| **onChatUsage** | 每次 LLM 调用后 | Token 用量明细（提示 token、完成 token、总计） |
| **onSpanStart** | 追踪 Span 开始时 | Span 元数据（名称、父 span ID、时间戳） |
| **onSpanEnd** | 追踪 Span 结束时 | Span 结果（持续时间、状态、元数据） |
| **onRunEnd** | 完整运行结束时 | 运行汇总（总 token、总成本、总时间） |
| **onTelemetryWarning** | 遥测异常时 | 警告信息（阈值超限、数据异常） |

**设计特点：** 遥测回调使用独立的接口，不与核心事件体系混合。这是有意的设计决策——遥测消费者通常需要同步接收数据，不应该被事件 handler 的异步行为阻塞。

### 5.9 TUI 集成接口

OMP 的 Hook handler 可以通过 `ctx.ui` 接口直接操作 TUI，这是 OMO/SLIM 作为 OpenCode 插件不具备的能力。

```typescript
// ctx.ui 提供的方法
interface TUIInterface {
  select<T>(options: SelectOption<T>[]): Promise<T>       // 选择器
  confirm(message: string): Promise<boolean>               // 确认对话框
  input(prompt: string): Promise<string>                   // 文本输入
  notify(message: string, level: 'info'|'warning'|'error'): void  // 通知
  setStatus(status: string): void                          // 状态栏更新
  component(name: string, props: any): void                // 自定义组件渲染
}
```

这种深度 TUI 集成的能力来源于 OMP 作为独立产品的定位——它不仅运行自己的 Agent 循环，还运行自己的终端界面。

---

## 6. 横向对比

### 6.1 Hook 模型对比

| 维度 | OMO | SLIM | OMP |
|------|:---:|:----:|:---:|
| **Hook 模型** | 回调函数注册 | 回调函数注册 | 事件发射/订阅 |
| **注册方式** | 工厂函数分组创建 | 单文件手动注册 | pi.on() 链式调用 |
| **阻断机制** | throw Error | throw Error | return { block: true, reason } |
| **参数修改** | 修改 output 对象 | 修改 output 对象 | 修改参数引用 |
| **结果修改** | 修改 output.result | 修改 output.result | 修改结果引用 |
| **异步支持** | ✅ Promise | ✅ Promise | ✅ Promise |
| **执行顺序** | 工厂注册顺序 | 数组中定义的顺序 | 订阅顺序 |
| **try/catch 隔离** | ✅ safeCreateHook | ✅ for 循环内 try/catch | ❌ 由消费者自己处理 |
| **条件启用** | ✅ isHookEnabled | ✅ 按子模块加载 | ✅ 按需订阅 |

### 6.2 生命周期覆盖对比

| 生命周期阶段 | OMO | SLIM | OMP |
|-------------|:---:|:----:|:---:|
| **插件加载时** | ✅ config | ✅ config | ❌ 不适用 |
| **配置加载时** | ✅ config | ✅ config | ✅ config_reload |
| **会话创建时** | ✅ event | ✅ event (session.created) | ✅ session_start |
| **会话切换时** | ❌ | ❌ | ✅ session_before_switch + session_switch |
| **会话分支时** | ❌ | ❌ | ✅ session_before_branch + session_branch |
| **会话关闭时** | ✅ event | ❌ | ✅ session_shutdown |
| **Agent 启动前** | ❌ | ❌ | ✅ before_agent_start |
| **Agent 启动后** | ❌ | ❌ | ✅ agent_start |
| **Agent 结束时** | ❌ | ❌ | ✅ agent_end |
| **Turn 开始时** | ❌ | ❌ | ✅ turn_start |
| **Turn 结束时** | ❌ | ❌ | ✅ turn_end |
| **工具调用前** | ✅ (10 个守卫) | ✅ (2 个处理) | ✅ tool_call (block/reason) |
| **工具调用后** | ✅ (7 个处理) | ✅ (4 个处理) | ✅ tool_result (modify) |
| **系统消息构造时** | ✅ | ✅ system.transform | ✅ context |
| **消息提交时** | ✅ chat.message | ✅ messages.transform | ❌ |
| **模型调用时** | ✅ (event) | ✅ (event) | ✅ (llm_stream 系列) |
| **会话压缩前** | ✅ (event) | ❌ | ✅ session_before_compact |
| **会话压缩后** | ✅ (event) | ❌ | ✅ session_compact |
| **命令执行前** | ✅ | ✅ | ❌ |
| **用户输入时** | ✅ | ✅ | ✅ message_start |

**发现：** OMP 在生命周期覆盖上最为完整，特别是 Agent/Turn 级别的生命周期和会话切换/分支事件是独有优势。OMO 在压缩管理和工具调用前后覆盖最全面。SLIM 注重实用性，覆盖关键节点但跳过细粒度事件。

### 6.3 工具拦截能力对比

| 能力维度 | OMO | SLIM | OMP |
|---------|:---:|:----:|:---:|
| **执行前阻断** | ✅ throw Error | ✅ throw Error | ✅ block + reason |
| **执行前修改参数** | ✅ output.args | ✅ output.args | ✅ 直接修改 |
| **执行后修改结果** | ✅ output.result | ✅ output.result | ✅ 直接修改 |
| **per-Agent 差异化** | ✅ Agent 解析 → 差异化守卫 | ✅ 有限的 per-Agent | ✅ 上下文中有 Agent 信息 |
| **per-工具差异化** | ✅ 工具名匹配 | ✅ 工具名匹配 | ✅ 工具名匹配 |
| **参数内容检查** | ✅ 文件路径检查 | ❌ | ✅ 参数内容分析 |
| **工具输出截断** | ✅ tool-output-truncator | ❌ | ❌ |
| **错误恢复** | ✅ 7 个子系统 | ✅ 3 个子模块 | ✅ HTTP 重试层 |
| **审批模式** | ❌ | ❌ | ✅ yolo/write/always-ask |

### 6.4 Compaction 处理对比

| 能力维度 | OMO | SLIM | OMP |
|---------|:---:|:----:|:---:|
| **主动压缩触发** | ✅ preemptive-compaction | ❌ 依赖 OpenCode 原生 | ✅ auto_compaction_start/end |
| **压缩前保护内容** | ✅ compaction-todo-preserver | ❌ | ✅ session_before_compact 中保护 |
| **压缩后恢复** | ✅ anthropic-context-window-limit-recovery | ❌ | ✅ auto_compaction_end 后处理 |
| **退化监控** | ✅ 连续 3 条无文本→恢复压缩 | ❌ | ❌ |
| **LLM 驱动压缩** | ❌ | ❌ | ✅ 通过 TTSR 和压缩事件 |
| **前缀缓存优化** | ❌ | ❌ | ✅ StablePrefix + AppendOnlyLog |
| **Nudge 系统** | ❌ | ❌ | ✅ 可自定义阈值和频率 |

### 6.5 模型管理对比

| 能力维度 | OMO | SLIM | OMP |
|---------|:---:|:----:|:---:|
| **模型回退** | ✅ runtime-fallback（50+ 文件） | ✅ foreground-fallback（~386 行） | ✅ fetch-retry（HTTP 层） |
| **per-Agent 模型绑定** | ✅ | ✅ | ✅ |
| **模型路由策略** | 基于链的回退 | 4 种链解析策略 | 单纯 HTTP 重试 |
| **去重窗口** | ✅ | ✅ 5 秒 | ❌ |
| **错误模式检测** | ✅ 60+ 正则模式 | ✅ 11 个正则模式 | ✅ HTTP 状态码 |
| **模型切换粒度** | per-Agent + per-Session | per-Agent + per-Session | 全局 |
| **重试策略** | 指数退避 + 3 次上限 | 链解析 + 模型数组 | 指数退避 + 5 次上限 |
| **per-Agent per-Model 约束** | ✅ no-sisyphus-gpt, no-hephaestus-non-gpt | ❌ | ❌ |

### 6.6 通知机制对比

| 能力维度 | OMO | SLIM | OMP |
|---------|:---:|:----:|:---:|
| **会话通知** | ✅ session-notification | ❌ | ❌（有 TUI 状态栏） |
| **后台通知** | ✅ background-notification | ❌ | ❌ |
| **版本更新通知** | ✅ auto-update-checker | ✅ auto-update-checker | ❌ |
| **TUI 通知** | ❌（无 TUI） | ❌（无 TUI） | ✅ ctx.ui.notify() |
| **状态栏** | ❌ | ❌ | ✅ ctx.ui.setStatus() |
| **插件化通知** | ❌ | ❌ | ✅ component() 自定义渲染 |

### 6.7 团队/多 Agent 支持对比

| 能力维度 | OMO | SLIM | OMP |
|---------|:---:|:----:|:---:|
| **并行 Agent** | ✅ Team Mode（1-8 个） | ❌ | ❌ |
| **Agent 间通信** | ✅ 团队邮箱 | ❌ | ❌ |
| **Agent 工具隔离** | ✅ team-tool-gating | ❌ | ❌ |
| **不稳定 Agent 监控** | ✅ unstable-agent-babysitter | ❌ | ❌ |
| **团队状态可视化** | ✅ tmux 布局 | ❌ | ❌ |
| **深度限制** | ❌（依赖配置） | ✅ SubagentDepthTracker（3 层） | ❌ |

### 6.8 TUI 集成对比

| 能力维度 | OMO | SLIM | OMP |
|---------|:---:|:----:|:---:|
| **是否拥有 TUI** | ❌ | ❌ | ✅ 自建 TUI |
| **选择器** | ❌ | ❌ | ✅ ctx.ui.select() |
| **确认对话框** | ❌ | ❌ | ✅ ctx.ui.confirm() |
| **文本输入** | ❌ | ❌ | ✅ ctx.ui.input() |
| **通知** | ❌（只能通过 OpenCode 日志） | ❌ | ✅ ctx.ui.notify() |
| **状态栏** | ❌ | ❌ | ✅ ctx.ui.setStatus() |
| **自定义组件** | ❌ | ❌ | ✅ ctx.ui.component() |

### 6.9 Hook 数量与覆盖率总表

| 类别 | OMO | SLIM | OMP |
|------|:---:|:----:|:---:|
| **Hook 注册数 / 挂载点使用数** | 59 个 Hook 注册到 12 个挂载点 | 13 个 Hook 模块注册到 9 个挂载点 | 47 个事件+回调（独立产品） |
| **Hook 模块 / 事件** | 分布在多个文件中 | 13 子模块 + 5 消费者 | 26 核心 + 15 扩展 + 6 遥测 |
| **工具执行前** | 10 | 2 | 1 + 阻断/理由两种模式 |
| **工具执行后** | 7 | 4 | 1 + 结果修改 |
| **Session 生命周期** | 7 | 3 事件 | 11 事件 |
| **Agent/Turn 生命周期** | 0 | 0 | 7 事件 |
| **压缩管理** | 4 | 0 | 3 事件 + 前缀缓存 |
| **模型管理** | 5 事件 | 1 事件 | HTTP 重试层 |
| **消息变换** | 7 | 2 transform | 3 消息事件 |
| **用户交互** | 0 | 0 | 3 用户交互事件 |
| **遥测** | 0 | 0 | 6 回调 |

---

## 7. 设计哲学对比

### 7.1 OMO: "全部拦截"哲学

OMO 的设计哲学可以概括为 **"宁可多拦截，不可漏拦截"**。59 个 Hook 覆盖了几乎所有的 OpenCode 可扩展点，形成了一张"密不透风"的拦截网。

**核心理念：**

1. **安全至上：** 5 层安全架构（L0-L4）确保每层都有独立的拦截能力，单层绕过不会导致全局失效
2. **per-Agent 极致差异化：** 每个 Agent 可以有完全不同的行为约束，从工具权限到模型绑定到文件写入范围
3. **预防胜于修复：** 工具预执行守卫（10 个）远多于工具后处理（7 个），优先在问题发生前阻断
4. **全生命周期覆盖：** 从配置加载到会话销毁，从工具调用到模型选择，每个关键节点都有 Hook

**代价：**

- **代码复杂度极高：** ~313k LOC，跨越数百个文件
- **学习曲线陡峭：** 新开发者需要理解 5 层安全架构和工厂化注册系统
- **性能开销：** 每次工具调用需要经过多个守卫链检查
- **维护负担：** 添加新功能可能需要修改多个工厂函数

**适用场景：** 大型团队、安全敏感环境、需要精细控制每个 Agent 行为的场景。

### 7.2 SLIM: "核心聚焦"哲学

SLIM 的设计哲学可以概括为 **"做少做好"**。9 个挂载点上注册 13 个 Hook 模块，专注于编排器最核心的需求，不追求全覆盖。

**核心理念：**

1. **80/20 原则：** 只用 9 个挂载点 + 13 个模块覆盖 80% 的编排需求，其余 20% 通过 OpenCode 原生机制解决
2. **轻量可维护：** 主文件 1237 行，所有 Hook 在单文件中可见，新开发者可以快速理解全貌
3. **组合而非继承：** 每个子模块是独立功能单元，通过简单数组组合到顶层 Hook 中
4. **错误恢复聚焦：** 只实现 L1+L2（输出修饰 + 模型回退），不碰 L3（全面恢复），ROI 优先

**代价：**

- **覆盖不足：** 缺少压缩管理、Team Mode、per-Agent 模型绑定等高级功能
- **扩展受限：** 单文件模式在功能超过一定阈值后会变得难以维护
- **功能深度浅：** JSON error recovery 只有 ~80 行，不如 OMO 专用的 JSON 错误处理子系统

**适用场景：** 中小型团队、快速原型、对复杂度敏感的项目。

### 7.3 OMP: "原生深度集成"哲学

OMP 的设计哲学可以概括为 **"深度拥有整个栈"**。作为独立产品，它不受 OpenCode 插件接口的限制，可以构建最适合自己需求的事件体系。

**核心理念：**

1. **端到端控制：** 从 TUI 到 Agent 循环到工具系统到 LLM 调用，全部自己实现，Hook 可以触及每一层
2. **细粒度事件：** 26 个核心事件提供了 OMO/SLIM 无法比拟的粒度（如 `session_before_switch`、`turn_start/end`）
3. **TUI 深度集成：** Hook handler 可以直接操作 UI，这是插件形式的 OMO/SLIM 不可能做到的
4. **性能优先：** StablePrefix + AppendOnlyLog 机制专为最大化 DeepSeek/Anthropic 前缀缓存命中率设计
5. **实时控制：** TTSR 事件能在 token 流中实时检测违规并中断，这是另两个项目没有的能力

**代价：**

- **生态隔离：** 不能使用 OpenCode 生态的 Agent、工具和配置格式
- **重复造轮子：** 需要自己实现 Agent 循环、工具系统、TUI 等基础设施
- **兼容性负担：** 需要兼容 Cursor MDC、Cline .clinerules、Codex AGENTS.md、Copilot 等 8 种格式

**适用场景：** 追求极致性能和深度控制的场景、独立产品、有完整栈开发能力的团队。

### 7.4 哲学对比总表

| 维度 | OMO | SLIM | OMP |
|------|:---:|:----:|:---:|
| **核心哲学** | 全部拦截 | 核心聚焦 | 原生深度集成 |
| **Hook 数量** | 59（最多） | 9（最少） | 47 事件+回调（适中） |
| **粒度** | 中 | 粗 | 最细 |
| **架构复杂度** | 最高 | 最低 | 中 |
| **安全性** | 最高（5 层） | 中（2 层） | 中（审批模式） |
| **可维护性** | 低 | 高 | 中 |
| **学习曲线** | 陡峭 | 平缓 | 中等 |
| **性能** | 守卫链开销 | 轻量 | 最优（前缀缓存） |
| **TUI 集成** | 无 | 无 | 深度集成 |
| **与 OpenCode 耦合** | 深度耦合 | 中等耦合 | 无耦合 |
| **错误恢复深度** | L3（全面） | L1+L2（聚焦） | HTTP 重试 |
| **团队/多 Agent** | ✅ 完整 | ❌ | ❌ |
| **事件粒度** | 工具/会话级 | 工具/会话级 | Turn/Agent/Session 三级 |
| **扩展性** | 工厂注册 | 数组组合 | 事件订阅 |

---

## 8. 对 ZooKeeper 的启示

ZooKeeper 当前使用 3 个 OpenCode 挂载点（config、tool.definition、tool.execute.before），采用声明式配置 + Prompt 注入的轻量架构。**长期目标是向 OMO 看齐：全量 Hook 覆盖、多层安全纵深、团队多 Agent、完善的错误恢复与压缩管理。**

本节按分阶段路线图组织：短期（SLIM 式的务实落地）→ 中期（OMO 子系统的逐步引入）→ 长期（OMO 级别全覆盖）。

### 8.1 总路线图

```
阶段           对标           核心目标
─────────────────────────────────────────────────────────
短期（当前）    SLIM 务实       补全基础挂载点，建立 Hook 模块化骨架
中期           OMO 子系统      引入错误恢复、压缩协作、per-Agent 守卫
长期           OMO 全覆盖      团队多 Agent、全量 Hook 注册、5 层安全
```

### 8.2 Hook 注册模式

**现状：** 3 个 Hook 回调直接内联在入口文件中，无模块拆分。

**路线：**

| 阶段 | 对标 | 动作 |
|:----:|------|------|
| **短期** | SLIM | 用子 Handler 数组替代内联回调——当单个挂载点内逻辑超过 3 个时，拆分为独立 handler 函数，用 for 循环 + try/catch 串联。比 OMO 工厂模式简单，但为后续拆分打好边界 |
| **中期** | OMO | 引入 `safeCreateHook()` 包装 + `isEnabled()` 开关——确保单个 handler 异常不断裂整个管道，支持通过 `config.toml` 开关各功能模块 |
| **长期** | OMO | 工厂化注册模式——当 Hook 数量超过 20 个时，按职责分组（`createGuardHooks()`、`createInjectionHooks()`、`createRecoveryHooks()` 等），匹配 OMO 的分组结构 |

**关键原则：** 不一步跳到完整工厂模式，但每一步都预留接口。短期用 SLIM 的数组风格，但 handler 签名和注册方式设计成未来可直接被 `safeCreateHook` 包装的形状。

### 8.3 挂载点覆盖

**现状：** 只用 `config`、`tool.definition`、`tool.execute.before` 三个挂载点。

**路线：**

| 阶段 | 挂载点 | 做什么 |
|:----:|--------|--------|
| **短期** | `tool.execute.after` | 已有 json-error-nudge、post-task-nudge 等逻辑，统一注册到此挂载点作为独立 Hook 模块 |
| **短期** | `event` | 监听 `session.error`、`session.idle`、`session.deleted` ——为中期错误恢复和 session 生命周期管理做准备 |
| **中期** | `experimental.chat.messages.transform` | 按需注入 verify-iterate 提示，替代现在全量写死在 build.md 的方式，实现 OMO 式的上下文注入管线 |
| **中期** | `chat.message` | 追踪 sessionID→agentName 映射，精确识别当前会话的 Agent 类型（SLIM 的 sessionAgentMap 模式） |
| **长期** | `experimental.chat.system.transform` | 注入编排器 system prompt，替代现在的静态 build.md |
| **长期** | `command.execute.before` | 支持自定义 slash 命令（如 `/preset`） |

### 8.4 错误恢复策略

**现状：** 基本无恢复——验证失败直接 throw。

**路线：**

| 阶段 | 对标 | 层级 | 动作 |
|:----:|------|:----:|------|
| **短期** | SLIM json-error-recovery | L1（追加提示） | 已有雏形——在 `tool.execute.after` 中匹配 JSON 错误模式，追加修正提示 |
| **短期** | SLIM delegate-task-retry | L1（追加提示） | 在 `tool.execute.after` 中检测 `task()` 失败模式，追加结构化修复建议（可用 Agent 列表、参数示例） |
| **中期** | SLIM foreground-fallback | L2（自动切换） | 扩展 `config.toml` 的 model 字段为数组，在 `event` Hook 中监听 429/rate limit 错误，自动切换到备选模型 |
| **中期** | OMO runtime-fallback | L2（自动切换） | 在回退链中支持 per-Agent 模型绑定、去重窗口、指数退避 |
| **长期** | OMO anthropic-context-window-limit-recovery | L3（全面恢复） | 检测 token 超限错误，自动截断大输出、触发 compaction、回退模型——OMO 50+ 文件级别的恢复系统作为终局目标 |

### 8.5 Compaction 协作

**现状：** 完全依赖 OpenCode 原生 compaction。

**路线：**

| 阶段 | 对标 | 动作 |
|:----:|------|------|
| **短期** | OMO preemptive-compaction | 在 `tool.execute.after` 中检测上下文使用率（通过 OpenCode 提供的 token 计数），超过阈值时在输出中追加压缩建议 |
| **中期** | OMO compaction-todo-preserver | 在压缩前捕获并保护关键的 task 工具输出（尤其是 ACCEPTANCE 字段），压缩后恢复——确保验证闭环不丢失 |
| **中期** | OMO compaction-context-injector | 在压缩时将活跃的后台 task 状态注入压缩 prompt，使压缩后的上下文仍保留编排进度信息 |
| **长期** | OMO 退化监控 | 监控 LLM 回复质量下降信号（连续短回复、反复重试同一工具），触发恢复性压缩 |

**与 DCP 的关系：** DCP（Dynamic Context Pruning）是独立的上下文裁剪插件。短期 ZooKeeper 应确保与 DCP 兼容（不冲突），中期在 compaction 协作上互为补充：DCP 做结构性裁剪，ZooKeeper 做语义保护（保护 task 输出、注入编排状态）。

### 8.6 多 Agent 支持

**现状：** 5 个 Agent（build、general、explore、spider），通过 `config.toml` 静态声明。

**路线：**

| 阶段 | 对标 | 动作 |
|:----:|------|------|
| **短期** | SLIM SubagentDepthTracker | 在 `tool.execute.before` 中追踪 task() 委派深度，防止无限递归。这是最低成本、最高收益的防御措施 |
| **中期** | OMO per-Agent 守卫 | 在每个挂载点中根据当前 session 所属 Agent 类型应用不同的检查逻辑——例如 build agent 才做三段式验证，explore agent 不注入 workflow 提示 |
| **中期** | OMO Agent 信息解析 | 实现 OMO 的三级解析：缓存（sessionAgentMap）→ 状态文件（session metadata）→ 消息回退（解析 message.agent） |
| **长期** | OMO Team Mode | 引入并行多 Agent 协作（1-N 个 worker + 1 个 lead），支持 Agent 间通信（team-mailbox）、工具隔离（team-tool-gating）、不稳定 Agent 监控（unstable-agent-babysitter） |

**关于"静态声明式"的说明：** 当前 ZooKeeper 的 `config.toml` 静态声明是优势——明确了权限边界，配置即文档。Team Mode 不需要推翻这一哲学，而是扩展它：在 `config.toml` 中声明 team 的组成结构和通信规则，在运行时由 Hook 模块强制执行。OMO 的 `hooks.json` 外部配置模式是很好的参照。

### 8.7 上下文注入管线

**现状：** Prompt 通过 `install.py` 在安装时静态注入 `build.md`，运行时不做动态注入。

**路线：**

| 阶段 | 对标 | 动作 |
|:----:|------|------|
| **短期** | SLIM phase-reminder | 在 `experimental.chat.messages.transform` 中按 Agent 类型动态注入工作流阶段提示，替代全量写死在 prompt 中的方式 |
| **中期** | OMO directory-agents-injector | 当文件被 read 时，查找并注入附近的 `AGENTS.md` 内容——让子 Agent 自动感知项目上下文 |
| **中期** | OMO filter-available-skills | 根据 per-Agent 权限过滤 `<available_skills>` 列表，与 `config.toml` 的 deny 规则联动 |
| **长期** | OMO 完整注入管线 | rules-injector（注入 .mdc/CLAUDE.md 规则）、directory-readme-injector（注入 README）、monitor-status-injector（注入监控状态）——形成 OMO 式的多层上下文注入网 |

### 8.8 安全架构纵深

**现状：** 单一层——`config.toml` deny 列表 + OpenCode permission 机制。

**路线（对标 OMO 5 层）：**

| 层 | OMO 实现 | ZooKeeper 状态 | 路线 |
|:--:|---------|:-------------:|------|
| L0 | 配置层（tool-config-handler） | ✅ `config.toml` deny 列表 | 已有 |
| L1 | SDK 权限层（frontier-tool-schema-guard） | ❌ | **中期：** 在 `tool.execute.before` 中实现工具 schema 级别校验 |
| L2 | Hook 守卫层（prometheus-md-only 等 10 个守卫） | 🟡 部分（task prompt 校验） | **中期：** 补齐文件操作守卫（覆盖写入检查、bash 文件读替代提示） |
| L3 | 工具定义层（disabled-tools） | ✅ OpenCode permission | 已有 |
| L4 | Agent 工具限制（per-agent tool restriction） | ✅ config.toml per-agent section | 已有 |

**长期目标：** L2 守卫数量达到 6-8 个，覆盖文件写入、bash 使用、task prompt 格式、JSON 格式、委派深度等关键防御点。

### 8.9 分阶段 Hook 数量目标

| 阶段 | 挂载点数 | Hook 模块数 | 关键新增 |
|:----:|:--------:|:----------:|---------|
| **当前** | 3 | ~4（内联） | config, tool.definition, tool.execute.before（含 json-error-nudge 等） |
| **短期** | 5 | 8-10 | + tool.execute.after（模块化）, + event（跟踪）, delegate-task-retry, depth-tracker |
| **中期** | 7 | 15-20 | + chat.message, + messages.transform, phase-reminder, filter-skills, foreground-fallback, 文件操作守卫（2-3 个） |
| **长期** | 9-12 | 25-40 | + system.transform, + command.execute.before, compaction-preserver, context-injector, rules-injector, Team Mode 相关（3-5 个） |

---

## 9. 总结

### 9.1 核心发现

1. **OMO 的 Hook 体系是"广度优先"的典范：** 59 个 Hook 覆盖了几乎所有 OpenCode 可扩展点，5 层安全架构提供了纵深防御。代价是 ~313k LOC 的代码量和极高的学习曲线——但这是全功能多 Agent 编排框架的必然成本，也是 ZooKeeper 的长期目标形态。

2. **SLIM 的 Hook 体系是"深度优先"的范本：** 9 个挂载点上 13 个 Hook 模块聚焦于编排器最核心的需求，代码量适中，可维护性好——是 ZooKeeper **短期落地**的最佳参照。但在高级功能（Team Mode、per-Agent 模型绑定）上有明显缺失，这些缺口正是向 OMO 演进时需要填补的。

3. **OMP 的 Hook 体系展示了"从零构建"的可能性：** 47 个事件+回调覆盖了从 TUI 到 Agent 循环到 LLM 调用的完整链路。TTSR 流规则匹配是独有创新。但作为独立产品，无法享受 OpenCode 生态的便利——ZooKeeper 作为 OpenCode 插件不需要走这条路。

### 9.2 关键对比

| 维度 | 胜出者 | 理由 |
|------|:------:|------|
| **Hook 数量** | OMO | 59 个，全量注册 |
| **生命周期覆盖** | OMP | 26 个核心事件，Session/Agent/Turn 三级覆盖 |
| **工具拦截粒度** | OMP | block + reason 双模式，参数/结果均可修改 |
| **错误恢复深度** | OMO | 50+ 文件的全面恢复系统 |
| **可维护性** | SLIM | 单文件注册 + 独立子模块 |
| **安全性** | OMO | 5 层安全架构，纵深防御 |
| **性能** | OMP | StablePrefix + AppendOnlyLog，前缀缓存最优 |
| **团队多 Agent** | OMO | 唯一支持并行 Agent + Agent 间通信 |
| **TUI 集成** | OMP | 唯一拥有自建 TUI 的项目 |
| **易学性** | SLIM | 9 个挂载点 + 13 个模块，主文件 1237 行 |

### 9.3 三者的共同盲区

1. **缺少 LLM 行为测试：** 三个项目都只测试代码正确性，不测试 prompt 对 LLM 行为的实际影响
2. **缺少 Hook 执行顺序的显式管理：** OMO 和 SLIM 都依赖数组顺序 / 编号顺序，OMP 依赖订阅顺序，都没有显式的依赖声明
3. **缺少 Hook 超时保护：** 没有项目为 Hook handler 设置执行超时，单个 handler 阻塞会导致整个 Hook 管道卡死
4. **缺少 Hook 度量：** 没有项目跟踪每个 Hook 的执行耗时、成功率、阻断率等性能指标

### 9.4 ZooKeeper 的演进路径

以 OMO 为终局目标，ZooKeeper 采用"用 SLIM 的方法走到 OMO"的策略：

| 原则 | 说明 |
|------|------|
| **短期务实** | 每个阶段只引入当下需要的 Hook 模块，用 SLIM 式的数组串联而非 OMO 式的工厂注册 |
| **架构预留** | handler 签名、模块边界、配置开关从第一天就设计成可平滑过渡到 OMO 式 `safeCreateHook` + `isEnabled` 的形状 |
| **不跳步** | 不在 Hook 数量只有 4 个时搭建 50 个 Hook 的管理框架，但当 Hook 超过 10 个时立即分组 |
| **安全纵深逐步构建** | 已有 L0/L3/L4 层，短期补齐 L1（schema 校验），中期补齐 L2 守卫体系 |
| **Team Mode 是长期里程碑** | 当前优先做好单编排器的工作流质量，多 Agent 协作在 Hook 基础设施成熟后自然引入 |

---

## 10. 参考资料

### OMO (oh-my-openagent)

| 文件 | 内容 |
|------|------|
| `packages/omo-opencode/src/config/schema/hooks.ts` | 59 个 Hook 注册入口 |
| `src/index.ts` | 插件入口 |
| `src/plugin-interface.ts` | 12 个 OpenCode hook 处理程序映射 |
| `src/plugin-module.ts` | createPluginModule() 工厂 |
| `src/hooks/runtime-fallback/` | 运行时回退（50+ 文件） |
| `src/hooks/session-recovery/` | 会话恢复系统 |
| `src/hooks/preemptive-compaction/` | 主动压缩 |
| `src/hooks/anthropic-context-window-limit/` | Anthropic 上下文限制恢复 |
| `src/agents/sisyphus-agent-factory.ts` | 主 agent 工厂 |
| `src/shared/agent-tool-restrictions.ts` | 权限常量 |
| `claude-code-hooks/` | 外部 hooks.json 兼容层 |

### SLIM (oh-my-opencode-slim)

| 文件 | 内容 |
|------|------|
| `src/index.ts` | 组合根（9 个挂载点 + 13 个 Hook 模块注册） |
| `src/hooks/foreground-fallback/` | 前台模型回退（~386 行） |
| `src/hooks/json-error-nudge/` | JSON 错误恢复 |
| `src/hooks/delegate-task-retry/` | 委托重试 |
| `src/hooks/filter-available-skills/` | Skill 可用性过滤 |
| `src/hooks/phase-reminder/` | 阶段提醒注入 |
| `src/hooks/task-session-manager/` | 任务会话管理器 |
| `src/agents/orchestrator.ts` | 编排器 prompt 构建 |
| `src/config/loader.ts` | 分层配置加载 |
| `src/council/council-manager.ts` | 多 LLM 共识（可选） |

### OMP (oh-my-pi)

| 文件 | 内容 |
|------|------|
| `packages/agent/src/agent-loop.ts` | 核心 agent 循环（26 个事件发射点） |
| `packages/agent/src/append-only-context.ts` | StablePrefix + AppendOnlyLog |
| `packages/coding-agent/src/tools/approval.ts` | 审批分级 |
| `packages/coding-agent/src/session/agent-session.ts` | ACP 权限门控 |
| `packages/utils/src/fetch-retry.ts` | HTTP 重试层 |
| `packages/hashline/` | 哈希编辑系统 |
| `packages/agent/src/ttsr.ts` | TTSR 流规则匹配 |
| 扩展事件定义 | LLM 流/工具流/消息流事件 |
| 遥测回调 | onCostDelta, onChatUsage, onSpanStart/End, onRunEnd, onTelemetryWarning |

### ZooKeeper 相关文档

- `docs/opencode-plugin-mechanism.md` — OpenCode 插件机制与 OMO 参考实现
- `docs/agent-framework-comparison.md` — 编排框架横向对比

---

> **文档维护说明：** 本报告基于 2026-06-21 的代码状态编写。由于三个项目都在快速迭代中，Hook 数量和分类可能发生变化。建议每季度更新一次，或在重大版本发布后更新。
