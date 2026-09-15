## concept

- [NPC 式分工](concepts/npc.md) — 人类扮演"游戏设计师"编写 NPC 行为脚本，AI agent 扮演 NPC 在脚本约束下自主行动，实现策略与执行的分离。
- [后验问责制](concepts/post-hoc-accountability.md) — 不阻止 agent 越界编辑，而是在实验记录时捕获偏差并要求合理性说明，通过透明度而非硬限制管理 agent 自主性。
- [增强型 LLM](concepts/augmented-llm.md) — 通过检索、工具和记忆扩展基础模型能力的 agentic system 构件，也是 agent 与外部世界交互的最小接口单元。
- [简约准则](concepts/simplicity-criterion.md) — 自主实验中变更评估准则：复杂度成本必须与收益 magnitude 相称，小幅改进若需大量 hacky 代码则不值得。

## source

- [Anthropic Building Effective Agents 工程博客](sources/notes/anthropic-building-effective-agents.md) — Anthropic 关于 workflow、agent、增强型 LLM 和可靠 agent 系统设计模式的工程博客摘要。

## analysis

- [Agent/Skill/Plugin 判断框架](analysis/agent-skill-plugin-framework.md) — 通过六个维度评估一个能力应实现为 Agent、Skill 还是 Plugin Extension 的结构化判断框架。
- [Agentic System 选择分析](analysis/agentic-system-selection.md) — 在单次 LLM 调用、固定 workflow 和自主 agent 之间选择的复杂度阶梯与风险权衡。
- [LLM Workflow 模式](analysis/llm-workflow-patterns.md) — Prompt chaining、routing、parallelization、orchestrator-workers 和 evaluator-optimizer 五种可组合的 LLM workflow 控制结构。
