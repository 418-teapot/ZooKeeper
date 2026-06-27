# {{TITLE}}

## Scope

### Must have

<!-- 3-5 个具体交付物。每个用 "- [ ]" 开头。
     例：
     - [ ] 在 src/middleware/auth.ts 实现 JWT 验证函数
     - [ ] 添加 /api/auth/verify 端点
     - [ ] 集成测试覆盖 3 种 token 状态 -->

### Must NOT have

<!-- 明确不需要做的事情，防止 scope 扩张。每个用 "- [ ]" 开头。
     例：
     - [ ] 不实现 refresh token 轮换
     - [ ] 不改动现有 user 表结构 -->

## Context

<!-- 2-4 句话：什么触发了这个 plan，涉及哪些关键文件，用户需求是什么。
     例：用户报告 auth token 在 15 分钟后过期但前端无刷新提示。
     涉及 src/middleware/auth.ts、src/api/auth.ts、src/components/Layout.tsx。 -->

## Approach

<!-- 编号步骤，每步包含具体做法 + rationale。
     例：
     1. 在 auth.ts 添加 token 过期检测函数（复用现有 verify 逻辑）
     2. 在 auth 端点新增 /api/auth/refresh 接口（分离刷新逻辑）
     3. 前端 Layout 组件监听 401 并自动调用刷新（用户体验无感） -->

## Critical Files

<!-- ≤5 个文件，每个带原因。格式：`path` (原因)
     例：
     - `src/middleware/auth.ts` (核心验证逻辑，主要修改点)
     - `src/api/auth.ts` (新增 refresh 端点)
     - `src/components/Layout.tsx` (401 处理) -->

## Execution strategy

<!-- 依赖矩阵 + 并行波次。
     例：Wave 1: auth.ts || types.ts → Wave 2: routes.ts → Wave 3: tests
     用 "→" 表示依赖，"||" 表示可并行 -->

## Verification

<!-- 精确命令 + 期望输出。
     格式：`命令` → 期望: <输出模式>
     例：
     - `curl -X POST /api/auth/verify -H "Authorization: Bearer <token>"` → 期望: HTTP 200 + { valid: true }
     - `curl -X POST /api/auth/verify -H "Authorization: Bearer <expired-token>"` → 期望: HTTP 401 + { error: "token_expired" }
     - `npm test -- --grep "auth"` → 期望: 5 passing, 0 failing -->

## TODOs

<!-- 每个 todo 包含：做什么 + 不做什么 + 验收标准。
     格式：
     - [ ] N. <标题>
           What to do: <具体步骤>
           Must NOT do: <排除项>
           Acceptance criteria:
           - [ ] <可验证的条件，必须 agent 可执行> -->

## Final verification wave

- [ ] F1. Plan compliance audit
- [ ] F2. Code quality review
- [ ] F3. Manual QA (agent-executable)
- [ ] F4. Scope fidelity

## Commit strategy

<!-- 哪些 task 合并在一个 commit；每个 squash 的 commit type + scope + summary。
     例：
     - squash N1-N2: feat(auth): add JWT verification middleware
     - squash N3: test(auth): add expired/revoked/invalid token tests -->

## Success criteria

<!-- 所有 TODO 完成 + F1-F4 全部通过 + 用户确认 scope 匹配。
     例：
     - [ ] 所有 TODO checkbox 已勾选
     - [ ] F1-F4 全部通过
     - [ ] 用户确认交付物符合预期 -->

## Risks

<!-- 已知风险 + 具体缓解措施。格式：R<序号>: <风险> → Mitigation: <缓解动作>
     例：
     - R1: 刷新 token 并发竞态 → Mitigation: 加 mutex 锁，同一时间只允许一个刷新请求
     - R2: 现有测试可能因 mock 变化失败 → Mitigation: 运行全量测试确认回归 -->
