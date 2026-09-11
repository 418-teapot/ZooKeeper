---
status: done
slug: "pi-todo-widget-column-20260911"
project_root: "/home/cambricon/Code/Agent/ZooKeeper"
created_at: "2026-09-11T10:21:33+08:00"
updated_at: "2026-09-11T13:55:00+08:00"
active_sessions: []
---

# pi Widget todo 列（fleet + todo 双列并排）

## Scope

### Must have

- [x] 列布局原语 `src/adapters/pi/tui/columns.ts`（ANSI 感知 padding、双列 `│` 并排、<100 列降级纵向堆叠判定）+ 单测
- [x] todo 列渲染器 `src/adapters/pi/tui/todo-column.ts`（复用 core `todoLines` / `collapsedSummaryLine` / `fitToBudget`，空态占位、焦点标识、静态划线）+ 单测
- [x] `src/adapters/pi/tui/widget.ts` 双列组合改造（统一折叠状态机、`tab` 焦点切换、焦点列键位路由、折叠单行双摘要、两列均空整行隐藏）+ 单测
- [x] `src/pi.ts` 数据接线（widget 新增 `getTodoPhases` 表面；`tool_result` / `sessionStart` / `sessionTree` 三个刷新点）+ 桥测试
- [x] `./check.sh` + `./test.sh` 全量通过

### Must NOT have

- [ ] 不做 OpenCode 侧栏 todo section（独立课题）
- [ ] 不做 `/ztodo` 命令、eager preferred 注入（P5 其余两件，另行规划）
- [ ] 不做完成划线动画（HUD 静态划线即可，报告 4.5 已定）
- [ ] 不新增定时器（spinner 复用现有 150ms 刷新时钟）
- [ ] 不新增配置门 / config.toml 变更（无 `todoStore` 时列恒空自动隐藏，天然 fail-closed）
- [ ] 不做 subagent 完成联动勾选 todo（报告 4.2 已砍）
- [ ] 不改 `src/core/todo/` 状态机与视图投影（已就绪、已测试）

## Context

调研报告 `docs/todo-tool-design-research.md` 4.5 已定稿 pi 侧 `zoo` widget 双列设计（左 fleet 右 todo）。现状比报告更进一步：todo 工具已在 pi 侧完整落地（工具单元 + details 快照持久化 + transcript 恢复 + 卡片渲染），且 **core 视图投影已存在**（`src/core/todo/view.ts` 的 `todoLines` / `collapsedSummaryLine`，glyph/hue 走共享 `STATUS_PRESENTATION` 表，460 行单测已在）。缺的是 pi 适配层三段：列渲染、双列组合、数据接线。用户要求每步足够小、可测试。

## Approach

1. **列布局原语先行**（纯新增，零回归风险）：`columns.ts` 提供 ANSI 感知 padding（pi-tui 已导出 `visibleWidth`，`packages/tui/src/tui.ts:170`）、双列并排 join（左 55% / 右 45%，中间 ` │ ` 分隔）、宽度 <100 列降级为纵向堆叠的判定函数。字符串空间拼接，不走 pi-tui `HStack` 组件组合——与现有 widget 的 `render(width) → string[]` 架构一致，测试设施（stub theme、注入定时器）原样复用。
2. **todo 列渲染器**（纯新增）：`todo-column.ts` 把 `TodoPhase[]` + 焦点/选中/帧号渲染成着色行序列。复用 core `todoLines`（展开窗口，经 `fitToBudget` cap 7 行）与 `collapsedSummaryLine`（折叠摘要段）；空列渲染占位 `待办 —` 保持列结构稳定；完成态静态划线（`view.ts` 的 `strikethrough` 标志已给出）；spinner 行只置 `spinner` 标志，帧字符由宿主时钟驱动。
3. **双列组合**（唯一改造现有代码的一步）：`widget.ts` 扩展为双列——统一折叠/展开状态机；`tab` 切换焦点列（焦点列标题用 `selectedBg` 背景带标识，不用反色）；`↑↓/jk` 只作用焦点列（todo 列选中仅驱动窗口滚动，无 enter 动作）；`esc` 折叠；折叠态单行双摘要（`▸ 代理 1/3 … │ ▸ 待办 3/7 …`）；**两列均空时整行隐藏**；整高 = 两列 max，≤ `FLEET_MAX_LINES`（10 行）预算；键位守卫沿用"编辑器非空不抢键"。
4. **数据接线**（薄改 pi.ts）：widget 新增 `getTodoPhases` 表面——内部缓存 `TodoPhase[]` 供同步 render，异步刷新缓存后 nudge `refresh()`。三个刷新点：`tool_result`（`toolName === "todo"` 且成功 → `todoStore.get(sessionId)` → 更新缓存 → refresh；execute 先 `store.set` 再返回，缓存必然已新，无竞态）、`sessionStart`、`sessionTree`（现有 `todoStore.invalidate` 之后重取）。`todoStore` 与 `fleetWidget` 本就在同一工厂闭包（pi.ts:885 / 981），接线距离极短。
5. **全量验证**：`./check.sh` + `./test.sh`。

