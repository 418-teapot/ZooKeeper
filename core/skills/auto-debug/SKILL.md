---
name: auto-debug
description: 面向软件故障的证据驱动自主调试。用于调查 bug、回归、崩溃、错误结果、性能问题，或生成并验证最小修复。工作区存在 .zoo/debug/ Case、被唤醒继续调查，或需要经 zdebug 记录调查时加载。
---

# Auto Debug

Auto Debug 是一个证据驱动的调查循环。用户可能只需要一个结论；不要默认必须实施修复。本 skill 只定调查纪律，不描述任何强制执行机制。

## 先理解这些 ID

CLI 为调查对象分配稳定 ID。ID 不是状态，也不是执行命令；它只是后续命令引用对象的名字。

| ID | 对象 | 示例 | 含义 |
|---|---|---|---|
| `CASE-1` | Case | `CASE-1` | 一次完整调查的容器，由 `case init` 的位置参数指定 |
| `DL-001` | Deliverable | `DL-001` | 用户要求的一个交付物 |
| `CR-001` | Criterion | `CR-001` | 某个 Deliverable 的第一个验收项，由 `deliverable add` 按顺序生成 |
| `CL-001` | Claim | `CL-001` | 一个可检验的原因或解释 |
| `EX-001` | Experiment | `EX-001` | 一份已规划的实验定义 |
| `EX-001-A001` | Attempt | `EX-001-A001` | `EX-001` 的第一次实际执行；重试会产生 `A002` |
| `EV-001` | Evidence | `EV-001` | 一条不可变的观察事实 |
| `AR-001` | Artifact | `AR-001` | 一个日志、脚本、IR、报告或其他存储载体 |

例如：

```text
EX-001
├── procedure          已保存的实验脚本
└── EX-001-A001        第一次执行
    ├── stdout.log
    ├── stderr.log
    └── execution.json
```

`EX-001` 是实验计划；`EX-001-A001` 是该计划的一次执行。`experiment run EX-001` 运行的是计划，不是手写的临时命令。

## Case 在哪里

Case 由用户经 `/debug <调查目标>` 创建，位于当前目录的 `.zoo/debug/<case-id>/`：

```text
当前目录/
└── .zoo/debug/
    └── CASE-1/
        ├── case.jsonl       权威追加记录，不直接编辑
        ├── summary.md       自动生成的恢复视图，不直接编辑
        └── artifacts/       脚本、日志、快照和附件
```

agent 禁止自主执行 `zdebug case init`。工作区没有 Case 时按正常流程调试，不要碰 zdebug 的 case 命令，也不要为了"开始自主调试"而造一个 Case。

如果当前目录下只有一个 Case，CLI 通常可以自动找到它。存在多个 Case 时，在命令中显式传入：

```bash
zdebug case status --case-id CASE-1
zdebug case status --case-dir /path/to/.zoo/debug/CASE-1
```

也可以从任意工作目录用 `--case-dir` 操作指定的 Case。所有写入都必须通过领域 CLI 完成；不要直接编辑 `case.jsonl` 或 `summary.md`。

## 四个核心概念

- **Deliverable**：用户要求获得的结果，以契约和验收项表达。只需要原因时，Deliverable 不要求修复代码。
- **Claim**：不可变、有范围的解释。陈述发生变化时创建新的 Claim，并使用 `refines`、`contradicts` 或 `supersedes` 表达关系。
- **Experiment**：预先声明的问题和过程。规划与运行是两个独立操作。
- **Evidence**：不可变的观察，包含来源、上下文和 artifact 引用。

关系通常是：

```text
Experiment 产生执行记录
    ↓
Agent 从执行记录提炼 Evidence
    ↓ supports / challenges
Claim
    ↓ 被验收项引用
Deliverable
```

CLI 负责维护 Case 记录和校验引用；Agent 负责技术解释。Core 不会根据退出码自动判断根因，也不会替 Agent 选择下一项实验。

## 核心循环

1. 定义所需的 Deliverable 及其验收标准。
2. 使用常规源码和 shell 工具自由探索。探索过程不必记录。
3. 提出有范围且可证伪的 Claim。
4. 在运行前规划 Experiment。记录问题、受控条件、单一变量、过程脚本和判读规则。
5. 通过 `zdebug experiment run EX-001` 运行不可变的过程脚本。
6. 将观察结果明确提炼为 Evidence。执行成功不等于技术结论成立。
7. 用 `supports` 或 `challenges` 建立 Evidence 与 Claim 的关系；Claim 的评估强度不能超过证据支持的范围。
8. 将每项 Deliverable 标记为 `satisfied`、`blocked` 或 `waived`。只有用户请求的交付物已经诚实结清后，才能关闭 Case。

收敛由外部验证判据决定，不由自述决定。判据转绿后循环沉默（converged），但只要 Case 保持 OPEN，每轮停稳仍会重跑验证实验作回归监视。

## 最小流程

### 1. 恢复现状

接手已存在的 Case 时，先看机器记录的现状：

```bash
zdebug case status
```

