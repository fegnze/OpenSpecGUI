## Context

OpenSpecGUI 当前通过项目专用 Provider、模型和 renderer 承载复合 Initiative，导致通用宿主理解并复制消费项目的内部结构。Electron 43.4.1 提供 `WebContentsView`，可以在同一 `BrowserWindow` 的内容树中承载项目自有 renderer。参见 [proposal.md](./proposal.md) 的边界说明。

## Goals / Non-Goals

**Goals:**

- 建立适用于任意自定义复合专项的最小 manifest 和静态独立 App 宿主。
- 加载专项自己的本地 Web 应用，不复制、解释或改写其模型、schema、页面和样式。
- 保留 OpenSpecGUI 的项目、Initiative 列表、返回、刷新和 View 生命周期边界。
- 在真实窗口、项目切换和故障场景中可靠管理原生 View。

**Non-Goals:**

- 不建立通用插件 API、远程 Web App 市场或项目命令执行器。
- 不统一独立 App 的内部主题、导航或信息架构。
- 不替代 Generic Initiative 的通用详情页。
- 不解析任何消费项目的专项状态、成果分类、图表或任务数据。

## Decisions

### 1. 独立 App manifest 使用固定深度通用发现

宿主扫描 `openspec` 下非保留 collection 的直接子目录，只识别固定文件 `initiative-app.json`。manifest 提供基础身份、`embedded-app` presentation、相对静态应用根、首页和可选宿主动作映射。任意类别都使用同一 `openspec/<collection>/<id>` 结构，无需宿主知道其内部文件模型。

发现只做 schema、realpath、符号链接、ID 冲突和文件边界校验。仓库不能注册 JavaScript 模块、命令或 URL 到 OpenSpecGUI。

### 2. 使用 `WebContentsView`，不使用 iframe、webview 标签或 DOM 组件重建

主进程创建 `WebContentsView` 并加入 `BrowserWindow.contentView`。renderer 只渲染一个内容占位区，通过受限 IPC 报告其 DIP bounds；主进程校验并裁剪到窗口内容边界后调用 `setBounds`。窗口 resize、侧栏断点、全屏和系统缩放都会重算，路由切换或宿主 modal 出现时先隐藏 View。

`BrowserView` 已废弃；iframe/webview 标签会继续形成 DOM 嵌入和安全配置问题；当前宿主内 renderer App 已证明会造成 UI 复制和漂移，因此均不采用。

### 3. 使用受限 custom protocol 直接提供静态应用

应用 ready 前注册 standard、secure、supportFetchAPI 的 `openspec-initiative-app` scheme。每次 mount 创建不透明 instance origin；协议 handler 根据 main 保存的 `(projectId, revision, initiativeId, manifestHash)` 找到已验证 `webRoot`，只提供根内普通文件。URL 不包含本机路径，页面不能自行选择项目或目录。

handler 拒绝坏编码、点段、反斜杠、NUL、符号链接、越界 realpath、未知 host/path/method 和超限文件。使用 `file://` 会扩大本地文件访问；启动 loopback 服务会引入项目代码执行、端口和进程生命周期；两者都没有必要，因此不采用。

### 4. 页面动作由固定 registry 映射，不形成专项 API

manifest 可以把已有同源请求路径映射到静态注册的宿主动作 ID。首个动作 `openspec.open-change` 只接收 `changeId`，并以当前 workspace revision 的官方 active/archive Change 索引解析目录；main 重新校验当前 instance、request method、Content-Type、body 大小、ID、realpath 和符号链接后调用系统打开目录能力。

项目不能提供 handler 代码、任意 IPC、路径参数或网络代理。请求路径由 manifest 声明，Host 只理解静态动作 ID，不理解任何专项业务语义，也不要求消费项目实现宿主私有请求头。

### 5. View 使用独立且短生命周期的安全 session

每个 mounted App 使用非持久 partition，`nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`，不配置 preload。权限、下载、新窗口、`file:`、http/https/ws/wss、跨 instance origin 和跨 Initiative 导航全部拒绝；静态页面只拥有自身 origin 内的 HTML/CSS/JS 与声明动作。

