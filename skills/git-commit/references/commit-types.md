# 约定的提交参考

## 快速参考

```
<type>(<scope>): <imperative summary — max 72 chars>

CONTEXT: - past tense, what existed before (≤ 40 words).

CHANGE:  - present tense, what was done (≤ 70 words).

WHY:     - the non-obvious reason (≤ 70 words).

IMPACT:  - what this enables or unblocks (≤ 30 words).

<footer>
```

---

## 类型参考

| 类型 | 适用场景 | 反例 | 正例 |
|------|-------------|-------------|--------------|
| `feat` | 为用户或API添加新功能 | `feat: stuff` | `feat(auth): add OAuth2 login with Google` |
| `fix` | 修复缺陷（生产或开发环境） | `fix: fixed it` | `fix(api): handle null response on timeout` |
| `perf` | 性能优化 | `perf: faster now` | `perf(db): add composite index on org_id` |
| `security` | 安全漏洞修复 | `security: patched` | `security(api): add rate limiting to login` |
| `refactor` | 代码变更，无行为变化 | `refactor: cleaned up` | `refactor(payments): extract validator class` |
| `test` | 添加或更新测试 | `test: more tests` | `test(cart): add empty cart checkout cases` |
| `docs` | 仅文档变更 | `docs: updated` | `docs(api): document webhook payload format` |
| `chore` | 配置、依赖、工具、CI | `chore: stuff` | `chore(deps): upgrade axios to 1.7.2` |
| `hotfix` | 紧急生产修复 | `hotfix: fixed` | `hotfix(api): restore removed pagination param` |
| `revert` | 撤销之前的提交 | `revert: revert` | `revert(core): restore removed endpoint from a3b2c1d` |
| `release` | 版本号提升/发布标记 | `release: bump` | `release(project): bump version to v2.1.0` |
| `deps` | 仅依赖更新 | `deps: upgrade` | `deps(react): upgrade react to 18.3.0` |
| `migration` | 数据库模式或数据迁移 | `migration: add column` | `migration(db): add email_verified column to users` |
| `style` | 格式化、空白（无逻辑变更） | `style: format` | `style(core): reformat with prettier` |
| `ci` | CI/CD配置变更 | `ci: pipeline` | `ci(github): add GitHub Actions deploy workflow` |
| `build` | 构建系统变更 | `build: config` | `build(core): switch from webpack to vite` |

---

## 作用域指南

| 好的作用域 | 差的作用域 |
|------------|-----------|
| `(auth)` — 具体模块 | `(src)` — 过于宽泛 |
| `(payments)` — 领域边界 | `(utils)` — 杂物堆 |
| `(api)` — API层 | `(fix)` — 这是类型，不是作用域 |
| `(db)` — 数据层 | `(changes)` — 无意义 |
| `(deps)` — 依赖管理 | `(stuff)` — 不专业 |

**经验法则**：作用域应是最多变更文件所在的目录或模块名称。如果变更涉及3个以上模块，则使用顶层作用域。

---

## 摘要行规则

| 规则 | ✅ 正确 | ❌ 错误 |
|------|---------|--------|
| 祈使语气 | `add pagination` | `added pagination` / `adding pagination` |
| 不加句号 | `fix timeout` | `fix timeout.` |
| 不超过72字符 | `feat(api): add pagination to user list` (38 chars) | `feat(api): add pagination support to the user list endpoint with cursor-based navigation` (97 chars) |
| 冒号后小写 | `feat(core): add` | `feat(core): Add` |

---

## 破坏性变更

标记破坏性变更的两种方式：

```
# Method 1: ! before colon (shorter, preferred)
feat(api)!: redesign user profile endpoint

BREAKING CHANGE: /user/profile deprecated. Use /users/{id}/profile.

# Method 2: BREAKING CHANGE footer (more explicit)
feat(api): redesign user profile endpoint

BREAKING CHANGE: /user/profile deprecated. Use /users/{id}/profile.
```

---

## 脚注参考

| 脚注 | 用途 |
|--------|-------|
| `Closes #N` | 完全解决问题（合并时自动关闭） |
| `Fixes #N` | 特定缺陷自动关闭（同 Closes） |
| `Refs #N` | 相关但不关闭 |
| `Part of #N` | 大型工作中的一个提交 |
| `BREAKING CHANGE:` | 破坏性变更描述 |

---

## 决策树

```
What type of change is this?
├─ New feature?                    → feat
├─ Bug fix?                        → fix
├─ Security vulnerability?         → security
├─ Performance improvement?        → perf
├─ Code restructure (no behavior)? → refactor
├─ Tests only?                     → test
├─ Documentation only?             → docs
├─ Config / Deps / CI / Tooling?   → chore
├─ Urgent production fix?          → hotfix
├─ Database migration?             → migration
├─ Dependency update?              → deps
├─ Reverting a previous commit?    → revert
├─ Version release?                → release
├─ Breaking change?                → add ! or BREAKING CHANGE footer
└─ Unsure?                         → refactor (safe default)
```
