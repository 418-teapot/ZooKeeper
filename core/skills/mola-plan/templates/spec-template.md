# {{TITLE}} — Design Spec

## Context

<!-- 2-4 句话：什么触发了这个 spec，涉及哪些现有代码，解决什么用户需求。
     例：需要引入 JWT 认证方案，现有代码使用 session-based auth，
     新需求要求无状态 token 以支持移动端。 -->

## Design Goals

<!-- 每个 goal 必须是独立可验证的。格式：G<序号>: <specific, measurable goal>
     例：
     - G1: 实现无状态 JWT 认证，token 过期时间 < 1 小时
     - G2: 支持 token refresh，无需用户重新登录 -->

## Architecture Decision

<!-- 高层方案选择 + WHY 选这个而非其他。不要写实现步骤。
     例：选择 access/refresh token 双 token 方案，因为：
     1) 减少 access token 泄露风险；2) 支持移动端离线刷新 -->

## Key Design Decisions

<!-- 每个 decision 需要三件套：Chosen + Alternatives considered + Scenarios tested
     每个决策应回答：为什么选这个、不选其他的、stress test 通过了吗 -->

### Decision 1: <decision name>

- **Chosen:** <做出的决定 + rationale>
- **Alternatives considered:** <其他选项 + 拒绝原因>
- **Scenarios tested:** <具体场景验证了这个决定>

## Non-Goals

<!-- 防止 scope 扩张，每条说清楚"不做什么 + 为什么"。
     例：
     - NG1: 不实现 refresh token 轮换（因为 MVP 阶段不需要）
     - NG2: 不改动现有 user 表（因为 auth 层解耦设计） -->

## Constraints and Assumptions

<!-- 影响设计的技术/组织/时间约束。
     例：
     - C1: 必须兼容现有 session-based 中间件（不能破坏现有功能）
     - A1: 假设 API 网关层已处理 SSL 终止（如果不对则需在应用层加 TLS） -->

## Risks and Mitigations

<!-- 已知风险 + 具体缓解措施（不是"遇到了再处理"）。
     例：
     - R1: token 泄露风险 → Mitigation: access token 有效期 15 分钟 + refresh token 加 scope 限制 -->

## Open Questions

<!-- 延迟决策的待定项，包含 rationale 和触发解决的条件。
     例：
     - Q1: token 存储方式（localStorage vs httpOnly cookie）→ 暂缓因为：依赖前端架构决策 → 解决条件：确定前端部署方案后 -->

## Success Criteria

<!-- 每个 criterion 必须 observable + verifiable，1:1 映射到 Design Goal。
     例：
     - SC1: access token 过期后返回 401，refresh token 可获取新 token
     - SC2: 移动端 token refresh 流程延时 < 200ms -->
