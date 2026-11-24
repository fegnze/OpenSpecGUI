# Proposal: 将 OpenSpec GUI 演进为团队 Agent 工作台

## Why

团队需要一个桌面应用管理各项目在 Codex 和 Claude Code 中实际采用的能力，并验证流程检查确实由宿主执行。现有 OpenSpec GUI 已覆盖提案、规范和审阅归档。将经过团队维护的能力随工作台交付后，新成员能在选定项目时直接看到可选项。

## What Changes

- 桌面应用更名为 Agent Workbench（Agent 工作台），沿用本机已有的项目、授权和登记的宿主入口。
- 在同一个应用中支持现有 OpenSpec 项目和普通 Git 仓库。项目侧栏分设「Agent 配置」和「OpenSpec」，执行台、专项、规范、归档平铺，「能力绑定」提供团队目录与当前项目设置，「宿主接入」管理本机宿主。
- 由维护者在工作台仓库收录 Skills、MCP、Tools 和基础规范。同一应用版本在所有项目展示同一份目录。成员在每个项目或 worktree 内选择能力、配置参数并决定使用哪个宿主。新项目从未启用状态开始，设置和运行回执留在本机。
- 通过 Codex 和 Claude Code 原生入口接入随应用安装的钩子。退出应用后宿主仍可执行检查，工作台展示具体触发结果或需要处理的步骤。
- 将已授权的文档能力接入 Agent 会话。DeepSeek Harness 使用原生文档工具，Codex 和 Claude Code 使用启动钩子提供的本机命令。按工作树、宿主、绑定版本和实际授权提供飞书文档读取、评论与 Google Drive 元数据查询。
- 以 OpenSpec 归档预检连接程序检查和人工审阅。桌面端沿用差异预览与确认，Agent 在受控入口执行项目原有的 OPSX 流程。
- 目录、能力文件和内置连接适配器随 macOS 桌面应用整包发布。客户端从稳定的 HTTPS 地址检查版本，成员确认后更新应用。维护者先上传通过签名、公证和验证的各架构发行包，再发布指向它们的版本索引。

## Capabilities

### New Capabilities

- `agent-capability-management`: 从统一目录按项目或 worktree 选用、配置和更新能力。
- `agent-host-integration`: 本机宿主检测、可审阅的原生接入、钩子执行和真实回执。

### Modified Capabilities

- `project-registry`: 导入与发现普通 Git 仓库及 worktree，将项目可用性和 OpenSpec 可用性分开。
- `desktop-workbench`: 确立项目及全局导航，为项目能力与本机宿主操作提供独立的受限入口，并支持应用内检查、下载和安装 macOS 整包更新。
- `change-archive`: 增加与受控 Agent 归档入口共享的只读预检，保留桌面端原有审阅与事务边界。

## Impact

涉及 Electron 主进程、项目注册表、渲染导航、preload、归档预检和 macOS 更新分发。发行端复用 `release-packaging` 已有的分架构构建与包内源码校验。接入操作按用户确认的范围更新本机宿主配置。正式规范及协作记录继续由项目工作流管理。交互取舍见[评审稿](../../../docs/design/agent-workbench.md)。
