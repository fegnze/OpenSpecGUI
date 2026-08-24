## Why

提案机器名经常需要粘贴到 OpenSpec 命令、终端或沟通内容中，目前用户只能手动选择文本，操作慢且容易漏选。工作台应在提案上下文中提供稳定的一键复制入口。

## What Changes

- 在执行台状态卡、筛选后的提案列表、归档提案列表和提案详情中，为每个提案提供复制机器名的图标按钮。
- 复制值统一为 OpenSpec 提案机器名，例如 `keep-sidebar-fixed`，不复制展示标题。
- 复制按钮与打开提案的主交互相互独立，点击复制不会进入详情或改变当前筛选。
- 复制成功后显示短暂的明确反馈，并为键盘和辅助技术提供可识别名称。
- 复用现有受控剪贴板 IPC，不向渲染进程开放新的系统能力或第三方依赖。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `desktop-workbench`: 提案卡片、列表与详情增加安全、可访问的一键复制提案机器名行为。

## Impact

- 主要影响 `src/renderer/app.js`、`src/renderer/styles.css` 和对应 Electron E2E/视觉测试。
- 复用现有 `bridge.clipboard.write` 与主进程剪贴板处理，不修改 IPC 权限模型。
- 不改变项目扫描结果、提案状态、路由结构或导航信息架构。