## Critical Files

- `src/adapters/pi/tui/widget.ts` (双列组合改造主战场：状态机、键位路由、预算裁剪)
- `src/adapters/pi/tui/todo-column.ts` (新增：todo 列渲染器)
- `src/adapters/pi/tui/columns.ts` (新增：列布局原语)
- `src/pi.ts` (数据接线：`getTodoPhases` 表面 + 三个刷新点)
- `src/core/todo/view.ts` (只读依赖：视图投影，不改)

## Execution strategy

依赖链是线性的，每步独立可测：

```
Wave 1: columns.ts（含单测）
   → Wave 2: todo-column.ts（含单测）
      → Wave 3: widget.ts 双列组合（含单测）
         → Wave 4: pi.ts 接线（含桥测试）
            → Wave 5: check.sh + test.sh 全量
```

不可并行：1→2 有依赖（todo-column 用列宽截断约定），3 依赖 1+2，4 依赖 3 的 widget 接口。

## Verification

- `bun test src/adapters/pi/tui/columns.test.ts` → 期望: 全部通过（padding ANSI 感知、55/45 分配、<100 列降级判定）
- `bun test src/adapters/pi/tui/todo-column.test.ts` → 期望: 全部通过（空态占位、cap 7 窗口、focus 标识、strikethrough、spinner 帧）
- `bun test src/adapters/pi/tui/widget.test.ts` → 期望: 全部通过（tab 焦点切换、焦点列键位路由、双列折叠摘要、两空隐藏、预算 ≤10 行、既有 fleet 行为无回归）
- `./check.sh` → 期望: lint/format 零错误
- `./test.sh` → 期望: 全量测试通过（含既有 460 行 view.test.ts 与 widget 回归）

## TODOs

- [x] 1. 列布局原语 `columns.ts`
      What to do: 新建 `src/adapters/pi/tui/columns.ts`：`visibleWidth` 驱动的 ANSI 感知右 padding；`joinColumns(left, right, totalWidth)` 双列并排（左列 55%、右列 45%、中间 ` │ `，行数不齐时短列补空行）；`isNarrowLayout(width)` 降级判定（<100 列）。配套 `columns.test.ts`。
      Must NOT do: 不引入 pi-tui HStack/VStack 组件组合；不在 core 放布局逻辑（4.5 决议：布局属 pi 宿主约束）。
      Acceptance criteria:
      - [x] `bun test src/adapters/pi/tui/columns.test.ts` 通过，覆盖：含 ANSI 色码行的 padding 宽度正确、55/45 分配、99 列判定为 narrow / 100 列判定为 wide
      - [x] 模块零 pi 运行时依赖（纯函数，duck-typed）

- [x] 2. todo 列渲染器 `todo-column.ts`
      What to do: 新建 `src/adapters/pi/tui/todo-column.ts`：`renderTodoColumn(phases, opts)` 展开态经 core `todoLines` + `fitToBudget`（cap 7）着色输出（`hueToPiColor` 复用），空列输出 `待办 —` 占位；`renderTodoCollapsed(phases)` 输出折叠摘要段（计数 + 当前活跃项，空列 `待办 —`）；spinner 帧字符由传入帧号驱动；完成态按 `strikethrough` 标志加划线。配套 `todo-column.test.ts`（stub theme，仿 `widget.test.ts` 设施）。
      Must NOT do: 不改 `src/core/todo/view.ts`；不新增定时器；不做划线动画。
      Acceptance criteria:
      - [x] `bun test src/adapters/pi/tui/todo-column.test.ts` 通过，覆盖：空 phases → 占位行、>7 行溢出 → `+N` 行、blocked 行带 blocker 文本、completed 行划线、in_progress 行帧号变化驱动 spinner
      - [x] 与 core view 模型之间无重复投影逻辑（只着色与截断）

