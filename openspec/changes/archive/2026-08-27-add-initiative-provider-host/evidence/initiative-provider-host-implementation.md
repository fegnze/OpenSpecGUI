# Initiative Provider Host Implementation Evidence

## 结论

OpenSpec GUI 已同时承载独立 OpenSpec Changes、普通 Initiative 与 Resource Program 型 Initiative。通用 Host 只运行应用内静态注册的 Provider/App；项目仓库只能提供受 schema 约束的声明式数据，不能提供脚本、模块、命令、HTML、iframe、URL、网络代理或任意 IPC method。

## 交付结构

- `openspec/initiatives/<initiative-id>/initiative.yaml` 由 Generic Provider 自动发现，使用通用列表和详情页。
- `openspec/programs/<initiative-id>/initiative-provider.json` 只作为固定类型签名；内置 `wtc-resource-program-v1` Provider 独立解析 Program 权威文件。
- Resource Program App 通过固定 Host API 惰性加载 overview、artifact index 和单个成果正文，提供 Program/Workstream/Change/治理、归档任务与四种成果阅读视角。
- Host Router 保存 project、provider、initiative 与专用子路由；刷新、项目切换、revision/source hash 变化和 App 异常均受隔离。

## 跨仓库契约

实施基线为 OpenSpecGUI `d245c848fbf55b293ccad966376892feb25a04bc` 与 WorldTourCasino `968b2441151815a301989ea3c46a7eed8ebc3e84`。两仓库 canonical fixture 逐字节一致：

| 文件 | SHA-256 |
| --- | --- |
| `canonical-input.json` | `4f2b645fab6ad2d64147180bf18417883c6cc0f6c9fa45d6aec31ed4c3ba34d1` |
| `expected-descriptor.json` | `7455d1f1d75b04ff123eefa289b873c684de4ea6b81bd17d3a418cf1cc8193ab` |
| `expected-overview.json` | `4d71634e5120732ae91ab16770bb7b035e8fc97d49424ba99b5eba6fb9c9258b` |
| `expected-artifact-index.json` | `4f74062fca696498311a48907ec6f6cd33237af5e7ddcca46e254f084a01fd2a` |
| `negative-cases.json` | `564dafefe8be48c167b4e3de70c7b9f14bea75e8d86c1705cdee9e8daa854f4f` |

Canonical Provider source hash 为 `754e6c7b6f3a7434138e4484fa9679d7e0fe61a8cb923dcf3dc311f2d565dc17`。GUI 未 require、spawn 或调用 WTC 的实现代码、checker、CLI 或 Dashboard 服务。

## 安全与渲染边界

- IPC 请求绑定当前 project ID、workspace revision、provider ID、initiative ID、source hash 与稳定 artifact ID，并限制 request/response 大小。
- Provider 每次惰性读取重新验证白名单、逐段符号链接、realpath、允许根、媒体类型和正文上限；contract lock 文件会独立重算 hash。
- Markdown 经 inert DOM 白名单净化；Mermaid 使用本地 `11.16.1`、strict、全局 `htmlLabels=false`、SVG 二次校验与作用域外部样式，不放宽 CSP。
- renderer 保持 sandbox、无 Node、无 fetch/WebSocket/EventSource、无 iframe/webview，也不监听端口。

## 功能与视觉等价

真实 WTC 只读测试得到 1 个 Program、9 个 Workstream、5 个 Change、10 个 gate 和 41 个 Diagram。四个归档 Change 的任务正文与 Provider 官方计数逐项一致；41/41 Diagram 均在未切换源码的情况下由滚动/深链接触发并生成非空 SVG。

最小合法 Program E2E 另外覆盖普通 Initiative 与 Program 型 Initiative 共存、owned 冲突不隐藏 Change、未完成/全部任务筛选、四种成果视角、恶意 Markdown、图形/源码切换、手动缩放、主题更新、条件刷新、深链接刷新恢复、820×640、axe、文本与控件边界。

## 验证记录

- `npm test`：67 passed，1 个真实 WTC 可选测试按设计 skipped。
- `OPENSPEC_GUI_WTC_PROJECT=/Users/ghost/work/WorldTourCasino node --test test/wtc-resource-program-compatibility.test.js`：1/1 passed，41/41 Diagram。
- `npm run test:e2e`：3/3 passed。
- `npm run test:visual:update` 后 `npm run test:visual`：1/1 passed，独立复跑稳定。
- `npm run check`：47 个 JavaScript 文件通过语法检查。
- `npm run package`：Darwin arm64 package passed。
- `npx openspec validate add-initiative-provider-host --strict --no-interactive`：passed。
- `git diff --check`：passed。

## 恢复与后续边界

GUI 不可用时，项目 OpenSpec 文件不受影响。WTC 仍保留静态 Dashboard 及其 build/check/serve、checker 和 Finder 后备；本 Change 不授权退役这些路径。未来新专项类型应新增独立的固定 Provider 契约，只有确实需要差异化交互时才新增静态 Initiative App。
