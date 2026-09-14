## concept

- [NPC 式分工](concepts/npc.md) — 人类扮演"游戏设计师"编写 NPC 行为脚本，AI agent 扮演 NPC 在脚本约束下自主行动，实现策略与执行的分离。
- [后验问责制](concepts/post-hoc-accountability.md) — 不阻止 agent 越界编辑，而是在实验记录时捕获偏差并要求合理性说明，通过透明度而非硬限制管理 agent 自主性。
- [简约准则](concepts/simplicity-criterion.md) — 自主实验中变更评估准则：复杂度成本必须与收益 magnitude 相称，小幅改进若需大量 hacky 代码则不值得。

## analysis

- [Agent/Skill/Plugin 判断框架](analysis/agent-skill-plugin-framework.md) — 通过六个维度评估一个能力应实现为 Agent、Skill 还是 Plugin Extension 的结构化判断框架。
