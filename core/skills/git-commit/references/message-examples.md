# 提交消息示例 — 15个黄金标准示例

每条示例均使用五段式格式：CONTEXT / CHANGE / WHY / IMPACT / 脚注。
这些示例覆盖了约定式提交规范中的所有提交类型。

---

## 1. feat — 新功能

```
feat(api): add pagination to user list endpoint

CONTEXT: - GET /api/users returned all users in single response.
         - Orgs with 50k+ users saw 15s load times.

CHANGE:  - Adds ?page=N&per_page=100 query params.
         - Uses Link header for cursor-based pagination.

WHY:     - Cursor pagination scales better for high-write tables.
         - Prevents page drift on concurrent insert.

IMPACT:  - P95 response time drops from 15s to 120ms for large orgs.
         - Backward compatible: missing params default to full list.

Closes #204
```

---

## 2. fix — 缺陷修复

```
fix(payments): prevent double-charge on Stripe webhook retry

CONTEXT: - Stripe delivered webhooks twice under high load.
         - Application timeout of 30s caused duplicate charges.

CHANGE:  - Adds idempotency_key to all Stripe charge requests.
         - Key uses order_id and unix_ts hash before callout.

WHY:     - Stripe API natively deduplicates on idempotency keys.
         - Simpler than Redis-based deduplication approach.

IMPACT:  - Eliminates billing support tickets for duplicate charges.

Fixes #301
```

---

## 3. perf — 性能优化

```
perf(db): add composite index on (org_id, created_at) for dashboard queries

CONTEXT: - Dashboard loaded 18s for org-scoped date-range queries.
         - Queries ran sequential scans on 12M-row audit_logs table.

CHANGE:  - Adds B-tree composite index on audit_logs(org_id, created_at).

WHY:     - All dashboard queries filter by org_id then sort by created_at.
         - Composite index covers both without INCLUDE columns.

IMPACT:  - Dashboard P95 drops from 18s to 340ms.
         - Index is 240MB, within budget for 8GB RAM instance.

Closes #156
```

---

## 4. security — 安全修复

```
security(api): add rate limiting to login endpoint

CONTEXT: - POST /api/auth/login had no rate limiting.
         - Allowed unlimited brute-force: 12k requests/min in prod.

CHANGE:  - Adds token-bucket limiter: 5 attempts/min per IP, 10/min per email.
         - Returns 429 with Retry-After header on exceed.

WHY:     - OWASP ASVS requires rate limiting on auth endpoints.
         - In-memory sliding window avoids Redis dependency.

IMPACT:  - Blocks brute-force at network edge without breaking changes.
```

---

## 5. refactor — 代码重构

```
refactor(payments): extract PaymentValidator from PaymentProcessor

CONTEXT: - PaymentProcessor was 1,200 lines with mixed concerns.
         - Validation, network calls, webhooks, refund logic tangled.

CHANGE:  - Extracts PaymentValidator class with pure validation methods.
         - Moves Stripe client to PaymentGateway.
         - Keeps orchestration in PaymentProcessor.

WHY:     - PaymentProcessor had 3 reasons to change, violating SRP.
         - Unit tests needed heavy mocking due to tangled logic.

IMPACT:  - Coverage on validation logic goes from 22% to 91%.
         - PaymentGateway can swap providers without changing processor.
```

---

## 6. test — 仅测试

```
test(cart): add empty cart checkout and quantity overflow cases

CONTEXT: - Cart checkout had 68% line coverage.
         - Missing edge cases for empty carts and max quantity.

CHANGE:  - Adds 14 test cases: empty cart returns 422, quantity exceeds 999.
         - Adds concurrent add/remove and mixed currency validation.

WHY:     - Empty cart edge case caused P0 incident last sprint.
         - These tests prevent regression on critical paths.

IMPACT:  - Cart checkout coverage goes from 68% to 94%.
         - Test names document cases for quick debugging.
```

---

## 7. docs — 文档

```
docs(api): document webhook payload format and retry behavior

CONTEXT: - Webhook consumers reverse-engineered payload from Stripe docs.
         - No internal documentation existed for webhook format.

CHANGE:  - Adds webhooks.md with payload schema for all 6 event types.
         - Documents retry schedule and idempotency guidance.
         - Includes local testing instructions with stripe listen.

WHY:     - Integration PRs delayed because developers had no reference.
         - ISO 8601 dates vs Unix timestamps caused confusion.

IMPACT:  - Self-serve onboarding reduces integration time to ~4 hours.
```

---

## 8. chore — 维护

