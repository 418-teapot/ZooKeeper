# ZooKeeper PPT Skill 设计规格

> 参考实现：[guizang-ppt-skill](https://github.com/op7418/guizang-ppt-skill)（AGPL-3.0, 541 行 SKILL.md + 22 版式 + 2 模板）
> 调研日期：2026-07-05

---

## 1. 概述

为 ZooKeeper 构建一个 PPT 生成 Skill。输出单文件 HTML，浏览器打开即可横向翻页播放，`Cmd+P` 打印导出 PDF。

**场景**：技术分享 + 学术报告。

**非目标**：商业路演、产品发布、Keynote 风格的视觉冲击型演示。

---

## 2. 核心决策

### 2.1 输出格式：HTML 单文件

- 零依赖：不需要 PowerPoint、Keynote 或任何播放器，`file://` 协议直接打开。
- LLM 原生擅长 HTML/CSS，生成质量远高于 PPTX（OOXML 是 LLM 的弱项）。
- PDF 导出通过浏览器打印原生完成，CSS 配置 `@page` 和 `page-break-after`。
- PPTX 导出暂不纳入：引入 python-pptx 等外部依赖，投屏用 HTML、分享用 PDF 已覆盖主要场景。

### 2.2 风格：仅瑞士国际主义

只做一套风格：无衬线、网格系统、单一锚点色、极简克制。不做杂志风（衬线标题、流体背景、暖色调）。

理由：技术分享和学术报告天然适合瑞士风。双风格是参考实现中最大的复杂度来源——SKILL.md 每一步都要分叉判断风格，两套模板中同名 CSS 类语义不同。砍掉双风格后 SKILL.md 预估从参考实现的 541 行降至 ~350 行。

### 2.3 画布：16:9 + 4:3 双比例

通过 `<body data-ratio="16-9">` 或 `data-ratio="4-3"` 切换，单一模板支持两种比例，而非维护两套模板。

- 16:9：演示默认（投屏、显示器）
- 4:3：学术会议标配（会议要求、论文 defense、打印友好）

核心差异在 `min(Xvw, Yvh)` 系数和水平 padding：

| 属性 | 16:9 | 4:3 |
|---|---|---|
| vw/vh 映射 | 1vw ≈ 1.78vh | 1vw ≈ 1.33vh |
| 水平 padding | 5vw | 7vw |
| 双约束 Y 系数 | Y ≥ X × 1.6 | Y ≥ X × 1.2 |

### 2.4 模板架构：分层

参考实现的模板是单文件 2419 行，CSS 设计系统、翻页导航、WebGL 着色器、ASCII 呼吸场、动画引擎全部耦合在一个 `<style>` 和 `<script>` 块中。修改任意子系统都需编辑整个文件，AI 生成时也必须理解全部子系统。

ZooKeeper 采用分层模板，关注点分离：

```
core/skills/ppt-generate/template/
├── index.html       # 组装入口，AI 只需在 <!-- SLIDES_HERE --> 处插入页面
├── base.css         # CSS 设计系统 + 19 版式骨架
├── base.nav.js      # 翻页导航
├── base.anim.js     # 入场动效（二期）
└── base.webgl.js    # WebGL 背景（三期）
```

一期只做 `base.css` + `base.nav.js`。`base.css` 需包含 `@media print` 样式：解除横翻 `transform` 约束，逐页 `page-break-after: always`，隐藏导航点与 WebGL/ASCII 画布，`print-color-adjust: exact` 保留 accent 背景色。动画和 WebGL 是锦上添花，对信息传达无实质影响，分期交付。

---

## 3. 版式系统

### 3.1 版式总览（19 个，S01–S19）

每个版式有完整 HTML 骨架，`<section>` 必须带 `data-layout="Sxx"`，不允许使用未登记的版式。

#### 继承自参考实现并适配（11 个）

| 版式 | 用途 | 来源 |
|---|---|---|
| S01 Cover | 封面 | guizang S01 |
| S02 Agenda | 目录 | 新增（参考实现无目录页） |
| S03 Section Divider | 章节分隔 | 基于 guizang S03 Statement 改造 |
| S04 Statement | 核心论点/金句 | guizang S03 |
| S05 Closing | 收束页 | guizang S09 |
| S06 Timeline | 横向/纵向时间线 | guizang S02/S11 |
| S07 Duo Compare | A/B 双轨对照 | guizang S08 |
| S08 Three Cards | 三点并列论证 | guizang S13 |
| S09 Grid Cards | 自适应多卡片网格（3–9 项） | 基于 guizang S04/S19 改造 |
| S11 Bar Compare | 横向条形 benchmark 对比 | guizang S07 |
| S12 KPI Tower | 不等高柱状数据 | guizang S06 |

#### 自研（8 个）

| 版式 | 用途 | 说明 |
|---|---|---|
| S10 Data Table | 极简条带数据表 | 实验数据展示 |
| S13 System Diagram | 闭环流程/同心圆架构 | 基于 guizang S14/S17 改造 |
| S14 Code | 代码展示（highlight.js + 行号） | 技术分享核心需求 |
| S15 Code Diff | 左右对照代码 diff | 同上 |
| S16 Diagram | 全屏 Mermaid/SVG 图表 | 架构图、流程图 |
| S17 Diagram + Note | 左文右图说明 | 同上 |
| S18 Equation | KaTeX 块级公式 + 推导 | 学术报告核心需求 |
| S19 References | 参考文献/引用页 | 学术报告标配 |

### 3.2 不做的版式类型

**条件版式**：参考实现中 S04（Six Cells）必须恰好 6 项、S05（Three Sub-cards）必须 3 项、S16（Multi-card Brief）必须 6 项。要求 AI 数清内容数量再选版式，容易出错。ZooKeeper 用 S09 Grid Cards 统一替代——3/4/6/9 项自适应列数。

**商业场景专用**：参考实现中 S10（Dot Matrix Statement）、S12（Manifesto + Ink Banner）、S15（Image Matrix）、S18（Why Now）、S20（Stacked KPI Ledger）、S22（Image Hero）等服务于商业路演和产品发布，技术/学术场景不需要。

---

## 4. CSS 设计系统

独立设计，不直接复用参考实现的 CSS。核心原则对齐但实现更简化，降低 LLM 生成时的选择空间。

### 4.1 颜色

白底 `#fafafa` + 三档灰（`#111` / `#555` / `#999`）+ 单锚点色 5 选 1。

| # | 名称 | 色值 | 场景 |
|---|---|---|---|
| 1 | IKB 蓝 | `#002FA7` | 默认，技术/学术通用 |
| 2 | 胭脂红 | `#C41E3A` | 强调/警告 |
| 3 | 墨绿 | `#2D5A3D` | 自然/可持续 |
| 4 | 琥珀 | `#D4890C` | 人文/暖调 |
| 5 | 石墨 | `#374151` | 极简/正式 |

只替换 `--accent` / `--accent-rgb` / `--accent-on` 三个变量。灰度和字体全局不变。

参考实现使用 Carbon 文本角色 Token（`--text-primary` 到 `--text-placeholder`），抽象层次多了一层，LLM 生成时容易用错 `--text-helper` 和 `--text-placeholder`。ZooKeeper 直接用灰度值。

### 4.2 间距

8px 基准，5 档：`--sp-xs`(8px) / `--sp-sm`(16px) / `--sp-md`(24px) / `--sp-lg`(48px) / `--sp-xl`(80px)。

参考实现使用 Carbon 2x Grid 的 11 档间距（`--sp-3` 到 `--sp-13`），LLM 面对 11 个选项容易随机挑选导致间距不协调。5 档覆盖全部场景且选择明确。

### 4.3 排版

统一 `z-` 前缀区分排版类和组件类：`.z-hero` / `.z-h1` / `.z-h2` / `.z-h3` / `.z-body` / `.z-body-sm` / `.z-meta` / `.z-cat` / `.z-num`。

参考实现的模板存在两套并行命名——"expressive"（`.h-hero`、`.kpi-hero`）和"productive"（`.t-cat`、`.t-meta`），源于两个设计体系的合并。ZooKeeper 统一为 `z-` 前缀，避免 AI 生成时在两类之间选错。

### 4.4 网格

16 列统一网格。固定比例辅助类：`grid-2-8-8`（均分）、`grid-2-10-6`（左重右轻）、`grid-2-6-10`（左轻右重）、`grid-2-5-11`（极左栏）。

参考实现的文档描述为 16 列但实际 CSS 为 12 列，修复此不一致。

### 4.5 CDN 组件

按需引入，仅在实际使用时加载对应的 `<link>` / `<script>`：

- highlight.js（代码高亮，monokai-sublime 主题）
- KaTeX（数学公式，含 auto-render）
- Mermaid（流程图/时序图/类图）
- Lucide（图标）

### 4.6 不设的特性

- **卡片颜色类**：参考实现的 `card-ink` / `card-accent` / `card-fill` / `card-outlined` 四类互斥且 LLM 经常混用。ZooKeeper 用 `style="background:var(--accent)"` inline 控制，减少类名数量。
- **禁止项**：渐变、阴影、圆角、emoji——这些在瑞士风中破坏克制感。

---

## 5. 模板运行时

### 5.1 文件结构

```
core/skills/ppt-generate/
├── SKILL.md                 # 主指令文件（~350 行，6 步工作流）
├── template/
│   ├── index.html           # 组装入口
│   ├── base.css             # CSS 设计系统 + 19 版式全骨架
│   ├── base.nav.js          # 翻页导航
│   ├── base.anim.js         # 入场动效（二期，占位）
│   └── base.webgl.js        # WebGL 背景（三期，占位）
├── references/
│   ├── layouts.md           # 19 版式骨架 + 排版规则
│   ├── themes.md            # 5 套锚点色
│   ├── components.md        # 组件手册（表格/卡片/时间线/条形图）
│   ├── checklist.md         # P0–P3 质量清单
│   └── images.md            # 图片规范
```

参考实现有 10 个 references 文件（含双风格布局、配图系统、截图帧化、地图组件），ZooKeeper 5 个文件更聚焦。

### 5.2 翻页导航

`base.nav.js` 实现以下全部输入模态：

- **键盘**：→/PageDown/Space 下一页，←/PageUp 上一页，Home/End 首尾，Escape 索引总览
- **滚轮**：累积 deltaY+deltaX，阈值 50px
- **触屏**：touchstart/touchend，50px 水平阈值
- **底部导航点**：动态生成，`.active` 高亮，可点击
- **URL 深链**：`?slide=N`
- **B 键**：toggle 纯色模式（借鉴低功耗模式思路，不持久化）

翻页动画：`#deck` 容器 `transform: translateX(-idx*100vw)` + 900ms 缓动 + 700ms 锁。

### 5.3 排版规则

继承自参考实现的风格 B，经过多轮迭代验证：

- **双约束限高**：所有大字号 `min(Xvw, Yvh)`，16:9 下 Y ≥ X × 1.6，4:3 下 Y ≥ X × 1.2
- **中文字号分档**：1 行 ≤8 字符 → `min(6.4vw, 11.2vh)`；2 行 → `min(5.8vw, 10.2vh)`；3 行 → 优先改短标题
- **字重阶梯**：≥8vw → 200；4–7.9vw → 200–300；1.8–3.9vw → 300–400；16–20px → 400–500；13–15px → 500–600
- **最小字号底线**：正文 18px、caption 16px、meta 14px

编入 `references/layouts.md` 和 `references/checklist.md`。

### 5.4 一期暂不纳入

- **WebGL 着色器**（极细网格 + 鼠标光环 + 点阵背景）：视觉加分明显，但一期优先保证版式和内容的正确性。三期可选增强。
- **ASCII 字符呼吸场**（Canvas 2D 封面动态字符）：一期封面采用纯色底色 + 大字排版。
- **入场动效**：参考实现为每个版式写了独立的 JS 动画函数（22 种配方），效果精确但维护成本高。二期评估用通用 stagger/fade-up 引擎覆盖全部版式。

---

## 6. 工作流

批量生成 + 迭代模式，6 步：

| 步骤 | 内容 | 模式 |
|---|---|---|
| Step 1 | 需求澄清：8 个问题（比例、锚点色、受众、时长、素材、配图、代码/公式需求、约束）+ 叙事弧 | 对话式 |
| Step 2 | 项目初始化：`mkdir` + `cp template/index.html` + 替换锚点色 + 设置 `data-ratio` | 自动 |
| Step 3 | 版式映射：Agent 生成页码–版式映射表，用户确认/调整 | 对话式 |
| Step 4 | 批量填充：读模板 `<style>` → 读 layout 骨架 → 替换内容 → 插入 CDN 引用 | 自动 |
| Step 5 | 验证 + 预览：`zppt validate index.html` + `open index.html` + 对照 checklist | 自动 |
| Step 6 | 迭代：用户反馈 → 改 inline style → 重新验证/预览 | 对话式 |

叙事弧模板：

```
封面(Hook)      → 1 页  : 抛问题/数据/反差
定调(Context)   → 1–2 页: 背景/动机
主体(Core)      → 4–8 页: 核心内容
转折(Shift)     → 1 页  : 新观点/突破
收束(Takeaway)  → 1–2 页: 结论/参考文献
```

---

## 7. 验证系统

### 7.1 `zppt validate` — Rust CLI

挂在 `tools/Cargo.toml` workspace 下，复用 `zutil`。使用 `scraper` crate 做 DOM 级解析（参考实现用纯正则，无法处理嵌套标签）。

10 项检查：

| # | 检查项 | 类型 |
|---|---|---|
| 1 | Slide 数量 > 0 | Error |
| 2 | 每页有 `data-layout="Sxx"`，在 S01–S19 范围 | Error |
| 3 | 比例一致性（全部 16:9 或全部 4:3） | Error |
| 4 | 16:9 页大字号双约束 Y ≥ X × 1.6 | Warning |
| 5 | 4:3 页大字号双约束 Y ≥ X × 1.2 | Warning |
| 6 | 最小字号 ≥ 14px | Error |
| 7 | 底部安全区（检测可能导致 nav 遮挡的定位方式） | Warning |
| 8 | CDN 完整性（使用的 highlight.js/KaTeX/Mermaid 有对应引用） | Error |
| 9 | 禁止项（`box-shadow` / `linear-gradient` / `border-radius`） | Error |
| 10 | 禁止 emoji（Unicode emoji 范围） | Error |

### 7.2 质量检查清单

沿用 P0–P3 四级严重度，条目针对技术/学术场景裁剪：

- **P0**（不可破坏）：字号底线、字重阶梯、安全区
- **P1**（版式节奏）：hero 交替、版式多样性
- **P2**（视觉打磨）：对齐规则
- **P3**（操作细节）：图片路径

---

## 8. 图片规范

统合到 `references/images.md`：

- 目录：`项目/XXX/ppt/images/`
- 命名：`{页号二位数}-{语义}.{ext}`
- 比例标准：16:9 / 16:10 / 4:3 / 1:1，映射到 CSS 类 `.frame-img.r-16x9` 等
- 容器规则：直角无阴影、照片 cover / 信息图 fit-contain、白底容器不用灰底
- 占位策略：无图时用锚点色块（`background: var(--accent); opacity: 0.12`），标注尺寸要求
- 规格建议：单张 ≥ 1600px，JPG 照片，PNG 透明图，总大小 ≤ 10MB

AI 配图生成依赖平台模型能力，一期不纳入。

---

## 9. 路线图

### Phase 1（MVP）

| 交付物 | 量级 |
|---|---|
| `SKILL.md` | ~350 行，6 步工作流 |
| `template/base.css` | CSS 设计系统 + 19 版式全骨架 |
| `template/base.nav.js` | 键盘/触屏/滚轮/URL 深链/索引总览/B 键纯色模式 |
| `template/index.html` | 组装入口 |
| `references/` | 5 文件 |
| `zppt validate` | Rust CLI，scraper DOM 解析，10 项检查 |

### Phase 2

- `template/base.anim.js`：通用 stagger/fade-up 引擎
- Lucide 图标集成
- 增强 checklist（P1/P2 视觉打磨）

### Phase 3

- `template/base.webgl.js`：极简网格背景着色器
- `zppt images`：图片批处理（resize/转格式/校验比例）

### 暂不纳入

- PPTX 导出（引入外部依赖，待实际需求）
- AI 配图生成（依赖平台模型能力）
- 双风格支持（专注瑞士风）
- MapLibre 地图集成（技术/学术场景需求极低）

---

## 附录：与 guizang-ppt-skill 关键差异

| 维度 | guizang | ZooKeeper |
|---|---|---|
| 风格 | 2（A: 杂志风 + B: 瑞士风） | 1（瑞士风） |
| 版式 | 32（A: 10 + B: 22） | 19 |
| 场景 | 商业 + 产品 + 发布会 | 技术分享 + 学术报告 |
| 代码展示 | 无 | highlight.js |
| 图表 | 无 | Mermaid |
| 公式 | 无 | KaTeX |
| 模板 | 单文件 2419 行 | 分层 5 文件 |
| 背景 | WebGL + ASCII（默认启用） | 纯 CSS（一期），WebGL 预留 |
| 动画 | 22 种独立命名配方 | 通用引擎（二期） |
| 配图 | GPT-M 2.0 生成 | 基础规范，生成不做 |
| 验证 | 纯正则 Node.js（110 行） | Rust CLI + DOM 解析 |
| SKILL.md | 541 行 | ~350 行 |
| references | 10 文件 | 5 文件 |
