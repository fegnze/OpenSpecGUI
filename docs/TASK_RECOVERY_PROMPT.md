# OpenSpec GUI 任务恢复提示词

在新的 Codex 或 Claude Code 任务中使用下面的提示词，可以从仓库状态恢复上下文，而不依赖原会话记录。

```text
请继续实施 /Users/ghost/work/OpenSpecGUI 中的 OpenSpec GUI。

开始前：
1. 读取仓库 AGENTS.md（如存在）和 OpenSpec 本地技能说明。
2. 使用 openspec-apply-change，change 固定为 build-multi-project-desktop-app。
3. 运行：
   openspec status --change build-multi-project-desktop-app --json
   openspec instructions apply --change build-multi-project-desktop-app --json
4. 完整读取 apply 指令列出的 proposal、specs、design、tasks，不要根据本提示词猜测任务完成度。
5. 运行 git status --short，保留当前未提交变更，不要 reset 或删除不属于本任务的文件。

架构约束：
- 这是独立 Electron 单实例应用，不得恢复 HTTP server，也不得为项目占用端口。
- 项目注册表位于 app.getPath('userData')/projects.json，不向被导入项目写配置。
- Electron main / preload / renderer / core 必须保持隔离；renderer 只能使用 window.openSpecGUI。
- contextIsolation=true、sandbox=true、nodeIntegration=false，权限默认拒绝。
- 文档路径必须限制在当前项目真实 openspec 根目录内，Markdown 按不可信内容清洗。
- 首页只展示提案状态，不放跨提案待办列表；进入提案后 tasks 必须是首要内容。
- 进度固定 10 段并允许末段部分填充，例如 83% = 8 个完整段 + 第 9 段 30%。
- 界面保持紧凑、现代、正文常规字重和适合中英文长期阅读的字号。
- 旧实现 /Users/ghost/work/WorldTourCasino/tools/openspec-workbench 必须保留，除非另有独立 OpenSpec change 明确清理。

实现来源与映射：
- 旧 workspace.js、markdown.js、openspec-cli.js 已迁移到 src/core。
- 原 /api/workspace 与 /api/document 已替换为受限 IPC。
- 项目注册与扫描位于 src/main/project-registry.js。
- 当前项目快照与 revision 隔离位于 src/main/workbench-service.js。
- Electron 生命周期和安全配置位于 src/main/index.js，桥接位于 src/preload/index.js。
- 工作台 UI 位于 src/renderer，截图位于 artifacts。

继续时：
- 从 tasks.md 中第一个未勾选项开始，完成一项就立即勾选。
- 修改后运行 npm test、npm run check、npm audit、npm run package，并执行 OpenSpec strict validation。
- UI 变更必须运行 npm run test:e2e 并检查 artifacts 下的桌面与最小窗口截图。
- 所有 tasks 完成后报告状态，等待用户明确要求后再归档 change。
```
