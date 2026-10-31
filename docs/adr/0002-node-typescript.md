# ADR 0002：Node.js + TypeScript，而不是 Python

- 状态：已采纳（v1）
- 与执行指南的关系：指南示例用 Python（FastAPI / pytest）。本项目用 TypeScript 全栈。

## 背景
原型需要一个复杂的前端编辑器（DAG、表单、差异对比）和一个后端执行引擎，并且要在评审者机器上“一条命令”跑起来。

## 决策
前后端共用 TypeScript 类型（`shared/types.ts`），后端 Express + 内置 `node:sqlite`，前端 React + Vite，测试用 vitest 与 Playwright。

## 备选方案
Python 后端 + TypeScript 前端：Python 的 NLP / OCR 生态更好，但两套类型定义需要同步，安装步骤翻倍。

## 代价
OCR 用 tesseract.js（精度低于商业 OCR）；若要接入 Python 生态（如 Presidio 做个人信息识别），需要以独立服务方式接入。

## 何时重新评估
当需要大规模文档处理或专用 NLP 模型时，把这些能力拆成独立服务，核心编排仍保留在 TypeScript。
