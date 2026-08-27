## Why

当前 OpenSpec Workbench 跟随业务项目运行，每个项目都需要单独启动服务并占用端口，既增加使用成本，也无法统一查看和切换多个项目。需要将其升级为独立、无端口的桌面工作台，在不修改被导入项目的前提下集中管理本地 OpenSpec 工作区。

## What Changes

- 新建独立 Electron 桌面应用，由单一应用进程读取多个本地项目，不再为每个项目启动 HTTP 服务或占用端口。
- 增加项目管理能力：导入目录、自动发现 `openspec`、批量扫描候选项目、去重、切换、移除和路径修复。
- 将项目清单和当前项目保存在应用自身的数据目录中，不向被导入项目写入配置。
- 迁移现有 OpenSpec 解析、提案状态、规范文档与任务展示能力，保持首页聚焦提案状态、提案详情突出 tasks。
- 通过受限 IPC 暴露文件读取与工作区操作，隔离 Electron 主进程、预加载层和渲染层。
- 提供 macOS 可运行包和面向后续恢复任务上下文的交接提示词。
- 使用仓库内中性合成项目验证迁移，不依赖任何消费项目的旧实现或真实数据。

## Capabilities

### New Capabilities

- `project-registry`: 管理本地项目的导入、OpenSpec 目录发现、持久化、切换、移除与路径修复。
- `desktop-workbench`: 以无端口桌面应用展示当前项目的提案状态、任务进度、规范和文档，并约束本地文件访问与进程通信。

### Modified Capabilities

无。

## Impact

- 新增独立仓库 `/Users/ghost/work/OpenSpecGUI`，包含 Electron 主进程、preload、renderer、OpenSpec 读取核心、测试与打包配置。
- 复用单项目原型中已经验证的解析器、视图和样式，原有 HTTP server 与 CLI 启动入口不进入新架构。
- 新增 Electron 及其打包工具依赖，并使用应用用户数据目录保存项目注册表。
- 被导入项目保持只读；应用仅读取其 `openspec` 内容和必要的 Git 元数据。
