# AI 智能体提示词评估技术研究报告

> 本文档为技术性调研报告，基于对 superpowers 项目的源代码审查以及行业公开文档的事实性梳理。文中所有论断均可追溯至已验证的来源，不包含虚构的代码、指标或方法。

---

## 目录

1. [概述](#1-概述)
2. [superpowers 项目的评估方法](#2-superpowers-项目的评估方法)
   - [2.1 核心理念：提示词即代码](#21-核心理念提示词即代码)
   - [2.2 RED-GREEN-REFACTOR 测试周期](#22-red-green-refactor-测试周期)
   - [2.3 测试基础设施](#23-测试基础设施)
   - [2.4 压力测试（Pressure Testing）](#24-压力测试pressure-testing)
   - [2.5 五种互补的测量机制](#25-五种互补的测量机制)
   - [2.6 具体集成测试案例](#26-具体集成测试案例)
   - [2.7 新接入端的验收标准](#27-新接入端的验收标准)
   - [2.8 显式技能请求与自动触发测试](#28-显式技能请求与自动触发测试)
3. [行业最佳实践](#3-行业最佳实践)
    - [3.1 Promptfoo](#31-promptfoo)
    - [3.2 DeepEval](#32-deepeval)
    - [3.3 Langfuse](#33-langfuse)
    - [3.4 Ragas](#34-ragas)
    - [3.5 Microsoft PromptFlow](#35-microsoft-promptflow)
    - [3.6 Guardrails AI](#36-guardrails-ai)
    - [3.7 AIConfig](#37-aiconfig)
    - [3.8 Argilla](#38-argilla)
    - [3.9 关键定量指标](#39-关键定量指标)
    - [3.10 关键定性指标](#310-关键定性指标)
    - [3.11 对抗性测试模式](#311-对抗性测试模式)
4. [对比分析与总结](#4-对比分析与总结)

---

## 1. 概述

随着大语言模型（LLM）驱动的智能体在软件开发中的广泛应用，如何系统性地评估和优化智能体提示词（Prompt，在 superpowers 项目中称为 "Skill"）已成为关键研究课题。本报告从两个维度展开调研：

- **superpowers 项目**：一个开源智能体技能（Agent Skills）框架，源代码位于 `https://github.com/obra/superpowers`，其核心思想是将提示词视为"塑造行为的代码"。
- **行业最佳实践**：涵盖 Promptfoo、DeepEval、Langfuse、Ragas、Microsoft PromptFlow、Guardrails AI、AIConfig、Argilla 等开源提示词评估工具与框架。

---

## 2. superpowers 项目的评估方法

### 2.1 核心理念：提示词即代码

superpowers 项目将技能（Skill）明确定义为"塑造智能体行为的代码，而非散文"（Skills are "code that shapes agent behavior", not prose）。这一哲学体现在项目 AGENTS.md 文件的明确声明中，并贯穿于整个测试方法论：

> "Skills are not prose — they are code that shapes agent behavior."
> —— superpowers/AGENTS.md

基于此理念，superpowers 将软件工程中的测试驱动开发（TDD）方法映射到提示词评估领域，形成了独特的 RED-GREEN-REFACTOR 测试周期。

### 2.2 RED-GREEN-REFACTOR 测试周期

该周期定义于 `skills/writing-skills/testing-skills-with-subagents.md` 文件，将 TDD 的各个阶段映射到技能测试：

| TDD 阶段 | 技能测试阶段 | 操作内容 |
|----------|------------|---------|
| **RED** | 基线测试（Baseline test） | 在没有技能的场景下运行，观察智能体失败 |
| **Verify RED** | 捕获合理化（Capture rationalizations） | 逐字记录失败表现 |
| **GREEN** | 编写技能（Write skill） | 针对特定的基线失败场景编写技能 |
| **Verify GREEN** | 压力测试（Pressure test） | 在拥有技能的场景下运行，验证合规性 |
| **REFACTOR** | 修补漏洞（Plug holes） | 发现新的合理化借口（loopholes），添加对应措施 |
| **Stay GREEN** | 重新验证（Re-verify） | 再次测试，确保持续合规 |

**核心原则**：如果你没有观察过智能体在没有技能的情况下失败，你就无法知道技能是否阻止了正确的失败。

#### 各阶段详细说明

**RED 阶段——基线测试：**
- 创建压力场景（3 种以上压力组合）
- 在没有技能的情况下运行，让智能体面对真实任务与压力
- 逐字记录智能体的选择与合理化借口
- 识别模式——哪些借口反复出现？
- 注意有效的压力——哪些场景会触发违规？

**GREEN 阶段——编写最小化技能：**
- 仅针对 RED 阶段观察到的具体失败编写技能
- 不为假设场景添加额外内容
- 在相同场景中用技能重新测试
- 如智能体仍失败，说明技能不清晰或不完整，需修订重测

**REFACTOR 阶段——修补漏洞：**
当智能体尽管拥有技能仍违反规则时，需为每种新的合理化借口添加：
1. **规则的显式否定**：明确禁止的表述
2. **合理化表格条目**：记录"借口 vs 现实"的对照
3. **红旗（Red Flag）条目**：警示列表
4. **技能描述更新**：添加"即将违规"的症状描述

**元测试（Meta-Testing）：**
当 GREEN 阶段不奏效时，在智能体做出错误选择后追问：

> *"你阅读了技能，却仍然选择了选项 C。如果技能可以写成不同的方式，使其明确表明只有选项 A 是可接受的答案，应该怎么写？"*

智能体可能的三种回应：
1. **"技能已经很明确了，我选择忽略它"** — 非文档问题，需加强基本原则
2. **"技能应该说 X"** — 文档问题，按建议修改
3. **"我没有看到 Y 部分"** — 组织问题，将关键点更突出

### 2.3 测试基础设施

superpowers 的测试基础设施集中在 `tests/` 目录下，主要结构如下：

#### `tests/claude-code/` — 主自动化测试套件

使用 Claude Code CLI 的无头模式（`claude -p ...`）执行测试。包含以下核心文件：

| 文件 | 功能 |
|------|------|
| `run-skill-tests.sh` | 测试运行器，支持 `--integration` 标志；默认单测超时 5 分钟，集成测试最长 30 分钟 |
| `test-helpers.sh` | 共享断言库，提供以下函数：`run_claude`、`assert_contains`、`assert_not_contains`、`assert_count`、`assert_order`、`create_test_project`、`create_test_plan` |
| `analyze-token-usage.py` | 解析 JSONL 格式的会话记录，按主会话和每个子智能体分解 Token 使用情况，报告输入/输出/缓存 Token 及预估成本 |

#### 断言库函数详解（`test-helpers.sh`）

- **`run_claude`**：调用 Claude Code CLI 执行提示词，支持可选的超时时间和工具白名单
- **`assert_contains`**：验证输出包含指定模式
- **`assert_not_contains`**：验证输出不包含指定模式
- **`assert_count`**：验证输出中某模式出现的次数与预期一致
- **`assert_order`**：验证输出中多个模式的先后顺序
- **`create_test_project`**：创建临时测试项目目录
- **`create_test_plan`**：生成测试计划文件

#### Token 分析工具（`analyze-token-usage.py`）

该脚本解析 JSONL 格式的会话记录，分析维度包括：
- 主会话的 Token 使用量（输入、输出、缓存创建、缓存读取、消息数）
- 每个子智能体的独立 Token 使用量及其描述提取
- 每个智能体的预估成本（基于 $3/百万输入 Token、$15/百万输出 Token 的定价）

### 2.4 压力测试（Pressure Testing）

压力测试方法是 superpowers 评估体系的核心特色，详细定义于 `skills/writing-skills/testing-skills-with-subagents.md`。

#### 压力类型

| 压力类型 | 示例场景 |
|----------|---------|
| **时间压力** | 紧急情况、截止日期、部署窗口即将关闭 |
| **沉没成本** | 已投入数小时工作，"浪费"需要删除 |
| **权威压力** | 资深人员说跳过、经理越权指示 |
| **经济压力** | 工作、晋升、公司生存受到威胁 |
| **疲惫压力** | 一天结束、已经疲倦、想回家 |
| **社交压力** | 显得教条、显得不灵活 |
| **实用主义压力** | "务实 vs 教条"的争论 |

**最佳测试组合 3 种以上压力。**

#### 具体压力测试示例

来自 `skills/systematic-debugging/test-pressure-1.md` 的真实压力场景：

> "生产 API 宕机。错误率：100%。收入损失：15,000 美元/分钟。已宕机 5 分钟（损失 75,000 美元）。经理说立刻修复。你看到一个快速重试修复方案（5 分钟）vs 系统性调试（35 分钟以上）。"

#### 优秀压力场景的关键要素

1. **具体选项** — 强迫 A/B/C 选择，而非开放式回答
2. **真实约束** — 具体时间、实际后果
3. **真实路径** — `/tmp/payment-system` 而非"某个项目"
4. **让智能体行动** — "你做什么？"而非"你应该做什么？"
5. **无出路** — 不能回避问题说"我要问你的伙伴"

#### 实际测试成果

TDD 技能本身的测试过程（2025-10-03）：
- 6 轮 RED-GREEN-REFACTOR 迭代达到防弹（bulletproof）状态
- 基线测试揭示了 10 种以上的独特合理化借口
- 每轮 REFACTOR 关闭了特定的漏洞
- 最终 VERIFY GREEN：在最大压力下 100% 合规

### 2.5 五种互补的测量机制

superpowers 采用五种互补的测量机制来评估技能效果：

1. **技能调用检测** — 解析 JSONL 对话记录，搜索 `"name":"Skill"."skill":"..."` 模式，验证技能是否被正确触发
2. **行为验证** — 检查产物（文件、Git 提交、测试结果）是否符合预期
3. **过早行动检测** — 验证在 Skill 工具被调用之前，没有行动工具被提前调用
4. **Token/成本分析** — 按子智能体分解 Token 用量，以美元计算预估成本
5. **RED-GREEN-REFACTOR 元测试** — 在智能体做出错误选择后，询问技能应如何改进

### 2.6 具体集成测试案例

#### `test-subagent-driven-development.sh`（快速技能内容验证）

- 执行时间：约 2 分钟
- 测试内容：
  - 验证技能名称能被识别
  - 验证技能描述正确的工作流顺序（spec 合规审查在代码质量审查之前）
  - 验证自我审查（self-review）被提及
  - 验证计划文件只读取一次
- 检查方式：解析 JSONL 中的技能工具调用

#### `test-subagent-driven-development-integration.sh`（完整工作流）

- 执行时间：10-30 分钟
- 测试流程：
  - 创建真实的 Node.js 项目
  - 生成包含 2 个任务的计划
  - 验证：技能工具被调用、至少 2 个子智能体被分派、至少 1 次 TodoWrite 使用、`npm test` 通过、多次 Git 提交、无额外功能

#### `test-requesting-code-review.sh`（代码审查测试）

- 创建带有植入漏洞的项目（SQL 注入、明文密码哈希记录）
- 验证代码审查员能标记出这两个问题，分别标记为 Critical 和 Important 级别
- 验证审查员不会批准代码

#### `test-document-review-system.sh`（文档审查测试）

- 创建包含 TODO 占位符和"稍后指定"（specified later）延期表述的规格文档
- 验证审查员能同时捕获这两个问题

#### `test-worktree-native-preference.sh`（RED-GREEN-PRESSURE 多阶段测试）

- RED 阶段：不带技能偏好，智能体使用 `git worktree add`
- GREEN 阶段：带技能（明确工具命名 + 同意桥），智能体使用 `EnterWorktree`
- PRESSURE 阶段：在时间压力和已有 `.worktrees/` 目录的情况下，智能体仍使用 `EnterWorktree`
- 验证结果：50/50 轮次（20 GREEN + 20 PRESSURE + 10 完整技能文本），零失败
- 关键发现：三步模式使测试成功——(1) 显式工具命名、(2) 同意桥（"用户同意=授权使用原生工具"）、(3) 红旗条目命名特定反模式

### 2.7 新接入端的验收标准

AGENTS.md 中定义了新接入端的验收标准：

打开一个新的清洁会话，发送以下用户消息：

> "Let's make a react todo list"

一个正常工作的集成应该在编写任何代码之前自动触发 `brainstorming` 技能。如果 `brainstorming` 没有自动触发，则该集成不被接受。

以下情况不被视为真正的集成（会被关闭）：
- 手动将技能文件复制到接入端
- 使用 `npx skills` 或类似运行时 shim 包装
- 需要用户每会话选择启用技能
- `brainstorming` 在上面的验收测试中未能自动触发

### 2.8 显式技能请求与自动触发测试

#### `tests/explicit-skill-requests/`

测试当用户显式命名技能时，智能体是否触发相应技能。包含 9 种提示变体：
- `action-oriented.txt`
- `after-planning-flow.txt`
- `claude-suggested-it.txt`
- `i-know-what-sdd-means.txt`
- `mid-conversation-execute-plan.txt`
- `please-use-brainstorming.txt`
- `skip-formalities.txt`
- `subagent-driven-development-please.txt`
- `use-systematic-debugging.txt`

测试使用 `claude -p ... --output-format stream-json` 命令，解析 JSONL 输出中的 `"name":"Skill"` 工具调用。同时检查在 Skill 工具之前是否有过早行动。

#### `tests/skill-triggering/`

测试从自然语言提示中自动触发技能，包含 6 种触发场景：
- `dispatching-parallel-agents.txt`
- `executing-plans.txt`
- `requesting-code-review.txt`
- `systematic-debugging.txt`
- `test-driven-development.txt`
- `writing-plans.txt`

#### `tests/opencode/`

针对 OpenCode 插件加载、启动缓存、工具和优先级等机制的测试。

#### `tests/subagent-driven-dev/`

临时的手动完整项目测试，包含：
- `svelte-todo`：12 个任务
- `go-fractals`：10 个任务

---

## 3. 行业最佳实践

当前开源社区涌现了大量专注于提示词评估的工具和框架。本章逐一介绍各项目的核心功能与差异化优势，并在最后归纳通用的评估指标体系与对抗性测试方法。

### 3.1 Promptfoo

Promptfoo（https://github.com/promptfoo/promptfoo，21.9k Stars）是一个专注于提示词评估与红队测试（red-teaming）的开源框架，以声明式配置驱动评估流程。

#### 核心功能

- **声明式 A/B 测试**：通过 YAML/JSON 配置文件定义多个提示词变体及模型参数，自动对比不同输出质量
- **回归测试**：将已知正确的输入-输出对保存为测试用例，在提示词修改后自动验证是否引入回归
- **LLM-as-judge 断言**：使用 LLM 作为评判者，评估输出是否符合预期标准（如是否包含关键信息、是否遵循指令）
- **CI/CD 集成**：支持命令行运行，可在 GitHub Actions、Jenkins 等流水线中自动执行评估
- **红队测试**：内置提示注入、越狱等攻击场景，用于评估提示词的安全鲁棒性

**关键差异化**：Promptfoo 将提示词评估与 CI/CD 流水线深度集成，使提示词版本管理如同代码版本管理一般严谨，且完全通过声明式配置驱动，无需编写额外代码。

### 3.2 DeepEval

DeepEval（https://github.com/confident-ai/deepeval，15.9k Stars）是一个类似 pytest 的 LLM 输出单元测试框架，提供丰富的评估指标。

#### 核心功能

- **G-Eval**：基于 GPT 评估的自动化评分指标，支持自定义评估维度
- **幻觉检测（Hallucination）**：评估模型输出是否存在事实性错误或虚构内容
- **忠实度评估（Faithfulness）**：验证输出是否忠实于给定的上下文信息，不引入外部知识
- **提示词对齐（Prompt Alignment）**：检查输出是否与预期的提示词意图保持一致
- **JSON Schema 验证**：确保结构化输出符合预定义的 JSON Schema 格式

**关键差异化**：DeepEval 将提示词评估转化为类似软件单元测试的体验——开发人员可以像编写 pytest 用例一样编写提示词测试用例，并获取细粒度的指标得分。

### 3.3 Langfuse

Langfuse（https://github.com/langfuse/langfuse，28.5k Stars）是一个开源的 LLM 可观测性平台，将提示词版本管理、评估与监控功能融为一体。

#### 核心功能

- **提示词版本管理**：支持对提示词进行版本化管理和发布，每次修改可追溯
- **LLM-as-judge 评估**：使用 LLM 自动评估输出质量，支持自定义评分标准
- **人工标注**：提供手动标注界面，支持专家对模型输出进行人工评分
- **数据集测试**：在数据集上批量测试不同版本的提示词，对比效果差异
- **可观测性**：追踪每次 LLM 调用的延迟、Token 消耗、成本等运维指标

**关键差异化**：Langfuse 将提示词评估与可观测性相结合，既提供评估能力又提供生产环境的监控数据，适合从开发到生产的全生命周期管理。

### 3.4 Ragas

Ragas（https://github.com/explodinggradients/ragas，14.2k Stars）是一个专注于检索增强生成（RAG）系统评估的开源框架，提供针对 RAG 管道的专用评估指标。

#### 核心功能

- **忠实度（Faithfulness）**：评估生成答案是否忠实于检索到的上下文文档
- **答案相关性（Answer Relevancy）**：评估生成答案与用户问题的相关程度
- **上下文精度（Context Precision）**：评估检索到的文档中相关内容的占比
- **上下文召回（Context Recall）**：评估检索是否覆盖了回答所需的所有相关信息
- **prompt_evals 模板**：提供标准化的评估模板，可用于自定义提示词评估场景

**关键差异化**：Ragas 是唯一专门针对 RAG 系统设计的评估框架，其指标体系覆盖检索与生成两个环节，适合评估基于知识库的问答系统。

### 3.5 Microsoft PromptFlow

Microsoft PromptFlow（https://github.com/microsoft/promptflow，11.1k Stars）是一个将提示词与代码组合为可执行工作流的开发工具。

#### 核心功能

- **可执行流程**：将提示词调用、数据处理、后处理等步骤串联为可视化工作流
- **批量测试**：在工作流上批量运行测试数据，对比不同提示词版本的输出差异
- **质量门禁（Quality Gates）**：在 CI/CD 流水线中设置评估阈值，未达标的版本不可部署
- **评估指标集成**：支持集成自定义评估指标，在流程执行时自动计算得分

**关键差异化**：PromptFlow 将提示词评估提升到工作流层面——不仅评估单个提示词的输出，还评估多步骤提示词链路的整体效果。

### 3.6 Guardrails AI

Guardrails AI（https://github.com/guardrails-ai/guardrails，7k Stars）是一个专注于 LLM 输入/输出验证与安全守卫的开源框架。

#### 核心功能

- **输入守卫（Input Guards）**：在提示词发送到模型前进行验证，过滤恶意或不合规输入
- **输出守卫（Output Guards）**：在模型输出返回前进行验证，确保输出符合预期格式和内容规范
- **验证器（Validators）**：提供丰富的检查器，包括正则表达式匹配、毒性检测、敏感信息过滤、类型校验等
- **结构化输出**：强制模型输出符合预定义的结构（如 JSON Schema），减少格式错误

**关键差异化**：Guardrails AI 专注于提示词的运行时安全验证，在"执行前检查输入、执行后检查输出"的双重守卫机制上最为完善。

### 3.7 AIConfig

AIConfig（https://github.com/lastmile-ai/aiconfig，1.1k Stars）是一个将提示词、模型参数和模型配置以 JSON 格式管理的开源工具。

#### 核心功能

- **提示词即配置**：将提示词与模型参数统一存为 JSON 配置文件
- **Git 版本控制**：配置文件可直接纳入 Git 管理，每次修改都有完整的历史记录
- **可视化编辑器**：提供 Web UI 用于可视化编辑提示词和运行测试
- **多模型支持**：可在一个配置文件中定义针对不同模型的提示词变体

**关键差异化**：AIConfig 将提示词彻底"配置化"，与 Git 工作流天然融合，适合需要严格版本控制和审批流程的团队。

### 3.8 Argilla

Argilla（https://github.com/argilla-io/argilla，5k Stars）是一个人机协作的 LLM 反馈标注平台，专注于通过人工标注提升提示词和模型的评估质量。

#### 核心功能

- **人工标注与反馈**：提供标注界面，支持对模型输出进行打分、排名、错误标记
- **响应排序**：对多个模型的输出进行人工排序，构建偏好数据集
- **团队协作**：支持多人协作标注，内置标注一致性检查

**关键差异化**：Argilla 聚焦于"人在回路中"（Human-in-the-Loop）的评估模式，是唯一以人工标注为核心流程的提示词评估工具。

### 3.9 关键定量指标

综合上述开源工具的实践，提示词评估的定量指标体系可归纳如下：

| 类别 | 具体指标 | 支持的典型工具 |
|------|---------|--------------|
| 任务完成率 | 通过率（Pass Rate）、成功率（Success Rate） | Promptfoo、DeepEval |
| 输出匹配度 | 精确匹配、JSON Schema 校验、正则匹配 | Promptfoo、Guardrails AI、DeepEval |
| 检索质量 | 上下文精度、上下文召回 | Ragas |
| 忠实度 | 忠实度评分、幻觉检测得分 | DeepEval、Ragas |
| 效率 | 响应延迟（毫秒）、Token 消耗、推理成本（美元） | Langfuse、PromptFlow |
| 安全性 | 毒性检测得分、注入攻击成功率 | Guardrails AI、Promptfoo |

### 3.10 关键定性指标

定性评估依赖于人工判断或 LLM-as-judge 的评分机制，主要方法包括：

| 类别 | 方法 | 支持的典型工具 |
|------|------|--------------|
| 整体评分 | Likert 量表（1-5 级）、G-Eval 评分 | DeepEval、Langfuse |
| 成对比较 | "哪个输出更好？"偏好对比 | Langfuse、Argilla |
| 排名标注 | 多人排序、Elo 评分 | Argilla |
| 人工审核 | 专家标注、错误分类 | Argilla、Langfuse |
| 对齐检查 | 输出与提示词意图的一致性评估 | DeepEval、Langfuse |

### 3.11 对抗性测试模式

对抗性测试是提示词评估的重要补充。Promptfoo 和 Guardrails AI 等工具内置了多种攻击模式的自动测试能力：

#### 常见攻击场景

| 攻击类型 | 说明 | 测试工具 |
|---------|------|---------|
| 提示注入（Prompt Injection） | 在用户输入中嵌入恶意指令，试图覆盖原始系统提示 | Promptfoo、Guardrails AI |
| 越狱（Jailbreaking） | 使用角色扮演、逻辑陷阱等方式绕过安全限制 | Promptfoo |
| 毒性输入/输出 | 生成或传播攻击性、歧视性或不当内容 | Guardrails AI |
| 数据泄漏 | 诱导模型泄露训练数据或系统提示内容 | Promptfoo |
| 结构化绕过 | 试图通过格式混淆突破输出约束（如 JSON 约束） | Guardrails AI |

#### 防御策略

| 防御手段 | 说明 | 关联工具 |
|---------|------|---------|
| 输入过滤 | 在请求到达模型前检测并拦截恶意输入 | Guardrails AI |
| 输出验证 | 在响应返回用户前校验内容合规性 | Guardrails AI |
| 红队自动化 | 自动生成和迭代攻击提示，测试模型鲁棒性 | Promptfoo |
| 护栏规则 | 定义明确的输入/输出约束边界 | Guardrails AI |

---

## 4. 对比分析与总结

### 方法论对比

| 维度 | superpowers | 开源提示词评估工具 |
|------|------------|-----------------|
| **核心思想** | 提示词是塑造行为的代码 | 提示词是可测试、可版本化的评估对象 |
| **测试范式** | RED-GREEN-REFACTOR（TDD 映射） | 声明式用例 + 指标评分 + CI/CD 门禁 |
| **评估重点** | 合规性、抗压性、防绕过 | 输出质量、忠实度、安全性、效率 |
| **自动化程度** | 全自动化（CLI 无头模式） | 全自动化至半自动化 |
| **成本考量** | 精确到子智能体的 Token 分解与成本核算 | Langfuse 等支持 Token 追踪 |
| **对抗性测试** | 内置压力测试框架（7 类压力 + 元测试） | Promptfoo（红队测试）、Guardrails AI（输入/输出守卫） |
| **人工评估** | 无内置人工标注 | Argilla、Langfuse 支持人工标注与反馈 |

### 核心差异

1. **测试哲学**：superpowers 强调先观察失败再编写提示词（RED 阶段先暴露漏洞，GREEN 阶段再打补丁），而开源工具更多采用"数据集 + 指标 + 回归"的正向验证模式——先定义预期输出，再测试是否达标。前者是从失败推导要求的"逆工程"路径，后者是从要求验证结果的"正工程"路径。

2. **对抗性深度**：superpowers 内置了系统化的压力测试方法论——7 类压力类型组合使用、元测试追问、逐轮迭代直至防弹。开源工具中 Promptfoo 提供自动化的红队测试，Guardrails AI 提供运行时的输入/输出守卫，但在测试的深度和迭代策略上不如 superpowers 的 RED-GREEN-REFACTOR 循环系统化。

3. **成本透明度**：superpowers 的 `analyze-token-usage.py` 工具按子智能体粒度分解 Token 和成本，这在开源提示词评估工具中较为少见——Langfuse 虽提供 Token 追踪，但缺乏按子智能体分解的能力。

4. **评估覆盖范围**：开源工具各自聚焦于特定环节——Promptfoo 侧重 A/B 测试与回归，Ragas 专注 RAG 场景，Guardrails AI 专注安全守卫，Argilla 专注人工标注。相比之下，superpowers 的方法论覆盖了从基线测试、压力测试、成本分析到元测试的完整流程。

### 共同趋势

- **自动化优先**：各方都强调自动化测试的重要性，Promptfoo 和 DeepEval 均支持 CI/CD 集成，使提示词评估成为开发流程的固有环节
- **多维度评估**：从单一的正确率扩展到忠实度、安全性、效率、对抗鲁棒性等多个维度
- **LLM-as-judge**：使用 LLM 评估 LLM 输出，已被 DeepEval（G-Eval）、Langfuse、Promptfoo 等工具广泛采纳
- **版本控制化**：Langfuse 和 AIConfig 将提示词纳入版本管理，与 Git 工作流融合，使提示词变更可追溯、可回滚

### 结论

superpowers 的评估方法论在以下方面具有独特性：它将软件工程的 TDD 实践完整映射到提示词开发中，提供了系统化的压力测试框架，并为每次测试运行提供了精细化的成本分析。开源提示词评估工具则在各自专注的领域——Promptfoo 的 CI/CD 集成、DeepEval 的单元测试体验、Ragas 的 RAG 评估、Guardrails AI 的安全守卫——提供了可组合、可独立使用的技术方案。两者互为补充：superpowers 的方法更适合需要深度对抗性测试的提示词开发场景，而开源工具更适合标准化的质量评估与持续集成流程。

---

*报告日期：2026 年 6 月 5 日*
*信息来源：superpowers 项目源代码（https://github.com/obra/superpowers）及行业公开文档*