协议响应设置正确 Content-Type、`nosniff` 和限制性 CSP。为兼容已提交的静态应用，首期 CSP 只对当前本地 origin 允许 inline script/style；不允许外部连接、frame、object、worker 或 form target。

### 6. 内部 URL 作为不透明状态保存

宿主只记录当前 instance 下的 pathname、query 和 hash，并把它编码进当前 Initiative route；它不解释应用内部参数。刷新和重新挂载时恢复该相对位置，无效或外部位置回到 manifest entry。

这保留项目自有应用的深链接，同时避免在宿主复制应用路由模型。

### 7. 生命周期与边界由 main 原子管理

main 维护 `instanceId -> { projectId, initiativeId, manifestHash, root, view, generation }`。新 mount 先 dispose 旧实例；dispose 顺序为隐藏 View、从 contentView 移除、关闭 webContents、删除协议会话和事件。generation 防止晚到的 load、navigation 和 crash 事件恢复旧项目。

`did-fail-load`、`render-process-gone` 和 `unresponsive` 都转换为 Initiative 级状态。renderer 只显示宿主错误边界，不在 native View 上叠加不可点击的 DOM。

### 8. 刷新只跟踪 manifest 与静态应用输出

workspace refresh 对 manifest 和 `webRoot` 做有界、内容敏感指纹；变化后使旧 instance 失效、重建文件会话并恢复相对 URL。它不扫描专项权威文件、不运行项目生成器，也不计算专项状态；消费项目自行负责生成和验证静态输出。

### 9. 删除项目专用重实现，保留通用 Initiative 内核

删除项目专用 Provider、模型与 schema 镜像、Provider fixture、专项 renderer、复制的页面依赖和只覆盖重建 UI 的视觉基线。删除只服务专用适配器的数据读取分支；普通 Initiative 所需的安全文档读取继续保留。

保留 Generic Initiative、关系索引、Initiative 列表、Host Router、项目 revision 和无 Initiative 项目的零回归行为。`InitiativeAppHost` 改为 embedded View 生命周期协调器或由更小的 main/renderer bridge 取代，不再维护专项 renderer registry。

### 10. 验收只覆盖通用宿主责任

测试只使用仓库内合成 Initiative App，覆盖首页和相对资源加载、内部导航、通用宿主动作、刷新、项目切换、modal、renderer crash、边界同步与 dispose。断言独立 View 使用宿主占位区的有效矩形且页面非空；不比较消费项目页面的 DOM、像素、业务功能或专项数据。

既有工作台视觉基线继续覆盖宿主外壳；独立 App 只做结构和生命周期 smoke test，不保存消费项目内容截图。

## Risks / Trade-offs

- [custom protocol 需要处理现有 Finder POST] -> 只映射固定 `openspec.open-change`，继续使用官方 Change 索引和路径重校验，不暴露通用 API。
- [native View 始终位于 DOM 上层] -> modal/菜单/路由切换前隐藏，renderer 持续上报边界，main 对 bounds 做窗口裁剪。
- [静态输出可能落后于专项输入] -> Host 只刷新已生成文件；消费项目继续负责生成和 stale check，不让 GUI 成为第二生成器。
- [删除项目专用适配代码可能误伤 Generic Initiative] -> 用通用回归覆盖无 Initiative、Generic、独立 Change 和 Archive。

## Migration Plan

1. 冻结 Host、Generic Initiative、独立 Change、Spec 和 Archive 的通用回归基线。
2. 实现 manifest parser、受限 custom protocol、固定动作 registry 和 `WebContentsView` bridge。
3. 用合成 manifest 打通静态加载、相对资源、通用动作、刷新和 dispose。
4. 删除项目专用 Provider、模型/schema/fixture 镜像、专项 renderer App 和重复视觉基线。
5. 运行单元、安全、E2E、通用视觉回归、检查和打包，并由未参与实现者独立复核通用边界。
6. 先同步主 specs，再归档 Change。

回滚时禁用 embedded presentation 并恢复上一提交的专用适配器；消费项目的独立应用和 OpenSpec 工件不受宿主回滚影响。
