# 运行报告：新加坡营销物料合规初审

> 本报告由 AI 生成，仅为初审草稿，须由具备资质的法律/合规人员复核后使用，不构成法律意见。
> “引文核对”只说明引用的文字确实出现在材料中；“结论核验”会检查规则是否存在、是否适用于该渠道、并由核验代理复查，但都不能保证法律结论正确——它只决定复核顺序（优先 / 常规），所有发现都需要人工确认。

- 适用法域：新加坡（SG）（假设）（运行时未指定，按所用规则包的法域推定）
- 运行编号：run_35424d34（工作流 草稿（测试运行），测试运行，从失败节点重试自 run_d6bae1ff）
- 状态：成功
- 发起人：林创建（创建者）
- 模型：mock / mock-legal-v2（模拟模式，未调用真实模型）
- 开始：2026-10-31T18:08:55.596Z　结束：2026-10-31T18:08:58.602Z
- 用量：输入 23386 tokens，输出 2398 tokens

## 使用的规则包

- 新加坡营销物料规则包（示例）：**未经审核的草稿**（已批准），结果仅供测试

## 提示

- 从失败节点重试（原运行 run_d6bae1ff）：沿用原运行的工作流、Skill 与规则包版本，复用 1 个已成功节点的结果；不再注入故障。
- 规则包「新加坡营销物料规则包（示例）」使用未经审核的草稿内容，结果仅供测试。

## 节点

| # | 节点 | 类型 | Skill（版本） | 状态 | 耗时 | 引文核对 | 结论核验（优先复核） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 提取宣传声明 | AI Skill | 营销声明提取 (草稿) | 成功（复用 run_d6bae1ff 的结果） | 0.6s | 10/10 通过 | - |
| 2 | 对照规则检查 | AI Skill | 新加坡营销合规规则检查 (草稿) | 成功 | 1.5s | 20/20 通过 | 3/10 条优先复核 |
| 3 | 高风险深度审查 | AI Skill | 高风险深度审查 (草稿) | 成功 | 0.9s | 8/8 通过 | - |
| 4 | 起草补充材料请求 | AI Skill | 补充材料请求邮件 (草稿) | 成功 | 0.3s | - | - |
| 5 | 面向市场部的整改清单 | AI Skill | 面向市场部的整改清单 (草稿) | 成功 | 0.4s | - | - |
| 6 | 法务负责人审批 | 人工审批 | - | 成功 | - | - | - |
| 7 | 生成审阅意见 | AI Skill | 审阅意见书生成 (草稿) | 成功 | 0.3s | - | - |

## 审批记录

- 法务负责人审批：批准 — 吴复核（法律审核人），2026-10-31T18:08:58.335Z；意见：重试后结果确认

## 最终结果

> ⚠️ 模拟模式输出：未调用真实模型，以下内容由程序根据输入自动拼装，仅用于演示流程。

## 审阅意见书生成

### 输入：合规检查结果（JSON）
| rule_id | quote | issue | risk_level | suggested_fix |
| --- | --- | --- | --- | --- |
| SCAP-01 | Subject: 11.11 MEGA SALE – Singapore's No.1 Mattress at 70% OFF! | [模拟] 问题说明 | medium | [模拟] 修改建议 |
| SCAP-02 | Nimbus CloudRest is Singapore's No.1 mattress, trusted by over 50,000 happy slee | [模拟] 问题说明 2 | medium | [模拟] 修改建议 2 |
| SCAP-03 | Our patented memory foam is clinically proven to cure back pain in just 7 nights | [模拟] 问题说明 3 | high | [模拟] 修改建议 3 |
| SCAP-04 | WAS $2,999 – NOW ONLY $899! | [模拟] 问题说明 4 | medium | [模拟] 修改建议 4 |
| SCAP-05 | This 70% OFF deal ends TODAY ONLY – don't miss out! | [模拟] 问题说明 5 | high | [模拟] 修改建议 5 |
| SOCIAL-01 | Enjoy FREE delivery and FREE pillows worth $199* with every purchase. | [模拟] 问题说明 6 | medium | [模拟] 修改建议 6 |
| CPFTA-01 | "Best sleep of my life – I recommend it to all my patients." – Dr. | [模拟] 问题说明 7 | medium | [模拟] 修改建议 7 |
| CPFTA-02 | Unlike cheap Brand X mattresses that sag within a year, CloudRest lasts a lifeti | [模拟] 问题说明 8 | medium | [模拟] 修改建议 8 |

