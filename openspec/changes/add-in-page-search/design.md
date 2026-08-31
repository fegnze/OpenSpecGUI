## Context

当前 renderer 只提供顶部全局索引搜索，`/` 会聚焦该搜索框。主内容在每次路由或数据状态变化时由 renderer 重新生成；现有主进程和 preload 没有 `findInPage` IPC 契约。详见 `proposal.md`。

## Goals / Non-Goals

**Goals:**

- 让当前工作台主内容拥有可靠、可见且可键盘操作的页内查找体验。
- 将查找状态和高亮完全限定于 renderer 的当前页面生命周期。
- 不增加 preload 或主进程权限面，不影响现有全局索引搜索。

**Non-Goals:**

- 不跨多个文档、项目、页面或 embedded Initiative App 搜索。
- 不实现正则、替换、持久化查询、全文索引或写入 Markdown。
- 不修改第三方嵌入页面的 DOM 或输入焦点。

## Decisions

### Renderer 内置、作用域受限的查找栏

在宿主 renderer 的固定界面中提供可关闭的查找栏，并监听 `metaKey/ctrlKey + F`。匹配范围只限主内容容器，避免导航、工具栏和查找栏的文字被计入。`/` 快捷键维持原实现，两个输入框各自管理状态。

备选方案是调用 Electron `webContents.findInPage`。该 API 会扩大匹配范围到整个 WebContents，且需要把匹配事件与导航操作经主进程或 IPC 回传；它不能自然地限定为当前工作台内容，也无法覆盖独立 native view。因此本改动选择 renderer 范围内实现。

### 不破坏已渲染内容的高亮

为匹配项维护独立的 Range/Highlight 状态，或在无法使用浏览器 Highlight API 时采用可逆的 DOM 标记；每次重新渲染前或查询变更前先清理旧状态。当前项使用单独样式，并通过 `scrollIntoView` 定位。该选择避免把搜索结果写入工作区数据，也使页面刷新不会遗留旧节点。

### 可预测的键盘导航和关闭行为

输入变更从第一项开始；Enter 定位下一项，Shift+Enter 定位上一项；前后按钮均支持循环；Escape 和关闭按钮清空状态并退出。空查询或零结果保持稳定的零计数，不触发导航或异常。

## Risks / Trade-offs

- [动态 render 导致 Range 指向失效节点] → 每次 render 前主动清理；render 后仅以当前 DOM 重建匹配项。
- [浏览器 Highlight API 在目标 Chromium 版本不可用] → 提供等价的、可逆的 DOM 标记降级路径，并在测试中覆盖清理行为。
- [长文档的逐节点匹配影响输入响应] → 匹配范围限制为当前页面，使用去抖或合帧更新，并避免读取工作区之外的数据。
- [嵌入 Initiative 原生视图不接收宿主键盘事件] → 明确不纳入本能力范围，保持其隔离边界。

## Migration Plan

该改动不迁移数据或持久化状态。发布后可通过删除查找栏、快捷键监听及其 renderer 样式回滚；全局搜索和工作区文件不受影响。