随后读 `.zoo/debug/<case-id>/summary.md` 了解目标、已有 Claim、实验与证据。不要凭对话记忆重建"试过什么、排除了什么"——agent 会忘，仓库不会忘。需要机器可读现状时加 `--json`。

### 2. 定义交付物

```bash
zdebug deliverable add \
  --title "解释问题原因" \
  --contract "给出有范围且有证据支持的原因" \
  --criterion "定位最早异常阶段" \
  --criterion "说明证据边界和替代解释"
```

这会创建 `DL-001`，并按参数顺序创建：

```text
CR-001: 定位最早异常阶段
CR-002: 说明证据边界和替代解释
```

如果没有显式传 `--id`，Deliverable、Claim、Experiment、Evidence 和 Artifact 会在当前 Case 内按类型自动编号。也可以为这些对象显式指定 ID。

### 3. 物化验证判据

判据是交付契约的机器可执行形式：循环的判定完全建立在 Case 里的 verify 命令上，**判据未物化 = 循环不激活**。所以物化判据要尽早，能立即做就不要拖。

- objective 中用户已经给出验证命令 → 立即代录，来源标为 user：
  ```bash
  zdebug case update-verify --command '<用户给出的命令>' --source user --timeout <秒>
  ```
- agent 自拟的判据（例如定位类目标里，对候选结论形成的确认实验）→ 来源标为 agent：
  ```bash
  zdebug case update-verify --command '<自拟命令>' --source agent --timeout <秒>
  ```
  `--source` 省略时默认为 agent；来源如实标注，不要把自己写的判据冒充用户声明。
- `--timeout` 必填：时长上界是判据自身的知识，写判据的人最清楚它该跑多久（单位秒，可给小数）。超时由 zdebug 强制执行，超时的判据按判据损坏处理。不声明时限的判据视为未物化，循环不激活。
- 判据命令要**窄、幂等、判定性**：复现脚本而非全量套件；间歇性问题把统计强度写进命令本身（如连跑 N 次，`for i in ...; do <cmd> || exit 1; done`）。
- 不要等"调查完再补判据"。形成判据的那一刻就写进去。

### 4. 提出 Claim

```bash
zdebug claim add \
  --id CL-001 \
  --statement "Pass X 首次引入了错误的 loop-carried value" \
  --scope scope.json
```

`--scope` 是可选 JSON，接受内联 JSON 或文件路径（存在即按文件读），用于记录 revision、输入、环境或其他适用范围。没有 scope 时，scope 为空对象；复杂调试应显式记录范围。

Claim 创建后初始评估为 `open`。评估级别含义：

- `open`：尚未得到足够支持。
- `supported`：当前证据支持，但仍有边界或替代解释。
- `established`：已处理当前 Case 中登记的 challenge，并作出因果结论。
- `rejected`：被挑战证据否决。

### 5. 准备判读规则

`experiment plan` 的 `--interpretations` 必须是一个非空 JSON 数组，接受内联 JSON 或文件路径，例如 `interpretations.json`：

```json
[
  {
    "when": "禁用 Pass X 后首个错误 IR 消失",
    "meaning": "支持 Pass X 首次引入错误的 Claim"
  },
  {
    "when": "错误 IR 在 Pass X 之前已经存在",
    "meaning": "挑战该 Claim"
  }
]
```

判读规则必须在实验运行前写入，不能看到结果后再补写。

### 6. 规划 Experiment

先准备过程脚本，例如 `reproduce.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail
bash run.sh -b test -f 'some/package:case.test'
```

然后规划实验：

```bash
zdebug experiment plan \
  --id EX-001 \
  --question "Pass X 是否引入首个错误 IR？" \
  --claim CL-001 \
  --controlled "相同输入" \
  --controlled "相同 revision" \
  --variable "禁用 Pass X" \
  --interpretations interpretations.json \
  --script reproduce.sh
```

这会创建 `EX-001`，并把脚本副本保存到 Case。之后修改本地的 `reproduce.sh` 不会改变已规划的 `EX-001`。

- `--question`：实验要回答的问题。
- `--claim`：实验关联的 Claim，可重复传入多个。
- `--controlled`：必须保持不变的条件，可重复传入多个。
- `--variable`：本次实验要改变的变量。
- `--interpretations`：结果及其含义的 JSON，内联或文件路径。
- `--script`：实验脚本文件，或使用 `-` 从 stdin 读取。
- `--interpreter`：可选解释器；省略时使用脚本 shebang、Case 默认解释器或 `bash`。
- `--cwd`：可选执行目录；省略时使用规划命令的当前目录。

### 7. 运行 Experiment

```bash
zdebug experiment run EX-001
```

这会执行 `EX-001` 中保存的脚本，并产生第一次 Attempt：

```text
EX-001-A001
```

如果由于基础设施问题需要重试，再次运行同一个计划会产生 `EX-001-A002`。修改实验变量或判读规则时，不要覆盖旧实验，应规划新的 `EX-002`。

- `--cwd` 可覆盖执行目录。
- `--env KEY=VALUE` 可重复，注入额外环境变量。

