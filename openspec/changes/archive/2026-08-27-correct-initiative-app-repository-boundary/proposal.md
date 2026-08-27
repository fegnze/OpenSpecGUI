## Why

历史规划与证据把一个消费项目的专属适配内容留在了通用宿主仓库中，容易把已废弃的 Provider/UI 重建路线误认为公共能力。现需明确并落实仓库边界，使 OpenSpecGUI 只拥有通用 Initiative App 发现、静态承载与隔离规范。

## What Changes

- 清除历史归档中的消费项目专属 schema、Provider、fixture、renderer、测试数据、兼容证据和绝对路径；纯专项 evidence 删除，其余历史示例改为中性合成项目。
- 明确生产代码、正式规范、文档、测试和历史归档均不得把任何消费项目的数据模型、页面或兼容性作为宿主能力；通用验证只使用仓库内合成 fixture。
- 保留已归档的通用嵌入实现及当前工作树中删除旧专项实现的改动，不重新设计 UI，不重建专项应用。
- 还原两张与本次通用 Initiative 列表变更无关的视觉基线，不批量更新截图。
- 审计说明：历史文件曾包含 `WorldTourCasino` / `WTC`、`wtc-resource-program`、`dh-browser-progressive-resource-reorganization` 与 `/Users/ghost/work/WorldTourCasino` 等消费项目标识；本 Change 获批清除这些内容，避免其被误认作公共契约。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `embedded-initiative-app`: 将消费项目无关性扩展为整个 tracked 仓库的规范边界，并要求自动化验收只使用中性合成 fixture。

## Impact

- 影响历史 OpenSpec 归档、正式 `embedded-initiative-app` 规范、仓库文档与测试资产审计。
- 不新增依赖、运行时协议、Provider、专项 schema、页面组件或视觉设计。
