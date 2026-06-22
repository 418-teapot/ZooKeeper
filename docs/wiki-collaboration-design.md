# Wiki 多人协同与分发方案 — 技术调研报告

**版本:** 2.0
**日期:** 2026-06-22
**状态:** 设计阶段，方案 B（组织级 .org 层）选定，待评估后纳入实施路图

---

## 目录

1. [问题陈述](#1-问题陈述)
2. [外部参考与方向探索](#2-外部参考与方向探索)
3. [设计总览：四层架构](#3-设计总览四层架构)
4. [设计一：Layer 0 — 本地单机（现状）](#4-设计一layer-0--本地单机现状)
5. [设计二：Layer 1 — 分层覆盖（Overlay）](#5-设计二layer-1--分层覆盖overlay)
6. [设计三：Layer 2 — Git 团队同步](#6-设计三layer-2--git-团队同步)
7. [设计四：Layer 3 — OKF Bundle 联邦](#7-设计四layer-3--okf-bundle-联邦)
8. [与现有路线图的衔接](#8-与现有路线图的衔接)
9. [总结](#9-总结)

---

## 1. 问题陈述

### 1.1 现状

ZooKeeper 的 wiki 系统（`~/.zoo/wiki/`）已实现核心循环——ingest → query → lint，并具备 `zwiki` CLI 骨架、OKF 合规访问格式、四阶段生命周期状态模型。这是一个成熟的**单人单机知识库**。

当前系统的运行依赖是自洽的：`install.py` 创建 `~/.zoo/wiki` 软链接，所有工具脚本通过 `Path.home() / ".zoo" / "wiki"` 解析路径，插件在 `config` hook 中注入 SCHEMA 和 prompt 文件。agent 在机器本地就能完成全部知识操作。

### 1.2 八个结构性缺口

当场景从"单人单机"扩展到"多人团队 + 多团队协作 + 跨机器"时，现有设计暴露出八个结构性缺口：

| # | 缺口 | 表现 | 根因 |
|---|------|------|------|
| 1 | **路径硬编码单机** | `install.py` 和所有 wiki skill/tool 固定 `~/.zoo/wiki/`，跨机器无法访问 | 路径解析假设本地文件系统 |
| 2 | **无分发机制** | `zwiki okf export` 已在生命期报告 §7.2 设计但未纳入实施路线图 | 导出被推迟但分发从未被规划 |
| 3 | **无同步通道** | wiki 虽用 git 做版本历史，但未设计为分发通道——没有 push/pull 协议，没有冲突处理 | git 仅作回溯审计，非协作通道 |
| 4 | **无多用户层级** | 没有"个人知识"vs"团队知识"的概念区分——agent 的试探性发现与经过验证的权威知识存放在同一层级 | 目录结构是扁平的，缺少覆盖优先级 |
| 5 | **目录结构阻碍分发** | 当前类型优先（`concepts/`、`entities/`）而非域优先，打包子目录作为合法 bundle 时缺乏领域完整性 | OKF 分析已指出域优先才支持打包 |
| 6 | **注入机制无远程接口** | SCHEMA 注入仅限本地 `config` hook，MCP 规划也是本地工具模式 | 没有考虑远程知识源的消费场景 |
| 7 | **单一团队槽位** | `.team/` 只有一个槽位，无法同时接入多个团队（架构组、安全组、基础设施组）的知识 | 目录结构假设"一个团队"，缺少多团队命名空间 |
| 8 | **跨团队知识冲突** | 不同团队可能对同一概念有不同理解（如"权限模型"在核心团队和安全团队视角不同），当前没有冲突检测或仲裁机制 | 没有信任层级、没有跨团队共识协议 |

### 1.3 设计原则

1. **文件即协议** — 不引入数据库、不部署服务、不依赖外部平台。文件系统 + git + OKF 格式本身就是协同协议。
2. **渐进过渡** — 四层架构每层可独立部署，不强制团队一步到位。单人单机依然工作在 Layer 0，团队协作逐步启用 Layer 1/2/3。
3. **覆盖不摧毁** — 个人理解不干扰团队权威。覆盖层只影响查询时的优先级顺序，不修改下层文件。
4. **去中心化优先** — 联邦拓扑（Layer 3）优先于中心化服务。任何 bundle 都可独立存在，不依赖注册中心。
5. **后验可审计** — 所有同步、发布、合并操作留下可追溯的记录。git 是天然的审计轨道。

### 1.4 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 文件即协议，零基础设施依赖 | ❌ 引入数据库或知识图谱服务 |
| ✅ 渐进过渡，每层独立部署 | ❌ 一步到位的大统一方案 |
| ✅ 覆盖不摧毁，个人层不影响团队层 | ❌ 权限控制优先于协作流程 |
| ✅ 去中心化优先，bundle 可独立存在 | ❌ 中心化注册中心或 marketplace |
| ✅ git 作为审计轨道 | ❌ 自建审核系统 |

---

## 2. 外部参考与方向探索

### 2.1 npm for Knowledge（Bundle 包管理）

将知识打包为可发布、可安装的 bundle，借鉴 npm 的包管理模型：

| 机制 | npm 对应 | wiki 对应 |
|------|---------|----------|
| 包定义 | `package.json` | `bundle.toml` |
| 版本管理 | semver | semver（OKF bundle 版本） |
| 依赖声明 | `dependencies` | `[dependencies]` 跨 bundle 引用 |
| 发布 | `npm publish` | `zwiki bundle publish` |
| 安装 | `npm install` | `zwiki bundle install` |
| 作用域 | `@scope/name` | `@name/path` 语法 |

关键差异：npm 的依赖是执行时加载（代码），bundle 的依赖是查询时加载（知识）。bundle 安装不是下载到 `node_modules/`，而是注册到本地的 bundle registry（Layer 3 的 `~/.zoo/bundles/`）。

### 2.2 MCP Server 模式（实时共享）

Model Context Protocol (MCP) 提供"资源暴露"模式——将本地文件系统暴露为远程可访问的资源。对于 wiki 协同：

- **本地 MCP Server** 暴露 `~/.zoo/wiki/` 目录为 MCP 资源，其他机器的 agent 通过 MCP 客户端读取
- **优点：** 实时访问，零同步延迟，不需要 git 操作
- **代价：** 需要运行中 server、网络可达、认证机制

与本方案的互补关系：MCP 适合"hot sharing"（会话级实时共享），git 适合"cold distribution"（发布级异步分发）。两者不是替代关系。Layer 2 使用 git 做持久分发；MCP 可以作为补充通道——例如在团队内网部署 wiki MCP server，agent 直接查询远端而不需要本地克隆。

### 2.3 Pub/Sub 联邦（RSS for Wikis）

将 wiki 变更事件发布为类似 RSS 的 feed，订阅者自动拉取更新：

- **发布端：** `zwiki bundle publish` 时同时生成 feed（atom.xml），记录版本、变更摘要、新增页面路径
- **订阅端：** 定期轮询（或 webhook）检测 feed 更新，自动执行 `zwiki bundle install --upgrade`
- **优点：** 不依赖 git remote，适合单向发布场景（如上游项目发布知识包，下游自动接收）
- **代价：** 没有双向同步能力，冲突处理依赖"后发布的覆盖前发布的"

### 2.4 CRDT/P2P 去中心化

基于 CRDT（Conflict-free Replicated Data Types）的 P2P wiki 同步：

- 每个节点独立写入，CRDT 确保最终一致性
- 不需要中央服务器、不需要 git merge 手工解决冲突
- 适合离线优先、网络间歇可达的场景

**评估结论：** 对于 ZooKeeper 的组织规模（< 20 人团队），CRDT/P2P 的复杂度远超收益。CRDT 的冲突解决在文本文件层级仍然不成熟（Yjs/Automerge 主要用于富文本，markdown 文件的 CRDT 合并没有成熟方案）。维护 P2P 发现和连接的运维成本也不可忽略。**放弃此方向。**

### 2.5 Wiki-as-a-Service

将 wiki 托管为服务，agent 通过 API 查询和写入：

- 中心化 server 管理所有知识，提供 REST/gRPC/GraphQL 接口
- 内置认证、权限、版本管理、全文搜索

**评估结论：** 与"文件即协议"的核心原则完全矛盾。引入 server 意味着引入部署、运维、可用性、安全等一整套系统工程问题。对于 ZooKeeper 这种面向 agent 而非面向用户的系统，server 层是过度工程。**放弃此方向。**

### 2.6 知识粒度交易（单页寻址）

将"知识交易"的粒度从整个 bundle 细化到单页——类似 URL 级别的引用和引用计数：

- 每个页面有一个全局唯一的 URI（例如 `wiki://zookeeper-core/concepts/overlay-fs.md`）
- bundle 安装时可以选择只安装某个页面而非整个 bundle
- 单页引用可附带版本约束（`>=1.2.0`）

**评估结论：** 单页寻址在技术上可行（OKF 的路径本身就是地址），但版本约束在单页粒度上实践复杂——页面 A v1 和页面 A v2 的 diff 无法独立于 bundle 版本管理。当前 bundle 级 semver 足够覆盖需求。**单页寻址作为远期扩展保留，不纳入当前设计。**

### 2.7 六方向总体评估

| 方向 | 可行性 | 复杂度 | 与原则一致性 | 纳入方案 |
|------|--------|--------|------------|---------|
| npm for Knowledge | 高 | 中 | ✅ 文件即协议 | ✅ Layer 3 核心 |
| MCP Server 模式 | 高 | 中 | ✅ 零基础设施假设 | ⚠️ 补充通道 |
| Pub/Sub 联邦 | 中 | 中 | ⚠️ 需要 server 端 | ❌ 暂不纳入 |
| CRDT/P2P | 低 | 高 | ❌ 复杂度不可接受 | ❌ 放弃 |
| Wiki-as-a-Service | 低 | 极高 | ❌ 违背零依赖 | ❌ 放弃 |
| 单页寻址 | 中 | 中 | ✅ 但版本管理复杂 | ⚠️ 远期保留 |

### 2.8 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ npm 风格 bundle 包管理（Layer 3） | ❌ CRDT/P2P 去中心化同步 |
| ✅ MCP Server 作为补充实时通道 | ❌ Wiki-as-a-Service 中心化服务 |
| ✅ Bundle 级 semver 版本管理 | ❌ 单页粒度独立版本（远期考虑） |
| ✅ bundle.toml + 依赖声明 | ❌ Pub/Sub 联邦订阅机制 |
| ✅ 去中心化联邦拓扑 | ❌ 中心注册中心或 marketplace |

---

## 3. 设计总览：四层架构

### 3.1 架构概览

四层架构从本地单机逐步扩展到联邦分发，每层向下兼容：

```
┌────────────────────────────────────────────────────────┐
│  Layer 3: OKF Bundle 联邦                              │
│  bundle.toml → publish → install → @team/path          │
│  跨组织、跨项目知识分发                                │
│  联邦拓扑：组织 registry → team bundles → consensus    │
├────────────────────────────────────────────────────────┤
│  Layer 2: Git 团队同步                                 │
│  teams.toml → 多 repo 管理 → push/pull → PR/CI         │
│  每个团队独立 repo，install.py 管理多 remote           │
├────────────────────────────────────────────────────────┤
│  Layer 1: 分层覆盖（Overlay）                          │
│  personal/ → .org/ → .teams/<name>/ → .upstream/       │
│  五级查询级联，team role 决定冲突行为                   │
│  .org/ 层存放跨团队共识知识                             │
├────────────────────────────────────────────────────────┤
│  Layer 0: 本地单机（现状）                             │
│  ~/.zoo/wiki/ → install.py 创建 → SCHEMA 注入          │
│  单人单机，零协同能力                                  │
└────────────────────────────────────────────────────────┘
```

### 3.2 各层职责与边界

| 层 | 用户规模 | 数据流向 | 延迟 | 依赖 |
|----|---------|---------|------|------|
| L0 | 1 人 | 本地读写 | 即时 | 无 |
| L1 | 1-N 人试错 | 本地级联（五级） | 即时 | 目录约定 + teams.toml |
| L2 | 2-20 人 | git push/pull | 分钟级 | git + remote |
| L3 | 任意 | bundle publish/install | 小时级 | HTTP hosting |

### 3.3 递进关系

```
L0 → L1: 新增目录约定，不改现有文件。~/.zoo/wiki/ 变为 personal 层，新增 .org/、.teams/<name>/ 和 .upstream/。
          个人知识从 personal 起步，稳定后 promote 到 .teams/<name>/。跨团队共识提升到 .org/。零中断迁移。

L1 → L2: 将 ~/.zoo/wiki/ 变为多 git repo 架构。install.py 新增 --wiki-repo <name> <url> 参数。
          每个团队独立 repo，teams.toml 管理。git push/pull 按团队隔离。

L2 → L3: bundle.toml + publish/install CLI。团队知识打包发布到组织外。
          跨 bundle 引用通过 @name/path 统一语法（@team/path 或 @bundle/path）。
```

### 3.4 设计哲学：文件即协议

四层架构不需要任何新基础设施。每一层都是对现有文件系统约定的扩展：

- **L0 的文件路径**就是协议——agent 解析 `~/.zoo/wiki/` 即得
- **L1 的目录名**就是协议——`personal/` > `.org/` > `.teams/<name>/` > `.upstream/` 优先级隐含在查询逻辑中
- **L2 的 teams.toml + git remote**就是协议——每个团队独立 remote，`origin` 映射到 primary team
- **L3 的 bundle.toml**就是协议——声明了版本、依赖、导出范围

### 3.5 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 四层递进，每层独立部署 | ❌ 所有层必须全上线才能工作 |
| ✅ 每层向下兼容 L0 | ❌ 强制迁移到更高层 |
| ✅ 文件即协议，无基础设施依赖 | ❌ server/数据库/中间件 |
| ✅ 目录约定作为协议（命名即 API） | ❌ 配置文件驱动的发现协议 |
| ✅ 渐进过渡风格 | ❌ 大爆炸式统一迁移 |

---

## 4. 设计一：Layer 0 — 本地单机（现状）

### 4.1 当前架构

Layer 0 是现有系统，不做任何修改。它的边界清晰：

```
~/.zoo/wiki/（软链接到 <project>/wiki/）
├── index.md
├── log.md
├── overview.md
├── SCHEMA.md
├── concepts/
├── entities/
├── analysis/
├── syntheses/
├── sources/
│   ├── adr/
│   ├── rfc/
│   └── notes/
└── templates/
```

- `install.py` 创建 `~/.zoo/wiki` 软链接
- 工具脚本通过 `Path.home() / ".zoo" / "wiki"` 解析路径
- `config` hook 注入 SCHEMA 缩略版到 agent prompt

### 4.2 L0 的约束

| 约束 | 影响 |
|------|------|
| 路径硬编码 `~/.zoo/wiki/` | 跨机器无法共享 |
| 单层目录，无覆盖优先级 | 多人有冲突语义 |
| 非 git repo（或仅在项目内 git） | 无独立版本历史 |
| 类型优先目录结构 | 无法打包合法 OKF bundle |
| 无贡献者追踪 | 多人编辑无法归因 |

### 4.3 L0 → L1 的迁移路径

L0 用户向 L1 迁移时只需一步：创建 `.teams/default/` 目录和 `teams.toml`，将现有 `~/.zoo/wiki/` 内容搬入 `.teams/default/`，新的 `personal/` 层保持为空。整个过程对查询语义是透明的——`personal` 空，`.teams/default` 有内容，查询结果与 L0 完全一致。

```
# 迁移前（L0）
~/.zoo/wiki/concepts/prompt-injection.md

# 迁移后（L1）
~/.zoo/wiki/.teams/default/concepts/prompt-injection.md
~/.zoo/wiki/personal/（空，新建）
~/.zoo/wiki/.org/（空，新建）
~/.zoo/wiki/.upstream/（空，新建）
~/.zoo/wiki/teams.toml
```

agent 查询 `concepts/prompt-injection.md` 时：
1. 尝试 `personal/concepts/prompt-injection.md` → 不存在
2. 尝试 `.org/concepts/prompt-injection.md` → 不存在
3. 遍历 `.teams/`，按 priority 排序 → `.teams/default/concepts/prompt-injection.md` 存在，返回
4. 尝试 `.upstream/...` → 不存在，跳过

结果与 L0 完全一致。**零中断迁移。**

> **注意：** 单团队场景只需创建 `.teams/default/` 一个目录，teams.toml 中只定义一个 team。多团队场景在此基础扩展即可。

### 4.4 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ L0 完全保持不动 | ❌ 要求 L0 用户立即理解分层概念 |
| ✅ 零中断迁移路径 | ❌ 强制目录结构修改 |
| ✅ `~/.zoo/wiki` 路径兼容 | ❌ 多路径歧义（`personal/` vs 根部） |
| ✅ L0 用户不感知上层存在 | ❌ 向上兼容性测试的隐性成本 |

---

## 5. 设计二：Layer 1 — 分层覆盖（Overlay）

### 5.1 问题

团队协作的核心矛盾：**个人探索需要自由修改，团队知识需要稳定权威。** 如果 agent 为了试探某个假设而修改了概念页面，而这个修改被后续查询当作权威结论引用，代价是不可接受的。

Docker overlay filesystem 给了我们启发：上层覆盖下层，但下层文件本身不被修改。查询时按优先级读取，写操作只影响当前层。

当组织存在**多个团队**时，问题进一步复杂化：
- 核心团队（负责架构）和安全团队（负责合规）对"权限模型"可能有不同视角——两者都是有效知识，但不能互相覆盖
- 跨团队达成的共识需要比单个团队更高的权威层级
- 团队之间有信任层级——某些团队的知识应优先采纳

### 5.2 五级目录结构

```
~/.zoo/wiki/
├── personal/              ← 最优先：当前 agent/用户的个人理解
│   └── concepts/
│       └── overlay-fs.md
├── .org/                  ← 组织级共识（跨团队 review 后合入，权威性最高）
│   └── concepts/
│       ├── coding-standards.md
│       └── permission-model.md   (多团队共识版本)
├── .teams/                ← 各团队知识（按 teams.toml 中 priority 排列）
│   ├── core/              ← primary team (priority=1)
│   │   └── concepts/
│   │       └── permission-model.md    (核心团队视角)
│   ├── security/          ← advisory team (priority=2)
│   │   └── concepts/
│   │       └── permission-model.md    (安全团队视角)
│   └── infra/             ← supplementary team (priority=3)
│       └── concepts/
├── .upstream/             ← 最低优先：外部 bundle 提供的基础知识
│   └── entities/
│       └── task-tool.md
├── index.md               ← 五层合并后的索引（自动生成或手动维护）
├── log.md
└── SCHEMA.md
```

**为什么 `.org/`、`.teams/` 和 `.upstream/` 用点前缀？**
- 点前缀目录在文件管理器中默认隐藏，暗示"框架维护，用户一般不直接操作"
- `personal/` 无点前缀，暗示"用户的主工作区"
- 这与 dotfile 惯例一致（`.git/`、`.github/`、`.vscode/`）
- `.org/` 作为组织级共识层，应受保护不被随意修改

**为什么 `.org/` 不是独立 git repo？**
`.org/` 是组织级共识的安置处，内容来源是 teams 间达成共识后提取的页面。它由 `zwiki consensus` 管理（见 §5.5），任何团队不能单方面修改——需多团队 review，至少 2 个团队 approve。

#### teams.toml 配置

```toml
# ~/.zoo/wiki/teams.toml
[[teams]]
name = "core"
repo = "git@github.com:org/zookeeper-wiki.git"
priority = 1
role = "primary"

[[teams]]
name = "security"
repo = "git@github.com:org/security-wiki.git"
priority = 2
role = "advisory"

[[teams]]
name = "infra"
repo = "git@github.com:org/infra-wiki.git"
priority = 3
role = "supplementary"
```

**Team role 决定查询时的冲突行为：**

| Role | 行为 |
|------|------|
| `primary` | 最高优先团队，同名页面直接返回（如 core 和 security 都有 `permission-model.md`，返回 core 的） |
| `advisory` | 不覆盖 primary，返回 primary 版本但附注提示"[Security] 团队另有结论，运行 `zwiki check --teams concepts/permission-model.md` 查看差异" |
| `supplementary` | 无重叠预期，重叠时警告"⚠️ [infra] 团队页面与 primary 重叠，请确认" |

Priority 仅在 role 相同的团队间生效（如同一 org 有两个 primary team，priority 低的在前）。

### 5.3 查询级联（Phase 1-2-3）

`wiki-query` 收到查询后执行五级级联：

```
Phase 0: 读合并后的 index.md
  如果 index.md 已正确索引，直接跳转到 Phase 2

Phase 1: 解析路径
  对于每个需要读取的 <category>/<page>.md：
    1. 检查 personal/<category>/<page>.md       → 存在则返回（最高优先）
    2. 检查 .org/<category>/<page>.md            → 存在则返回（组织共识，权威性最高）
    3. 遍历 .teams/<name>/，按 priority 排序
       a. 遍历按 priority 升序（1→N）
       b. 对每个 team，检查 <category>/<page>.md
       c. 根据 team role 处理（见上表）
    4. 检查 .upstream/<category>/<page>.md       → 存在则返回（最低优先）
    5. 全部不存在 → 页面不存在

Phase 2: 同名覆盖检测
  如果多层有同名页面：
    - 返回最高优先版本
    - 追加跨层覆盖附注：
      "⚠️ 当前显示的是 personal 层版本。
       .org 层有一个同名页面（最后更新于 2026-06-22，status: stable），
       可能包含不同的描述。运行 `zwiki check --layers <page>` 查看差异。"
    - 如果跨 team 同页面存在（如 core 和 security 都有某页面），附注提示 teams 差异
```

**index.md 的处理：**
- 各层自己的 `index.md` 独立维护
- 查询时 `/index.md` 路径也会触发级联——先查 `personal/`、再 `.org/`、再 `.teams/`、再 `.upstream/`
- 或者生成一个合并的 `index.md`（`zwiki check --merge-index`），但这引入写冲突。更好的方式是 agent 查询时做逻辑合并，不写文件

**实现提示：** agent 通过 `bash` 工具执行 `zwiki check --layers <path>` 获取覆盖信息，而不是自行拼凑路径解析逻辑。

### 5.4 覆盖检测（zwiki check --layers）

```
$ zwiki check --layers
检查层级覆盖状态...

overlay-fs.md:
  personal:       存在（updated: 2026-06-22，status: draft）
  .org:           不存在
  .teams/core:    存在（updated: 2026-06-15，status: stable）
  ⚠️ personal 版本较新，但 core 版本是 stable，personal 只是 draft
  ⚠️ 建议：编辑 core 版本或撤销 personal 覆盖

permission-model.md:
  personal:       不存在
  .org:           存在（updated: 2026-06-22，status: stable）
  .teams/core:    存在（updated: 2026-06-10，status: stable）
  .teams/security:存在（updated: 2026-06-18，status: stable）
  ✅ .org 层覆盖（跨团队共识），core 和 security 有独立版本
  ⚠️ 跨团队分歧：core 和 security 对 permission-model 有不同版本
     运行 `zwiki check --teams concepts/permission-model.md` 查看差异
```

**跨团队冲突三级处理：**

| 层级 | 场景 | 处理 |
|------|------|------|
| a) 同 team 内 | 同团队两人同时编辑 | 现有 contradiction 机制（lifecycle research 已覆盖） |
| b) 跨 team 无共识 | 不同团队对同一概念有不同理解且无法调和 | 各 team 保留各自版本，查询时按 role 处理（primary 优先，advisory 附注） |
| c) 跨 team 有共识 | 团队间达成共识 | 提取到 .org 层，通过 `zwiki consensus` 管理 |

**覆盖规则（同 team 内）：**

| 条件 | 状态 | 提示 |
|------|------|------|
| 同名页面只存在于单层 | ✅ 正常 | 无 |
| personal 比 team 版本新，但 personal 是 draft / team 是 stable | ⚠️ stale override | "你的覆盖比被覆盖的版本更不成熟" |
| personal 比 team 版本旧 | ⚠️ stale override | "你的覆盖版本已过时，团队版本有更新" |
| personal 覆盖了 .upstream 但 .org 有相关页面 | ⚠️ 间接覆盖 | "上游版本被 indirect override" |

**不自动处理。** 检测是做呈现，不自动删除覆盖、不自动合并。覆盖存在本身就是信息——agent 在试探某个假设，这个假设被记录在 personal 层，可以在 review 时被团队审视。

### 5.5 Promote 与共识流程

#### 5.5.1 Personal → Team Promote

当个人层的内容经过验证，值得提升为团队权威知识时：

```
途径 1：手动 promote（L1 内部，无 git）
  zwiki promote concepts/overlay-fs.md --team core
    → 扫描 personal/concepts/overlay-fs.md
    → 检查 .teams/core/ 是否有同名页面 → 有则提示 diff
    → 复制到 .teams/core/concepts/overlay-fs.md
    → 保留 personal 副本（可选择 --delete-source）
    → 追加 log.md：personal → core promote

途径 2：通过 git propose（L2 集成，见 §6.5）
  zwiki propose concepts/overlay-fs.md --team core
    → 同上 promote 逻辑 + diff + gh pr create
```

**`zwiki promote` 参数变化：**
- `--team <name>`：指定目标团队（默认读取 teams.toml 中 priority=1 的 team）
- 省略 `--team` 时提示可用团队列表

#### 5.5.2 Team → .org Consensus（zwiki consensus）

当多团队对同一概念达成共识，需提升到 `.org/` 层时：

```
zwiki consensus concepts/permission-model.md --teams core,security
  Step 1: 分析各团队版本差异
    - 读取 .teams/core/concepts/permission-model.md
    - 读取 .teams/security/concepts/permission-model.md
    - 生成版本对比报告（diff + 语义差异）
  Step 2: kiwi 辅助判断（是否可以调和）
    - 如果差异可自动合并 → 生成合并草案
    - 如果差异不可调和 → 提示人工介入
  Step 3: 生成 consensus draft
    - 写入临时文件 .org/.drafts/concepts/permission-model.md
    - 添加 consensus frontmatter
  Step 4: 需要指定团队 approve
    - --require core,security (至少 2 个团队)
    - 每个团队运行 `zwiki consensus approve <draft-id> --team <name>`
    - 当批准数达到门槛 → 移动 draft 到 .org/concepts/permission-model.md
```

**Consensus 页面 frontmatter：**

```yaml
---
title: Permission Model
type: synthesis
status: stable
consensus_of:
  - team: core
    version: 2026-06-15
  - team: security
    version: 2026-06-18
resolved: 2026-06-22
---
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `type: synthesis` | 标识此页面为多团队综合产物 |
| `consensus_of[]` | 来源团队列表 + 各团队版本的快照时间 |
| `resolved` | 共识达成日期 |
| `status: stable` | 共识页面固定为 stable（不允许 draft） |

**共识的版本演化：**
- 如果 core 或 security 后续更新了自己的版本，`.org/` 版本标记为 `stale`，提示运行 `zwiki consensus update concepts/permission-model.md` 重新协商
- `zwiki consensus update` 流程同上，但保留 frontmatter 中旧 consensus_of 记录

### 5.6 与 wiki-query 的集成

`wiki-query` skill 的 Phase 1（导航入口）需要感知五层结构：

```
## Phase 0 — 层级感知

wiki 有五层：personal（个人） > .org（组织共识） > .teams/<name>（团队） > .upstream（上游）。
各团队按 teams.toml 中 priority 排列，role 决定查询行为。
查询优先读取 personal 层，然后级联到 .org、.teams 和 .upstream。
运行 `zwiki check --layers <page>` 查看某页面各层版本的状态。
运行 `zwiki check --teams <page>` 查看跨团队页面差异。
```

当前 `wiki-query` SKILL.md 中的 Phase 0 只是"Read index.md"，需要扩展为"确定读取哪个层级的 index.md"。

### 5.7 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ personal → .org → .teams/<name> → .upstream 五级覆盖 | ❌ 无限层级（N 层个人嵌套） |
| ✅ 查询级联：最高优先返回 + 附注提示 | ❌ 自动合并多版本内容 |
| ✅ 覆盖检测：stale override + 跨团队检测 | ❌ 自动修复覆盖冲突 |
| ✅ promote 流程（personal → team） | ❌ 自动 promote（需人工/团队确认） |
| ✅ consensus 流程（team → .org，多团队 review） | ❌ 自动 consensus（kiwi 辅助判断，人工决策） |
| ✅ team role 约束冲突行为 | ❌ 复杂的权限矩阵 |
| ✅ teams.toml 作为单一 team 配置来源 | ❌ 从 git remote 自动推导 team 信息 |
| ✅ .org/.teams/.upstream 点前缀隐藏 | ❌ 复杂的路径重写或软链接 |
| ✅ index.md 逻辑合并 | ❌ 写合并的 index.md 引发冲突 |

---

## 6. 设计三：Layer 2 — Git 团队同步

### 6.1 问题

Layer 1 解决了"个人 vs 团队"的覆盖优先级，但没有解决"怎么把个人修改同步给团队"。如果两个同事各自改了 `.teams/core/` 的不同页面，他们需要一个共享通道来协调这些变更。

当组织有**多个团队**时，同步问题进一步复杂化：
- 每个团队有自己的 git repo，互不干扰
- primary team 的变更直接影响查询结果，advisory 和 supplementary 团队的变更独立演进
- `install.py` 需要管理多个 remote，不是单个 `--wiki-repo` 参数

### 6.2 多 Repo 架构（teams.toml 驱动）

每个团队拥有自己独立的 git 仓库，`teams.toml` 统一管理：

```toml
# ~/.zoo/wiki/teams.toml
[[teams]]
name = "core"
repo = "git@github.com:org/zookeeper-wiki.git"
priority = 1
role = "primary"

[[teams]]
name = "security"
repo = "git@github.com:org/security-wiki.git"
priority = 2
role = "advisory"
```

```
# install.py 新增参数（可多次指定）
python3 install.py --wiki-repo core git@github.com:org/zookeeper-wiki.git \
                   --wiki-repo security git@github.com:org/security-wiki.git

# 或通过环境变量
ZOO_WIKI_REPO=core:git@github.com:org/zookeeper-wiki.git python3 install.py
```

**行为变化：**

| 场景 | 单机模式（L0/L1） | 多 Repo 模式（L2） |
|------|-------------------|-------------------|
| install.py 创建 | 软链接 + 本地目录 | 读取 teams.toml，逐个 git clone |
| 首次安装 | 创建目录 | 对每个 team: `git clone <repo> ~/.zoo/wiki/.teams/<name>/` |
| 已有目录 | 不动 | 逐个添加/更新 remote |
| `zwiki sync` | 无操作 | 遍历所有 team，各自 pull/push |
| `zwiki promote` | 本地复制 | 根据 `--team` 参数同步到对应 repo |

**.org/ 和 .upstream/ 的 git 管理：**
- `.org/` 层非独立 git repo——它由 `zwiki consensus` 生成，在 primary team repo 中版本管理
- `.upstream/` 由 `zwiki bundle install` 管理，不纳入团队 git
- `personal/` 始终 .gitignore

**为何独立 repo 而非嵌入项目 repo？**

| 方案 | 优点 | 缺点 |
|------|------|------|
| 嵌入项目 repo | 单一仓库，单次 clone | wiki 变更频率与项目代码不同步；git log 混杂；分支策略耦合 |
| **独立 repo（选）** | 独立版本历史；独立权限；独立 CI | 需要额外 clone 操作 |

wiki 的生命周期与项目代码不同——知识积累是持续、低频的，而代码迭代是周期、高频的。独立 repo 让 wiki 的版本历史不被代码提交冲散。

#### 目录变化（L0 → L2 状态对比）

```
# L0/L1 单机状态
~/.zoo/wiki/
├── personal/
├── .org/
├── .teams/
│   └── core/            ← 本地目录，无 git remote
├── .upstream/
└── teams.toml

# L2 多 repo 状态
~/.zoo/wiki/
├── personal/             ← .gitignore
├── .org/                 ← 包含在 primary team repo 中
├── .teams/
│   ├── core/             ← git remote → git@github.com:org/zookeeper-wiki.git
│   ├── security/         ← git remote → git@github.com:org/security-wiki.git
│   └── infra/            ← git remote → git@github.com:org/infra-wiki.git
├── .upstream/            ← bundle 管理，非 git
├── teams.toml            ← git 管理
├── index.md
├── log.md
└── SCHEMA.md
```

### 6.3 同步工作流

```
# 拉取所有团队的最近知识
zwiki sync pull
    → 遍历 teams.toml 中所有 team
    → 对每个 team: git pull origin main（在 .teams/<name>/ 下执行）
    → 检测是否有 remote 新建/修改的页面
    → 如果有覆盖 local personal 层的内容，提示
    → 输出同步摘要：
       core:     ✅ up-to-date
       security: ✅ pulled 2 new commits
       infra:    ⚠️  pull failed (network error)

# 推送本地变更到指定团队
zwiki sync push --team core
    → 在 .teams/core/ 目录下执行
    → git add . SCHEMA.md index.md log.md
    → git commit -m "sync: <自动生成的消息>"
    → git push origin main

# 查看所有团队同步状态
zwiki sync status
    → 遍历 teams.toml 中所有 team
    → git status（在每个 .teams/<name>/ 下，排除 personal/）
    → 显示 ahead/behind 计数
```

**personal 层不纳入 git 管理：** `.gitignore` 中应包含 `personal/`。personal 是当前机器的工作区，不应污染团队版本历史。如果用户在 A 机器 personal 层做了 probe 后换到 B 机器，需要手动 promote 到 .teams/<name> 层才能在 B 机器访问到。

**`.org/` 的同步策略：**
- `.org/` 目录在 primary team repo 中版本管理
- `zwiki sync push --team primary` 自动包含 `.org/` 变更
- 非 primary team 的 repo 中 `.org/` 被 `.gitignore`（避免重复）

### 6.4 Propose 流程（Personal → Team via PR）

```
zwiki propose concepts/overlay-fs.md --team core
  Step 1: 检查 personal 层是否存在
  Step 2: 自动运行 zwiki check --layers <page> → 生成覆盖报告
  Step 3: 生成 diff（personal 版本 vs .teams/<team>/ 版本）
  Step 4: 用 kiwi 生成变更理由
  Step 5: git checkout -b propose/overlay-fs（在 .teams/<team>/ 下）
  Step 6: 复制 personal/ → .teams/<team>/
  Step 7: git add + git commit
  Step 8: gh pr create
      --title "propose: overlay-fs.md（个人→团队提升）"
      --body "<自动生成的变更理由 + diff 摘要 + 覆盖报告>"

输出：PR URL
```

**参数说明：**
- `--team <name>`：指定目标团队（必选）。不指定时提示可用团队列表（从 teams.toml 读取）
- 默认 target 是 primary team（priority=1）

**CI 门禁（触发条件：PR opened / synchronized）：**

```
CI 运行:
  1. zwiki check --ci           → 健康检查（零 LLM）
  2. zwiki lint --ci            → 格式和链接检查（零 LLM）
  3. zwiki okf check            → OKF 合规性（零 LLM）
  4. （可选）kiwi review         → LLM 审查语义一致性

门禁规则：
  - check/okf 失败 → ❌ 阻止合并
  - lint 警告 → ⚠️ 提示但不阻止
  - kiwi review 发现问题 → ⚠️ PR 评论附加
```

### 6.5 冲突处理

wiki 文件的冲突概率比代码低——大多数编辑是追加（新页面、新日志）而非修改。但在以下场景可能发生冲突：

| 场景 | 概率 | 处理方法 |
|------|------|---------|
| 两人同时编辑同一页面 | 低 | 标准 git merge conflict → 手工解决 |
| 两人同时 promote 同页面名 | 低 | 后 promote 者需要 rebase |
| log.md 追加冲突 | 高（如果单文件） | ✅ **log.md 按月分文件**（见下） |
| index.md 条目追加 | 中 | 追加式不冲突，修改条目描述的才冲突 |
| 跨团队同名页面 | 中 | 按 role 处理（§5.2 team role），不产生 git conflict |
| consensus 页面被单方面修改 | 低 | `zwiki check` 检测到 .org 页面与团队版本不一致 → 标记 stale |

**跨团队冲突不在 git 层面处理。** 不同团队有各自独立的 git repo，同名页面存在于不同命名空间（`.teams/core/` vs `.teams/security/`），不触发 git merge conflict。冲突在**查询时**由 Layer 1 的 role 逻辑处理（§5.2）。

**log.md 分文件方案：**

```
wiki/log.md              → 索引文件，只列出各月日志文件名
wiki/logs/
├── 2026-01.md
├── 2026-02.md
├── 2026-03.md
├── ...
└── 2026-06.md
```

- 当月日志写入 `logs/2026-06.md`，不会与历史月份冲突
- 跨年时自动创建新文件
- 查询时 `zwiki log` 自动聚合所有月份（或按 `--since`/`--until` 过滤）
- 历史日志不会因为当前月份的写入而产生冲突

**log.md 索引文件内容：**

```markdown
# Change Log

按月分文件。当前月份：`logs/2026-06.md`

## 索引

- [2026-01](logs/2026-01.md)
- [2026-02](logs/2026-02.md)
- [2026-03](logs/2026-03.md)
- [2026-04](logs/2026-04.md)
- [2026-05](logs/2026-05.md)
- [2026-06](logs/2026-06.md)
```

### 6.6 贡献者追踪

前文定义过 frontmatter 中的 `contributors` 字段：

```yaml
contributors:
  - user: alice
    role: author
    since: 2026-01-15
  - user: bob
    role: validator
    since: 2026-03-20
```

在 git 同步场景下，contributors 字段自动维护：

```
# 有人通过 propose/PR 合入修改时
git log --follow --format="%an" -- .teams/<team-name>/concepts/foo.md
→ 获取所有修改者的 git username
→ 自动追加或更新 contributors 列表

# 手动维护（--edit 模式）
zwiki property contributors --add '{"user": "carol", "role": "reviewer", "since": "2026-06-01"}' --page .teams/<team-name>/concepts/foo.md
```

**自动化规则：**

| 事件 | 自动更新 contributors | 保留手动 role 声明 |
|------|---------------------|-------------------|
| PR merge 新增页面 | ✅ 添加 author | ✅ 保留 |
| PR merge 修改已有页面 | ✅ 如果 git 用户不在列表则添加为 contributor | ✅ 保留已有 role |
| zwiki property 编辑 | ❌ 不自动改 | ✅ 信任手动设置 |

### 6.7 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 每个团队独立 git repo（多 repo 架构） | ❌ 嵌入项目 repo 或单 repo 管理所有团队 |
| ✅ personal 层 gitignore | ❌ personal 纳入团队版本管理 |
| ✅ propose → PR → CI 流程（支持 `--team` 指定目标） | ❌ 绕过 PR 直接 merge |
| ✅ log.md 按月分文件 | ❌ 复杂 CRDT 冲突解决 |
| ✅ contributors frontmatter 自动维护 | ❌ 贡献度打分或统计 |
| ✅ zwiki sync pull/push（遍历所有 team） | ❌ 自动定时同步 |
| ✅ teams.toml 作为单一配置入口 | ❌ 环境变量或命令行参数拼凑 team 信息 |
| ✅ zwiki sync pull/push | ❌ 自动定时同步 |

---

## 7. 设计四：Layer 3 — OKF Bundle 联邦

### 7.1 问题

Layer 2 解决了团队内部的同步，但知识需要在**跨项目、跨组织**间分发。ZooKeeper 插件生态可能需要消费来自不同项目的知识包：`zookeeper-core` 提供核心概念，`opencode-plugin-system` 提供 MCP 集成指南，`llm-wiki-compiler` 提供蒸馏格式说明。

OKF 规范已经定义了 bundle 的概念——链接隔离域。我们的 wiki 已经是 OKF bundle（`okf_version: "0.1"`）。Layer 3 就是让这个 bundle 可以被分发和被消费。

### 7.2 Bundle 定义（bundle.toml）

每个 wiki 仓库的根目录包含 `bundle.toml`，声明包的元数据：

```toml
[package]
name = "zookeeper-core"
version = "1.2.0"
description = "ZooKeeper 编排器插件的核心 wiki 知识包"
okf_version = "0.1"

[dependencies]
opencode-plugin-system = ">=0.5"
llm-wiki-compiler = ">=1.0"

[export]
include = [
    "concepts/",
    "entities/",
    "analysis/",
    "SCHEMA.md"
]
exclude = [
    "concepts/internal-*",
    "personal/",
    ".teams/*/personal-notes/"
]

[export.index]
type = "auto"             # auto: 自动生成 index.md; manual: 使用已存在的 index.md
merge_upstream = true     # 是否在 index.md 中包含依赖 bundle 的条目

[federation]
trusted = ["opencode-plugin-system"]
review_required = ["experimental-ml-wiki"]
blocked = ["deprecated-legacy-wiki"]
```

**字段说明：**

| 字段 | 说明 |
|------|------|
| `[package]` | 包元数据。`name` 全局唯一（建议 `@org/name` 作用域）；`version` 遵循 semver；`okf_version` 声明 OKF 格式版本 |
| `[dependencies]` | 依赖的其他 bundle。版本范围支持 `>=x.y`、`~x.y.z`、`^x.y` |
| `[export.include]` | 发布的包含路径。**路径是 bundle-relative** |
| `[export.exclude]` | 排除模式。支持 glob。优先级高于 include |
| `[export.index]` | index.md 策略 |
| `[federation]` | **联邦可信列表**（新增）。`trusted` 白名单——无需额外确认即可安装；`review_required` 需人工审查后才能安装；`blocked` 黑名单——禁止安装 |

**`[federation]` 详细说明：**

| 字段 | 行为 |
|------|------|
| `trusted` | `zwiki bundle install` 时自动安装，无需确认。通常包含同组织的知名 bundle |
| `review_required` | 安装时提示"此 bundle 需要审查，运行 `zwiki bundle review <name>` 后继续" |
| `blocked` | 安装时直接拒绝："bundle <name> 已被组织屏蔽，原因：deprecated" |

联邦可信列表由组织管理员维护（通过 PR 修改 bundle.toml），每个 bundle 发布者可以声明自己信任/不信任哪些 bundle。安装时取交集（本地配置 × bundle.toml 声明）。

**为何需要 `exclude.personal/`？**
Layer 2 的 `.gitignore` 已经排除 `personal/`，但 bundle 发布时应再显式排除一次，防止误操作包含个人层内容。

### 7.3 发布与安装

**发布：**

```
# 打包并发布
zwiki bundle publish
  Step 1: 读取 bundle.toml
  Step 2: 运行 zwiki okf check（验证 OKF 合规）
  Step 3: 确认版本未重复（检查 registry）
  Step 4: 打包 export.include 中的文件为 tar.gz + SHA256
  Step 5: 发布到 registry（HTTP PUT）或生成 .bundle 文件
  Step 6: 打 git tag v1.2.0
  Step 7: 追加 log.md：bundle publish v1.2.0

# 输出 bundle 文件（无 registry 时）
zwiki bundle publish --output ./zookeeper-core-v1.2.0.bundle
```

**安装：**

```
# 从 registry 安装
zwiki bundle install zookeeper-core
    → 查询最新版本（默认）或指定版本
    → 下载 tar.gz → 校验 SHA256
    → 解压到 ~/.zoo/bundles/zookeeper-core/
    → 读取 bundle.toml → 递归安装 dependencies
    → 更新 ~/.zoo/wiki/.upstream/ 下的映射

# 从 bundle 文件安装
zwiki bundle install ./zookeeper-core-v1.2.0.bundle

# 卸载
zwiki bundle uninstall zookeeper-core
    → 检查是否有其他 bundle 依赖它（--force 可强制卸载）
    → 移除 ~/.zoo/bundles/zookeeper-core/
    → 移除 .upstream/ 映射

# 查看已安装的 bundle
zwiki bundle list
zookeeper-core@1.2.0     → ~/.zoo/bundles/zookeeper-core/
opencode-plugin-system@0.5.1 → ~/.zoo/bundles/opencode-plugin-system/
```

### 7.4 Bundle 安装目录结构

```
~/.zoo/
├── wiki/                     # Layer 1/2 的层级 wiki
│   ├── personal/
│   ├── .org/
│   ├── .teams/
│   │   ├── core/
│   │   ├── security/
│   │   └── infra/
│   └── .upstream/            # 从 bundle 安装的上游知识
│       └── zookeeper-core/
│           ├── concepts/
│           ├── entities/
│           └── ...
├── bundles/                  # Bundle 仓库
│   ├── zookeeper-core/
│   │   ├── bundle.toml
│   │   ├── concepts/
│   │   ├── entities/
│   │   └── ...
│   └── opencode-plugin-system/
│       └── ...
└── bundle-registry.toml      # 本地 bundle registry 配置
```

**`.upstream/` 的三种填充方式：**

| 方式 | 命令 | 说明 |
|------|------|------|
| bundle install 自动注入 | `zwiki bundle install zookeeper-core` | 自动创建 `~/.zoo/wiki/.upstream/zookeeper-core/` 软链接到 `~/.zoo/bundles/zookeeper-core/` |
| 手动软链接 | `ln -s ~/.zoo/bundles/zookeeper-core/* ~/.zoo/wiki/.upstream/zookeeper-core/` | 手动管理 |
| git submodule | `git submodule add <repo> ~/.zoo/wiki/.upstream/zookeeper-core` | 如果 upstream 也是 git repo |

推荐使用第一种：`zwiki bundle install` 管理映射关系，安装时自动建立符号链接，卸载时清理。

### 7.5 跨 Bundle 引用语法（统一命名空间）

Layer 3 最需要定义的新语法：**如何从页面 A（处于 bundle X）引用页面 B（处于 bundle Y）。**

`@name/path` 语法统一了团队和 bundle 的命名空间——`@` 前缀后可以是团队名（从 teams.toml 读取）或 bundle 名（从 registry 查询），解析时团队名优先。

```
# 同一 bundle 内（已有 OKF 规范）
[permission model](entities/permission-model.md)

# 跨 bundle 引用（同层）
[opencode plugin system](@opencode-plugin-system/concepts/mcp-integration.md)

# 引用团队知识（跨层）
[security permission model](@security/concepts/permission-model.md)

# 跨 bundle + 版本限定（可选，仅 bundle 支持版本）
[opencode plugin system v0.5+](@opencode-plugin-system@>=0.5/concepts/mcp-integration.md)
```

**解析规则（优先级）：**

1. 路径以 `@` 开头 → 解析命名空间
2. **先查 teams.toml**：如果 `@name` 匹配 teams.toml 中的 team name，解析为 `~/.zoo/wiki/.teams/<name>/<path>`
3. **再查 installed bundles**：如果 `@name` 匹配已安装的 bundle，解析为 `~/.zoo/bundles/<name>/<path>`
4. **再查 registry**：如果 bundle 未安装但 registry 中有，提示"需要安装 `<name>`"
5. **都不匹配**：报错"无法解析 `<name>`，不是已知的团队或 bundle"
6. 可选版本约束（`@name@version/`）仅对 bundle 生效——团队没有版本概念

```
# 解析示例
@core/concepts/permission-model.md
  → teams.toml 中有 team "core"
  → 解析为 ~/.zoo/wiki/.teams/core/concepts/permission-model.md

@opencode-plugin-system/concepts/mcp-integration.md
  → teams.toml 中无 "opencode-plugin-system"
  → 查 installed bundles → 找到
  → 解析为 ~/.zoo/bundles/opencode-plugin-system/concepts/mcp-integration.md
```

**为何不用 `okf://bundle/path` URI 方案？**
URL 方案需要 agent 理解新协议。`@name/path` 是 npm 社区几十年的约定，agent 和开发者都熟悉。而且文件系统路径转写方便——`@team/path` → `~/.zoo/wiki/.teams/team/path`，`@bundle/path` → `~/.zoo/bundles/bundle/path`，这在 shell 中也可以直接工作。

### 7.6 联邦拓扑（分层结构）

Bundle 联邦不需要中心注册中心。拓扑不再是扁平的去中心化结构，而是**分层的联邦拓扑**：

```
                    ┌──────────────────────┐
                    │  组织 Bundle Registry │
                    │  (组织级可信列表)     │
                    └──────┬───────┬───────┘
                           │       │
              ┌────────────┘       └────────────┐
              ▼                                  ▼
    ┌──────────────────┐             ┌──────────────────┐
    │  Team Bundles     │             │  Shared Consensus │
    │  (teams.toml 定义)│             │  (.org/ 层)       │
    │  core, security   │             │  跨团队综合产物    │
    └──────────────────┘             └──────────────────┘
              │                                  │
              ▼                                  ▼
    ┌──────────────────┐             ┌──────────────────┐
    │  External Bundles │             │  Upstream Dists   │
    │  (registry 安装)  │             │  (bundle install) │
    │  opencode-plugin  │             │  依赖的外部包     │
    └──────────────────┘             └──────────────────┘
```

**查询时的解析顺序：**
1. 本地 `~/.zoo/bundles/`（已安装的 bundle）
2. 本地 `~/.zoo/wiki/.org/`（共识层，同 Layer 1）
3. 本地 `~/.zoo/wiki/.teams/<name>/`（团队层，同 Layer 1）
4. 远程 registry（按 `bundle-registry.toml` 列表顺序）

**本地 registry 配置（~/.zoo/bundle-registry.toml）：**

```
[[registries]]
name = "zoo-team"
type = "git"
url = "https://github.com/org/zookeeper-wiki.git"

[[registries]]
name = "opencode-org"
type = "http"
url = "https://pkgs.opencode.dev/bundles/"

[[registries]]
name = "local"
type = "directory"
path = "/mnt/team-shared/bundles/"
```

**Registry 类型：**

| 类型 | 协议 | 适用场景 |
|------|------|---------|
| `git` | git clone / git archive | 团队内部、自托管 |
| `http` | HTTP GET + SHA256 校验 | 公共分发、CDN |
| `directory` | 文件系统复制 | 内网共享、离线 |
| `ipfs`（远期） | IPFS CID | 去中心化内容寻址 |

**依赖解析算法（类似 npm）：**

```
1. 读取 bundle.toml 中的 [dependencies]
2. 对每个依赖，按 registries 列表顺序查找
3. 找到第一个匹配版本 → 安装
4. 递归处理子依赖
5. 检测循环依赖 → 报错
6. 版本冲突检测 → 选择最高兼容版本（semver range）
```

### 7.7 Bundle 版本升级

```
# 查看可升级的 bundle
zwiki bundle outdated
zookeeper-core: installed 1.2.0, latest 1.3.0 (published 2026-06-20)
  changelog: v1.3.0 新增 concepts/overlay-fs.md，更新 entities/build-agent.md

# 升级
zwiki bundle upgrade zookeeper-core
    → 下载 1.3.0
    → 解压 → 校验
    → 读取 changelog → 提示："以下页面有变更：..."
    → 更新 .upstream/ 映射
    → 运行 zwiki check --layers 检查是否有覆盖被影响

# 降级
zwiki bundle downgrade zookeeper-core 1.1.0
    → 下载特定版本
    → 同上流程
```

**升级的覆盖影响：** 如果用户 personal 层覆盖了某个 upstream 页面，而 upstream 在升级后更新了该页面——`zwiki check --layers` 会检测到 stale override 并提示。

### 7.8 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ bundle.toml 声明包规格 | ❌ `package.json` 风格（TOML 一致性优先） |
| ✅ semver 版本管理 | ❌ 内容寻址（IPFS CID 作为远期选项） |
| ✅ `@name/path` 统一命名空间（team + bundle） | ❌ `okf://` URI 协议 |
| ✅ 分层联邦拓扑（组织 registry → team → consensus → external） | ❌ 扁平去中心化拓扑（信任不可控） |
| ✅ `[federation]` 可信列表（trusted / review_required / blocked） | ❌ 自动信任所有 bundle |
| ✅ HTTP/git/directory 三种 registry | ❌ 自动发现 registry（安全风险） |
| ✅ `zwiki bundle outdated/upgrade/downgrade` | ❌ `npm audit` 风格安全扫描 |
| ✅ bundle 间依赖解析 + 循环检测 | ❌ 锁文件（`bundle-lock.toml` 可选不强制） |

---

## 8. 与现有路线图的衔接

### 8.1 现有项与四层架构的关系

下表展示现有 `wiki-lifecycle-research.md` §9 路线图中各 P0-P3 项在四层架构中的位置：

| 层 | 现有路图项 | 阶段 | 是否受影响 |
|----|-----------|------|-----------|
| L0 | 0a-0g: OKF 字段对齐 + zwiki 骨架 | P0-pre | 不变，L0 地基 |
| L0 | 1-9: 地基（stale 标记、级联检索、OKF check） | P0 | 不变 |
| L0 | 7-12: supersede、矛盾检测、move、idempotent | P1 | 不变 |
| L0 | 13-14: 交叉验证、来源回溯 | P2 | 不变 |
| L0 | 15-21: 全自动维护、大规模摄入 | P3 | 不变 |
| **L1** | **新增：分层目录约定（五级）** | **P0** | **新建** |
| **L1** | **新增：查询级联逻辑（五级 + team role）** | **P0** | **新建** |
| **L1** | **新增：`.org/` 层约定 + consensus frontmatter** | **P0** | **新建** |
| **L1** | **新增：teams.toml + `.teams/<name>/` 目录约定** | **P0** | **新建** |
| **L1** | **新增：`zwiki check --layers`** | **P1** | **新建** |
| **L1** | **新增：`zwiki promote --team <name>`** | **P1** | **新建** |
| **L1** | **新增：`zwiki consensus`** | **P2** | **新建** |
| **L2** | **新增：`--wiki-repo <name> <url>` 多 repo 支持** | **P1** | **新建** |
| **L2** | **新增：`zwiki sync` 遍历所有 team** | **P1** | **新建** |
| **L2** | **新增：`zwiki propose --team <name>`** | **P2** | **新建** |
| **L2** | **新增：log.md 分月文件** | **P0** | **新建（低工作量）** |
| **L2** | **新增：contributors 追踪** | **P2** | **新建** |
| **L3** | **新增：`bundle.toml` 定义 + `[federation]` 可信列表** | **P2** | **新建** |
| **L3** | **新增：`zwiki bundle publish/install`** | **P3** | **新建** |
| **L3** | **新增：`@name/path` 统一命名空间** | **P3** | **新建** |
| **L3** | **新增：分层联邦拓扑** | **P3** | **新建** |

### 8.2 新增工作量估算

| # | 改动 | 文件 | 工作量 |
|---|------|------|--------|
| **L1-P0** | | | |
| L1a | 分层目录约定（personal/.org/.teams/<name>/.upstream 五级） | SCHEMA.md + wiki-query SKILL.md | ~30 行 |
| L1b | `zwiki check --layers` 覆盖检测（多 team 支持） | 新增 _layers.py | ~150 行 |
| L1c | 查询级联逻辑（wiki-query Phase 0 扩展） | wiki-query SKILL.md + shared/utils.py | ~40 行 |
| L1d | `.org/` 层约定 + consensus frontmatter 模型 | SCHEMA.md | ~20 行 |
| L1e | teams.toml 配置格式 + 解析 | 新增 _teams.py | ~60 行 |
| **L1-P1** | | | |
| L1f | `zwiki promote --team <name>`（personal → team 提升） | 新增 _promote.py | ~100 行 |
| **L1-P2** | | | |
| L1g | `zwiki consensus` 命令（分析/生成/approve） | 新增 _consensus.py | ~200 行 |
| **L2-P0** | | | |
| L2a | log.md 分月文件 | wiki_log.py + SCHEMA.md | ~60 行 |
| **L2-P1** | | | |
| L2b | `--wiki-repo <name> <url>` 多 repo 支持 + teams.toml 集成 | install.py | ~80 行 |
| L2c | `zwiki sync pull/push/status`（遍历所有 team） | 新增 _sync.py | ~180 行 |
| **L2-P2** | | | |
| L2d | `zwiki propose --team <name>`（personal → team via PR） | 新增 _propose.py | ~140 行 |
| L2e | contributors 前端字段 + 自动维护 | 新增 _contributors.py | ~80 行 |
| **L3-P2** | | | |
| L3a | bundle.toml 定义 + `[federation]` 可信列表 + `zwiki bundle init` | 新增 _bundle.py | ~120 行 |
| L3b | `zwiki okf export` bundle 导出 |  _okf.py 扩展 | ~80 行 |
| **L3-P3** | | | |
| L3c | `zwiki bundle publish/install/list` | _bundle.py 扩展 | ~200 行 |
| L3d | `@name/path` 统一命名空间解析（team + bundle） | shared/link_resolver.py | ~120 行 |
| L3e | 分层联邦拓扑（registry + trusted list） | _registry.py | ~180 行 |
| | **合计** | | **~1,840 行** |

### 8.3 新术语与现有概念对照

| 新术语 | 现有概念 | 关系 |
|--------|---------|------|
| personal 层 | `~/.zoo/wiki/` | 原根目录变为 personal 层；现有页面不动 |
| .org 层 | 无 | 新增，组织级跨团队共识知识 |
| .teams/<name>/ 层 | `.team/` | 单 `.team/` 扩展为多团队 `.teams/<name>/`，teams.toml 管理 |
| .upstream 层 | 无 | 新增，bundle 安装目标 |
| teams.toml | 无 | 新增，团队配置（name/repo/priority/role） |
| promote | "从 personal 复制到 .teams/<name>/" | 原无此操作（L0 无分层）；现在支持 `--team` 指定目标 |
| propose | promote + git PR | 原无（L0 无 git 协作）；现在支持 `--team` 指定目标 |
| consensus | "从 .teams 提取到 .org" | 新增，多团队共识管理命令 |
| team role | 无 | 新增，primary/advisory/supplementary，决定冲突行为 |
| bundle.toml | 无（仅 bundler 目标） | 新增，含 `[federation]` 可信列表 |
| @name/path | `[link](path)` | 统一命名空间，`@` 前缀可查 team 或 bundle |
| bundle registry | 无 | 新增，分层联邦拓扑 |

### 8.4 实施建议

**第一阶段（L1-P0 + L2-P0）：**
- 实现 log.md 分月文件（低工作量，立即受益——减少 merge conflict）
- 实现分层目录约定（五级：personal/.org/.teams/<name>/.upstream）
- 实现 teams.toml 配置格式 + 解析（替换单 `.team/` 约定）
- 实现 `.org/` 层 frontmatter 模型（consensus_of 字段）
- 修改 `zwiki check` 支持 `--layers` 扫描（含多 team 检测）

**第二阶段（L1-P1/P2 + L2-P1）：**
- 实现 `zwiki promote --team <name>`（本地 promote，无 git）
- 实现 `--wiki-repo <name> <url>` 多 repo 参数 + `zwiki sync`（启动 git 协作）
- 实现 `zwiki consensus`（本地共识 draft 生成，不含远程 approve）

**第三阶段（L2-P2 + L3-P2）：**
- 实现 `zwiki propose --team <name>`（PR 流程，指定目标团队）
- 实现 contributors 追踪
- 实现 bundle.toml 定义 + `[federation]` 可信列表 + bundle 导出

**第四阶段（L3-P3）：**
- 实现 bundle publish/install 完整流程
- 实现 `@name/path` 统一命名空间解析（team + bundle）
- 实现分层联邦拓扑 + registry 联邦

> **关键决策：** L1-P0（分层目录约定 + teams.toml + log 分月）对现有系统完全无影响，可以从下一迭代立即开始。L3-P3（bundle 联邦）复杂度最高、收益最不确定，建议在 L2 稳定运行后再评估是否需要。`zwiki consensus`（L1-P2）依赖多团队协作实际存在后再实施，前期可用手动协商替代。

### 8.5 本节的取舍

| 做什么 | 不做什么 |
|--------|---------|
| ✅ 新增项与现有路图分层映射 | ❌ 打乱现有 P0-P3 优先级 |
| ✅ log 分月作为 L2-P0 立即实施 | ❌ 所有 L3 功能在 L2 未验证前实施 |
| ✅ 四阶段分步实施 | ❌ 一步到位全部上线 |
| ✅ bundle.toml 定义复用现有 `okf` 子命令 | ❌ 另起独立工具链 |
| ✅ 新术语与现有概念的映射表 | ❌ 不兼容的 breaking change |

---

## 9. 总结

这篇调研围绕八个结构性缺口展开：**路径硬编码单机、无分发机制、无同步通道、无多用户层级、目录结构阻碍分发、注入机制无远程接口、单一团队槽位、跨团队知识冲突。**

答案是**四层递进架构，文件即协议：**

1. **Layer 0（现状不动）** — `~/.zoo/wiki/` 单人单机，保持现有 install.py + zwiki CLI + SCHEMA 注入的完整工作流。零改造。

2. **Layer 1（分层覆盖）** — 引入 `personal/` → `.org/` → `.teams/<name>/` → `.upstream/` 五级目录。查询按优先级级联，team role（primary/advisory/supplementary）决定冲突行为。覆盖检测（`zwiki check --layers`）扫描 stale override 和跨团队分歧。`zwiki promote --team <name>` 将个人理解提升为指定团队权威。`zwiki consensus` 将多团队共识生成到 `.org/` 层（需多团队 approve，frontmatter 记录 consensus_of 来源）。teams.toml 统一管理各团队配置。类比 Docker overlay filesystem：上层覆盖下层，下层不变。

3. **Layer 2（Git 同步）** — 每个团队独立 git repo，`install.py --wiki-repo <name> <url>` 管理多 remote。`zwiki sync pull/push` 遍历 teams.toml 中所有 team。`zwiki propose --team <name>` 从 personal promote 到指定团队走 PR + CI 门禁。`log.md` 按月分文件避免 merge conflict。contributors frontmatter 字段自动维护贡献者信息。

4. **Layer 3（Bundle 联邦）** — `bundle.toml` 声明包规格 + 依赖 + 导出范围 + `[federation]` 可信列表。`zwiki bundle publish/install` 做分发。`@name/path` 语法统一团队和 bundle 命名空间。分层联邦拓扑（组织 registry → team bundles → shared consensus → external bundles）。类比 npm for knowledge。

**外部方向探索的结论：** CRDT/P2P 和 Wiki-as-a-Service 因复杂度不可接受被放弃；MCP Server 模式作为实时补充通道保留（不做替代方案）；单页寻址和 Pub/Sub 联邦作为远期选项暂不纳入。

**新增工作量：** 约 1,840 行代码（分布在 12+ 新模块文件），分四阶段实施。L1-P0（分层目录 + teams.toml + log 分月）可立即启动，L3-P3（bundle 联邦）待 L2 稳定运行后评估。

始终遵守**文件即协议**的哲学——文件系统 + git + OKF 格式本身就是协同协议。不引入数据库、不部署服务、不依赖外部平台。覆盖不摧毁、渐进过渡、后验可审计。

---

## 参考

- ZooKeeper Wiki 设计文档: `docs/wiki-design.md`
- Wiki 知识生命周期管理: `docs/wiki-lifecycle-research.md`
- Open Knowledge Format (OKF) v0.1: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Docker Overlay Filesystem: https://docs.docker.com/storage/storagedriver/overlayfs-driver/
- npm 包管理: https://docs.npmjs.com/about-packages-and-modules
- Model Context Protocol (MCP): https://modelcontextprotocol.io/
- Semantic Versioning: https://semver.org/
- Karpathy, "LLM Wiki" (2026): https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