- [x] 3. widget.ts 双列组合
      What to do: 改造 `createFleetWidget` 为双列 widget（保持导出签名兼容或同步更新 pi.ts 调用点）：统一 expanded/collapsed 状态机；`tab` 切换焦点列（焦点列标题加 `selectedBg` 背景带）；`↑↓/jk` 路由到焦点列（todo 列选中仅滚动窗口，无 enter）；`esc` / 顶部 `↑` 折叠；折叠态单行双摘要（`│` 拼接）；两列均空返回空行数组（整行隐藏）；宽/窄两形态共享同一行渲染函数；整高 ≤10 行预算（窄形态 4+4+2 顶格时收紧窗口到 3）。新增 `getTodoPhases(): readonly TodoPhase[]` dep。扩充 `widget.test.ts`。
      Must NOT do: 不改变既有 fleet 列的渲染词汇与键位语义（回归测试须全绿）；todo 列不加 enter 动作；宽度分配不做自适应浮动（恒 55/45，空列占位保持结构）。
      Acceptance criteria:
      - [x] `bun test src/adapters/pi/tui/widget.test.ts` 全绿（含新增：tab 切换、焦点列路由、双列折叠摘要行、两空隐藏、宽/窄形态、预算裁剪保 ↑/↓ 指示器）
      - [x] 既有 fleet 单测用例零修改通过（行为无回归）

      实施备注：焦点标识落在"焦点列选中行背景带"（非标题行）——既有测试要求单背景带，标题加带会冲突；且焦点转移时旧列带消除（单带原则）。

      审查修复（双 Eagle PASS 后）：展开态无 todo 时不再渲染 `待办 —` 占位（列整体隐藏，与折叠态一致）；`syncTimer` 去掉 `hasActiveTodo` 项（折叠态不做无动画空转）；`tab` 不能聚焦隐藏列。Could Fix 五项亦已修复：`windowRows` budget≤2 预算不变量、`columnWidths` 列宽契约、共享 `todo-row.ts` 消除行体重复、hint 补 `tab switch`、选择索引收敛。

- [x] 4. pi.ts 数据接线
      What to do: 在工厂闭包内建 todo 视图缓存（`TodoPhase[]`），widget 的 `getTodoPhases` 同步读缓存；写 `refreshTodoView()`：`todoStore.get(sessionId)` → 更新缓存 → `widget.refresh()`；三个触发点——`tool_result` handler（`toolName === "todo"` 且无错误时）、`sessionStart`（注册 widget 后）、`sessionTree`（现有 `todoStore.invalidate` 调用后）。无 `todoStore` 时 `getTodoPhases` 恒返空（列自动隐藏）。扩充 pi 桥测试（仿现有 handlers 测试）。
      Must NOT do: 不在 render 路径里发起异步读取（渲染同步读缓存）；不加配置门；不改 `tool_result` 既有 handler 链行为（只追加一个旁路刷新）。
      Acceptance criteria:
      - [x] 桥测试通过：todo tool_result 后 widget 缓存更新并触发 refresh；sessionTree invalidate 后缓存重取；无 todoStore 时 `getTodoPhases` 返回 `[]`
      - [x] `bun test` 相关测试文件全绿

- [x] 5. 全量验证
      What to do: 运行 `./check.sh`（接受其自动格式化）与 `./test.sh`，修复任何失败。
      Must NOT do: 不 git commit / git add（仓库规则：仅用户明确要求时才提交）。
      Acceptance criteria:
      - [x] `./check.sh` 零错误退出
      - [x] `./test.sh` 全量通过

## 追加 TODOs（用户试用反馈）

- [x] 6. 全计划完结 → 投影收敛为单行总结（core `todoLines` 语义规则）
      What to do: `src/core/todo/view.ts` 的 `todoLines` 增加规则：整个计划无未完成任务（pending/in_progress/blocked 均为零）时返回单行 `TodoSummaryLine` 总结（如 `✓ 7/7 done`），替代 N 个 settled phase header；非全完结行为逐字节不变。同步更新 `view.test.ts` 及受影响的 `todo-card.test.ts` / `todo-column.test.ts`。
      Acceptance criteria:
      - [x] 全完结计划投影为单行总结；混合状态投影不变
      - [x] `bun test src/core/todo/ src/adapters/pi/tui/` 全绿