每次 Attempt 会保存：

- `stdout.log` 和 `stderr.log`；
- 退出码、信号、开始/结束时间；
- 实际解释器及版本；
- 环境变量快照；
- 实验前后的 Git workspace 快照；
- `execution.json` 元数据。

所有实验都使用"解释器 + 不可变脚本"这一套执行模型。Core 不注入 `set -e`、`pipefail`、profile 或其他隐藏环境变化；过程脚本必须自行声明这些语义。

### 8. 提炼 Evidence

实验执行记录是机器事实，不会自动成为 Evidence。Agent 必须明确写出观察：

```bash
zdebug evidence add \
  --id EV-001 \
  --from-experiment EX-001 \
  --statement "禁用 Pass X 后，首个错误 IR 不再出现"
```

- `EV-001` 是 Evidence ID。
- `--from-experiment EX-001` 表示来源于该实验的最近一次完成 Attempt。
- 如果需要指定某次 Attempt，增加 `--attempt EX-001-A001`。
- 也可以用 `--source path-or-description` 导入外部观察，不把它伪装成 CLI 执行结果。`--from-experiment` 与 `--source` 二选一。
- `--attach AR-001` 可关联已经登记的 Artifact。
- `--context context.json` 可提供额外 workspace、revision 或环境上下文，接受内联 JSON 或文件路径。

### 9. 建立 Evidence 与 Claim 的关系

```bash
zdebug evidence relate \
  --evidence EV-001 \
  --relation supports \
  --claim CL-001 \
  --reason "对照实验只改变了 Pass X"
```

`--relation` 只能是：

- `supports`：观察支持 Claim。
- `challenges`：观察挑战 Claim。

然后评估 Claim：

```bash
zdebug claim assess \
  --claim CL-001 \
  --as supported \
  --reason "实验结果与 Claim 一致" \
  --evidence EV-001
```

评估为 `established` 时，必须使用 `--address-challenge EV-XXX` 处理该 Claim 已登记的所有有效 challenge：

```bash
zdebug claim assess \
  --claim CL-001 \
  --as established \
  --reason "正向对照命中，且已处理所有挑战证据" \
  --evidence EV-001 \
  --address-challenge EV-002
```

证据不可修改，只能作废：

```bash
zdebug evidence invalidate EV-001 --reason "样本被污染"
```

### 10. 完成交付物

为每个验收项选择处置结果：

```bash
zdebug deliverable dispose \
  --deliverable DL-001 \
  --criterion CR-001 \
  --as satisfied \
  --reference CL-001
```

三种处置结果：

- `satisfied`：验收项已满足，必须引用至少一个 `CL-XXX` 或 `EV-XXX`。
- `blocked`：当前环境或信息无法满足，必须提供 `--reason`。
- `waived`：用户明确取消该验收项，必须提供 `--reason`。

保存最终交付内容：

```bash
zdebug deliverable content \
  --deliverable DL-001 \
  --file conclusion.md \
  --reference CL-001
```

CLI 会把 `conclusion.md` 复制为 Case 内的 Artifact。最终结论不能只留在 Agent 聊天记录中。

### 11. 校验、收尾和恢复

记录 workspace 最终状态：

```bash
zdebug case finalize
```

检查对象关系、Artifact hash 和完成门禁：

```bash
zdebug case verify
```

收尾时提醒用户关闭 Case——关闭是用户的操作，agent 不代劳：

```bash
zdebug case close --reason completed
```

关闭原因可以是：

- `completed`：要求已经完成。
- `partially-blocked`：部分要求因证据或环境限制无法完成。
- `cancelled`：用户取消或所有要求已放弃。

`CLOSED` 只表示交付契约已诚实结清，不表示 bug 已修复。只要求原因的 Case 可以在没有代码修改、原测试未通过的情况下关闭。

如果实验或 CLI 被中断：

```bash
zdebug case recover
zdebug case status --json
```

`case recover` 修复损坏的事件尾部并登记被中断的 Attempt。如果 `summary.md` 被删除或损坏：

```bash
zdebug case repair-view
```

如果需要重新打开已关闭的 Case：

```bash
zdebug case reopen --reason "出现新证据"
```

## 证据纪律

- 不要仅凭相关性将 Claim 评估为 `established`。
- 明确记录 revision、输入、环境和 workspace 范围。
- 在处理已登记的 challenge 前，不要把 Claim 评估为 `established`。
- 如果无法复现，应报告环境边界，不要声称复现成功。
- 如果 Artifact 位于外部或具有临时性，应记录 hash，并披露保留风险。
- 保留用户已有的 workspace 修改；Core 记录 Git 状态，但不会自动还原文件。
- 假设、实验、证据产生的那一刻就经 zdebug 落盘，不要攒着最后补记。
- 会话压缩、崩溃、重启后，靠重新读取 Case 恢复"试过什么、排除了什么"，不依赖对话记忆。
- 不要直接修改 `case.jsonl`、`summary.md` 或 Case 内已保存的实验脚本。
