# Proposal: 以独立应用承载复合 Initiative

## Why

当前 Initiative Host 通过项目专用 Provider、模型和界面承载复合专项，导致通用宿主需要理解消费项目的内部结构。OpenSpecGUI 应只定义发现文件规范并负责发现、隔离挂载和生命周期，让项目自有应用完整拥有其数据与界面。

## What Changes

- 新增通用 Initiative App 发现与运行机制：读取项目内最小声明，通过受限本地应用协议提供声明的静态应用根，并在 OpenSpecGUI 内容区挂载独立 `WebContentsView`。
- 宿主保留项目切换、顶层 Initiative 导航、返回动作、窗口尺寸同步、View mount/dispose 和故障隔离；内嵌程序完整拥有自己的 HTML、CSS、路由、数据和内部交互。
- `WebContentsView` 使用独立、沙箱化且无 Node/宿主 IPC 的渲染上下文；宿主只允许当前应用实例的本地协议 origin，拒绝外部导航、新窗口、权限和跨专项访问。
- **BREAKING** 将 `presentationMode=custom` 的“宿主内模块 + Provider 数据接口”模型改为“独立本地应用 + 原生 View”模型，不再用 renderer 模块重建项目专用 UI。
- 删除项目专用 Provider、模型与 schema 镜像、成果读取 IPC、专用 renderer、复制的页面依赖及其专项 fixture 和视觉基线。
- 保留普通 Initiative 的声明式发现与通用详情页，保留全部官方 OpenSpec Changes 的独立索引和现有工作台功能。
- 使用仓库内合成 Initiative App fixture 验证静态入口、相对资源、内部导航、刷新、边界同步和销毁；通用仓库不保存或验证任何消费项目的页面内容与业务行为。

## Capabilities

### New Capabilities

- `embedded-initiative-app`: 定义独立 Initiative 应用的声明发现、受控本地加载、`WebContentsView` 生命周期、安全隔离和不改写页面要求。

### Modified Capabilities

- `initiative-host`: 将专用 Initiative 的承载边界从宿主内重建 UI 改为独立应用原样嵌入，并收缩宿主数据与 IPC 职责。
- `workbench-visual-system`: 增加独立应用内容区的无裁切尺寸同步、宿主外壳边界和最小窗口可达性要求。

## Impact

- 影响 Electron main process、Initiative 发现、本地应用协议、窗口布局、View 生命周期、导航和安全测试。
- 删除既有项目专用 Provider、契约镜像、renderer App 及只验证重建 UI 的测试和视觉快照。
- 保留 Generic Initiative、Change/Spec/Archive 工作台和项目注册表；不把消费项目内部字段加入通用宿主模型。
- OpenSpecGUI 的构建、测试和发布只依赖通用 manifest 契约与合成 fixture，不依赖任何消费项目仓库、schema、页面、截图或验收证据。