- [x] 7. widget 标题/提示行提升为共享全宽头部
      What to do: `widget.ts` 展开态 render 重组：标题 + 提示行作为全宽共享行置于两列之上（不再属于 fleet 列），体部预算 8 行（10-2）；宽形态 joinColumns 只接体部行，窄形态堆叠体部；无 todo 单列形态输出与今日逐字节一致；`!hasFleet` todo-only 分支维持现状不加头部。
      Acceptance criteria:
      - [x] 双列展开时标题/提示行可见宽 == 终端宽且无 `│`，`│` 只出现在体部行
      - [x] `bun test src/adapters/pi/tui/widget.test.ts` 全绿（含既有单列用例零修改通过）

      实施备注：任务 6 联动修复了 `todo-card.ts` 折叠态全完结计划总结行重复显示的问题（card 在 body 前 prepend 总结行，与新投影规则重复）。

- [x] 8. 全量枚举投影：放得下就枚举完成项，超预算退回稀疏投影
      What to do: 用户试用反馈：全完结单行总结（任务 6）不满足"看到任务条目"的真实需求。修正规则为：core 新增全量枚举投影（每 phase header + 全部任务行，完成态带划线标志）；消费方（todo-column / todo-card）先尝试全量投影，行数 ≤ 预算则全显，否则退回现有稀疏投影（settled phase 仅 header、活跃 phase 保留最近一条完成项）再 fitToBudget。任务 6 的全完结单行总结规则保留为稀疏层的语义（仅稀疏路径可触及）。
      Acceptance criteria:
      - [x] 3 任务全完结小计划在列预算 7 下显示 header + 3 条划线任务行
      - [x] 超预算大计划退回稀疏投影，开放任务优先于完成项保留
      - [x] `bun test src/core/todo/ src/adapters/pi/tui/` 全绿

      实施备注：core 新增 `todoLinesFull`（全量枚举）与共享策略 `todoLinesForBudget`/`fitTodoRows`（放得下用全量、否则稀疏 + fitToBudget）；`todoLines` 稀疏语义不动。todo-column 无选择路径用 fitTodoRows、选择路径用 todoLinesForBudget + windowRows（选择不落被裁行）；todo-card body 改用 fitTodoRows。实测渲染确认全完结 3 任务计划显示 header + 3 条划线任务。

- [x] 9. 单一全量投影 + settled phase 默认折叠 + enter 展开
      What to do: 用户选定方案 C 变体：投影始终全量枚举（取消稀疏回退）；一个 phase 内任务全部完成时默认折叠为 header 行；todo 列聚焦时按 enter 展开/折叠该 phase。core `todoLines` 合并为单一投影（`expandedPhases?: ReadonlySet<string>` 参数）；删除 `todoLinesFull`/`fitTodoRows`/`todoLinesForBudget`、全完结单行总结规则、todo-card 防重复守卫（均为死代码）；widget 持有 `todoExpandedPhases` 并在 enter 时切换；todo-column options 透传 expandedPhases。
      Acceptance criteria:
      - [x] 全完结 phase 默认只渲染 header，enter 展开后显示全部划线任务，再按收起
      - [x] 开放 phase 始终全量枚举（含划线完成项），超预算走 fitToBudget/windowRows
      - [x] `bun test src/core/todo/ src/adapters/pi/tui/` 全绿，无死代码残留

      实施备注：`todoLines(phases, { expandedPhases })` 单一投影（一句话语义：全量枚举，settled phase 除非展开否则只渲染 header）；`TodoHeaderLine` 增加 `name`/`settled` 字段，折叠字形改为枚举状态（▾ 枚举 / ▸ 折叠）；widget 持有 `todoExpandedPhases`（collapse 时重置），enter 仅在选中行为 settled header 时切换；任务 6/7/8 的过渡产物（todoLinesFull/fitTodoRows/todoLinesForBudget/全完结总结规则/card 防重守卫）全部删除。实测渲染确认折叠/展开/再收起交互正确。

- [x] 10. 结构重组：fleet 列渲染器抽离 widget + 配额必传（方案 A）
      What to do: 用户批准的结构方案：widget.ts 只留组合层（状态/键路由/预算分配/拼合）；fleet 列渲染（expandedFleetBody、窗口/指示器/选中带）抽为 src/adapters/pi/tui/fleet-column.ts 纯函数，maxRows 必传；todo-column.ts 删 TODO_COLUMN_ROWS、maxRows 必传；widget 三路径显式下发配额（宽=bodyBudget 8、窄=收紧算术、todo-only=FLEET_MAX_LINES 10）。
      Acceptance criteria:
      - [x] 两个列渲染器同构（数据进、行出、配额必传），TODO_COLUMN_ROWS 全树零引用
      - [x] 既有测试行为锁定下全绿（仅宽形态 todo 容量 7→8、todo-only 7→10 两处有意的语义变化更新测试）

      实施备注：新增 `fleet-column.ts`（224 行纯渲染器，`renderFleetColumn(tops, opts)`，windowRows/maxLines 必传）+ 8 个渲染器级测试；widget.ts 缩至 790 行组合层；窄形态预收紧窗口保留 7（`NARROW_FULL_ROWS`）以限定语义变化范围。第一性原理结论：预算唯一所有者是组合层，渲染器不持高度意见。