```
chore(deps): upgrade axios to 1.7.2 to fix CVE-2024-39338

CONTEXT: - Axios 1.6.x had CVE-2024-39338 affecting all HTTP calls.
         - SSRF via redirect allowed internal network probing.

CHANGE:  - Bumps axios from 1.6.7 to 1.7.2.
         - All 342 existing tests pass with no breaking changes.

WHY:     - SSRF vulnerability is critical for payments service.
         - Attacker controlling redirect can probe internal network.

IMPACT:  - CVE patched with zero breaking changes.
         - CI now runs npm audit on every build.
```

---

## 9. BREAKING CHANGE — 破坏性变更

```
feat(api)!: redesign user profile endpoint

CONTEXT: - GET /api/users/:id/profile returned 60 fields.
         - Most callers needed only name and avatar.
         - 85% of payload was unused.

CHANGE:  - Replaces endpoint with /api/v2/users/:id/profile.
         - Returns only requested fields via sparse fieldset.

WHY:     - Payload size reduced by 85% on list views.
         - Sparse fieldsets align with Google API and JSON:API specs.

IMPACT:  - Old endpoint redirects with deprecation header for 90 days.
         - All clients must update URLs and adopt field selection.

BREAKING CHANGE: /api/users/:id/profile deprecated. Use /api/v2/users/:id/profile.
```

---

## 10. WIP — 进行中的工作

```
WIP: refactor(notifications): migrate from email to push

CONTEXT: - Email notification latency was 2-5 minutes during peak hours.
         - Push notifications are under 500ms.

CHANGE:  - Adds push notification schema, worker pool, FCM integration.
         - Email fallback remains active during migration.

WHY:     - Manual testing needed for FCM token expiry edge case.

IMPACT:  - Not for production use.
         - Use WIP to test FCM integration in staging.
```

---

## 11. hotfix — 紧急生产修复

```
hotfix(api): restore removed pagination parameter from user search

CONTEXT: - Deploy v2.4.0 removed ?limit= param from user search.
         - All API clients broke with 5xx errors at 2k/min.

CHANGE:  - Restores limit parameter with validation (1-200).
         - Reverts interface change only, keeps internal refactor.

WHY:     - Hotfix must be minimal to avoid losing 3 other fixes.
         - Single-line change takes 5 minutes to ship.

IMPACT:  - Restores API contract with patch version bump only.

Closes #417
```

---

## 12. revert — 撤销之前的提交

```
revert(core): restore removed endpoint from commit a3b2c1d

CONTEXT: - Commit a3b2c1d removed /api/v1/orders/:id/invoice endpoint.
         - Three legacy mobile clients still depended on it.

CHANGE:  - Reverts a3b2c1d using git revert.
         - Adds deprecation header to restored endpoint.

WHY:     - Full deprecation needs 2 release cycles.
         - Revert buys time for mobile app update.

IMPACT:  - Legacy clients work again with deprecation header logged.

Refs #318
```

---

## 13. release — 版本发布

```
release(project): bump version to v2.1.0

CONTEXT: - 12 commits since v2.0.0 including features and bug fixes.

CHANGE:  - Bumps version in package.json from 2.0.0 to 2.1.0.
         - Runs generate-changelog.sh to update CHANGELOG.md.

WHY:     - Minor bump because feat commits are present.
         - No breaking changes detected in commit history.

IMPACT:  - Tag v2.1.0 created with updated CHANGELOG.md.
```

---

## 14. deps — 依赖更新

```
deps(react): upgrade react to 18.3.0 for concurrent features

CONTEXT: - React 18.2.0 was 8 months old.
         - Missed useOptimistic hook and auto batching in 18.3.0.

CHANGE:  - Bumps react and react-dom from 18.2.0 to 18.3.0.
         - Updates @types/react to match without API changes.

WHY:     - useOptimistic simplifies optimistic UI for cart feature.
         - Automatic batching reduces re-renders.

IMPACT:  - Zero breaking changes in this upgrade.
         - Paves way for React 19 upgrade next quarter.
```

---

## 15. migration — 数据库迁移

```
migration(db): add email_verified column to users table

CONTEXT: - Users table lacked email_verified column or timestamp.
         - Registration flow couldn't verify user emails.

CHANGE:  - Adds email_verified and email_verified_at columns.
         - Creates index on (email_verified, created_at) for admins.

WHY:     - Email verification is prerequisite for passwordless login.
         - Migration is reversible with down script.

IMPACT:  - No impact on existing rows with nullable columns.
         - Admin panel benefits from new index for filtering.
```