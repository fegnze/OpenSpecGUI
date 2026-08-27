## Why

OpenSpecGUI 原本只在项目级展示独立 Changes、Specs 与 Archives，无法用一个通用声明组织多个相关 Change 和成果。需要增加项目无关的 Initiative Host，使仓库可以选择性提供普通 Initiative，同时保持官方 Change 生命周期完整可见。

## What Changes

- 在项目工作区中并列支持独立 OpenSpec Changes 与普通 Initiative；Initiative 只增加组织和阅读视图，不替代官方 Change 生命周期。
- 定义最小 `InitiativeDescriptor`，统一表达 ID、Provider、类型、标题、摘要、状态、健康诊断、关联 Change 和展示模式。
- 建立由 OpenSpecGUI 静态注册的 Generic Initiative Provider，只读取固定 `initiative.yaml` 声明；消费项目不得注册 Provider 代码、命令、模块或外部服务。
- 新增 Initiative 列表和普通专项通用详情；无效 Initiative、重复 ID、歧义发现和悬空 Change 引用显示受控诊断，不影响独立 Change、Spec 和 Archive。
- 通过项目 revision、文件变化检测和受限成果读取刷新 Initiative，不启动项目服务，也不执行被导入仓库中的脚本或 CLI。
- 消费项目专属文件模型、数据适配器和定制页面不属于本 Change；复杂专项后续只能通过公开的通用应用承载协议接入。

## Capabilities

### New Capabilities

- `initiative-host`: 定义 Initiative 的通用描述、受信任发现、刷新、诊断和安全访问边界。
- `generic-initiative`: 定义标准 Initiative 清单、Change 归属关系和无需专用模块的通用列表与详情体验。

### Modified Capabilities

- `desktop-workbench`: 在既有项目工作台中并列呈现独立 OpenSpec Changes 与普通 Initiative。
- `workbench-visual-system`: 为 Initiative 列表、通用详情和错误状态增加最小窗口、主题、键盘与可访问性要求。

## Impact

- 影响工作区索引与 revision 模型，以及 main/preload/renderer 之间的受控 Initiative 请求。
- 影响 renderer 路由和页面渲染，拆分宿主路由与通用 Initiative 页面边界。
- 新增 Generic Provider registry、Descriptor 校验、发现诊断、中性合成 fixture、单元测试及 Electron E2E。
- 保持 Electron `contextIsolation`、sandbox、无 `nodeIntegration`、单实例、无端口运行和导入项目只读边界。