### 输入：深度审查（JSON，可选）
| rule_id | quote | why_high_risk | evidence_needed | recommended_action |
| --- | --- | --- | --- | --- |
| SCAP-01 | Subject: 11.11 MEGA SALE – Singapore's No.1 Mattress at 70% OFF! | [模拟] 高风险原因 | Subject: 11.11 MEGA SALE – Singapore's No.1 Mattress at 70% OFF! | [模拟] 建议处理 |
| SCAP-02 | Nimbus CloudRest is Singapore's No.1 mattress, trusted by over 50,000 happy slee | [模拟] 高风险原因 2 | Nimbus CloudRest is Singapore's No.1 mattress, trusted by over 50,000 happy slee | [模拟] 建议处理 2 |
| SCAP-03 | Our patented memory foam is clinically proven to cure back pain in just 7 nights | [模拟] 高风险原因 3 | Our patented memory foam is clinically proven to cure back pain in just 7 nights | [模拟] 建议处理 3 |
| SCAP-04 | WAS $2,999 – NOW ONLY $899! | [模拟] 高风险原因 4 | WAS $2,999 – NOW ONLY $899! | [模拟] 建议处理 4 |

### 输入：审批意见（可选）
> {   "decision": "approved",   "comment": "重试后结果确认",   "by": "吴复核（法律审核人）",   "at": "2026-10-31T18:08:58.335Z" }

### 输入：营销物料
> Subject: 11.11 MEGA SALE – Singapore's No.1 Mattress at 70% OFF! Hi there, Nimbus CloudRest is Singapore's No.1 mattress, trusted by over 50,000 happy sleepers. Our patented memory foam is clinically proven to cure back pain in just 7 nights. WAS $2,999 – NOW ONLY $899! This 70% OFF deal ends TODA…

### 输入：报告语言
> 简体中文

### 结论（模拟）

- 请配置真实模型密钥后重新运行以获得实际分析结果。

## 节点详情：对照规则检查

**findings**

| # | rule_id | quote | issue | risk_level | suggested_fix | needs_human_review | reason | 引文核对 | 结论核验 | 人工复核 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SCAP-01 | Subject: 11.11 MEGA SALE – Singapore's No.1 Mattress at 70% OFF! | [模拟] 问题说明 | medium | [模拟] 修改建议 | true | [模拟] 复核原因 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 | 待复核 |
| 2 | SCAP-02 | Nimbus CloudRest is Singapore's No.1 mattress, trusted by over 50,000 happy sleepers. | [模拟] 问题说明 2 | medium | [模拟] 修改建议 2 | false | [模拟] 复核原因 2 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 2 | 待复核 |
| 3 | SCAP-03 | Our patented memory foam is clinically proven to cure back pain in just 7 nights. | [模拟] 问题说明 3 | high | [模拟] 修改建议 3 | true | [模拟] 复核原因 3 | ✓ 引文已核对（第 1 页） | ⚠ 优先复核 · 需补充事实：[模拟] 理由 3 | 待复核 |
| 4 | SCAP-04 | WAS $2,999 – NOW ONLY $899! | [模拟] 问题说明 4 | medium | [模拟] 修改建议 4 | true | [模拟] 复核原因 4 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 4 | 待复核 |
| 5 | SCAP-05 | This 70% OFF deal ends TODAY ONLY – don't miss out! | [模拟] 问题说明 5 | high | [模拟] 修改建议 5 | true | [模拟] 复核原因 5 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 5 | 待复核 |
| 6 | SOCIAL-01 | Enjoy FREE delivery and FREE pillows worth $199* with every purchase. | [模拟] 问题说明 6 | medium | [模拟] 修改建议 6 | false | [模拟] 复核原因 6 | ✓ 引文已核对（第 1 页） | ⚠ 优先复核 · 需补充事实：该规则适用于 social/web 渠道，物料渠道为 email；除非物料中另有相应的营销发送行为，否则可能不适用。；[模拟] 理由 6 | 待复核 |
| 7 | CPFTA-01 | "Best sleep of my life – I recommend it to all my patients." – Dr. | [模拟] 问题说明 7 | medium | [模拟] 修改建议 7 | true | [模拟] 复核原因 7 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 7 | 待复核 |
| 8 | CPFTA-02 | Unlike cheap Brand X mattresses that sag within a year, CloudRest lasts a lifetime. | [模拟] 问题说明 8 | medium | [模拟] 修改建议 8 | false | [模拟] 复核原因 8 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 8 | 待复核 |
| 9 | CPFTA-03 | Simply reply with your full name, NRIC number and mobile number. | [模拟] 问题说明 9 | high | [模拟] 修改建议 9 | true | [模拟] 复核原因 9 | ✓ 引文已核对（第 1 页） | ⚠ 优先复核 · 需补充事实：[模拟] 理由 9 | 待复核 |
| 10 | PRICE-01 | Free pillows while stocks last. | [模拟] 问题说明 10 | medium | [模拟] 修改建议 10 | true | [模拟] 复核原因 10 | ✓ 引文已核对（第 1 页） | 常规复核 · 有依据：[模拟] 理由 10 | 待复核 |

**overall_risk**

high

**coverage_note**

[模拟] 检查范围与局限
