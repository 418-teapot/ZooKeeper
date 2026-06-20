# Wiki 知识生命周期管理 — 技术调研报告

**版本:** 2.0
**日期:** 2026-06-19
**状态:** 调研阶段，未实施

---

## 目录

1. [问题陈述](#1-问题陈述)
2. [外部参考：LLM Wiki v2 分析](#2-外部参考llm-wiki-v2-分析)
3. [外部参考：Open Knowledge Format (OKF)](#3-外部参考open-knowledge-format-okf)
4. [设计一：知识生命周期](#4-设计一知识生命周期)
5. [设计二：数据检索](#5-设计二数据检索)
6. [设计三：自动化策略](#6-设计三自动化策略)
7. [设计四：工具统一 — zwiki CLI](#7-设计四工具统一--zwiki-cli)
8. [设计五：大规模摄入与增量同步](#8-设计五大规模摄入与增量同步)
9. [实施路线图](#9-实施路线图)
10. [总结](#10-总结)

---

## 1. 问题陈述

### 1.1 现状

ZooKeeper 的 wiki 系统（`~/.zoo/wiki/`）已实现 Karpathy 原始 LLM Wiki 模式的核心循环——ingest → query → lint。SCHEMA.md 定义了四种 status 状态：

```
draft → review → stable → deprecated
```

`lint.py` 的 `check_stale_pages` 已能检测出 `updated` 超过 90 天且 `status != deprecated` 的页面。

### 1.2 核心缺口

现有系统在三个方向上存在结构性不足：

| 方向 | 缺口 | 后果 |
|------|------|------|
| **知识生命周期** | 检测但不行动，缺少中间状态，无取代机制，无矛盾检测 | 知识腐烂了没人知道，旧结论继续被引用 |
| **数据检索** | 只有 index.md 导航一条路，无 fallback，标签未被查询利用 | index 没命中就断了，全文搜索能力为零 |
| **自动化** | 四个工具全部手动触发，ingest 后"记得跑 backlinks"靠人，lint 检测到 stale 无人定期执行 | 一致性依赖自觉 |

### 1.3 设计原则

1. **简约准则** — 复杂度成本必须与收益相称。不做置信度浮点数和事件驱动全自动。
2. **NPC 式分工** — 机械活交给工具脚本，语义判断 LLM 辅助但不替代人类决策。
3. **后验问责制** — 任何自动化的状态迁移必须留下可审计的痕迹。

---

## 2. 外部参考：LLM Wiki v2 分析

### 2.1 v2 的五个生命周期机制

Rohit Gupta 的 LLM Wiki v2（[gist](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2)）在 Karpathy 原版基础上引入了完整的知识生命周期管理：

| 机制 | 做法 | 底层假设 |
|------|------|---------|
| **置信度评分** | 每条事实附带 0.0–1.0 浮点数，依据来源数量、确认时间、矛盾存在与否。随时间衰减，验证后增强。 | 知识可信度可量化为连续值 |
| **取代（supersede）** | 新信息覆盖旧信息，旧版本保留但标记为过期 | 知识更新需要显式版本链 |
| **遗忘（forgetting）** | 艾宾浩斯遗忘曲线驱动指数衰减 | 所有知识随时间均匀失去价值 |
| **整合层级** | 原始观测 → 工作记忆 → 情节记忆 → 语义记忆 → 程序记忆 | 知识通过压缩和验证逐步升级 |
| **事件驱动自动化** | 会话开始自动加载、写入时自动检测矛盾、会话结束自动压缩 | LLM 足够可靠可以自主管理 |

### 2.2 gnusupport 的三条批评

评论区最尖锐的批评，每条都击中了 v2 的根基：

1. **置信度评分是伪精度** — 浮点数 0.73 不如可验证的引用链可靠。置信度应来自"谁说的、什么时候说的、有没有独立验证"，而非 LLM 拍脑袋的分数。
2. **遗忘曲线让人重复犯错** — 旧 Bug 比新 Bug 更有信息价值（说明某个路径已被探索过且失败）。遗忘旧知识等于鼓励 agent 重蹈覆辙。
3. **事件驱动自动摄入假设 LLM 可靠** — 实际上 LLM 会产生幻觉，自动摄入会把幻觉固化到知识库中。

### 2.3 三方对比

| 维度 | Karpathy 原版（我们的实现） | LLM Wiki v2 (Rohit) | 本方案方向 |
|------|--------------------------|---------------------|-----------|
| **知识生命周期** | 所有页面平等，仅 `stable → deprecated` | 置信度评分 + 衰减 + 取代 + 遗忘 | **取代 + 分档衰减**（不要浮点数，不搞艾宾浩斯） |
| **关系模型** | 扁平交叉引用（`related` + backlinks） | 类型化实体图谱 | **维持现状**（规模不够，图谱违反零依赖） |
| **搜索** | index.md 导航 | BM25 + 向量 + 图谱（RRF 融合） | **全文 grep + 标签过滤**（规模不到 200 页） |
| **自动化** | 手动触发 skill | 会话级事件驱动钩子 | **机械活自动 + 语义活半自动**（不信任全自动） |
| **质量保证** | LLM 语义检查 + 脚本机械检查 | 质量评分 + 自我修复 | **自动标记 + 人工裁决**（不要自动修复） |
| **矛盾处理** | 概念上有，代码里没有 | 自动检测 + 自动修复 | **发现不裁决**（三阶段分离） |
| **信任假设** | 未定义 | LLM 可自主管理 | LLM 检测可靠，裁决不可靠 |

### 2.4 两种哲学

```
v2 的目标：自治的知识库
  人类只用，不用管。LLM 负责全流程。
  类比：自动驾驶（L5）。

本方案的目标：诚实的知识库
  知道哪里不确定就标注不确定。知道哪里矛盾就呈现矛盾。
  机械活全自动，判断活留给人。
  类比：辅助驾驶（L2）+ 完整仪表盘。
```

差异不在简单 vs 复杂，而在**把 LLM 当工具还是当管理员。** v2 选了后者，我们选前者。

### 2.5 断舍离

**拿三样：** 知识有生命周期、取代优于删除、级联意识。

**丢三样：** 置信度浮点数（伪精度）、艾宾浩斯遗忘曲线（人类记忆模型不适用文件）、全自动自我修复（LLM 不能既当运动员又当裁判）。

---

## 3. 外部参考：Open Knowledge Format (OKF)

### 3.1 概述

OKF 是 Google 提出的知识格式规范（[v0.1 草案](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)），
目标是定义一种**人机可读、跨组织可交换**的知识表示。核心理念与我们完全一致——
Markdown + YAML frontmatter + 目录树，零基础设施依赖。

OKF 的极简设计：**`type` 是唯一必填字段**。推荐字段为 `title`、`description`、`resource`、`tags`、`timestamp`。
保留文件名 `index.md`（目录导航）和 `log.md`（变更记录）。
链接为 bundle-relative（`/path.md` 或 `./other.md`），broken link 不报错。

### 3.2 与我们的关系：超集合规

OKF v0.1 §9 的三个合规条件我们全部满足，且是超集：

| 条件 | 我们 | 状态 |
|------|------|------|
| 每个非保留 `.md` 有可解析 YAML frontmatter | 6 个必填字段，更严格 | ✅ |
| 每个 frontmatter 有非空 `type` | `type: concept\|entity\|source\|analysis\|synthesis` 枚举 | ✅ |
| `index.md`/`log.md` 遵循规范 | 格式不同但语义等价 | ✅ |

我们多出的字段（`status`、`related`、`sources` 复数、以及本报告设计的 `timeliness`/`last_validated`/`contradictions`）
都是 OKF §4.1 明确允许的扩展——消费者保留未知字段，不拒绝未知 type 值。

### 3.3 字段对齐

对比后需要四个改动，删除一个冗余字段：

| 操作 | 字段 | 理由 |
|------|------|------|
| 重命名 | `updated` → `timestamp` | OKF 对齐，"last meaningful change"。格式改为 ISO 8601 datetime（`YYYY-MM-DDTHH:mm:ssZ`，未知时间默认 `T00:00:00Z`） |
| 重命名 | `source`（单数）→ `resource` | OKF 对齐（外部资产 URI）。同时修掉跟内部引用 `sources`（复数）的命名事故 |
| 新增 | `description` | OKF 推荐，一句话摘要。可用于三阶段检索排序 |
| 新增 | `okf_version: "0.1"` | 放 `wiki/index.md` frontmatter（OKF §11） |
| 删除 | `created` | 全系统无消费者（lint/query/backlinks 全不读），跟 log.md 信息冗余 |

**不动的字段：**

| 字段 | 理由 |
|------|------|
| `sources`（复数） | 内部 wiki 引用列表，级联过期和交叉验证依赖它 |
| `type` 枚举 | 五个值是 OKF type 的有效子集，放宽会破坏 health.py 校验 |
| `related` | OKF 用正文链接实现，保留为扩展 |
| `status` 及所有生命周期扩展 | OKF 允许任意扩展 |

### 3.4 命名事故：`source` ≠ `sources`

两个字段不是单复数关系，是两个独立概念恰好撞名：

| 字段 | 实际语义 | 值类型 | 用于 |
|------|---------|--------|------|
| `source`（单数） → 改为 `resource` | 页面**描述的对象**（外部 URI） | `https://...` 或 `raw/xxx.md` | 仅 `type: source` |
| `sources`（复数） → 不动 | 页面**引用的材料**（内部路径列表） | `sources/notes/xxx.md` 等 | `type: analysis` / `type: synthesis` |

两个字段从不同时出现在同一页面上，所以一直未被发现。`source → resource` 一改正好修掉。

### 3.5 目录结构：类型优先 vs 域优先

OKF 允许 `index.md` 出现在任意层级，支持**渐进式披露**——agent 逐层深入，
每层只面对少量条目。这天然倾向域优先结构，但我们当前是类型优先：

```
当前（类型优先）:           OKF 倾向（域优先）:
wiki/                       wiki/
├── concepts/ (15 页)       ├── index.md
├── entities/ (3 页)        ├── autoresearch/
├── analysis/ (6 页)        │   ├── index.md
└── sources/ (3 页)         │   └── concepts/
                             │       ├── index.md
                             │       └── npc.md
                             ├── wiki-system/
                             │   ├── index.md
                             │   └── concepts/
                             │       └── wiki-health-check.md
                             └── shared/
                                 ├── npc.md
                                 └── simplicity-criterion.md
```

跨领域共享概念（`npc.md`、`simplicity-criterion.md`）不是域优先的障碍——
放在 `shared/` 下两边引用即可。域优先不要求概念归属单一域，只要求**索引结构以域为第一级路由**。

当前 28 页一屏 index 够用。页数接近 50 时域拆分的收益会显现——每个子域 index 只有 5-10 个条目，
agent 不需要扫完全部 50 条才知道有没有相关概念。

### 3.6 单 bundle vs 多 bundle

OKF 定义 bundle 为**链接隔离域**——bundle 内自由链接，跨 bundle 无链接语法。
Google 的三个样例（ga4 / stackoverflow / crypto_bitcoin）就是三个独立 bundle，互不联通。

我们是单 bundle——所有目录之间自由交叉引用。这符合 ZooKeeper 单项目、知识需要融合的场景，
而非 OKF 多团队、各管各的场景。将来如果需要导出某个领域知识给外部系统（如打包 autoresearch
知识发给另一个项目的 agent），域优先结构下直接打包子目录就是合法 OKF bundle。

### 3.7 对 knowledge-catalog 仓库的考察

OKF 规范所在的 [knowledge-catalog](https://github.com/GoogleCloudPlatform/knowledge-catalog)
远不止一个格式文件。它是一整套元数据富化流水线：

| 组件 | 语言 | 功能 | 对我们的可借鉴点 |
|------|------|------|-----------------|
| `okf/` enrichment-agent | Python | BQ 元数据 → OKF bundle，自动 index 再生，Cytoscape.js 图谱可视化 | 自动 index 再生模式（→ 路图 P3 `--fix`） |
| `agents/enrichment/` | Python | 四种模式的表/文档/叠加/混合富化，支持 Drive/Confluence/SharePoint/GitHub | 评估框架的 9 项指标（`hallucination_free`、`absence_of_contradictions` 等 → 矛盾检测验收标准） |
| `agents/conversation_learner/` | Python | 从 Cloud Logging 分析对话，LLM-as-judge 发现知识缺口 → 生成富化提案 | 跟"从对话日志发现 wiki 覆盖不足"思路一致 |
| `toolbox/mdcode/` (kcmd) | TypeScript | Metadata-as-Code CLI + MCP 服务，支持 OKF layout | MCP 工具模式（→ wiki-design.md 已规划的 MCP 化） |
| `toolbox/enrichment/` | TypeScript | 逐条元数据调 Gemini 富化，自带 `md-fileset` MCP 工具 | `md-fileset` 是把 Markdown 目录暴露为 MCP 资源的标准做法 |

其余 BigQuery/Dataplex/Drive/Confluence 部分属 Google 云生态特化，与本项目无关。

---

## 4. 设计一：知识生命周期

核心问题：**一条知识从写入到废弃，中间应该经历什么状态？谁来决定状态迁移？消费者在不同状态下如何对待它？**

### 3.1 状态模型：双轴离散

v2 把"置信度"和"时效性"压成一个 0-1.0 浮点数，丧失了精度。本方案用两个独立维度、离散状态：

```
        置信度轴 →
        draft    review    stable
时效性  ┌────────┬────────┬────────┐
  ↓     │        │        │        │
current │ 少用   │ 可用   │ 权威   │
        ├────────┼────────┼────────┤
stale   │ 少用   │ 谨慎用 │ 谨慎用 │
        ├────────┼────────┼────────┤
superseded│ 不用 │ 不用   │ 不用(保留引用)│
        ├────────┼────────┼────────┤
deprecated│ 不用 │ 不用   │ 历史存档│
        └────────┴────────┴────────┘
```

**置信度轴（已有）：** `draft`（新建）→ `review`（初审通过）→ `stable`（多方验证）。

**时效性轴（新增）：** `current`（最新）→ `stale`（超过验证阈值）→ `superseded`（被新页面取代）→ `deprecated`（手动废弃）。

**查询行为：** 只有 `stable + current` 可以直接引用不加免责。其他组合追加相应警告（"⚠️ N 天未验证"/"📝 未经充分审查"/"已被 X 取代"）。`deprecated` 页面默认不出现。

**新增 frontmatter 字段（全部可选，向后兼容）：**

```yaml
timeliness: current | stale | superseded | deprecated
last_validated: 2026-06-19T00:00:00Z    # 区别于 timestamp（编辑时间 ≠ 验证时间）
validation_level: 0 | 1 | 2 | 3
supersedes:                    # 可选，声明推翻哪些旧页面
  - path: concepts/old.md
    reason: "新来源确认此结论已被推翻"
contradictions:                # 可选，记录矛盾
  - page: concepts/other.md
    claims: ["声称 X=1", "声称 X=2"]
    detected: 2026-06-19
    resolution: unresolved
```

### 3.2 衰减模型：按页面类型分档

不同种类的知识对"世界变化"的敏感度完全不同。用统一阈值是错误的：

| 页面类型 | 阈值 | 理由 |
|----------|------|------|
| `source` | **永不过期** | 记录的是"某时某地说过什么"，历史事实不变 |
| `analysis` | **365 天** | 设计权衡长期有效，范式迁移才需重评 |
| `concept` | **180 天** | 抽象模式稳定，但举例和上下文可能过时 |
| `entity` | **60 天** | 代码天天改，文件描述易过时 |
| `synthesis` | **级联判断** | 时效性取决于引用的页面，不独立判断 |

衰减用 `last_validated` 而非 `updated`——编辑时间不等于验证时间。昨天修了个 typo 不等于重新确认了内容正确。

### 3.3 触发事件：五类状态迁移

生命周期不靠定时器，靠事件驱动：

| 事件 | 触发条件 | 迁移 | 自动化 |
|------|---------|------|--------|
| **时间流逝** | lint check_stale，阈值超期 | `current → stale` | ✅ 全自动（时间戳比较） |
| **新源摄入** | wiki-ingest 执行 | kiwi 提议 supersede / 刷新 last_validated | ⚠️ 半自动（LLM 提议 + 人确认） |
| **定期审查** | 人/agent 主动审查 stale 页 | `stale → current` 或 `→ deprecated` | ❌ 人工（语义判断） |
| **矛盾发现** | lint 语义检查 | 双方置信度各降一级，写入 contradictions | ⚠️ 半自动（发现 + 降级 + 等裁决） |
| **级联过期** | 页面 A 变为 superseded | 扫描所有引用 A 的页面，判断引用性质后标记 | ⚠️ 半自动（扫描自动，标记需 LLM） |

**级联过期详解：** 页面失效会沿引用链扩散。当页面 A 被 supersede 后，系统通过 backlinks 自动找到所有引用者，按引用性质分类——"基于 A 的结论做推理"的标记为 stale，"介绍 A 本身"的不标记，"引用 A 作为历史事实"的不标记。触发全自动，判断需 LLM。

### 3.4 验证机制：四级确认

生命周期不光要能"标记过期"，还要能"确认不过期"：

| 层级 | 方式 | 强度 | 刷新 |
|------|------|------|------|
| 0 | 时间戳刷新（任何 edit 后） | 最低 | 仅 `updated` |
| 1 | 机械检查（health/lint 通过） | 低 | 刷新 `last_validated` |
| 2 | 来源回溯（source ↔ 衍生页面比对） | 中 | 刷新 `last_validated`，需 LLM |
| 3 | 交叉验证（两独立源互相确认） | 高 | 双方都刷新 `last_validated`，需 LLM |

v2 用"被访问 = 被验证"——翻了一下不等于检查了一遍。本方案验证是显式的、可追溯的。

### 3.5 矛盾管理：发现不裁决

v2 让 LLM 自动检测并修复矛盾——循环验证。本方案三阶段分离：

1. **发现**（半自动）— 图拓扑预筛选候选对 → LLM 提取冲突声明（只问"是否不一致"，不问"谁对谁错"）。候选对通常 < 5，成本极低。
2. **记录**（自动）— 双方写入 `contradictions` frontmatter，置信度各降一级。
3. **呈现**（查询时）— 不采用任何一方的结论，将矛盾本身作为知识呈现，引导用户查看源代码等权威来源。

LLM 不裁决。所有矛盾最终由人类解决。系统的职责是**保证矛盾不会在无人知晓的情况下共存**。

### 3.6 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 双轴离散状态 + 分档衰减 | ❌ 置信度浮点数 |
| ✅ `last_validated` vs `updated` 分离 | ❌ 艾宾浩斯遗忘曲线 |
| ✅ 级联过期（先报告模式） | ❌ 级联全自动标记 |
| ✅ 矛盾发现 + 呈现 | ❌ 自动修复矛盾 |
| ✅ supersede 声明机制 | ❌ 自动 supersede（需人确认） |

---

## 5. 设计二：数据检索

核心问题：**wiki-query 只有 index.md 导航一条路。如果关键词不匹配，整条链路就断了。没有 fallback，没有排序。**

### 4.1 当前状态

- `wiki-query` skill 的 Phase 2 有 `grep` 提示，但仅作为松散建议，未结构化
- 所有页面都有 `tags` frontmatter 字段，但查询流程完全不消费
- `backlinks.py` 维护反向链接，但查询时不走"从结论反查依赖"这条路径
- 无搜索结果排序逻辑——index 命中和 grep 命中权重一样

### 4.2 方案：三阶段级联检索

```
Phase 1: index.md 导航（现有，优先级最高）
  按类别定位 → 读匹配页面 → 沿 related 递归
  ↓ 如果结果 < 3 个页面

Phase 2: 标签过滤（新增）
  用用户问题中的关键词匹配 frontmatter tags
  title 中的 tag 命中 > 正文中的 tag 命中
  ↓ 如果结果 < 3 个页面

Phase 3: 全文 grep（新增）
  ripgrep 扫全 wiki，匹配正文内容
  heading 匹配 > 段落匹配
```

**排序规则：** index 命中 > tag(title) > tag(body) > grep(heading) > grep(paragraph)

不需要任何新基础设施——`bash rg -l "关键词" ~/.zoo/wiki/` 一行命令。

### 4.3 远期扩展

| 阶段 | 功能 | 触发条件 |
|------|------|---------|
| 现在 | 三阶段级联检索 | 立即实施 |
| 页面 > 100 | backlinks 反向查询（"哪些页面引用了 X"） | 按需 |
| 页面 > 200 | 向量搜索（轻量级 embedding，不引入外部服务） | 按需评估 |
| 页面 > 500 | RRF 多路径融合 | 按需评估 |

### 4.4 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 三阶段级联：index → tag → grep | ❌ BM25 全文检索引擎（过度工程） |
| ✅ tag 过滤利用已有 frontmatter | ❌ 知识图谱（违反零依赖原则） |
| ✅ 搜索结果排序 | ❌ 嵌入向量存储（38 页不需要） |
| ✅ 远期按规模评估向量搜索 | ❌ 现在就上外部 embedding 服务 |

---

## 6. 设计三：自动化策略

核心问题：**四个工具全部手动触发。但机械活和人判断活混在一起，导致该自动的没自动，不该自动的也不敢自动。**

### 5.1 当前状态

- `wiki-ingest` skill 写了"完成后运行 backlinks.py"，但作为建议而非强制步骤
- `health.py` 和 `lint.py` 无任何自动触发机制
- pre-query / post-ingest 无集成点——查询时不知道页面是否 stale

### 5.2 自动化边界

关键不是"要不要自动化"，而是**区分什么该自动、什么不该**：

| 操作性质 | 是否自动 | 判据 |
|----------|---------|------|
| 时间戳比较 → 标记 stale | ✅ 全自动 | 确定性计算，无可争议 |
| backlinks 更新 | ✅ 全自动 | 确定性计算 |
| frontmatter 格式检查 | ✅ 全自动 | 确定性规则匹配 |
| index.md 条目追加 | ✅ 全自动 | 确定性，新页面路径已知 |
| post-ingest 强制 backlinks + health | ✅ 全自动 | 确定性，且阻止后续错误 |
| 断裂链接修复（目标改名） | ⚠️ 半自动 | 自动发现 + 建议修复 + 人确认 |
| 图拓扑筛选矛盾候选对 | ⚠️ 半自动 | 自动发现，LLM 提取声明，人不裁决 |
| supersede 判断 | ❌ 需人确认 | 语义判断，LLM 提议 |
| 矛盾裁决 | ❌ 人工 | LLM 不能当裁判 |
| 级联过期标记 | ❌ 需人确认 | 需要判断引用性质 |
| 定期审查 stale 页面 | ❌ 人工 | 需要判断"旧结论还成立吗" |

### 5.3 should-do 清单

| 优先级 | 动作 | 效果 |
|--------|------|------|
| 🔴 立即 | post-ingest 强制 backlinks + health | 消除"忘记跑 backlinks" |
| 🔴 立即 | lint.py `--apply` 自动标记 stale | lint 从报告工具变成执行工具 |
| 🟡 之后 | wiki-query pre-query lint 注入（> 7 天自动触发） | 查询时自动感知页面时效性 |
| 🟡 之后 | health.py `--fix` 自动修复 index 不一致 | 减少手工维护 |

### 5.4 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 机械活全自动 | ❌ 会话开始自动加载上下文（打满 context） |
| ✅ 语义活半自动 + 人确认 | ❌ 会话结束自动压缩（质量不可控） |
| ✅ 确定性操作用 `--apply`/`--fix` 模式 | ❌ 写入时自动检测矛盾（每次 write 跑 LLM 太贵） |
| ✅ pre-query / post-ingest 集成 | ❌ 定时 cron（依赖用户机器配置） |

---

## 7. 设计四：工具统一 — zwiki CLI

核心问题：**六个脚本六种 CLI 风格，agent 和人都要记住不同名字和参数约定。新增的 property 操作、deadends 检测、idempotent ingest 如果要再变成独立脚本，调用方认知负担会持续膨胀。**

### 7.1 现状

```
wiki/tools/
├── backlinks.py      python3 wiki/tools/backlinks.py --write
├── health.py         python3 wiki/tools/health.py --json
├── lint.py           python3 wiki/tools/lint.py
├── diff_check.py     python3 wiki/tools/diff_check.py
├── new_page.py       python3 wiki/tools/new_page.py --type concept --title "..."
└── wiki_log.py       python3 wiki/tools/wiki_log.py --op ingest --path ...
```

所有操作都需要记住文件路径。`--json` 只在 `health.py` 和 `backlinks.py` 上支持，`lint.py` 不支持。
`diff_check.py` 需要 git 上下文。

### 7.2 方案：zwiki 统一入口

按操作类型分四组——维护（check/fix）、读写（CRUD + property）、检索（search）、迁移（OKF）。
zwiki 是薄路由层，底层仍然调用现有模块：

```
zwiki
├── 维护
│   ├── check              → 运行 health + lint，输出报告
│   │   --apply            →   自动修复（stale 标记、deadends 标记）
│   │   --ci               →   按阈值退出码（CI gating）
│   │   --json             →   JSON 输出
│   ├── backlinks <page>   → 反向链接查询
│   │   --write            →   写入 Backlinks 节到所有页面
│   └── log --op ...       → 追加日志（原 wiki_log.py）
│
├── 读写
│   ├── page <path>        → 读页面（frontmatter + body）
│   │   --property <name>  →   只读某个属性
│   │   --outline          →   标题树
│   ├── property <name> --value <val> --page <path>
│   │                      → 设置单个属性（结构化，不手改 YAML）
│   ├── property <name> --delete --page <path>
│   │                      → 删除属性
│   ├── create --type <type> --title "..."
│   │                      → 新页面脚手架（原 new_page.py）
│   ├── ingest <source>
│   │   --idempotent       →   内容未变则跳过
│   └── move <old> <new>   → 重命名 + 自动更新所有链接
│
├── 检索
│   └── search "<query>"   → 三阶段级联检索（index → tag → grep）
│       --json             →   JSON 输出
│
└── 迁移
    └── okf check          → OKF 合规检查
        okf export <dir>   → 导出 OKF bundle
```

### 7.3 内部架构

六个现有脚本的核心逻辑全部保留为内部模块。`zwiki` 是薄路由，新增三个内部模块，
其余全是对现有函数的包装：

```
zwiki (CLI 入口，argparse)
├── _check.py      → 新增：health.py::run_health() + lint.py::run_lint()
│                    + --apply（stale 标记、deadends 标记）
│                    + --ci（阈值 YAML → exit code）
├── _property.py   → 新增：YAML 解析 + 键路径修改 + 原子写
├── _search.py     → 新增：index 解析 + tag 匹配 + rg 调用
├── _okf.py        → 新增：格式校验 + bundle 导出
├── _move.py       → 新增：backlinks 反向索引 + 批量 edit
│
├── 包装现有模块（不改内部逻辑）:
│   backlinks → backlinks.py
│   log       → wiki_log.py
│   page      → shared/utils.py
│   create    → new_page.py
│   ingest    → 现有 ingest 路径 + idempotent 检查
```

### 7.4 外部工具借鉴

三件事的来源：

| 能力 | 来源 | 核心逻辑 |
|------|------|---------|
| `property:set` / `property:read` / `property:remove` | Obsidian CLI | YAML 解析 → 路径修改 → 原子写回。使 agent 无需理解 YAML 缩进就能安全修改 frontmatter |
| `deadends`（零出链检测） | Obsidian CLI | 现有 `check_orphan_pages` 反着做：页面有 inbound 但自身不链接出任何目标 → 警告 |
| `move` 重命名 + 自动更新链接 | notesmd-cli（Go） | backlinks 反向索引定位所有引用者 → 批量 `edit` 替换路径 |
| idempotent ingest | llm-wiki-compiler | 源身份匹配（frontmatter `resource` 字段比对）+ 内容 SHA-256 跳过未变化重复摄入 |
| eval CI gating | llm-wiki-compiler | `thresholds.yaml` 定义阈值 → `zwiki check --ci` 不符合时 exit 1 |
| 12 条静态 lint 规则 | llm-wiki-compiler | 我们已有 4 条，可加 `deadends`、`schema_cross_link_minimums`（纯拓扑） |

### 7.5 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 统一 zwiki 入口，薄路由 | ❌ 重写现有工具逻辑 |
| ✅ property 结构化操作（消除 agent 手改 YAML） | ❌ 支持 Obsidian 的 `type=checkbox\|datetime` 等高级类型 |
| ✅ deadends 检测（纯拓扑，20 行） | ❌ 引入知识图谱（规模不够） |
| ✅ 三阶段检索 CLI 化 | ❌ 在 CLI 层做向量搜索（→ skill 层） |
| ✅ idempotent ingest（SHA-256 跳过） | ❌ 增量编译的依赖传播（P2 再考虑） |
| ✅ CI gating（thresholds.yaml） | ❌ 全量 eval 套件（citation support LLM judge 成本高） |

---

## 8. 设计五：大规模摄入与增量同步

核心问题：**当前 wiki-ingest 假设源材料能一次性塞进 kiwi 的上下文。面对 50 个模块、8 万行代码的仓库，单次 ingest 直接撑爆。且仓库每周有 15% 的模块变更——反复全量重蒸馏不可行。正确的做法是分而治之的蒸馏流水线 + 增量同步机制。**

### 8.1 当前局限

现有 ingest 流程（wiki-design.md §5/§7）针对的是单篇文章、设计文档、讨论记录——
源材料大小在 LLM 上下文窗口内。对于大型代码仓库，kiwi 面临两个问题：

1. **首次摄入：** 8 万行代码远超上下文限制。不可能一次性读完再蒸馏。
2. **持续同步：** 仓库每周变更后，无法判断哪些 wiki 页面受影响、哪些需要重蒸馏。

### 8.2 首次摄入：四阶段分块蒸馏

不是"切成小块分别 ingest"（会产生一堆孤立概念页），而是有层次地蒸馏：

```
Phase 1: 结构扫描（确定性，零 LLM）
  输入：仓库文件系统
  工具：目录遍历 + AST 解析 import 图
  产出：结构化摘要表——每个模块一行，含路径/文件大小/import 列表/注释密度/被引用关系
        （几百行，不是 8 万行代码）

Phase 2: 内容地图（1 次 LLM 调用）
  输入：Phase 1 的结构化摘要表（~500 行）
  kiwi 判断：
    ✓ 模块分类：核心模块（单独成页）/ 支撑模块（合并）/ 工具模块（跳过）
    ✓ 块划分方案：auth+crypto → 块 1，db+config → 块 2，api+gateway → 块 3
    ✓ 块间关系：块 1 依赖块 2，块 3 依赖块 1
  产出：内容地图

Phase 3: 分块蒸馏（N 次 LLM 调用，可并行）
  输入：每个块内的完整源码（~600 行/块，远低于上下文限制）
  每个 kiwi 只看自己的块，产出：
    ✓ entities/auth-middleware.md、concepts/token-lifecycle.md 等概念/实体页
    ✓ 跨块引用声明："token-lifecycle 与块 2 的 db-pool 相关"
        （声明是单向的、轻量的——kiwi 不需要知道其他块的具体内容）
  各块独立蒸馏，可并行执行，互不依赖

Phase 4: 综合编织（1 次 LLM 调用）
  输入：Phase 2 的内容地图 + Phase 3 所有产出（页面 frontmatter + 摘要 + 声明）
  kiwi 全局视角：
    ✓ 匹配声明 → 建立准确的 related 交叉引用
    ✓ 检测未被引用的页面 → 补充正文链接
    ✓ 生成 overview.md + 更新 index.md + log.md
  相当于把 Phase 3 独立蒸馏的碎片"缝"成一本完整的书
```

**关键设计决策：**

- Phase 1 的结构扫描是纯确定性的——目录遍历 + AST 解析 import 图，零 LLM 成本。借鉴 oh-my-opencode-slim 的 [codemap](https://github.com/user/oh-my-opencode-slim) 模式：确定性脚本做文件发现 + 哈希，LLM 只做语义填充。
- Phase 2 的块划分由 Phase 1 的摘要表驱动——不是机械地每 5000 行一切，而是根据模块的"独立成页价值"和自然耦合关系划分。
- Phase 3 的并行性来自块之间的独立性——各块共享的是"声明"而非"内容"，不需要互相等待。
- Phase 4 不重新写内容——只补充关系。跨块引用在 Phase 3 各块独立蒸馏时无法建立，Phase 4 统一缝合。

### 8.3 每周增量：六步同步

仓库每周变更 ~15% 的模块。不是全量重蒸馏——增量同步分六个步骤：

```
Step A: 哈希扫描（确定性，零 LLM）
  输入：仓库当前状态 + 上次 codemap 快照（文件 MD5 哈希）
  输出：{changed: [auth/middleware.go, db/pool.go, api/handler.go],
         unchanged: [...47 个模块...]}
  所有 unchanged 模块的 wiki 页面完全不受影响——跳过。

Step B: 变更量判断（确定性）
  middleware.go: +30 / 540 = 5.5%   → < 10%，走差分蒸馏（Step D）
  pool.go:       -5 / 200 = 2.5%    → < 10%，走差分蒸馏（Step D）
  handler.go:    +200 / 350 = 57%   → > 50%，走全量重蒸馏（Step E）
  阈值 10%/50% 是经验值，实际由 Phase 2 产出的模块知识决定——
  注释密度高、稳定的模块阈值可以放宽。

Step C: 概念依赖追踪（确定性 + 1 次 LLM 补充）
  查 state.json：middleware.go → 提取了 concept "token-lifecycle" 和 entity "auth-middleware"
  查 backlinks：concepts/token-lifecycle.md 被 3 个页面引用 →
    analysis/auth-vs-oauth.md    → 标记 needs_review
    concepts/token-lifecycle.md  → 标记 needs_review（自身来源变更）
    overview.md                  → 标记 needs_review
  对所有 changed 模块重复此过程。
  不自动改任何东西——只标记。确切的引用性质判断（"基于 A 的结论做推理"
  vs "介绍 A 本身"）确需 LLM 判断，后续由 zwiki check 报告引导人工审查。

Step D: 差分蒸馏（小变更，LLM 调用）
  输入：源文件 diff + 旧版本摘要（上次蒸馏时的状态）
  kiwi 回答三个问题，返回增量操作列表：
    1. 这些变更是否改变了模块的核心职责？（是 → 需要重写 Overview）
    2. 这些变更是否引入了新概念或废弃旧概念？（是 → 需要增删 concept 页）
    3. 这些变更是否改变了模块间关系？（是 → 需要更新交叉引用）
  输出不是完整页面，而是增量操作：
    - page: entities/auth-middleware.md
      section: "## Details / Token 验证"
      action: append_after
      suggested_content: "### Refresh Token 轮换\n当 access token 过期时..."

Step E: 全量重蒸馏（大变更，LLM 调用）
  变更量 > 50% 的模块走回 Phase 3 完整蒸馏流程——
  生成新页面覆盖旧页面，保留 ## Notes 等人工维护节。

Step F: 报告
  zwiki sync 完成：
    扫描：50 个模块，3 个变更
    蒸馏：2 个差分，1 个全量
    标记：8 个页面 needs_review
    跳过：47 个模块未变
  建议执行 zwiki check 审查标记页面。
```

### 8.4 与现有机制的衔接

| 概念 | 连接点 |
|------|--------|
| Step A 哈希扫描 | 复用 codemap 风格的文件发现 + MD5 快照脚本 |
| Step C 依赖追踪 | 复用路图 P1 的 `check_cascade_stale`（backlinks 反向查引用者） |
| Step D 差分蒸馏 | kiwi 新增模式：输入从"完整源码"扩展为"diff + 旧摘要" |
| Phase 2 内容地图 | kiwi 新增模式：输入从"原始材料"扩展为"结构化摘要表" |
| 全流程门控 | 每阶段输出被审查后才进入下一阶段（借鉴 slim `deepwork` 的 plan → review → delegate → verify） |
| Phase 1 结构扫描 | 借鉴 oh-my-opencode-slim 的 codemap：确定性文件发现 + LLM 填充分离 |

### 8.5 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 四阶段分块蒸馏（首次） | ❌ 机械切片——每 5000 行一切 |
| ✅ 六步增量同步（持续） | ❌ 每次变更全量重蒸馏 |
| ✅ 概念依赖追踪 → 标记 needs_review | ❌ 自动重蒸馏标记页面 |
| ✅ 差分蒸馏（小变更） | ❌ LLM 自动裁决变更影响（只生成增量操作列表，不自动应用） |
| ✅ 哈希快照驱动增量检测 | ❌ 引入外部 CI 系统依赖 |
| ✅ kiwi 两种新模式（摘要表蒸馏 + 差分蒸馏） | ❌ 新建独立 agent（kiwi 扩展即可） |

---

## 9. 实施路线图

### 9.0 P0-pre：OKF 字段对齐 + zwiki 骨架（纯机械，零 LLM 成本）

**目标：wiki 格式与 OKF v0.1 合规对齐；建立统一的 zwiki CLI 入口。**

| # | 改动 | 文件 | 工作量 |
|---|------|------|--------|
| 0a | `updated` → `timestamp`（格式改为 ISO 8601 datetime，默认 `T00:00:00Z`） | SCHEMA.md + 5 模板 + 27 wiki 页面 + shared/utils.py + health.py + lint.py + test_lint.py | ~50 行 |
| 0b | `source`（单数）→ `resource` | SCHEMA.md + templates/source.md + 3 wiki 页面 + health.py | ~15 行 |
| 0c | 新增 `description` 字段 | SCHEMA.md + 5 模板 | ~6 行 |
| 0d | 新增 `okf_version: "0.1"` | wiki/index.md | 2 行 |
| 0e | 删除 `created` 字段 | SCHEMA.md + 5 模板 + 27 wiki 页面 + health.py | ~35 行 |
| 0f | zwiki CLI 骨架：统一入口 argparse，挂载 check/page/property/create/backlinks/log 子命令 | 新增 zwiki（薄路由，~100 行） | ~100 行 |
| 0g | `zwiki property`：结构化读/写/删 frontmatter 属性（新增 `_property.py`） | 新增 _property.py + shared/utils.py | ~80 行 |

### 9.1 P0：地基（纯机械，零 LLM 成本）

**目标：让 wiki 知道哪些页面过时了，查询时自动感知。**

| # | 改动 | 文件 | 工作量 |
|---|------|------|--------|
| 1 | 新增 `timeliness`、`last_validated`、`supersedes`、`contradictions` 等可选字段 | SCHEMA.md | ~20 行 |
| 2 | `check_stale_pages` 支持 `--apply`，按页面类型分档阈值 | lint.py | ~50 行 |
| 3 | wiki-query 感知 `timeliness`：stale 加免责，superseded/deprecated 降级 | wiki-query SKILL.md | ~15 行 |
| 4 | 五个页面模板追加新字段（可选，默认兼容） | templates/*.md | 各 ~3 行 |
| 5 | 三阶段级联检索：index → tag → grep | wiki-query SKILL.md | ~20 行 |
| 6 | post-ingest 强制 backlinks + health | wiki-ingest SKILL.md | ~5 行 |
| 7 | `zwiki check --apply`：整合 stale 自动标记 + deadends 检测 | 新增 _check.py | ~60 行 |
| 8 | `zwiki search`：三阶段级联检索 CLI 化 | 新增 _search.py | ~50 行 |
| 9 | `zwiki okf check`：OKF 合规自检 | 新增 _okf.py | ~40 行 |

### 9.2 P1：半自动机制（LLM 辅助，但调用量极小）

**目标：supersede 声明 + 矛盾发现。**

| # | 改动 | 文件 | 工作量 |
|---|------|------|--------|
| 7 | kiwi 蒸馏时判断新源是否推翻旧结论，声明 `supersedes` | wiki-ingest SKILL.md | ~30 行 |
| 8 | `check_cascade_stale`：页面 superseded 后扫描引用者，生成候审列表 | lint.py | ~80 行 |
| 9 | 矛盾检测：图拓扑预筛选 → LLM 声明提取 → contradictions 写入 | 新增 contradiction.py | ~150 行 |
| 10 | wiki-query 矛盾感知：读到 contradiction 页面时呈现冲突 | wiki-query SKILL.md | ~10 行 |
| 11 | `zwiki move`：重命名 + 自动更新所有引用链接 | 新增 _move.py | ~100 行 |
| 12 | `zwiki ingest --idempotent`：源身份匹配 + SHA-256 跳过 | 修改现有 ingest 路径 | ~60 行 |

### 9.3 P2：验证体系

**目标：不只检测过期，还能验证不过期。**

| # | 改动 | 文件 | 工作量 |
|---|------|------|--------|
| 13 | 交叉验证：ingest 新源时自动比对已有声明，一致则刷新 `last_validated` | lint.py | ~100 行 |
| 14 | 来源回溯验证：source ↔ 衍生页面一致性比对 | 新增脚本 | ~120 行 |

### 9.4 P3：全自动维护 + 大规模摄入

| # | 改动 | 文件 | 工作量 |
|---|------|------|--------|
| 15 | pre-query 自动 lint 注入（> 7 天触发） | wiki-query SKILL.md | ~15 行 |
| 16 | `zwiki check --ci`：阈值 YAML → exit code CI gating | 修改 _check.py | ~30 行 |
| 17 | 结构扫描脚本：目录遍历 + import 图解析 → 结构化摘要表（Phase 1，纯确定性） | 新增 _structure_scan.py | ~150 行 |
| 18 | 哈希快照脚本：文件 MD5 快照 + 增量变更检测（Step A，codemap 风格） | 新增 _hash_snapshot.py | ~80 行 |
| 19 | kiwi 摘要表蒸馏模式：读摘要表 → 模块分类 + 块划分（Phase 2） | kiwi SKILL.md | ~40 行 |
| 20 | kiwi 差分蒸馏模式：读 diff + 旧摘要 → 增量操作列表（Step D） | kiwi SKILL.md | ~40 行 |
| 21 | `zwiki sync`：六步增量同步流程（Step A-F，编排层） | 新增 _sync.py | ~200 行 |

---

## 10. 总结

这份调研围绕六个问题展开：**wiki 里哪些知识过时了？找不到怎么办？谁来记得做维护？格式是否应该对齐外部标准？工具散落怎么统一？超大仓库怎么摄入和同步？**

答案分别是：

1. **知识生命周期** — 给每个页面加一个双轴状态（置信度 × 时效性），按页面类型分档衰减，五类事件驱动状态迁移。不做置信度浮点数，不搞艾宾浩斯曲线。最核心的改动是 `last_validated` 与 `timestamp` 分离，以及 `stale` 中间状态的引入。

2. **数据检索** — 在 index.md 导航之后加两道 fallback：标签过滤 + 全文 grep。三道防线逐级降级，确保链路不断。不做向量搜索，不做 BM25，当前 38 页用 ripgrep 足够。

3. **自动化策略** — 画一条清晰的线：确定性计算的全自动（`--apply`/`--fix`），语义判断的半自动（LLM 提议 + 人确认），裁决类的人工。不做事件驱动全自动，不信任 LLM 当裁判。

4. **OKF 格式对齐** — 我们的 wiki 已经是 OKF v0.1 的超集合规格式。四个字段重命名/新增、一个冗余字段删除，改动约 100 行。

5. **工具统一** — 六个散落脚本 + 多个新增能力整合为 `zwiki` 统一 CLI。借鉴 Obsidian CLI 和 llm-wiki-compiler 的设计，薄路由层包装现有模块逻辑。

6. **大规模摄入与增量同步** — 首次摄入用四阶段分块蒸馏（扫描→地图→分块编织→综合缝合），每周增量用六步同步（哈希→分大小→依赖追踪→差分或全量→报告）。借鉴 oh-my-opencode-slim 的 codemap 确定性扫描模式，kiwi 新增摘要表蒸馏和差分蒸馏两种能力。始终不自动应用 LLM 的修改——只标记，等审查。

这六个方向共用一个地基——P0-pre + P0 共 16 项改动约 600 行代码，纯机械，零 LLM 成本，可以立即实施。P1-P3 逐步引入 LLM 辅助和自动化，最终形成 21 步的完整路图，始终保持**机械活自动、判断活留人**的分界线。

---

## 参考

- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Rohit Gupta, "LLM Wiki v2" (2026): https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2
- Google, "Open Knowledge Format (OKF) v0.1": https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Google, "Knowledge Catalog": https://github.com/GoogleCloudPlatform/knowledge-catalog
- ZooKeeper wiki 设计文档: `docs/wiki-design.md`
- Wiki 健康检查概念: `wiki/concepts/wiki-health-check.md`
- 图链接预测概念: `wiki/concepts/graph-link-prediction.md`
- 复利知识概念: `wiki/concepts/compounding-knowledge.md`
- SCHEMA.md: `wiki/SCHEMA.md`
- lint.py: `wiki/tools/lint.py`
- Obsidian CLI: `https://help.obsidian.md/cli`
- notesmd-cli: `https://github.com/Yakitrak/notesmd-cli`
- llm-wiki-compiler: `https://github.com/atomicstrata/llm-wiki-compiler`
- oh-my-opencode-slim (codemap): `https://github.com/user/oh-my-opencode-slim`
