## Why

OpenSpecGUI 当前只在项目级展示独立 Changes、Specs 与 Archives，无法识别和承载由多个 Change、跨 Change 成果及自定义治理模型组成的 Initiative。需要增加可扩展的 Initiative 宿主，使普通专项获得通用体验，同时允许 Resource Program 这类复合体以受信任的专用模块接管内容区，而不退回 iframe、项目专属 HTTP 服务或任意仓库代码执行。

## What Changes

- 在项目工作区中并列支持独立 OpenSpec Changes 与 Initiative；Initiative 只增加组织和专用阅读视图，不替代官方 Change 生命周期，也不得使未归属或解析失败的 Change 消失。
- 定义最小 `InitiativeDescriptor`，统一表达 ID、Provider、类型、标题、摘要、状态、健康诊断、关联 Change 和展示模式。
- 建立受信任的 `InitiativeProvider` 注册与发现机制；通用 Provider 读取标准 Initiative 清单，专用 Provider 可以使用固定签名发现自定义文件结构并归一化为通用摘要。
- 建立 `Initiative App` 挂载机制：宿主保留项目切换、顶层导航、主题、刷新、安全 IPC 和深链接，专用 App 可以接管内容区及内部子路由，但不得使用 iframe 或获得任意文件系统、进程和网络能力。
- 新增 Initiative 列表和普通专项通用详情；未知 Provider、无效 Initiative、重复 ID、歧义发现和悬空 Change 引用显示受控诊断，不影响项目的独立 Change、Spec 和 Archive 视图。
- 在宿主内核与普通专项通过独立验收后，将 `wtc-resource-program-v1` 作为首个专用 Provider/Initiative App 接入目标，消费 WorldTourCasino Change `adapt-resource-program-as-initiative-provider` 定义的版本化契约，并保留其 Program、Workstream、Gate、Contract Lock、成果 taxonomy、阅读视角和 Mermaid 专用页面。
- 通过宿主统一的项目 revision、文件变化检测和 Provider refresh 更新 Initiative；不为每个项目启动 loopback 服务，也不自动执行被导入仓库为 Initiative Provider 声明的 JavaScript、脚本或 CLI。既有受控 OpenSpec CLI 状态读取不受影响。

## Capabilities

### New Capabilities

- `initiative-host`: 定义 Initiative 的通用描述、Provider 发现与隔离、专用 App 挂载、路由、刷新、诊断和安全访问边界。
- `generic-initiative`: 定义标准 Initiative 清单、Change 归属关系和无需专用 App 的通用列表与详情体验。

### Modified Capabilities

- `desktop-workbench`: 在既有项目工作台中并列呈现独立 OpenSpec Changes 与 Initiative，并允许专用 Initiative App 在统一桌面宿主内运行。
- `workbench-visual-system`: 为 Initiative 列表、通用详情和专用 App 挂载区增加最小窗口、主题、键盘及错误状态要求。

## Impact

- 影响 `src/core/workspace.js` 的工作区索引与 revision 模型，以及 main/preload/renderer 之间的受控 Initiative IPC。
- 影响当前集中式 renderer 路由和页面渲染，需要拆分宿主路由、通用 Initiative 页面与专用 Initiative App 模块边界。
- 新增 Provider registry、Descriptor schema、发现诊断、专用成果读取白名单和相应 fixture、单元测试及 Electron E2E。
- 首个专用模块与 `/Users/ghost/work/WorldTourCasino` 的 `wtc-resource-program-v1` 契约协调，但 OpenSpecGUI 不执行该仓库脚本，也不依赖其 loopback Dashboard 服务。
- 保持 Electron `contextIsolation`、sandbox、无 `nodeIntegration`、单实例、无端口运行和导入项目只读边界。
