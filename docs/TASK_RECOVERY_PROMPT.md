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
- 项目同时允许独立 OpenSpec Changes、普通 Initiative 与 embedded Initiative App；Initiative 不替代 Change 生命周期。
- 普通 Initiative 只从 openspec/initiatives/<id>/initiative.yaml 发现并由内置 Generic Provider 解析；独立 App 只通过公开 manifest 协议发现。
- 独立 App 只从固定深度的 openspec/<collection>/<id>/initiative-app.json 发现；manifest 只能声明基础身份、项目内静态 webRoot、entry 和宿主固定 action ID。
- 项目不得声明 Provider/App 代码、命令、模块、任意 URL、iframe、网络代理或 IPC method；OpenSpecGUI 不解析消费项目的内部数据模型、实体关系或业务工件。
- 普通 Initiative 成果继续通过当前 project/revision/provider/initiative/sourceHash/artifactId 的固定 IPC 惰性读取；独立 App 静态内容通过受限 custom protocol 和原生隔离 View 加载。
- contextIsolation=true、sandbox=true、nodeIntegration=false，权限默认拒绝。
- 文档路径必须限制在当前项目真实 openspec 根目录内，Markdown 按不可信内容清洗。
- 首页只展示提案状态，不放跨提案待办列表；进入提案后 tasks 必须是首要内容。
- 进度固定 10 段并允许末段部分填充，例如 83% = 8 个完整段 + 第 9 段 30%。
- 界面保持紧凑、现代、正文常规字重和适合中英文长期阅读的字号。
- 目标项目拥有自己的静态 Dashboard、生成/check/serve 后备与内部测试；OpenSpecGUI 只发现、导航、隔离承载并提供固定 openspec.open-change 动作。

实现来源与映射：
- 旧 workspace.js、markdown.js、openspec-cli.js 已迁移到 src/core。
- 原 /api/workspace 与 /api/document 已替换为受限 IPC。
- 项目注册与扫描位于 src/main/project-registry.js。
- 当前项目快照与 revision 隔离位于 src/main/workbench-service.js。
- Electron 生命周期和安全配置位于 src/main/index.js，桥接位于 src/preload/index.js。
- Initiative 契约、静态 Provider registry 与关系索引位于 src/core/initiative-*.js。
- embedded App manifest 发现位于 src/core/embedded-initiative-app-provider.js，本地协议与原生 View 生命周期位于 src/main/embedded-initiative-app-*.js。
- renderer 只维护宿主占位区、边界同步和不透明子路由；不得新增消费项目专用 renderer App。
- 工作台 UI 位于 src/renderer，截图位于 artifacts。

继续时：
- 从 tasks.md 中第一个未勾选项开始，完成一项就立即勾选。
- 修改后运行 npm test、npm run check、npm audit、npm run package，并执行 OpenSpec strict validation。
- UI 变更必须运行 npm run test:e2e 并检查 artifacts 下的桌面与最小窗口截图。
- Initiative UI 变更还必须运行 npm run test:visual；独立 App 通用边界运行 node --test test/embedded-initiative-app.test.js，并且只使用仓库内合成 fixture。消费项目自行验证其静态应用，不属于 OpenSpec GUI 验收门禁。
- 所有 tasks 完成后报告状态，等待用户明确要求后再归档 change。
```
