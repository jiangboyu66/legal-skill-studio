# AGENTS.md

给在本仓库工作的 AI 编码代理（以及人类开发者）的约定。每次开始工作前先读本文件。

## 项目
Legal Skill Studio：让法务团队自建 AI Skill，组合成 DAG 工作流并执行；以新加坡营销物料合规初审为验证场景。前后端均为 TypeScript（Express + React），存储为内置 SQLite。

## 不可违反的约束
- **模型调用只经过 `server/services/llm/`**（由 `server/core/queryEngine.ts` 调用）；其他模块不得直接请求模型接口或引入模型 SDK。
- **密钥只来自环境变量**，不得出现在代码、日志、前端、测试快照或文档中。提交前运行 `npm run check:secrets`（也会扫描 `dist/`）。
- **材料是数据不是指令**：任何发给模型的用户材料都必须经过 `executeSkill` / 核验钩子的守卫——假名化（`Pseudonymizer`）、随机边界标签（`wrapInput`）、结尾重申、金丝雀检测。新增调用模型的路径必须复用这些守卫。
- **场景内容不进引擎代码**：Skill、规则包、工作流模板放在 `server/plugins/bundled/`，评测集放在 `testdata/eval/`。新增场景不应修改 `server/core/`。
- **所有查询按组织隔离**：仓储方法都带 `orgId`；跨组织访问返回 404。
- **角色可见范围由服务端强制**：使用者（对某类对象既无 edit 也无 approve 权限）只拿到已发布内容——经 `consumerSkillView` / `consumerWorkflowView`（`server/routes/views.ts`）；运行记录经 `runForViewer` 去掉提示词与原始返回（需要 `run.view_internals`）；审核区接口需要 `review.view`。新增返回 Skill、工作流或运行的接口必须走这些函数，前端隐藏只是体验。
- **治理在运行时强制**：正式运行只能使用已批准的规则包、已发布并钉住的 Skill 版本；不要为了“方便”绕过。
- **不伪造证据**：模拟模式的结果必须标注“模拟”；没有真实密钥不得声称完成了真实调用；`docs/evidence/` 只放系统导出的记录。
- **测试材料只用虚构或公开、脱敏的内容。**

## 约定
- 错误统一用 `AppError(code, 中文说明, { hint })`；新增错误码同时更新 docs/04 §3.3 的对应表。
- 先写能复现问题的测试，再改实现；修改行为时同步更新受影响的测试与文档，而不是删除断言。
- 界面文字用简体中文；代码注释用英文。
- 前端渲染 AI 输出只能用 `OutputView` / `SafeMarkdown`（不加载外部图片）。
- 输入框：说明写在框下方的 `field-help`，placeholder 只放简短示例（≤ 24 字，见 `shared/hints.ts`）；多行文本用 `AutoTextarea`；不要用 `window.prompt`。
- 测试账号的密码在 `server/seed/index.ts` 的 `DEMO_USERS` 中，每个角色一个；改动时同步 README 的账号表。
- 重大取舍写 ADR（`docs/adr/`）。

## 常用命令
```bash
npm install
npm run dev            # API :8787 + 前端 :5173（模拟模式，无需密钥）
npm test               # vitest（单元 + API）
npm run typecheck
npm run e2e            # Playwright 多角色浏览器流程，截图写入 docs/assets/ui-*.png
npm run eval           # 用 testdata/eval 评测内置规则检查 Skill，报告写入 docs/evidence/
npm run check:secrets  # 密钥扫描
npm run demo:real      # 配置密钥后跑一次真实模型演示
```

## 目录速览
- `server/core/`：代理主循环、工具、提示词、守卫（`security.ts`）、核验、评测与优化、工作流引擎、治理
- `server/services/`：模型适配器、文档解析与 OCR、存储（含加密）、鉴权、保留期
- `server/routes/`：HTTP 接口
- `src/`：React 界面
- `tests/`：自动化测试；`scripts/`：e2e、评测、演示、密钥扫描
- `docs/`：需求、调研、计划、验证、架构、ADR、AI 使用说明
