# Golden 行为基线

快照回归套件的统一家园。每个组件一个子目录套件，共享
`framework/` 通用层（归一化 + 深比较）。快照比对适合输出为长
文本、由多条规则交互生成、漂移无声无息的组件——单测断言难以
覆盖整体形态时，快照是最便宜的回归网。

现有套件：

- **`context/`** — 上下文清理流水线。每个场景通过公开入口
  （transform handler、compress/decompress 工具工厂、/dcp 命令、
  marks/blocks 状态 API）驱动流水线，捕获归一化后的可观察输出；
  `context/snapshots/` 中提交的 JSON 基线是机器可判定的回归网——
  折叠位置、注入格式、占位符文本的细微漂移都会被快照比对拦下。

新增套件的判据与路径：输出满足上述判据的组件（候选：install.py
生成的 opencode.json / settings.json），在 `tests/golden/` 下新建
子目录，复用 `framework/` 的归一化与比较器，快照提交在库。

## 目录结构

```
tests/golden/
├── README.md                 # 本文件
├── framework/                # 通用层（所有套件共享）
│   ├── normalize.ts          # 纯归一化函数（refs）
│   ├── compare.ts            # 深比较器
│   └── normalize.test.ts     # 归一化/比较器单元测试
├── context/                  # 上下文流水线套件
│   ├── types.ts              # 场景 / 捕获类型定义
│   ├── messages.ts           # 消息与 part 构造器
│   ├── capture.ts            # 语义投影（视图 + 状态）
│   ├── runner.ts             # 场景运行器（动作 + transform）
│   ├── scenarios/
│   │   ├── fold.ts           # G-FOLD-01..04：块折叠/展开视图结构
│   │   ├── compress.ts       # G-COMP-01..04：压缩生命周期与区间门控
│   │   ├── decompress.ts     # G-DEC-01..02：restore/recall 双路径
│   │   ├── markSweep.ts      # G-MS-01..04：三个剪除 producer 与释放时序
│   │   ├── nudgeRefs.ts      # G-NUDGE-01 阈值提醒，G-REF-01 行号注入
│   │   ├── persistReport.ts  # G-PERSIST-01 重启持久化，G-REPORT-01 报告
│   │   ├── tools.ts          # G-TOOL-01：工具可观察契约与报错路径
│   │   └── index.ts          # 全部 19 场景的有序注册表
│   ├── snapshots/            # 提交的 JSON 基线（每场景一份）
│   └── golden.test.ts        # 基线驱动（ZOO_GOLDEN_UPDATE=1 重生成）
└── bun-test.d.ts             # bun:test 类型声明
```

> **过渡说明（2026-08，切换后整段删除）：** 宿主无关核心迁移期间，
> context 套件的 runner 驱动 `src/core/context/` 新核心 +
> `src/adapters/opencode/` 适配层；P2.4 第一阶段 rewiring 完成，后续
> 按同一归一化规则重生成快照一次（等价性在切换前由 shadow 双跑验证）。
> 场景 ↔ 契约清单的映射表已迁入清单文档
> `.zoo/plans/semantic-equivalence-checklist-20260814.md`，P2.8 核对
> 完成后随该文档归档。

各场景覆盖的具体行为见对应场景文件的头部注释。以下章节以
context 套件为例，新增套件参照同构组织。

## 快照归一化规则（framework/）

三类**实现细节**允许不同，比较前归一化——它们不影响用户可观察的
语义，钉死只会让无害的内部演进制造红灯：

1. **Ref 编号** — `m0001` / `m0007`（零填充注册表引用）与 `[m1]`
   （当轮稠密行号）统一折叠为 `[mN]`。比较只断言"此处存在 ref
   标记"，不断言具体编号——编号方案是实现自由。
2. **持久化 schema** — 块在捕获时投影为
   `{blockId, active, title, coveredMessages, compressedTokens,
   summaryTokens}`，marks 投影为 `{pending, pendingTokens,
   effective, effectiveTokens}`。锚点 id、消息 id 列表、时间戳
   从不进入快照。
3. **边界探测痕迹** — compaction 边界 id 在捕获时排除（边界消息
   只记一个 ignored 的 `boundary` 标记）。

`normalizeRefs` / `normalizeSnapshotValue` 是纯函数，在
`normalize.test.ts` 中独立单测；`compareSnapshots` 对归一化后的值
做深比较。

## 重生成快照

快照是提交在库的资产，只在意图变更行为时重生成：

```shell
ZOO_GOLDEN_UPDATE=1 bun test tests/golden/context/golden.test.ts
```

审查 diff 后跑普通套件确认基线稳定：

```shell
bun test tests/golden/
```

## 存储隔离

状态层默认持久化到 `~/.zoo/storage/`。golden 场景使用唯一的
`golden-g-*` 会话 id 并在 teardown 删除落盘文件，真实用户数据
不会被触碰或残留。
