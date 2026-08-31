## Why

顶部搜索会跨提案、规范和任务索引跳转，不能帮助用户在当前打开的长文档或页面中定位某个具体词句。用户按常用的 `⌘F` / `Ctrl+F` 时目前没有受控的页内查找体验，阅读和核对内容需要手动滚动。

## What Changes

- 新增仅作用于当前工作台页面内容的页内文本查找栏，并通过 macOS 的 `⌘F` 和其他平台的 `Ctrl+F` 打开。
- 在输入时高亮全部匹配项，显示匹配数量，并支持前一处、后一处和关闭操作。
- 让键盘能够在查找结果间循环导航，且不会取代现有 `/` 全局文档搜索。
- 页面重新渲染、路由切换或查询清空时，清除旧的页内高亮和结果状态。

## Capabilities

### New Capabilities

- `in-page-search`: 在当前工作台页面中使用标准快捷键查找和定位可见文本。

### Modified Capabilities

- `desktop-workbench`: 为工作台阅读页面增加受控的页内文本查找行为。

## Impact

- Affected code: `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/app.js` and renderer-focused automated tests.
- No new dependencies, backend APIs, project file access or changes to the existing global search index.
