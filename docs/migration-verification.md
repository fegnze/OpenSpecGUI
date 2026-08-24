# 新旧实现迁移验收

## 范围

- 原实现：`/Users/ghost/work/WorldTourCasino/tools/openspec-workbench`
- 独立应用：`/Users/ghost/work/OpenSpecGUI`
- OpenSpec change：`build-multi-project-desktop-app`

## 能力映射

| 原实现 | 独立应用 | 验收方式 |
| --- | --- | --- |
| `src/workspace.js` | `src/core/workspace.js` | 活动/归档提案、正式规范、缺失 artifact、搜索索引单测 |
| `src/markdown.js` | `src/core/markdown.js` | Requirement、Scenario、task 与警告解析单测 |
| `src/openspec-cli.js` | `src/core/openspec-cli.js` | CLI 多级解析、超时/输出限制与文件回退测试 |
| `/api/workspace` | `workspace:load/refresh` | IPC 与 Electron 端到端测试 |
| `/api/document` | `documents:read` | revision、白名单、符号链接替换与目录越界测试 |
| 浏览器页面 | Electron renderer | 桌面、最小窗口与项目管理截图 |
| 单项目 CLI 参数 | 用户数据目录项目注册表 | 添加、扫描、去重、切换、移除、relink 与恢复测试 |

## 有意变化

- 删除运行时 HTTP transport 和端口选择，不迁移 `server.js` 与旧 `bin/openspec-workbench.js`。
- 首页继续聚焦提案状态；项目管理进入独立对话框，task 仅在提案详情突出展示。
- renderer 不再直接读取网络 API、剪贴板、文件系统或子进程。
- CLI 诊断在侧栏只显示简短状态，完整错误仅作为非阻断诊断保留。
- macOS 首版提供未签名 `.app` 与 `.zip`，不包含 DMG、签名、公证和自动更新。

## 验收证据

- `npm test`：核心、注册表、服务、IPC、安全、进度和 Electron 端到端测试
- `npm run check`：所有 JavaScript 语法检查
- `npm audit`：生产与开发依赖安全审计
- `npm run package` / `npm run make`：macOS 应用与 ZIP 产物
- `artifacts/desktop-task-detail.png`：task 优先详情和 83% 部分分段
- `artifacts/minimum-overview.png`：最小支持窗口布局
- `artifacts/project-manager.png`：项目注册与管理对话框
- OpenSpec change 严格校验

## 旧实现保留

WorldTourCasino 中的旧 Workbench 未被修改或删除，可作为迁移对照和临时回滚入口。后续清理必须单独提出、验证并归档，不属于本次 change。
