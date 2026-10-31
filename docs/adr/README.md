# 架构决策记录（ADR）

每条记录说明：当时的背景、做了什么决定、考虑过哪些备选方案、付出了什么代价、什么情况下应该重新评估。与执行指南建议不同的决定（0001、0002、0003、0004）都写明了偏离的理由。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-dag-workflow.md) | 工作流采用 DAG（条件、并行、审批节点），而不是线性步骤 | 已采纳（v2），与指南 MVP 建议不同 |
| [0002](0002-node-typescript.md) | 技术栈用 Node.js + TypeScript，而不是 Python | 已采纳（v1） |
| [0003](0003-read-only-agent-tools.md) | Skill 以代理方式运行，可调用只读工具 | 已采纳（v2），与指南“不给工具”不同 |
| [0004](0004-governed-rule-packs.md) | 规则包是受审核的独立实体，而不是工作流里的文本参数 | 已采纳（v2） |
| [0005](0005-pseudonymize-before-model.md) | 发送模型前做可逆假名化，并配合随机边界、金丝雀、外链拦截 | 已采纳（v3） |
| [0006](0006-pin-skill-versions.md) | 工作流版本钉住 Skill 版本 | 已采纳（v3） |
| [0007](0007-eval-gated-optimization.md) | 评测驱动的受控优化：只产生候选，过门控后由人采用 | 已采纳（v3） |
| [0008](0008-storage-encryption-retention.md) | SQLite + 应用层加密 + 保留期，而不是一开始就上 Postgres / KMS | 已采纳（v3） |
