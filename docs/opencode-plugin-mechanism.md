# OpenCode 插件机制与 OMO 参考实现

**版本:** 1.0  
**日期:** 2026-06-03  
**分类:** 技术架构文档  

---

## 目录

1. [概述](#1-概述)
2. [OpenCode 插件机制](#2-opencode-插件机制)
   - 2.1 [插件签名与类型定义](#21-插件签名与类型定义)
   - 2.2 [PluginInput 接口](#22-plugininput-接口)
   - 2.3 [Hooks 系统](#23-hooks-系统)
   - 2.4 [权限系统](#24-权限系统)
   - 2.5 [插件加载方式](#25-插件加载方式)
   - 2.6 [npm 包自动安装](#26-npm-包自动安装)
   - 2.7 [进程内执行模型](#27-进程内执行模型)
3. [OMO 参考实现](#3-omo-oh-my-openagent-参考实现)
   - 3.1 [项目架构总览](#31-项目架构总览)
   - 3.2 [入口与模块导出](#32-入口与模块导出)
   - 3.3 [server() 启动流程](#33-server-启动流程)
   - 3.4 [插件接口映射层](#34-插件接口映射层)
   - 3.5 [多层安全架构](#35-多层安全架构)
   - 3.6 [Agent 解析机制](#36-agent-解析机制)
   - 3.7 [Hook 管道与处理链](#37-hook-管道与处理链)
   - 3.8 [工具定义过滤](#38-工具定义过滤)
4. [多层约束模型详解](#4-多层约束模型详解)
   - 4.1 [L0 — 配置层（tool-config-handler）](#41-l0--配置层tool-config-handler)
   - 4.2 [L1 — SDK 权限层（frontier-tool-schema-guard）](#42-l1--sdk-权限层frontier-tool-schema-guard)
   - 4.3 [L2 — Hook 守卫层（prometheus-md-only）](#43-l2--hook-守卫层prometheus-md-only)
   - 4.4 [L3 — 工具定义层（disabled-tools）](#44-l3--工具定义层disabled-tools)
   - 4.5 [L4 — Agent 工具限制（agent-tool-restrictions）](#45-l4--agent-工具限制agent-tool-restrictions)
5. [权限粒度与 Glob 规则](#5-权限粒度与-glob-规则)
6. [全局禁用与按 Agent 禁用](#6-全局禁用与按-agent-禁用)
7. [最佳实践与常见模式](#7-最佳实践与常见模式)
8. [总结](#8-总结)
9. [子 Agent 上下文隔离机制](#9-子-agent-上下文隔离机制)
   - 9.1 [上下文隔离策略](#91-上下文隔离策略)
   - 9.2 [提示词解析与文件引用](#92-提示词解析与文件引用)
   - 9.3 [工作目录与文件系统共享](#93-工作目录与文件系统共享)
   - 9.4 [权限继承与推导](#94-权限继承与推导)
   - 9.5 [任务输出与可见性](#95-任务输出与可见性)
   - 9.6 [Task ID 恢复与会话复用](#96-task-id-恢复与会话复用)
   - 9.7 [总结](#97-总结)

---

## 1. 概述

OpenCode 是一个基于 AI Agent 的代码开发平台，支持通过插件机制扩展核心功能。插件以 Node.js 模块的形式运行在 OpenCode 的 Bun 运行时中，通过声明式 Hook 接口与平台交互。

OMO（`oh-my-openagent`）是一个大型参考实现（约 31.3 万行代码），展示如何通过 OpenCode 插件机制构建复杂的多 Agent 编排系统。它实现了多层安全架构，在配置阶段、工具定义阶段和运行时阶段分别施加约束，确保 Agent 行为符合预期。

本文档从技术视角客观分析 OpenCode 的插件机制，并以 OMO 为参考案例，深入剖析其多层安全架构的设计与实现。

---

## 2. OpenCode 插件机制

### 2.1 插件签名与类型定义

OpenCode 插件是一个异步函数，接收 `PluginInput` 和可选的 `PluginOptions`，返回一个 `Hooks` 对象。

```typescript
type Plugin = (
  input: PluginInput,
  options?: PluginOptions
) => Promise<Hooks>
```

插件可以以两种形式导出：

**形式一：直接导出 Plugin 函数**

```typescript
// src/index.ts
export default async function myPlugin(input: PluginInput) {
  return {
    config(config) {
      // 修改配置
    },
    "tool.execute.before"(input, output) {
      // 拦截工具调用
    },
  }
}
```

**形式二：导出 PluginModule 对象（OMO 采用的方式）**

```typescript
// src/index.ts
import { createPluginModule } from "./plugin-module"

export const pluginModule = createPluginModule({
  id: "omo",
  name: "Oh My OpenAgent",
  // ...
})
```

`PluginModule` 是一个包含 `server()` 方法的对象，`server()` 返回 `Hooks`：

```typescript
interface PluginModule {
  id: string              // 运行时强制要求（尽管 TS 类型标注为可选 id?: string）
  name?: string
  version?: string
  server: (input: PluginInput) => Hooks | Promise<Hooks>
}
```

> **⚠️ 关键限制：`file://` 路径插件不支持函数导出形式。**
>
> 当插件通过 `opencode.json` 的 `plugin` 数组以文件路径（相对路径、绝对路径或 `file://` URL）加载时，
> OpenCode 的 `file://` 路径插件加载器仅识别 `PluginModule` 对象导出格式
> （`export default { id, server }`）。`export default async function` 形式会导致运行时无法
> 识别插件，抛出 "not a valid plugin" 错误。
>
> **`id` 字段的运行时要求：**
> 尽管 `@opencode-ai/plugin` 的 TypeScript 类型将 `PluginModule.id` 标记为可选
> （`id?: string`），运行时加载器在解析 `file://` 路径插件时**强制要求 `id`**。
> 缺少 `id` 会抛出：`"Path plugin ... must export id"`。

### 2.2 PluginInput 接口

插件被加载时，OpenCode 平台会注入一个 `PluginInput` 对象，提供访问平台核心能力的入口：

```typescript
interface PluginInput {
  client: ReturnType<typeof createOpencodeClient>  // OpenCode 客户端 API
  project: Project                                  // 项目级 API
  directory: string                                 // 当前工作目录
  worktree: string                                  // 工作树路径
  $: BunShell                                       // 安全的 Shell 执行接口
  serverUrl?: URL                                   // 服务器 URL（远程模式时可用）
  experimental_workspace?: { register(type: string, adapter: WorkspaceAdapter): void }  // 实验性的工作区 API
}
```

各字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| `client` | `ReturnType<typeof createOpencodeClient>` | 提供 `getSession()`、`resolveAgent()` 等方法，用于查询运行时会话信息 |
| `project` | `Project` | 项目元数据和配置的访问接口 |
| `directory` | `string` | 插件被加载时所在的项目根目录 |
| `worktree` | `string` | 当前工作树路径 |
| `$` | `BunShell` | 经过沙箱化的 Shell 执行接口，受 OpenCode 权限系统管控 |
| `serverUrl` | `URL` | 当 OpenCode 以客户端-服务器模式运行时，远程服务器的 URL |
| `experimental_workspace` | `{ register(type: string, adapter: WorkspaceAdapter): void }` | 实验性 API，用于注册自定义工作区适配器 |

### 2.3 Hooks 系统

插件通过返回的 `Hooks` 对象在平台生命周期各阶段注册回调。OpenCode 目前提供了 25 个以上的 Hook 点。

#### 2.3.1 核心 Hook 类别

| 类别 | Hook 名称 | 触发时机 | 用途 |
|------|-----------|---------|------|
| **配置** | `config` | 配置加载/合并时 | 修改 Agent 配置、工具定义、权限设置 |
| **工具执行前** | `tool.execute.before` | Agent 发起工具调用时 | 拦截、阻断或修改工具参数 |
| **工具执行后** | `tool.execute.after` | 工具调用完成后 | 检查或修改工具执行结果 |
| **工具定义** | `tool.definition` | 工具定义构造时 | 注册自定义工具或修改现有工具定义 |
| **聊天消息** | `chat.message` | 消息被发送给 LLM 时 | 修改或注入聊天消息 |
| **Shell 环境** | `shell.env` | 执行 Shell 命令时 | 注入环境变量 |
| **事件** | `event` | 平台事件触发时 | 响应各类平台事件 |
| **工具注册** | `tool` | 工具系统初始化时 | 注册新的自定义工具 |
| **实验性** | `experimental.chat.system.transform` | 系统消息构造时 | 转换或增强系统提示 |

#### 2.3.2 config Hook

`config` Hook 是最常用的 Hook 之一，它在 OpenCode 加载和合并配置时被调用。插件可以在不直接修改 `opencode.json` 文件的前提下，动态修改 Agent 配置、工具定义和权限设置。

```typescript
config: (config: Config) => void
```

**行为特点：**
- **就地修改（mutate in-place）：** 插件直接修改传入的 `config` 对象，不需要返回值
- **无返回值：** 返回 `void`，平台使用修改后的 `config` 对象继续处理
- **执行时机：** 在所有配置源（`opencode.json`、默认配置、CLI 参数）合并之后

```typescript
// 示例：在 config hook 中动态注入权限
config(config) {
  const agent = config.agent?.build
  if (agent) {
    agent.permission = {
      ...agent.permission,
      grep: "deny",
      glob: "deny",
      webfetch: "deny",
    }
  }
}
```

#### 2.3.3 tool.execute.before Hook

`tool.execute.before` 是运行时拦截工具调用的核心 Hook。它在 Agent 发起工具调用但尚未实际执行时触发。

```typescript
type ToolExecuteBeforeHook = (
  input: ToolExecuteBeforeInput,
  output: ToolExecuteBeforeOutput
) => void | Promise<void>
```

**Input 结构：**

```typescript
interface ToolExecuteBeforeInput {
  tool: string           // 工具名称，如 "grep", "edit", "bash"
  sessionID: string      // 当前会话 ID
  callID: string         // 当前工具调用 ID
  args?: Record<string, unknown>  // 工具参数
}
```

**Output 结构：**

```typescript
interface ToolExecuteBeforeOutput {
  args?: Record<string, unknown>  // 可以修改工具参数
}
```

**阻断方式：** 通过 `throw new Error()` 来阻断工具调用：

```typescript
"tool.execute.before"(input, output) {
  if (input.tool === "grep") {
    throw new Error("[Guard] grep 已被阻断，请通过 task() 委托给子 Agent")
  }
}
```

当插件抛出错误时，OpenCode 平台会将该错误信息返回给 LLM，LLM 可以看到错误内容并调整行为。

#### 2.3.4 tool.execute.after Hook

在工具执行完成后触发，可以检查或修改执行结果：

```typescript
"tool.execute.after"(input, output) {
  // input.tool — 工具名称
  // output.result — 工具执行结果
  console.log(`Tool ${input.tool} completed with result length: ${output.result?.length}`)
}
```

#### 2.3.5 tool.definition Hook

在工具定义被构造时触发，逐个修改已有工具的定义，而非整体过滤工具列表：

```typescript
"tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>
```

该 Hook 通过修改 `output.description` 和 `output.parameters` 来改变单个工具的定义，而非返回过滤后的数组。

#### 2.3.6 chat.message Hook

在消息被发送给 LLM 之前触发，可以修改消息内容：

```typescript
"chat.message"(messages: ChatMessage[]) {
  // 注入系统消息或修改已有消息
  messages.unshift({
    role: "system",
    content: "额外的系统指令",
  })
}
```

#### 2.3.7 shell.env Hook

在 Shell 命令执行前触发，用于注入环境变量：

```typescript
"shell.env"(env: Record<string, string>) {
  env.MY_CUSTOM_VAR = "value"
}
```

### 2.4 权限系统

OpenCode 提供了一套细粒度的权限系统，支持对 15 个可 deny 的 key 进行访问控制。

#### 2.4.1 权限级别

每个权限 key 可以取以下三个值之一：

| 级别 | 值 | 行为 |
|------|-----|------|
| 允许 | `"allow"` | 工具可见且可用，无额外确认 |
| 询问 | `"ask"` | 每次调用前询问用户确认 |
| 拒绝 | `"deny"` | 工具从 Agent 的工具列表中移除，LLM 不可见 |

#### 2.4.2 可 deny 的权限 key

OpenCode 支持 15 个可控制权限的内置 key：

| Key | 对应工具/能力 | 说明 |
|-----|--------------|------|
| `read` | 文件读取 | `read` 工具 |
| `edit` | 文件编辑 | `edit`、`write` 工具 |
| `glob` | 文件模式搜索 | `glob` 工具 |
| `grep` | 内容搜索 | `grep` 工具 |
| `bash` | Shell 命令 | `bash` 工具 |
| `task` | 子 Agent 委派 | `task` 工具 |
| `skill` | 技能加载 | `skill` 工具 |
| `lsp` | 语言服务器协议 | LSP 相关工具 |
| `list` | 目录列表 | `list` 工具 |
| `external_directory` | 外部目录访问 | 访问项目外目录的能力 |
| `webfetch` | 网页抓取 | `webfetch` 工具 |
| `websearch` | 网络搜索 | `websearch` 工具 |
| `question` | 用户提问 | 向用户提问的能力 |
| `doom_loop` | 循环操作 | 防止无限循环的保护 |
| `todowrite` | TODO 写入 | 待办事项写入能力 |

#### 2.4.3 Glob 级别的细粒度规则

对于 `bash` 等关键工具，OpenCode 支持使用 Glob 模式进行更细粒度的控制：

```json
{
  "permission": {
    "bash": {
      "git *": "allow",
      "npm *": "allow",
      "rm *": "deny",
      "sudo *": "deny",
      "> /etc/*": "ask"
    }
  }
}
```

当值为对象时，key 为 Shell 命令的 Glob 模式（匹配命令前缀），值为对应的权限级别：

```typescript
// 权限匹配逻辑（伪代码）
function checkPermission(tool: string, command: string): "allow" | "ask" | "deny" {
  const rules = permission[tool]
  if (typeof rules === "string") return rules
  // 按定义顺序匹配 Glob 模式
  for (const [pattern, level] of Object.entries(rules)) {
    if (minimatch(command, pattern)) return level
  }
  return "allow" // 默认允许
}
```

#### 2.4.4 权限在配置中的位置

```json
{
  "agent": {
    "build": {
      "permission": {
        "grep": "deny",
        "glob": "deny",
        "bash": {
          "git *": "allow",
          "rm *": "deny"
        }
      }
    }
  }
}
```

### 2.5 插件加载方式

OpenCode 支持三种插件加载方式，由 `opencode.json` 的 `plugin` 字段控制。

#### 2.5.1 方式一：自动目录发现

将插件放在 `.opencode/plugins/` 目录下，OpenCode 自动发现并加载：

```
.opencode/plugins/
├── my-plugin/
│   └── index.ts
├── another-plugin/
│   ├── index.ts
│   └── package.json
```

无需在 `opencode.json` 中显式配置。

#### 2.5.2 方式二：字符串数组

在 `opencode.json` 的 `plugin` 字段中直接列出插件路径：

```json
{
  "plugin": [
    "./path/to/my-plugin/src/index.ts",
    "./path/to/another-plugin/dist/index.js"
  ]
}
```

路径可以是相对路径或绝对路径。Bun 运行时支持直接加载 `.ts` 文件，无需预先编译。

#### 2.5.3 方式三：数组-with-options 元组

为每个插件提供独立配置选项：

```json
{
  "plugin": [
    ["./path/to/my-plugin/src/index.ts", { "option1": "value1" }],
    "./path/to/simple-plugin/index.ts",
    ["@opencode-ai/omo", { "mode": "strict" }]
  ]
}
```

每个数组元素要么是字符串（插件路径），要么是 `[path, options]` 元组。`options` 对象会在加载时作为 `PluginOptions` 传入插件函数。

#### 2.5.4 加载顺序

插件按 `plugin` 数组中的顺序依次加载。当多个插件同时修改同一个配置项时，后加载的插件可能会覆盖先加载的修改。因此，插件的加载顺序很重要：

```json
{
  "plugin": [
    "@opencode-ai/omo",           // 先加载 OMO 基础插件
    "./my-override-plugin.ts"     // 后加载覆盖插件
  ]
}
```

### 2.6 npm 包自动安装

OpenCode 支持直接引用 npm 包名作为插件。如果指定的包尚未安装，OpenCode 会通过 Bun 自动安装：

```json
{
  "plugin": [
    "@opencode-ai/omo",
    "my-custom-plugin"
  ]
}
```

当 OpenCode 启动时，如果 `node_modules/` 中没有找到对应包，它会自动执行 `bun install` 或 `npm install`。

### 2.7 进程内执行模型

OpenCode 插件运行在 OpenCode 主进程的 Bun 运行时中，与平台共享同一进程空间：

```
┌─────────────────────────────────────────────────────────┐
│                   OpenCode 进程 (Bun)                    │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Agent A  │  │ Agent B  │  │ Agent C  │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       │              │              │                    │
│  ┌────▼──────────────▼──────────────▼─────┐             │
│  │           Hook 管道 (顺序执行)          │             │
│  │                                         │             │
│  │  Plugin 1 → Plugin 2 → Plugin 3 → ...  │             │
│  └─────────────────┬───────────────────────┘             │
│                    │                                     │
│  ┌─────────────────▼───────────────────────┐             │
│  │           工具执行引擎                   │             │
│  └─────────────────────────────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

**进程内模型的特点：**

| 特性 | 说明 |
|------|------|
| 延迟 | 接近零（直接函数调用，无 IPC） |
| 状态共享 | 插件之间可以通过进程内 Map、缓存等共享状态 |
| 错误传播 | 插件抛出的 Error 直接传递到平台异常处理 |
| 序列化 | 无需 JSON 序列化/反序列化 |
| 资源隔离 | 插件共享同一进程，需要自行管理资源 |

---

## 3. OMO (oh-my-openagent) 参考实现

OMO 是一个基于 OpenCode 插件机制构建的多 Agent 编排参考实现。它展示了如何利用 OpenCode 的 Hook 系统和权限机制，实现复杂的 Agent 行为控制和安全策略。

### 3.1 项目架构总览

```
omo/
├── src/
│   ├── index.ts                          # 入口：导出 PluginModule
│   ├── server.ts                         # server() 函数：启动流程
│   ├── plugin-interface.ts               # 插件接口映射层
│   ├── plugin-module.ts                  # createPluginModule() 工厂
│   │
│   ├── plugin-handlers/
│   │   ├── tool-config-handler.ts         # L0 配置层
│   │   └── ...
│   │
│   ├── agents/
│   │   ├── frontier-tool-schema-guard.ts  # L1 SDK 权限层
│   │   └── agent-tool-restrictions.ts     # L4 Agent 工具限制
│   │
│   ├── hooks/
│   │   ├── prometheus-md-only/            # L2 Hook 守卫层
│   │   │   ├── hook.ts                    # 主 Hook 逻辑
│   │   │   ├── agent-resolution.ts        # Agent 解析
│   │   │   ├── agent-matcher.ts           # Agent 匹配
│   │   │   ├── path-policy.ts             # 路径策略
│   │   │   └── constants.ts               # 常量定义
│   │   └── ...
│   │
│   └── shared/
│       └── disabled-tools.ts              # L3 工具定义过滤
```

### 3.2 入口与模块导出

OMO 的入口文件 `src/index.ts` 导出一个 `PluginModule` 对象：

```typescript
// src/index.ts
import { createPluginModule } from "./plugin-module"

export const pluginModule = createPluginModule({
  id: "omo",
  name: "Oh My OpenAgent",
  version: "1.0.0",
  // server 方法在 plugin-module.ts 中定义
})
```

`createPluginModule()` 是一个工厂函数，用于创建符合 OpenCode 插件接口规范的模块对象：

```typescript
// plugin-module.ts（简化示意，实际实现更复杂）
export function createPluginModule(options: {
  id: string
  name?: string
  version?: string
}): PluginModule {
  return {
    id: options.id,
    name: options.name,
    version: options.version,
    async server(input: PluginInput): Promise<Hooks> {
      // 初始化逻辑...
      return {
        config: ...,
        "tool.execute.before": ...,
        // 其他 Hook
      }
    },
  }
}
```

### 3.3 server() 启动流程

`server()` 是插件的核心启动函数，负责初始化所有组件并组装 Hook 对象。其执行流程为：

```
server(input)
  │
  ├─ 1. 启动检查（环境验证、依赖检查）
  │
  ├─ 2. 加载配置（读取插件自己的配置，与平台配置合并）
  │
  ├─ 3. 创建管理器（SessionManager、ToolManager、AgentManager 等）
  │
  ├─ 4. 创建 Hook 处理函数
  │   ├─ 创建 config handler
  │   ├─ 创建 tool.execute.before handler
  │   ├─ 创建 tool.execute.after handler
  │   └─ 创建其他 Hook handler
  │
  ├─ 5. 创建插件接口（建立 Hook 与生命周期事件的映射）
  │
  └─ 6. 返回 Hooks 对象
```

```typescript
// server.ts（简化示意，实际实现更复杂）
export async function server(input: PluginInput): Promise<Hooks> {
  // 步骤 1: 启动检查
  await runStartupChecks(input)

  // 步骤 2: 加载配置
  const config = await loadPluginConfig()

  // 步骤 3: 创建管理器
  const sessionManager = new SessionManager(input.client)
  const toolManager = new ToolManager()

  // 步骤 4: 创建 Hook 处理函数
  const configHandler = createConfigHandler(config)
  const toolBeforeHandler = createToolBeforeHandler({
    sessionManager,
    toolManager,
    config,
  })

  // 步骤 5: 创建插件接口
  const pluginInterface = createPluginInterface({
    configHandler,
    toolBeforeHandler,
    // ...
  })

  // 步骤 6: 返回 Hooks
  return pluginInterface.getHooks()
}
```

### 3.4 插件接口映射层

`plugin-interface.ts` 负责将 OMO 内部的事件处理系统映射到 OpenCode 的 Hook 接口：

```typescript
// plugin-interface.ts（简化示意，实际实现更复杂）
export function createPluginInterface(handlers: HandlerMap): PluginInterface {
  return {
    getHooks(): Hooks {
      return {
        config: (config) => {
          handlers.configHandler.handle(config)
        },

        "tool.execute.before": (input, output) => {
          handlers.toolBeforeHandler.handle(input, output)
        },

        "tool.execute.after": (input, output) => {
          handlers.toolAfterHandler.handle(input, output)
        },

        "tool.definition": (tools) => {
          return handlers.toolDefinitionHandler.handle(tools)
        },

        "tool": (toolRegistry) => {
          handlers.toolRegistrationHandler.handle(toolRegistry)
        },

        "chat.message": (messages) => {
          handlers.chatMessageHandler.handle(messages)
        },
      }
    },
  }
}
```

这种映射模式使得 OMO 的内部事件处理系统与 OpenCode 的 Hook 接口解耦，方便单元测试和内部重构。

### 3.5 多层安全架构

OMO 最核心的设计是**五层安全架构**，从不同阶段和不同粒度对 Agent 行为进行约束：

| 层级 | 名称 | 阶段 | 机制 | 强度 |
|------|------|------|------|------|
| L0 | 配置层 | 配置加载时 | `tool-config-handler.ts` — 全局工具禁用、per-Agent 权限注入 | 静态 |
| L1 | SDK 权限层 | 配置组装时 | `frontier-tool-schema-guard.ts` — 基于模型设置 SDK 级 deny | 静态 |
| L2 | Hook 守卫层 | 工具执行时 | `prometheus-md-only/hook.ts` — 运行时阻断非法操作 | 动态 |
| L3 | 工具定义层 | 工具构造时 | `disabled-tools.ts` — 从注册表中过滤工具 | 静态 |
| L4 | Agent 限制层 | 运行前 | `agent-tool-restrictions.ts` — per-Agent per-subAgent 拒绝列表 | 静态 |

### 3.6 Agent 解析机制

在 Hook 守卫层（L2）中，需要准确识别当前工具调用属于哪个 Agent。OMO 实现了三级的 Agent 解析机制。

#### 3.6.1 三级解析策略

`agent-resolution.ts` 实现了 `getAgentFromSession()` 函数，按以下优先级解析：

```
getAgentFromSession(sessionID)
  │
  ├─ 第一级：内存会话缓存
  │   (最快，命中已缓存的 session 信息)
  │
  ├─ 第二级：Boulder 状态文件
  │   (从磁盘 JSON 读取持久化的会话状态)
  │
  └─ 第三级：消息文件回退
      (从最新的消息文件中解析 Agent 信息)
```

```typescript
// agent-resolution.ts（简化示意，实际实现更复杂）
export async function getAgentFromSession(
  client: ClientAPI,
  sessionID: string
): Promise<AgentInfo | null> {
  // 第一级：内存缓存
  const cached = sessionCache.get(sessionID)
  if (cached) return cached

  // 第二级：Boulder 状态文件
  try {
    const boulderState = await readBoulderState(sessionID)
    if (boulderState?.agent) {
      sessionCache.set(sessionID, boulderState.agent)
      return boulderState.agent
    }
  } catch {
    // 忽略错误，继续下一级
  }

  // 第三级：消息文件回退
  try {
    const agentInfo = await resolveFromMessageFile(client, sessionID)
    if (agentInfo) {
      sessionCache.set(sessionID, agentInfo)
      return agentInfo
    }
  } catch {
    // 忽略错误
  }

  return null
}
```

#### 3.6.2 Agent 匹配

`agent-matcher.ts` 提供 Agent 匹配逻辑，用于判断当前 session 是否属于特定 Agent：

```typescript
// agent-matcher.ts（简化示意，实际实现更复杂）
export function isPrometheusAgent(agentInfo: AgentInfo): boolean {
  const name = agentInfo.name?.toLowerCase() ?? ""
  return name.includes("prometheus") || name.includes("prom")
}

export function isBuildAgent(agentInfo: AgentInfo): boolean {
  const name = agentInfo.name?.toLowerCase() ?? ""
  return name === "build" || name === "orchestrator"
}
```

### 3.7 Hook 管道与处理链

`tool.execute.before` Hook 内部维护了一个**子 Hook 链**（chain of sub-hooks），每个子 Hook 按顺序执行：

```
tool.execute.before(input, output)
  │
  ├─ 1. writeExistingFileGuard        # 检查写已有文件的合法性
  │
  ├─ 2. notepadWriteGuard             # 检查记事本写入的合法性
  │
  ├─ 3. prometheusMdOnly              # 检查 Prometheus Agent 是否只写 .omo/*.md
  │
  ├─ 4. ...其他子 Hook...
  │
  └─ 全部通过 → 工具继续执行
     任何子 Hook throw Error → 工具被阻断
```

```typescript
// hook.ts 中 prometheusMdOnly 的实现（简化示意，实际实现更复杂，核心逻辑约 82 行）
async function prometheusMdOnly(
  input: ToolExecuteBeforeInput,
  output: ToolExecuteBeforeOutput
): Promise<void> {
  // 步骤 1: 获取 Agent 信息
  const agent = await getAgentFromSession(client, input.sessionID)
  if (!agent) return // 无法识别 Agent，放行

  // 步骤 2: 判断是否是 Prometheus Agent
  if (!isPrometheusAgent(agent)) return // 非目标 Agent，放行

  // 步骤 3: 获取工具名称和参数
  const toolName = input.tool
  const args = input.args ?? {}

  // 步骤 4: 检查是否是受限制的操作
  // 只限制 Write/Edit 操作
  if (toolName !== "write" && toolName !== "edit") return

  // 步骤 5: 检查文件路径
  const filePath = (args as any).filePath ?? (args as any).path ?? ""
  if (isAllowedFile(filePath)) return // 允许写入 .omo/*.md

  // 步骤 6: 阻断
  throw new Error(
    `[OMOPrometheusGuard] Prometheus Agent 只能在 .omo/*.md 文件中写入。` +
    `尝试写入 "${filePath}" 被阻断。`
  )
}
```

### 3.8 工具定义过滤

`disabled-tools.ts` 在工具定义被构造时从注册表中过滤掉已禁用的工具：

```typescript
// disabled-tools.ts（简化示意，实际实现更复杂）
const DISABLED_TOOLS = new Set([
  "repo_clone",
  "repo_overview",
])

export function filterDisabledTools(
  tools: ToolDefinition[],
  additionalDisabled?: string[]
): ToolDefinition[] {
  const disabled = new Set(DISABLED_TOOLS)
  if (additionalDisabled) {
    additionalDisabled.forEach(t => disabled.add(t))
  }
  return tools.filter(t => !disabled.has(t.name))
}
```

这个过滤器是通过 `tool.definition` Hook 注入的：

```typescript
"tool.definition"(tools) {
  return filterDisabledTools(tools, this.config.disabledTools)
}
```

---

## 4. 多层约束模型详解

以下对 OMO 的五层安全架构进行逐层深入分析。

### 4.1 L0 — 配置层（tool-config-handler）

`tool-config-handler.ts` 在配置阶段工作，负责：

1. **全局工具禁用：** 在 Agent 配置中标记不应出现的工具
2. **per-Agent 权限注入：** 为每个 Agent 注入其专属的权限配置

```typescript
// tool-config-handler.ts（简化示意，实际实现更复杂）
export function handleToolConfig(
  config: Config,
  toolPolicy: ToolPolicy
): void {
  const agents = config.agent ?? {}

  for (const [agentName, agentConfig] of Object.entries(agents)) {
    if (typeof agentConfig !== "object" || agentConfig === null) continue

    const agentPolicy = toolPolicy.getAgentPolicy(agentName)
    if (!agentPolicy) continue

    // 注入 per-Agent 的 permission 设置
    agentConfig.permission = {
      ...agentConfig.permission,
      ...agentPolicy.permissions,
    }

    // 注入 per-Agent 的禁用工具列表
    if (agentPolicy.disabledTools?.length) {
      agentConfig.disabledTools = [
        ...(agentConfig.disabledTools ?? []),
        ...agentPolicy.disabledTools,
      ]
    }
  }
}
```

这个 handler 在 `config` Hook 中被调用：

```typescript
config(config) {
  handleToolConfig(config, toolPolicy)
}
```

### 4.2 L1 — SDK 权限层（frontier-tool-schema-guard）

`frontier-tool-schema-guard.ts` 在配置组装阶段工作，根据 Agent 使用的模型自动设置权限。

**核心逻辑：** 检查模型名称，如果是指定的"前沿模型"（如 Opus 4.7、GPT 5.5），则自动对某些工具设置 `"deny"` 权限。

```typescript
// frontier-tool-schema-guard.ts（简化示意，实际实现更复杂）
const FRONTIER_MODELS = [
  "opus-4.7",
  "opus-4.7-*",
  "gpt-5.5",
  "gpt-5.5-*",
  "claude-opus-4*",
]

const FRONTIER_DENY_RULES: Record<string, "deny"> = {
  grep: "deny",
  glob: "deny",
}

export function applyFrontierToolGuard(
  config: Config
): void {
  const agents = config.agent ?? {}

  for (const [agentName, agentConfig] of Object.entries(agents)) {
    if (typeof agentConfig !== "object" || agentConfig === null) continue

    const modelName = agentConfig.model ?? ""
    const isFrontier = FRONTIER_MODELS.some(pattern =>
      minimatch(modelName, pattern)
    )

    if (!isFrontier) continue

    // 对前沿模型注入额外的 deny 规则
    agentConfig.permission = {
      ...agentConfig.permission,
      ...FRONTIER_DENY_RULES,
    }
  }
}
```

**设计意图：** 前沿模型（Opus 4.7、GPT 5.5）成本高、能力强大，但同时也可能产生更多不可控的行为。限制它们的 `grep` 和 `glob` 工具，强制通过子 Agent（更便宜的模型）来执行搜索操作，既能控制成本，又能通过子 Agent 的隔离来增加安全性。

### 4.3 L2 — Hook 守卫层（prometheus-md-only）

`prometheus-md-only/hook.ts` 是运行时动态守卫层，在工具即将执行时进行检查。这是整个架构中唯一的**动态**检查点。

**完整流程：**

```
Agent 调用 write / edit 工具
  │
  ├─→ getAgentFromSession(sessionID)
  │    ├─ 内存缓存命中？→ 返回
  │    ├─ Boulder 状态命中？→ 返回
  │    └─ 消息文件回退 → 返回
  │
  ├─→ isPrometheusAgent(agentInfo)
  │    ├─ 是 Prometheus？→ 继续检查
  │    └─ 不是 Prometheus？→ 放行
  │
  ├─→ 工具名称匹配
  │    ├─ 是 write 或 edit？→ 继续检查
  │    └─ 其他工具？→ 放行
  │
  ├─→ isAllowedFile(filePath)
  │    ├─ 路径在 .omo/*.md 内？→ 放行
  │    └─ 路径不在 .omo/*.md 内？→ 阻断
  │
  └─→ throw new Error("Prometheus Agent 只能在 .omo/*.md 中写入")
```

**路径策略**（`path-policy.ts`）：

```typescript
// path-policy.ts（简化示意，实际实现更复杂）
export function isAllowedFile(filePath: string): boolean {
  // 只允许写入 .omo/ 目录下的 .md 文件
  const normalized = filePath.replace(/\\/g, "/")
  return (
    normalized.startsWith(".omo/") &&
    normalized.endsWith(".md")
  ) || (
    normalized.startsWith("/.omo/") &&
    normalized.endsWith(".md")
  )
}
```

### 4.4 L3 — 工具定义层（disabled-tools）

这一层在工具定义被构造时发挥作用，通过 `tool.definition` Hook 从 Agent 的工具列表中移除指定工具。

```typescript
// 在插件中注册（简化示意，实际实现更复杂）
"tool.definition"(tools: ToolDefinition[]) {
  // 从工具注册表中移除已禁用的工具
  return tools.filter(tool => !isGloballyDisabled(tool.name))
}
```

与 L1（SDK 权限层）的区别：

| 维度 | L1 SDK 权限层 | L3 工具定义层 |
|------|---------------|---------------|
| 机制 | 设置 permission 为 "deny" | 从工具列表中直接移除 |
| 效果 | 工具在列表中但被标记为不可用 | 工具根本不在列表中 |
| LLM 可见性 | 可能看到工具但标记为不可用 | 完全看不到工具 |
| 实现方式 | 修改 AgentConfig.permission | 过滤 ToolDefinition[] |

### 4.5 L4 — Agent 工具限制（agent-tool-restrictions）

这一层为每个 Agent 及其子 Agent 维护独立的工具拒绝列表，在委托会话（task 调用）时生效。

```typescript
// agent-tool-restrictions.ts（简化示意，实际实现更复杂）
const AGENT_TOOL_RESTRICTIONS: Record<string, string[]> = {
  build: {
    subAgents: {
      explore: ["edit", "write", "bash"],
      general: ["grep", "glob", "webfetch"],
      spider: ["edit", "write"],
    },
  },
}

export function getRestrictionsForSubAgent(
  parentAgent: string,
  subAgentType: string
): string[] {
  return AGENT_TOOL_RESTRICTIONS[parentAgent]?.subAgents[subAgentType] ?? []
}
```

---

## 5. 权限粒度与 Glob 规则

### 5.1 静态规则 vs 动态规则

| 规则类型 | 定义位置 | 示例 | 评估时机 |
|---------|---------|------|---------|
| 静态 deny | `permission` 配置 | `"grep": "deny"` | 配置加载时 |
| Glob 规则 | `permission` 配置 | `"bash": {"git *": "allow"}` | 工具调用时（动态匹配） |
| 运行时阻断 | Hook 代码 | `throw new Error()` | 工具调用时（动态判定） |

### 5.2 Glob 规则匹配示例

```json
{
  "permission": {
    "bash": {
      "git *": "allow",
      "npm *": "allow",
      "bun *": "allow",
      "ls *": "allow",
      "cat *": "allow",
      "echo *": "allow",
      "mkdir *": "allow",
      "rm *": "deny",
      "sudo *": "deny",
      "curl *": "ask",
      "wget *": "ask",
      "* install *": "ask"
    },
    "edit": {
      "*.md": "allow",
      "*.ts": "allow",
      "*.json": "allow",
      "*": "ask"
    }
  }
}
```

### 5.3 规则优先级

当存在多层权限规则时，优先级如下（从高到低）：

1. **Hook 运行时阻断**（L2）— 最高优先级，在代码中硬编码
2. **工具定义过滤**（L3）— 从注册表移除
3. **SDK 权限 Glob 规则**（L1）— 精确模式匹配
4. **SDK 权限字符串规则**（L1）— `"allow"`/`"ask"`/`"deny"`
5. **配置层注入规则**（L0）— 默认配置

---

## 6. 全局禁用与按 Agent 禁用

### 6.1 全局禁用

在 Agent 的 `permission` 中设置，对所有使用该 Agent 的会话生效：

```json
{
  "agent": {
    "build": {
      "permission": {
        "grep": "deny",
        "glob": "deny"
      }
    }
  }
}
```

### 6.2 按 Agent 类型禁用

在 OMO 中，可以为同一个 Agent 的不同运行模式设置不同的权限：

```typescript
const AGENT_PERMISSIONS: Record<string, PermissionConfig> = {
  build: {
    grep: "deny",
    glob: "deny",
    webfetch: "deny",
  },
  explore: {
    edit: "deny",
    write: "deny",
    bash: {
      "rm *": "deny",
      "sudo *": "deny",
    },
  },
  spider: {
    edit: "deny",
    write: "deny",
  },
}
```

### 6.3 按子 Agent 类型禁用

当父 Agent 通过 `task()` 委托子 Agent 时，可以为不同的子 Agent 类型设置不同的工具限制：

```typescript
// 在 agent-tool-restrictions.ts 中
export function getAgentToolDenyList(
  parentAgentType: string,
  subAgentType: string
): string[] {
  const restrictions: Record<string, Record<string, string[]>> = {
    orchestrator: {
      explore: ["edit", "write"],
      general: ["grep", "glob", "webfetch"],
      spider: ["edit", "write"],
    },
  }
  return restrictions[parentAgentType]?.[subAgentType] ?? []
}
```

---

## 7. 最佳实践与常见模式

### 7.1 双重防线模式

**原则：** 永远不要只依赖一层防护。推荐同时使用静态配置 deny 和运行时 Hook deny。

```typescript
// 插件入口
export default async function guardPlugin(input: PluginInput) {
  const BLOCKED_TOOLS = ["grep", "glob", "rm", "sudo"]

  return {
    // L1: 配置层 — 静态 deny（SDK 级别）
    config(config) {
      for (const agent of Object.values(config.agent ?? {})) {
        if (typeof agent !== "object" || agent === null) continue
        for (const tool of BLOCKED_TOOLS) {
          ;(agent as any).permission = {
            ...((agent as any).permission ?? {}),
            [tool]: "deny",
          }
        }
      }
    },

    // L2: 运行时层 — 动态阻断（Hook 级别）
    "tool.execute.before"(input, output) {
      if (BLOCKED_TOOLS.includes(input.tool)) {
        throw new Error(`[Guard] "${input.tool}" 已被阻断`)
      }
    },
  }
}
```

### 7.2 Agent 感知模式

在 Hook 中准确识别当前会话所属的 Agent，实现 per-Agent 的策略差异化：

```typescript
"tool.execute.before"(input, output) {
  const agentName = sessionCache.get(input.sessionID) ?? "unknown"

  const AGENT_POLICY: Record<string, string[]> = {
    build: ["grep", "glob"],
    explore: ["edit", "write"],
    spider: ["edit", "write", "bash"],
  }

  const blocked = AGENT_POLICY[agentName] ?? []

  if (blocked.includes(input.tool)) {
    throw new Error(
      `[Guard] Agent "${agentName}" 不允许使用 "${input.tool}"`
    )
  }
}
```

### 7.3 错误消息注入模式

阻断工具调用时，返回有意义的错误消息，指导 LLM 采取正确的替代行为：

```typescript
"tool.execute.before"(input, output) {
  if (input.tool === "grep") {
    throw new Error(
      `[OrchestratorGuard] "grep" 已被阻断以防止编排器直接进行代码搜索。` +
      `请使用 task(subagent_type="explore", prompt="...") 委托给 explore Agent 执行搜索。`
    )
  }
}
```

错误消息会被 OpenCode 返给 LLM，LLM 可以根据错误提示调整行为。

### 7.4 状态共享模式

利用进程内模型，在多个 Hook 调用之间共享状态：

```typescript
const toolCallCounts = new Map<string, number>()

export default async function rateLimitPlugin() {
  return {
    "tool.execute.before"(input, output) {
      const count = (toolCallCounts.get(input.tool) ?? 0) + 1
      toolCallCounts.set(input.tool, count)

      if (count > 10) {
        throw new Error(`[RateLimit] "${input.tool}" 调用次数已达上限`)
      }
    },
  }
}
```

### 7.5 参数修改模式

通过修改 `output.args`，在工具执行前更改其参数：

```typescript
"tool.execute.before"(input, output) {
  if (input.tool === "bash" && input.args?.command) {
    // 自动给 npm install 添加 --no-audit 标志
    const cmd: string = input.args.command
    if (cmd.startsWith("npm install") && !cmd.includes("--no-audit")) {
      output.args = {
        ...input.args,
        command: cmd + " --no-audit",
      }
    }
  }
}
```

---

## 8. 总结

### 8.1 OpenCode 插件机制核心要点

| 维度 | 要点 |
|------|------|
| **加载方式** | 自动目录发现、配置数组、数组-with-options 元组 |
| **运行时** | Bun 运行时，支持直接加载 .ts 文件 |
| **通信模型** | 进程内函数调用，零延迟 |
| **核心接口** | `Plugin = (input, options?) => Promise<Hooks>` |
| **Hook 种类** | 25+，覆盖配置、工具执行、聊天消息、Shell 环境等 |
| **权限级别** | allow / ask / deny 三级 |
| **权限粒度** | 15+ 内置 key，支持 Glob 模式精确匹配 |
| **npm 支持** | 自动安装未安装的 npm 包 |

### 8.2 OMO 参考实现核心设计

| 维度 | 要点 |
|------|------|
| **入口** | `createPluginModule()` 工厂函数导出 `PluginModule` |
| **启动流程** | 检查 → 加载配置 → 创建管理器 → 创建 Hook → 创建接口 |
| **安全架构** | 五层（L0~L4），配置/权限/运行时/定义/限制 |
| **Agent 解析** | 三级缓存：内存 → Boulder 状态 → 消息文件 |
| **Hook 管道** | 顺序执行的子 Hook 链，任一可阻断 |
| **隔离粒度** | 全局、per-Agent、per-SubAgent、per-Model |

### 8.3 适用场景

**OpenCode 插件机制适用于：**
- 自定义 Agent 行为和安全策略
- 注入动态配置和权限
- 拦截和修改工具调用
- 注册新的工具和能力
- 监控和审计 Agent 行为

**OMO 参考实现模式适用于：**
- 多 Agent 编排系统的安全控制
- 基于模型能力的分级权限管理
- 运行时动态 Agent 识别和行为控制
- 跨 Agent 类型的工具访问隔离
- 需要多重安全保障的高风险操作管控

---

## 9. 子 Agent 上下文隔离机制

子 Agent（Sub-agent）是 OpenCode 中通过 `Task` 工具生成的子会话 Agent。父 Agent 使用 `task(subagent_type="...", prompt="...")` 调用创建子 Agent 执行特定任务。本章分析子 Agent 与父 Agent 之间的上下文隔离策略、权限继承机制以及任务输出模型。

### 9.1 上下文隔离策略

子 Agent 的核心设计原则是**最小上下文原则**——子 Agent 仅获得父 Agent 显式传入的 `prompt` 参数文本，不继承任何父 Agent 的对话上下文：

| 继承项 | 是否继承 | 说明 |
|--------|----------|------|
| `prompt` 参数文本 | ✅ 是 | 唯一的信息传递通道 |
| 父 Agent 对话历史 | ❌ 否 | 子 Agent 启动全新会话 |
| 父 Agent 工具输出 | ❌ 否 | 工具执行结果不自动传递 |
| 父 Agent 系统提示词 | ❌ 否 | 子 Agent 使用自己的系统提示词 |
| 父 Agent 配置文件 | ❌ 否 | 子 Agent 重新加载自身配置 |

**源代码分析：** 在 `task.ts` 中，子 Agent 提示词的解析仅处理 `params.prompt` 参数，不涉及父 Agent 的消息列表：

```typescript
// task.ts — 提示词解析核心逻辑
const promptParts = await resolvePromptParts(params.prompt)
```

`resolvePromptParts` 函数仅接收 `prompt` 字符串作为输入，不访问父会话的 `messages[]` 数组。这意味着父 Agent 的所有历史对话、中间推理步骤、工具调用结果等均**不会**泄漏到子 Agent 的上下文中。

**设计意图：** 这种严格的隔离策略确保子 Agent 不会被父 Agent 的上下文噪声干扰，每次执行都是"干净"的。父 Agent 必须在 `prompt` 参数中显式提供子 Agent 完成任务所需的全部关键信息（如函数签名、变量名、代码片段等）。

### 9.2 提示词解析与文件引用

`resolvePromptParts` 函数不仅处理纯文本，还支持 `@file` 引用语法，自动将指定文件内容注入到提示词中：

```
task(subagent_type="general", prompt="请重构 src/utils.ts 中的 parseConfig 函数，源文件内容：@src/utils.ts")
```

`@file` 引用在解析时被替换为对应文件的完整内容，这使得父 Agent 可以精确控制子 Agent 能"看到"哪些代码，而无需手动复制粘贴。

**处理流程：**

```
用户 prompt 文本
    │
    ▼
resolvePromptParts(params.prompt)
    │
    ├─ 解析 @file 引用
    │      │
    │      ▼
    │  读取文件内容 → 替换引用标记
    │
    └─ 返回完整提示词字符串
           │
           ▼
      子 Agent 作为首条用户消息
```

**示例：** 如果 `prompt` 为 `"请修改 @src/config.ts 中的 timeout 值"`，`resolvePromptParts` 会读取 `src/config.ts` 的内容并嵌入到提示词中，最终子 Agent 收到的消息包含完整的配置文件内容。

### 9.3 工作目录与文件系统共享

尽管对话上下文严格隔离，子 Agent 与父 Agent **共享同一个项目目录（worktree）**。这意味着：

- 子 Agent 可以读取项目中的任何文件（受权限规则约束）
- 子 Agent 可以修改、创建、删除文件（受权限规则约束）
- 文件系统的修改对父 Agent 立即可见
- 同一时刻只能有一个 Agent 写入文件（OpenCode 的并发控制机制）

**设计权衡：** 文件系统共享是必要的——子 Agent 的输出最终需要落地到项目文件中。但这也意味着父 Agent 在生成子 Agent 之前，应确保自身的文件状态已提交或保存，避免并发修改冲突。

### 9.4 权限继承与推导

子 Agent 的权限并非从零开始，而是从父 Agent 会话**继承并推导**而来。相关实现在 `subagent-permissions.ts` 的 `deriveSubagentSessionPermission()` 函数中：

```typescript
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **session's** deny rules and external_directory rules —
 *    same forwarding the original code already did.
 * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
```

**权限推导规则总结：**

| 权限项 | 继承策略 | 说明 |
|--------|----------|------|
| `editDenyRules` | ✅ 继承 | 继承父 Agent 的 **edit 类** deny 规则（防止绕过 Plan 模式） |
| `deny` | ✅ 继承 | 父会话拒绝的路径/操作子 Agent 同样拒绝 |
| `external_directory` | ✅ 继承 | 外部目录访问规则一致 |
| `todowrite` | ❌ 条件性 deny | 条件性 deny — 仅当子 Agent 自身配置未允许时才拒绝 |
| `task` | ❌ 条件性 deny | 条件性 deny — 仅当子 Agent 自身配置未允许时才拒绝 |

**关键安全设计：**

1. **`editDenyRules` 继承**：这是 Plan 模式安全性的基石。如果父 Agent 处于 Plan 模式（禁止直接编辑文件），子 Agent 同样继承该限制，无法绕过父 Agent 的安全约束。

2. **`todowrite` 和 `task` 默认拒绝**：这两个工具如果允许子 Agent 使用，可能导致递归失控（子 Agent 生成子 Agent，无限嵌套）或任务管理混乱。除非在 Agent 配置中显式启用，否则子 Agent 无法调用这两个工具。

3. **`deny` 和 `external_directory` 继承**：确保子 Agent 遵守父会话的文件访问边界，不能访问被明确拒绝的路径。

### 9.5 任务输出与可见性

子 Agent 完成执行后，其输出以结构化 XML 格式返回给父 Agent：

```xml
<task id="sessionID" state="completed">
<task_result>
...子 Agent 的完整输出文本...
</task_result>
</task>
```

**输出模型特点：**

| 特性 | 说明 |
|------|------|
| 返回格式 | XML 包裹的完整文本 |
| 包含内容 | 子 Agent 的所有推理过程、工具调用结果 |
| 用户可见性 | ❌ **不可见** — 用户看不到子 Agent 的内部输出 |
| 父 Agent 角色 | 必须自行读取 `task_result` 并**总结**给用户 |

**设计意图：** 子 Agent 的输出对用户透明，用户只看到父 Agent 的最终响应。父 Agent 负责解析子 Agent 的结果并提炼成用户可读的摘要。这种设计使得多 Agent 协作对用户而言是"单一对话"体验，避免用户被多个 Agent 的输出淹没。

### 9.6 Task ID 恢复与会话复用

当父 Agent 使用 `task_id` 参数恢复一个之前的子 Agent 任务时，OpenCode 会复用已有的子 Agent 会话：

```typescript
// task.ts — Task ID 恢复逻辑（Effect 风格）
const session = params.task_id
  ? yield* sessions.get(SessionID.make(params.task_id))
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  : undefined

if (session) {
  // 复用已有会话，新的 prompt 通过 ops.resolvePromptParts + ops.prompt() 传递
  // ...
}
```

**恢复行为对比：**

| 场景 | 行为 |
|------|------|
| 首次调用（无 `task_id`） | 创建新子 Agent 会话，对话历史从零开始 |
| 恢复调用（有 `task_id`） | 复用已有会话，子 Agent 保留自己的历史；如果会话不存在（已删除或无效），则静默创建全新会话 |

**注意：** 即使复用会话，子 Agent 仍然**只看到自己的历史记录**，父 Agent 在两次调用之间产生的新的对话内容仍然不会传递给子 Agent。这是上下文隔离规则的一致应用。

### 9.7 总结

**子 Agent 上下文隔离机制核心要点：**

| 维度 | 要点 |
|------|------|
| **上下文传递** | 仅通过 `prompt` 参数显式传递，零历史继承 |
| **文件引用** | `@file` 语法自动注入文件内容 |
| **文件系统** | 与父 Agent 共享项目目录，修改立即可见 |
| **权限继承** | 继承 `editDenyRules`、`deny`、`external_directory` |
| **默认拒绝** | `todowrite` 和 `task` 默认 deny，防止递归滥用 |
| **输出模型** | XML 包裹返回给父 Agent，对用户不可见 |
| **会话复用** | `task_id` 恢复复用已有会话，子 Agent 保留自身历史 |

**安全意义：** 子 Agent 上下文隔离机制是多 Agent 编排的安全基础。它确保：
1. 父 Agent 的敏感决策过程不会意外泄漏给子 Agent
2. 子 Agent 不能绕过父 Agent 的权限限制（特别是 Plan 模式的编辑限制）
3. 子 Agent 不能无限递归生成新的子 Agent
4. 子 Agent 的文件操作在父 Agent 的安全边界内进行

---

*本文档基于 OpenCode 插件机制与 OMO 参考实现的代码分析编写，旨在提供客观的技术说明。*