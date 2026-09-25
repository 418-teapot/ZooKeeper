# AutoDebug 设计：证据驱动的自主调试循环

**日期:** 2026-09-24
**状态:** zdebug 状态基底已实现（2026-09-25，`tools/zdebug/`）；策略层与 `/debug` 命令待实现
**前置文档:** `docs/loop-engine-design.md`（loop 引擎抽象，本文档是它的第二个策略）、`docs/agent-loop-engineering-research.md`（OMO/OMP 机制调研）
**参考实现:** auto-debug 项目（Python，证据驱动调查状态机，本文档的状态基底来源）、oh-my-pi（OMP）的 autoresearch 扩展（触发与形态参照）

---

## 这是什么

ZooKeeper 要给 coding agent 增加一个**自主调试循环**。用户用一条命令启动调查：

```
/debug 支付并发测试间歇失败 --verify 'pytest tests/test_payment.py::test_concurrent_charge'
```

此后：

1. agent 开始调查，过程中的假设、实验、证据全部经 `zdebug` 命令行工具落到仓库里的 `.zoo/debug/` 目录——**状态在磁盘上，不在对话里**；
2. 每当 agent 停稳，loop 引擎**重新执行**那条 verify 命令：测试还红，就把 agent 再次唤醒继续；转绿，循环自动收敛；
3. 唤醒次数有引擎强制的上限，失控在结构上不可能。

一句话：**用户声明"什么叫修好"，机器每轮重新验证，agent 在验证通过之前一直被驱动，验证通过或预算耗尽即停。**

---

## 目录

