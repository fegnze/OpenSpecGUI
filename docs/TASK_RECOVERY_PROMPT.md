# OpenSpec GUI 任务恢复提示词

在新的 Codex 或 Claude Code 任务中使用下面的提示词，可以从仓库状态恢复上下文，而不依赖原会话记录。

```text
请继续实施 /Users/ghost/work/OpenSpecGUI 中的 OpenSpec GUI。

开始前：
1. 读取仓库 AGENTS.md（如存在）和 OpenSpec 本地技能说明。
2. 使用 openspec-apply-change，并以 openspec list 返回的当前 active change 为准；不要沿用已经归档的 change ID。
3. 对选中的 Change 运行：
   openspec status --change <change-id> --json
   openspec instructions apply --change <change-id> --json
4. 完整读取 apply 指令列出的 proposal、specs、design、tasks，不要根据本提示词猜测任务完成度。
5. 运行 git status --short，保留当前未提交变更，不要 reset 或删除不属于本任务的文件。

架构约束：
- 这是独立 Electron 单实例应用，不得恢复 HTTP server，也不得为项目占用端口。
- 项目注册表位于 app.getPath('userData')/projects.json，不向被导入项目写配置。
- Electron main / preload / renderer / core 必须保持隔离；renderer 只能使用 window.openSpecGUI。
- 项目同时允许独立 OpenSpec Changes、普通 Initiative 与 Program 型 Initiative；Initiative 不替代 Change 生命周期。
- 普通 Initiative 只从 openspec/initiatives/<id>/initiative.yaml 发现；专用 Provider 和 App 只允许由 GUI 静态注册。
- 项目不得声明或加载 Provider/App 脚本、命令、模块、HTML、iframe、URL、网络代理或任意 IPC method。
- 专用成果正文必须通过当前 project/revision/provider/initiative/sourceHash/artifactId 的固定 IPC 惰性读取。
- contextIsolation=true、sandbox=true、nodeIntegration=false，权限默认拒绝。
- 文档路径必须限制在当前项目真实 openspec 根目录内，Markdown 按不可信内容清洗。
- 首页只展示提案状态，不放跨提案待办列表；进入提案后 tasks 必须是首要内容。
- 进度固定 10 段并允许末段部分填充，例如 83% = 8 个完整段 + 第 9 段 30%。
- 界面保持紧凑、现代、正文常规字重和适合中英文长期阅读的字号。
- WTC 静态 Resource Program Dashboard、build/check/serve 与 Finder 后备必须保留，只有后续独立退役 Change 通过接管门禁后才能清理。

实现来源与映射：
- 旧 workspace.js、markdown.js、openspec-cli.js 已迁移到 src/core。
- 原 /api/workspace 与 /api/document 已替换为受限 IPC。
- 项目注册与扫描位于 src/main/project-registry.js。
- 当前项目快照与 revision 隔离位于 src/main/workbench-service.js。
- Electron 生命周期和安全配置位于 src/main/index.js，桥接位于 src/preload/index.js。
- Initiative 契约、静态 Provider registry 与关系索引位于 src/core/initiative-*.js。
- WTC Provider 位于 src/core/wtc-resource-program-provider.js，专用页面位于 src/renderer/resource-program-app.*。
- 工作台 UI 位于 src/renderer，截图位于 artifacts。

继续时：
- 从 tasks.md 中第一个未勾选项开始，完成一项就立即勾选。
- 修改后运行 npm test、npm run check、npm audit、npm run package，并执行 OpenSpec strict validation。
- UI 变更必须运行 npm run test:e2e 并检查 artifacts 下的桌面与最小窗口截图。
- Initiative UI 变更还必须运行 npm run test:visual；WTC 等价验证使用 OPENSPEC_GUI_WTC_PROJECT=<path> node --test test/wtc-resource-program-compatibility.test.js。
- 所有 tasks 完成后报告状态，等待用户明确要求后再归档 change。
```
