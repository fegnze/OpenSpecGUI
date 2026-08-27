## Context

通用嵌入能力已经由先前 Change 完成、同步并归档，当前工作树也已删除旧专项适配实现。剩余问题是历史归档仍保留消费项目来源、专属实现计划和真实兼容证据，且两张无关视觉基线被当前工作树改写。参见 [proposal.md](./proposal.md) 的审计动机。

## Goals / Non-Goals

**Goals:**

- 让全部 tracked 文件与当前工作树遵守消费项目无关边界。
- 保留通用嵌入实现和已有删除项，清理历史内容时仍保持 OpenSpec artifacts 可读、可验证。
- 用仓库内合成 fixture 和确定性文本扫描完成验收。

**Non-Goals:**

- 不重构通用发现、协议或 View 生命周期。
- 不设计新 UI，不做像素级或真实消费项目兼容验证。
- 不恢复旧 Provider snapshot、专项 schema 或宿主重建页面。

## Decisions

### 1. 历史归档按内容所有权清理

纯粹记录某个消费项目 Provider、页面或真实兼容结果的 evidence 直接删除。仍记录通用能力的 proposal、design、tasks 与 evidence 保留原有结构，但把真实来源、路径、样本和验收对象改为仓库内中性合成示例；不能仅替换名称后继续保留专属数据模型。

选择该方式是因为 maintainer 已批准历史清理，同时保留通用决策的审计价值。整段保留专项内容会继续污染公共边界；删除整个归档则会丢失通用 Host 和 Generic Initiative 的历史。

### 2. 不改写已完成的通用嵌入 Change

已归档的通用嵌入 Change 作为现行实现来源保持不变。本 Change 只修正正式边界规范和仓库历史，不重新解释其协议、生命周期、路由或 UI。

### 3. 精确恢复无关截图

只从当前 HEAD 恢复用户点名的两张视觉基线。与通用 Initiative 列表变化相关的基线及已删除的专项基线保持当前工作树状态，避免批量截图更新掩盖功能变更。

### 4. 验证不访问消费项目

测试只运行本仓库脚本与中性 fixture。最终以 tracked 文件标识扫描、当前文件语义扫描、`npm test`、语法检查、OpenSpec strict validation 和 `git diff --check` 共同验收；不启动外部服务、不读取外部仓库，也不做像素级比较。

## Risks / Trade-offs

- [改写历史归档会降低原始来源可追溯性] -> 在 correction proposal 中保留一条最小审计说明，并保留通用决策与任务结构。
- [只删标识但残留专属模型] -> 同时进行精确标识扫描和业务语义扫描，删除纯专项 evidence，重写仍有通用价值的段落。
- [清理误伤当前通用实现] -> 不重构实现；保留已有删除项，并运行全量测试和正式规范校验。

## Migration Plan

1. 冻结当前工作树与 OpenSpec 状态，创建 correction artifacts。
2. 删除纯专项 evidence，中性化两个历史归档中的真实项目内容。
3. 精确恢复两张无关视觉基线，审计 README、docs、正式 specs、源码和测试。
4. 运行本仓库自动化验证与最终扫描，完成 delta spec 同步后归档 correction Change。
5. 将全部 OpenSpecGUI 变更按仓库约定提交；若验证失败，只修复本次边界清理，不恢复已废弃专项实现。