1. [一个完整例子](#1-一个完整例子)
2. [为什么需要它](#2-为什么需要它)
3. [核心概念](#3-核心概念)
4. [它如何工作](#4-它如何工作)
5. [设计原则（不变量）](#5-设计原则不变量)
6. [zdebug：状态基底](#6-zdebug状态基底)
7. [策略：循环的判定逻辑](#7-策略循环的判定逻辑)
8. [触发与停止](#8-触发与停止)
9. [与参考实现的关系](#9-与参考实现的关系)
10. [关键决策与理由](#10-关键决策与理由)
11. [可观测性与测试](#11-可观测性与测试)
12. [暂缓项与未来决策点](#12-暂缓项与未来决策点)

---

## 1. 一个完整例子

用户发现支付服务并发测试间歇失败，在会话里输入：

```
/debug 支付并发测试间歇失败 --verify 'for i in {1..10}; do pytest tests/test_payment.py::test_concurrent_charge || exit 1; done'
```

（间歇性失败，所以 verify 命令连跑 10 次——判据的强度由命令本身表达。）

命令处理器调用 `zdebug case init`，工作区出现：

```
.zoo/debug/CASE-1/
├── case.jsonl      # 权威事件记录（append-only，禁止手改）
├── summary.md      # 机器生成的调查现状视图（禁止手改）
└── artifacts/      # 实验脚本副本、stdout/stderr、git 快照
```

agent 读到任务后开始调查。它的每一步都经 zdebug 留痕：

```bash
zdebug claim add --statement "连接池在并发下复用了未提交事务" ...
zdebug experiment plan --question "禁用连接复用后错误是否消失？" ...
zdebug experiment run EX-001        # 脚本由 zdebug 执行，结果机器记录
zdebug evidence add --from-experiment EX-001 --statement "禁用后 10 次全绿" ...
zdebug evidence relate --evidence EV-001 --relation supports --claim CL-001 ...
```

agent 每停稳一次，引擎就问策略一次"要不要继续"。策略重跑验证实验：红 → 唤醒 agent（带上 Case 现状快照）；绿 → 沉默，循环收敛。中途用户随时可以 `zdebug case status` 看调查进展，或 `zdebug case close` 终止。

**agent 崩溃、上下文压缩、会话重启都不丢失调查状态**——`case.jsonl` 是权威记录，`summary.md` 随时可由它重建。

## 2. 为什么需要它

**调试是多轮反馈过程，agent 一次打住做不完。** 复现 → 假设 → 实验 → 排除 → 再假设，真实调查动辄几十轮。ZooKeeper 已有通用 loop 引擎（`docs/loop-engine-design.md`）解决"停稳后谁来再驱动、如何不失控"，autodebug 是它的第二个策略。但引擎不回答策略侧的核心问题：**这次调试"算解决了"谁说了算？**

**没有机器可判的终止条件，循环只有两种死法**：修好了继续修直到修坏；没修好谎称完成。两者都是 Evaluation 失败——agent 自述的"我修好了"不可信，判定必须由外部执行。

**agent 的记忆不可靠。** 上下文压缩、会话重启后，"试过什么、排除了什么"全部丢失。调查过程必须是仓库里的持久状态，靠每轮重新读取恢复——"Agent 会忘，仓库不会忘"。

## 3. 核心概念

| 概念 | 含义 |
|------|------|
| **Case** | 一次调试调查的容器，存于 `.zoo/debug/<case-id>/`。Goal 的载体 |
| **verify（验证实验）** | 创建 Case 时用户声明的判定命令。**退出码即收敛判据**：0=已解决，1=未解决，>1=判据本身出错 |
| **Claim / Experiment / Evidence** | agent 的调查词汇：可证伪的假设、预先声明的实验、不可变的观察。全部经 zdebug 命令落盘 |
| **case.jsonl / summary.md** | 事件溯源：append-only 事件是权威记录；summary.md 是机器生成的恢复视图，可重建 |
| **策略（strategy）** | loop 引擎的可插拔控制器。autodebug 策略在 agent 停稳时回答"唤醒还是沉默" |
| **wake / silence** | 策略的输出：唤醒（附一段交给 agent 的文字）或沉默（附机器可读原因） |
| **额度（budget）** | 引擎强制的每会话自动唤醒上限，不失控的硬约束 |

策略和引擎**不理解** claim/evidence 的语义——它们只看验证实验的退出码。证据链是调查方法论（防自欺纪律），收敛判定是控制问题，两层正交。

## 4. 它如何工作

```
用户 /debug 命令（唯一激活入口）
   │  zdebug case init --verify '<cmd>'
   ▼
agent（经 bash 调用 zdebug，宿主权限层可见）
   │  case / deliverable / claim / experiment / evidence / artifact ...
   ▼
┌─ zdebug（Rust CLI，状态基底）──────────────────────┐
│ case.jsonl 事件溯源 → 校验 → 投影 summary.md        │
│ runner：不可变脚本 + Attempt 元数据 + git 快照      │
└────────────────────────────────────────────────────┘
   ▲ case status --json │ experiment run（子进程）
┌─ 策略 src/hooks/auto-debug（TS 薄层）──────────────┐
│ settled → 发现 Case → 重跑验证 → wake / silence     │
└────────────────────────────────────────────────────┘
   ▲ SettledInput │ Wake | null
┌─ loop 引擎（零改动）───────────────────────────────┐
│ 停稳联锁 / 额度联锁 / 汇聚 / 崩溃隔离               │
└────────────────────────────────────────────────────┘
```

一次停稳的完整判定链：

1. 宿主确认 agent 彻底停稳（不是中途、不是等用户回答）→ 上报引擎；
2. 引擎检查额度（超限 → 记 `budget-exhausted`，不问策略）→ 询问策略；
3. 策略在会话工作区找 `.zoo/debug/`：没有活跃 Case → 沉默；有 → 调 `zdebug experiment run` **重新执行**验证实验；
4. 退出码 0 → 沉默（收敛）；1 → 构造 wake 文案唤醒 agent；>1 或超时 → 沉默并报错（判据坏了 ≠ 没修好）；
5. 每次重跑都自动写入实验历史——过程记录零 agent 负担。

各层分工：

| 层 | 拥有 | 不拥有 |
|----|------|--------|
| **引擎** | 停稳联锁、额度联锁、汇聚、崩溃隔离 | 任何调试语义 |
| **zdebug** | 状态机完整性：事件校验、投影、实验执行 | 循环节奏、唤醒决策 |
| **策略** | 循环判断：Case 发现、重验证、wake 文案 | 状态存储（经 CLI 访问） |
| **宿主适配** | `/debug` 命令、wake 投递、额度重置时机 | 判断逻辑 |
| **skill** | 调查方法论纪律 | 任何强制执行 |

一句话：**zdebug 回答"调查怎样才算诚实"，策略回答"现在要不要继续"，引擎回答"能不能继续"。**

## 5. 设计原则（不变量）

以下性质必须恒成立，任何实现细节都不得破坏：

1. **唤醒只发生在彻底停稳之后**——半稳定状态做决策必然与宿主的重试/压缩/排队竞态（引擎联锁）；
2. **自动唤醒次数有上界**，且执行不依赖策略自觉（引擎联锁）；
3. **"已解决"由外部可执行的判定给出**，永远不是 agent 的自述；
4. **没有显式声明的调查目标时倾向沉默**——不从"会话里似乎在调 bug"隐式推断；
5. **判定出错 ≠ 判定为假**——判据命令本身坏了（语法错误、超时、不存在）时沉默并报错，而不是当作"未解决"继续唤醒；
6. **判定的外部性不仅在执行，还在来源**——verify 判据以用户声明为准；若由 agent 自行书写，"谎称完成"只是换成"自拟宽松裁判"。

## 6. zdebug：状态基底

### 6.1 为什么是 CLI 二进制

| 形态 | 结论 | 理由 |
|------|------|------|
| 宿主工具（registerTool） | 否决 | 双宿主各写一套适配；工具内自动执行绕过 bash 权限层，可见性下降 |
| N-API addon | 否决 | addon 是插件进程内的库（仓库先例 zweb 是为绕过 npm 依赖），**agent 没有触达 addon 的通道** |
| **CLI 二进制** | **选定** | agent 经 bash 调用，双宿主一致、过权限层、用户可见；策略经子进程调用；二进制缺失时功能静默关闭 |

CLI 一次实现同时服务 agent 与策略两个消费者；仓库已有 tools/ Rust workspace 与分发先例（zwiki/zlog 等，skill 按名引用）。

### 6.2 存储与发现

存储布局见 §1。Case 发现规则：策略在会话工作区扫描 `.zoo/debug/`，凡含 `case.jsonl` 的目录即视为一个 Case（不按生命周期过滤，CLOSED Case 同样能被发现）——唯一 Case 即绑定；多个 Case → 沉默（`ambiguous`），fail-closed 不猜测；需要并行调试会话时用 git worktree 隔离工作区。绑定后由策略按生命周期处理（CLOSED → 沉默，见 §7.1）。

### 6.3 事件词汇与校验

`case.jsonl` 的每个事件经 `apply_event` 等价逻辑校验后才落盘。事件类型：`case-created` / `deliverable-*`（created / criterion-disposed / content-attached）/ `claim-*`（created / related / assessed）/ `experiment-planned` / `experiment-attempt-started|finished|recovered` / `artifact-created|invalidated` / `evidence-created|invalidated|related` / `workspace-finalized` / `case-closed|reopened|recovered`，外加增量事件 `case-verify-updated`（判据修改留痕）。

校验要点（防自欺的机器侧）：

- criterion 标记 `satisfied` 必须引用 Claim 或 Evidence；
- Claim 评估为 `established` 必须处理全部有效 challenge 证据；
- Evidence 的 provenance 必须指向**已完成**的实验 Attempt——而 Attempt 由 runner 机器执行，证据可信不靠 agent 诚实，靠执行记录；
- `case close` 门禁：required criterion 全部结清 + 交付内容登记 + 工作区终态快照。`CLOSED` 只表示交付契约诚实结清，不声称 bug 已修复。

### 6.4 命令面

```
zdebug case init|status|close|reopen|finalize|verify|recover|repair-view|update-verify
zdebug deliverable add|dispose|content
zdebug claim add|assess|relate
zdebug experiment plan|run
zdebug evidence add|relate|invalidate
zdebug artifact add|invalidate
zdebug doctor                            # 环境自检（git 可用性、平台信息）
```

全局 `--json`（策略消费 `case status --json` 与 `experiment run` 结果）。

**CLI 契约**（策略层与脚本消费的接口约定，实现见 `tools/zdebug/src/cli.rs`）：

- **输出协议**：成功时 stdout 输出 `{"ok": true, "result": ...}`；业务错误时 stderr 输出 `{"ok": false, "code", "message", "details"}`。JSON 键按 canonical 序（排序键、紧凑分隔符）。非 `--json` 模式下错误渲染为 `error[code]: message`；`doctor` 另有中文人类可读报告；
- **退出码**：成功 0；业务错误（`ZdebugError`，含 `CASE_BUSY`/`CASE_CLOSED`/`VERIFY_FAILED` 等校验拒绝）退出 2。注意这与 §3 verify 判据的退出码语义（0/1/>1）是两个层面：判据命令的退出码由 `experiment run` 记录在 Attempt 元数据与 JSON `exit_code` 字段中，**不改变 zdebug 进程自身的退出码**（实验失败时 `experiment run` 仍退出 0）；
- **JSON 值参数**：`--scope` / `--interpretations` / `--context` 接受内联 JSON 或文件路径（存在即按文件读，否则按内联解析）——对 Python 参考实现是超集；
- **`--script -`**：`experiment plan` 的 `--script -` 从 stdin 读取脚本内容；
- **`case init --workspace`** 可重复；`--case-dir` 做 `~` 展开。

### 6.5 runner（实验执行）

`experiment plan` 保存脚本**副本**（此后修改本地文件不影响已规划实验）；`experiment run` 执行并记录 Attempt：退出码、信号、起止时间、解释器及版本、环境 hash、实验前后 git 快照。zdebug 不注入 `set -e`/`pipefail` 等隐藏环境变化，脚本自行声明语义。

## 7. 策略：循环的判定逻辑

### 7.1 判定流程

引擎保证只在停稳且有额度时询问策略。`handle()`：

```
1. 会话工作区发现 .zoo/debug Case：
     无            → silence("no-case")
     多个          → silence("ambiguous")
2. Case CLOSED     → silence("closed")
3. 指定了验证实验   → zdebug experiment run 重跑（超时包裹）：
     退出 0         → silence("converged")
     退出 1         → wake(...)
     >1/超时/调用失败 → silence("verify-error")
4. 未指定验证实验   → 交付门禁兜底（解释类调查）：
     required criterion 未结清 → wake(...)
     全部结清       → silence("converged")
```

### 7.2 wake 文案

Case 快照（目标 + verify 命令 + 最新 Attempt 结果摘要）+ claim 评估分布 + 未结清 criterion + summary.md 尾部 N 条 + 续写指令 + "经 zdebug 记录发现"的提醒。唤醒依据是磁盘状态快照，不是对话记忆。

### 7.3 配置与 fail-closed

`[zoo.autodebug]`：`max_wakes`（缺失/非法 → 策略不贡献，整个功能静默关闭）、`verify_timeout_ms`、wake 注入的 summary 尾部长度。zdebug 二进制不可用 → 不贡献。

### 7.4 verify 契约

判据命令必须**窄、幂等、判定性**（复现脚本而非全量套件）；flaky 场景的统计强度由命令作者负责（如 §1 的连跑 10 次范式）。每次停稳重跑的成本成立：一次谓词求值的代价永远小于一次无谓唤醒（一整轮 LLM 推理）。

## 8. 触发与停止

### 8.1 触发：仅 `/debug` 命令

**激活语义只有一个：Case 存在即激活。** 触发归约为"谁创建 Case"，答案是只有用户：

- `/debug <objective> [--verify '<cmd>']`：双宿主斜杠命令，处理器调 `zdebug case init`；verify 未给出时 Case 以无验证实验状态创建（收敛走交付门禁兜底），可后续 `update-verify` 补充；
- **skill 明文禁止 agent 自主 `case init`**——对齐 autoresearch 的严格立场（其实验工具默认不激活、测试断言无隐式激活钩子）。承认这是约定而非强制（zdebug 在 PATH 上，agent 技术上可调），接受"能但不能"的语义；
- 不做隐式激活（检测到测试失败自动建 Case）——违反不变量 4。

### 8.2 停止路径

| 路径 | 机制 |
|------|------|
| 验证实验转绿 / 交付结清 | 策略沉默（`converged`）——自然收敛 |
| `case close` | 策略沉默（`closed`） |
| 用户 abort | 引擎联锁 `not-settled` |
| 额度耗尽 | 引擎联锁 `budget-exhausted` |
| 真实用户回合 | 引擎重置额度（既有行为）——新工作意图 |

## 9. 与参考实现的关系

### 9.1 从 auto-debug 项目采用的

四类承重机制原样移植（Python → Rust）：事件溯源（append-only 权威记录）、校验规则（§6.3）、投影（summary.md 机器生成、可重建——这就是过程记录，agent 零簿记）、runner（§6.5）。

### 9.2 改造的：loop 终止判定 ≠ case 关闭门禁

auto-debug 是被动状态机，缺的两样恰好都是 loop 引擎的本职：

1. **触发器**：它没有"停稳时重新求值"的动作源；settled 事件正是引擎提供的；
2. **自动收敛语义**：它的 close 靠 agent 簿记走门禁；loop 不需要 close，只需要"指定验证实验的最新 Attempt 转绿"——机器执行、level-triggered 重观测，而不是查 agent 上次报告的结论。

因此 zdebug 相对 auto-debug 的增量只有一组：verify 判据声明——`case init --verify` 写入 `case-created` 的 verify 字段，`case update-verify` 追加增量事件 `case-verify-updated` 留痕。（`case status --json` 不算增量：Python 版的全局 `--json` 本就覆盖它。）

### 9.3 与 oh-my-pi autoresearch 的对照

不复制三样东西：**模式 flag**（第二控制平面；我们用"Case 存在即激活"替代，天然获得崩溃恢复语义）、**METRIC/MAD 置信度**（它回答"优化是否改进"，Goal 无二元收敛；debug 有二元收敛，退出码即判定）、**工具按需挂载**（它是单宿主项目，无跨宿主成本）。继承的是**严格的用户命令激活**。

### 9.4 三类目标的归约

| Goal 类型 | 例子 | 收敛判据 |
|---|---|---|
| 修复类 | "测试修到绿" | verify 命令转绿（创建时声明） |
| 定位类 | "哪个 commit 引入回归" | 对候选结论的确认实验（调查中 `update-verify` 产生） |
| 解释类 | "给出根因分析" | 交付门禁：required criterion 全部结清 |

三类归约为同一形态——**退出码谓词或它的投影**，策略与引擎零分支。

## 10. 关键决策与理由

编号接续引擎设计文档的 D1-D9。

| # | 决策 | 理由 |
|---|------|------|
| D10 | 状态基底采用 auto-debug 事件溯源模型，Rust 实现 | 事件溯源/校验/投影/runner 是经测试验证的承重机制；平行发明只会劣质重造（本设计早期方案即犯此错，已纠正） |
| D11 | 收敛 = settled 时重跑验证实验，退出码语义（0 收敛 / 1 继续 / >1 或超时 error 沉默） | 不变量 3、5：外部执行 + level-triggered 重观测 |
| D12 | 判据以用户声明为准；agent 可提议更新，留痕可见 | 不变量 6：判定的外部性包括来源 |
| D13 | 暴露完整 CLI 词汇，不做薄视图 | 薄视图造成双重心智模型；基底即真模型 |
| D14 | 三类目标归约为退出码谓词，无 kind 分支 | 扩展靠谓词组合而非 schema 演化 |
| D15 | CLI 二进制形态，否决宿主工具与 N-API addon | §6.1：双宿主零适配、过权限层可见、agent 可触达 |
| D16 | cwd 发现 + 歧义沉默；并行会话靠 worktree 隔离 | CLI 拿不到 sessionID；歧义猜测违反 fail-closed |
| D17 | 仅 `/debug` 命令激活，skill 禁止 agent 自主建 Case | autoresearch 的严格立场 + 不变量 4 |
| D18 | 过程记录 = summary.md 投影（机器生成），agent 零簿记 | 簿记纪律依赖自觉必失败；实验/证据经 CLI 产生即记录 |
| D19 | 交付门禁保证诚实但不 gate 循环 | 循环终止只看机器可执行判定；`CLOSED ≠ 已修复` 语义保留给 Case 生命周期 |
| D20 | 引擎零改动 | 策略完全长在引擎的 `SettledContribution` 抽象上——第二策略是对该抽象的第一次实战检验 |

## 11. 可观测性与测试

**日志**：策略沉默经 `loop` channel 的 `settle_silent` 事件可归因：`no-case` / `ambiguous` / `closed` / `converged` / `verify-error`；引擎联锁词汇不变（`not-settled` / `budget-exhausted`）。任何一次不唤醒都能回答"为什么"。

**测试布局**：

| 层 | 覆盖 |
|----|------|
| Rust 单测 | 事件校验、replay、close 门禁、runner、projector、崩溃恢复 |
| Rust CLI 集成测试 | 子命令行为、退出码语义、cwd 发现与歧义报错 |
| 策略测试（TS） | fixture Case + 真实二进制：判定各分支、wake 文案、配置 fail-closed |
| 双宿主端到端 | `/debug` 命令、settle → 重验证 → wake/沉默、额度、abort 联锁 |

验证命令：`./check.sh`、`./test.sh`、`./build.sh`。

## 12. 暂缓项与未来决策点

- **引擎级暂缓项不变**：节奏联锁（退避）、预算落盘、多策略仲裁升级。autodebug 与 todo-continuation 目标正交（todo 拥有任务列表，autodebug 拥有 Case 未收敛），维持"首个 wake 胜出"；
- **verify 统计强度内建**：当前 flaky 强度由命令作者负责；若成为问题源，评估 `case init --verify-runs N` 内建重复执行；
- **会话恢复后的自动续跑**：autoresearch 刻意"恢复后不自动续跑"；我们由 settled 事件自然恢复（Case 在磁盘上），差异待实践检验；
- **verify 判据的可执行化**：zdebug 目前只把 `--verify` 存为命令字符串，没有入口把它物化为可由 `experiment run` 重跑的 Experiment。策略层实现时需决定：zdebug 增加直接执行判据命令的入口，还是策略将其包装为 Experiment；
- **与 todo 策略的协作**：调试会话中 agent 自建 todo 时两策略同活跃，正交分区是否足够，待真实运行数据。

---

## 附录：参考

| 项目/文档 | 参考内容 |
|-----------|---------|
| auto-debug 项目（Python） | 事件模型与校验（`src/autodebug/model.py`）、runner、projector、调查方法论（`skills/auto-debug/SKILL.md`） |
| oh-my-pi 的 autoresearch | 命令注册与激活（`packages/coding-agent/src/autoresearch/index.ts`）、严格激活立场（测试断言无隐式激活钩子）、前置检查（脏工作区拒绝） |
| oh-my-pi 的 `/loop` 命令 | 退出码条件门：>1 判 error 而非 false 的设计理由 |
| `docs/loop-engine-design.md` | 引擎抽象、联锁、所有权三角、§9.1 autodebug 暂缓项（本文档将其落地） |
| `docs/agent-loop-engineering-research.md` | OMO/OMP loop 机制调研，§14 设计哲学 |
| `zhihu.md` | Loop Engineering 讨论：Goal/Evaluation 形式化是循环的上限 |