## 折叠语义泛化（任意 phase 可折叠）

用户指出折叠能力绑定“完成”状态不合理。改为：折叠是视图属性，默认由状态派生（开放展开 / 全完结收起），enter 对任意 phase header 切换；显式覆盖表 `foldOverrides: Map<string, boolean>`（非 XOR，状态迁移不翻转用户选择）；widget collapse 时清空。core `TodoLinesOptions.expandedPhases` → `foldOverrides`；`expandedPhases` 全树零引用。实测：开放 phase enter 收起为 `▸ name done/total`（释放行），再按恢复。

## 视觉统一（窄形态对齐问题）

用户发现窄形态三套用边（头部/内容行缩进 2、指示器与 todo 顶格）且节边界消失。采纳方案：所有形态所有行种统一从列左边缘开始（缩进 2 为单列时代无语义遗留，全部移除）；窄形态换短提示 `↑↓/jk · tab · esc`（条件段保持：tab 需 todo 列、enter 需 enterRun）。改动：widget.ts expandedHeaderLines 收 width 参数、fleet-column.ts 去缩进。新增测试：窄形态全行顶格、宽形态双列各自顶格、短提示条件性。`test.sh` 3012+ pass 全绿。

## 第二轮审查（任务 6-9 后）

- 双 Eagle PASS（HIGH），无 Must Fix；3 Should Fix + 5 Could Fix 逐项核实
- 已修复 6 项：空壳 phase 空白列（显隐改为投影行数门控）、beforeAgentStart fallback 一次性 seed（`todoSeeded`）、todo-only 焦点默认可见列、todoSelected 入口 clamp、投影 memo（phases 引用 + 展开版本号）、展开跨刷新持久性测试
- 无需修复 2 项：windowRows budget<3 为纯渲染原语契约（有测试）；两空返回 `[]` 为已核准例外（pi.ts 注册守卫使其生产不可达）
- 验证：`test.sh` 3002 pass / 0 fail、`check.sh` exit 0

## Final verification wave

- [x] F1. Plan compliance audit（对照 Must have / Must NOT have 逐条核对）
- [x] F2. Code quality review（注释英文、双引号、2-space、80 列、Biome 规则）
- [x] F3. Manual QA (agent-executable)（`bun test` 目标文件 + `./test.sh` 输出核对）
- [x] F4. Scope fidelity（无 P5 其他两件、无 OpenCode 侧改动渗入）

## Commit strategy

默认不提交（仓库规则：仅用户明确要求时执行 git 提交）。若用户要求提交，建议：

- squash 1-2: feat(pi): add todo column layout primitives and renderer
- squash 3: feat(pi): compose dual-column zoo widget with tab focus
- squash 4: feat(pi): wire todo store into widget refresh triggers

## Success criteria

- [x] 所有 TODO checkbox 已勾选
- [x] F1-F4 全部通过
- [ ] 用户确认交付物符合预期（宽终端双列并排 / 窄终端堆叠 / 两空隐藏 / tab 切焦点）

## Risks

- R1: widget.ts 双列改造引入 fleet 行为回归（450 行现有逻辑 + 既有单测） → Mitigation: 任务 1、2 纯新增先落地，任务 3 才动组合；验收标准要求既有 fleet 用例零修改通过
- R2: 窄形态 10 行预算顶格（4+4+2 = 10）溢出被 pi 截断 → Mitigation: 组合层检测顶格时把两列窗口收紧到 3，单测覆盖该边界
- R3: `tool_result` 刷新时序竞态（缓存读到旧值） → Mitigation: todo execute 先 `store.set` 再返回，`tool_result` 到达时缓存必然已新；桥测试断言该顺序
- R4: 字符串拼接列对齐被双宽字符破坏 → Mitigation: padding 统一走 `visibleWidth`；符号词汇禁用 emoji（4.5 已定）
