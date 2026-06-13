---
name: git-commit
description: 用于所有 git 提交操作（commit/amend/stage）。自动执行 diff 分析、安全扫描、lint 检查，并使用 5 部分格式（CONTEXT/CHANGE/WHY/IMPACT）生成标准提交。只要涉及 git 提交或任何记录代码变更的请求，就请加载此技能。
---

# Git 提交技能

生成黄金标准的 Git 提交：经过测试、安全且有文档记录。
按顺序执行以下每个阶段。除非用户明确说明，否则不得跳过任何阶段。

<!-- line-limit: 500 -->

---

## Phase 0 — 读取项目规则

检查仓库根目录下是否存在 AGENTS.md、CLAUDE.md、.gitmessage、.git/COMMIT_TEMPLATE 或任何跟 git commit 相关的 skill。
如果找到，这些规则将覆盖本技能的默认设置。

显示已加载的规则后再继续。

### 环境检查

```bash
git branch --show-current
git config user.name
git config user.email
```

如果在 `main`、`master` 或 `release` 分支上 → 警告用户并建议创建功能分支：
```bash
git checkout -b feat/<branch-name>
```
不强硬阻止 — 在受保护分支上执行热修复且经用户确认后是可以接受的。

如果 `user.name` 或 `user.email` 为空 → 请在提交前要求用户配置。

---

## Phase 1 — Diff 分析

在执行 `git add` 之前运行完整的 diff 分析：

```bash
git status
git diff --stat          # 哪些文件、多少行变更
git diff                 # 小变更集的完整 diff
git log --oneline -5     # 最近的提交上下文
```

对每个变更文件进行分类：

| 路径模式 | 分类 |
|-------------|----------|
| `src/` `lib/` `app/` | feature/fix/refactor |
| `tests/` `*.test.*` | test |
| `docs/` `*.md` | docs |
| `package.json` deps | chore |
| `third_party` deps | chore |
| `.github/` `Makefile` | tooling |

---

## Phase 2 — 安全扫描（不得跳过）

运行自动化安全扫描器：

```bash
bash scripts/scan-secrets.sh
```

- **Exit 0** → 显示 "✓ Clean" 并继续
- **Exit 1** → **HARD STOP**。显示发现结果。未清理干净前不得继续。

如果发现密钥：
1. `git reset HEAD <file>` 取消暂存
2. 替换为环境变量或占位符
3. 如有必要，添加到 `.gitignore`
4. 如果已推送，轮换已暴露的凭据

阅读 `references/security-rules.md` 获取完整的模式列表。

---

## Phase 3 — Lint 门控（不得跳过）

运行轻量级 lint 检查。不要假定具体工具 — 探测项目：

1. **阅读项目文档** — 检查 `AGENTS.md`、`CLAUDE.md` 或 `README.md` 中记录的 lint 命令。
2. **未找到任何内容** → 警告用户，询问是否在没有 lint 的情况下继续。

- **通过** → 继续
- **失败** → **硬停止**。先修复错误。

---

## Phase 4 — 提交消息构建

每次提交必须使用 **5 部分格式**。没有例外。正文四个字段以子项列表形式书写；每字段下每条子项以 `- ` 开头，对齐到字段标签之后的内容列，并以句号(`.`)结尾；各字段之间必须插入 1 个空行。

```
<type>(<scope>): <imperative summary — max 72 chars>

CONTEXT: - item 1
         - item 2

CHANGE:  - item 1
         - item 2

WHY:     - item 1

IMPACT:  - item 1
         - item 2

<footers>
```

### 摘要行规则

- **祈使语气**：用 "add" 而非 "added"，用 "fix" 而非 "fixing"
- **末尾不加句号**
- **不超过 72 个字符**
- **总消息长度**：body（CONTEXT + CHANGE + WHY + IMPACT）合计不超过 200 词（多子项时按字段内所有子项合计）。超出时精简 CHANGE，保留 WHY。
- **这些限制是硬性要求**。宁可信息不足也不冗长啰嗦。
- **类型**：`feat` `fix` `perf` `security` `refactor` `test` `docs` `chore` `hotfix` `revert` `release`

### 字段规则

| 字段 | 规则 | 字数上限 | 好的示例 | 差的示例 |
|-------|------|---------|------|-----|
| CONTEXT | 过去时，描述之前的不足 | ≤ 40 词 | "Auth tokens had no expiry" | "There was a bug" |
| CHANGE | 现在时，具体明确 | ≤ 70 词 | "Adds 15-min sliding expiry with refresh rotation" | "Fixed the token thing" |
| WHY | 从代码中不易看出 | ≤ 70 词 | "Required for SOC2 compliance" | "To improve security" |
| IMPACT | 下游影响 | ≤ 30 词, 或写 "No breaking changes" | "Enables audit logging of token refresh events" | "Things are better now" |

### 示例

```
fix(api): add idempotency key and rate limiter to payment endpoint

CONTEXT: - Stripe delivered webhooks twice under high load due to 30s
           application timeout, causing duplicate charges.

CHANGE:  - Adds idempotency_key (order_id + unix_ts hash) to
           all Stripe charges.
         - Implements per-user rate limiter (100 req/min) on POST
           /payment.

WHY:     - Stripe natively deduplicates on idempotency keys — simpler
           than Redis-based deduplication.

IMPACT:  - Eliminates billing support tickets for duplicate charges.

Closes #301
```

阅读 `references/message-examples.md` 获取 15 个完整示例。

### 消息格式验证（不得跳过）

提交前，用 `-m` 直接传入消息字符串运行验证脚本：

```bash
bash scripts/check-commit-msg.sh -m "<完整提交消息>"
```

- **Exit 0** → 消息格式正确，继续提交。
- **Exit 1** → **HARD STOP**。根据报告的错误修正消息，重新验证直到通过。不得提交未通过验证的消息。

此门控与安全扫描同级，不得跳过。

---

## Phase 5 — 问题和工单关联（可选）

从分支名自动检测：

```bash
git branch --show-current | grep -oE '[0-9]+'
```

使用正确的页脚关键字：

| 页脚 | 用途 |
|--------|--------|
| `Closes #N` | 完全解决（合并时自动关闭） |
| `Fixes #N` | 修复 bug（同 Closes） |
| `Refs #N` | 相关联但不关闭 |
| `Part of #N` | 更大任务中的一个提交 |

如果未发现任何问题或工单系统，则跳过此阶段。

---

## Phase 6 — 执行提交

选择性暂存 — 切勿盲目使用 `git add .`：

```bash
git add <specific files or directories>
git diff --cached --stat   # verify before committing
git commit -m "<subject>" \
  -m "CONTEXT: ...
CHANGE:  ...
WHY:     ...
IMPACT:  ..." \
  -m "<footers>"
git show --stat HEAD       # confirm after
```

---

## Phase 7 — 推送策略

切勿直接推送到 `main` 或 `release`。始终推送到功能分支：

```bash
git push origin HEAD
git push --set-upstream origin <branch>   # if new branch
```

显示即将推送的提交：

```bash
git log --oneline origin/main..HEAD
```

---

## 快速参考

| 场景 | 起始阶段 |
|----------|---------------|
| 单一的干净提交 | Phase 1 |
| 发现秘密 | Phase 2 → 先修复 |
| Lint 错误 | Phase 3 → 先修复 |
| 已暂存，需要消息 | Phase 4 |
| 需要推送 | Phase 7 |
| 在 main 上热修复 | Phase 0 → 检查规则 |
