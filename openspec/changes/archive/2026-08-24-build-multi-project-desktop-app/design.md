## Context

现有实现位于 `/Users/ghost/work/WorldTourCasino/tools/openspec-workbench`，由 Node HTTP server 提供 `/api/workspace` 与 `/api/document`，浏览器端通过 `fetch` 读取数据。其工作区解析、Markdown 渲染、OpenSpec CLI 适配、任务优先详情和视觉样式可复用，但 server、端口分配和单项目 CLI 入口与独立多项目应用目标冲突。详见 `proposal.md` 与两个能力规范。

新仓库起步为空，需要同时建立桌面进程边界、项目注册表、OpenSpec 读取服务、renderer 和打包流程。被导入项目可能使用不同 OpenSpec 版本，GUI 进程的 `PATH` 也可能不同于终端，因此不能把单一全局 CLI 当作唯一数据源。

## Goals / Non-Goals

**Goals:**

- 以单一桌面应用管理任意数量的本地 OpenSpec 项目，全程不监听 HTTP 端口。
- 最大程度迁移已经验证的解析器、任务进度语义和工作台视觉，避免重新解释 OpenSpec 文件。
- 用明确的数据边界隔离项目注册、文件读取、CLI 调用和 UI 状态。
- 使开发、测试和 macOS 打包路径从项目建立之初即保持一致。

**Non-Goals:**

- 本次不编辑 proposal、spec、design 或 tasks，也不代替 IDE。
- 本次不提供团队云同步、远程仓库克隆、账号或协作权限系统。
- 本次不清理 WorldTourCasino 中的旧实现；只有独立应用完成等价验证后才能另立变更处理。
- 本次不强制所有被导入项目升级到同一 OpenSpec 版本。

## Decisions

### 1. Electron 单实例应用，不内嵌本地 Web 服务

主进程负责窗口、项目目录选择、注册表和文件读取；preload 通过 `contextBridge` 暴露窄接口；renderer 只负责状态和 HTML 展示。使用自定义本地协议加载已打包资源，不创建 `http.Server`。启用单实例锁，第二次启动只聚焦已有窗口。

选择 Electron 是因为现有前端和 Node 解析核心可以直接迁移，同时具备原生目录选择与 macOS 打包能力。备选 Tauri 会减小包体，但需要引入 Rust 边界并重写核心；继续使用 localhost server 则保留了端口、生命周期和多实例问题。

### 2. 严格划分 main、preload、renderer 和 core

目录按职责组织：

```text
src/
  main/        Electron 生命周期、窗口、协议、IPC、项目注册表
  preload/     window.openSpecGUI 的类型化桥接
  core/        workspace、markdown、OpenSpec CLI 与路径校验
  renderer/    项目切换器、提案首页、提案详情和文档阅读器
```

窗口设置使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。renderer 不接触 `ipcRenderer`、`fs`、`child_process` 或绝对文件路径；preload 只暴露调用函数和取消订阅函数。

IPC 合约限定为：

- `projects:list`、`projects:add`、`projects:scan`、`projects:select`、`projects:remove`、`projects:relink`
- `workspace:load`、`workspace:refresh`
- `documents:read`
- `clipboard:write`

备选方案是将 Node 能力直接暴露给 renderer，代码更少但会让不可信 Markdown 和 UI 缺陷拥有任意本地访问能力，因此拒绝。

### 3. 注册表位于应用用户数据目录并原子写入

注册表保存为 `app.getPath('userData')/projects.json`，版本化结构如下：

```json
{
  "version": 1,
  "activeProjectId": "uuid",
  "projects": [
    {
      "id": "uuid",
      "name": "WorldTourCasino",
      "rootPath": "/absolute/project/path",
      "openspecPath": "/absolute/project/path/openspec",
      "addedAt": "ISO-8601",
      "lastOpenedAt": "ISO-8601"
    }
  ]
}
```

项目 ID 使用随机 UUID；导入时通过 `realpath` 去重。保存采用同目录临时文件、刷新并原子替换，读取失败时保留错误信息并尝试最近完整版本。重新关联只更新路径与展示名，保留 ID。注册表永不写入业务项目。

选择 JSON 而非 SQLite，是因为数据量小、结构简单、便于迁移和诊断；版本字段为未来迁移留出边界。

### 4. 导入与扫描是两个明确工作流

“添加项目”选择单个项目根目录并检查直接子目录 `openspec`。“扫描目录”选择父目录，默认最多向下 4 层寻找项目，跳过符号链接、隐藏版本库目录、`node_modules`、`dist`、`build`、`Library` 和缓存目录；先显示候选列表，用户确认后才写入注册表。

有界扫描避免在大磁盘或 Unity 产物中无控制遍历。若团队后续需要更深目录，可把最大深度变成设置项，不改变注册表或能力合约。

### 5. 当前项目拥有独立的工作区快照

主进程仅为当前项目建立完整工作区索引，并以 `{ projectId, revision }` 标识内存快照。项目切换递增 revision、清除 renderer 的提案选择与搜索状态，并使旧异步结果失效。非当前项目只做轻量有效性检查，不常驻解析全部文档。

手动刷新强制重建快照；窗口重新获得焦点时比较关键目录时间戳，发生变化才刷新。第一阶段不引入跨平台文件监听，避免编辑器批量写入导致事件风暴。

### 6. 迁移 core，替换 transport

从旧实现迁移 `workspace.js`、`markdown.js` 和 `openspec-cli.js` 及其测试，将项目根从进程启动参数改为显式 `projectContext`。原 `/api/workspace` 的结果由 `workspace:load` 返回，原 `/api/document` 由 `documents:read` 返回；renderer 的 `fetch` 调用替换为 `window.openSpecGUI`。

`server.js` 和 `bin/openspec-workbench.js` 不迁入新运行路径。旧仓库中的源代码暂时保留，作为对照与回滚来源。

### 7. CLI 多级解析并保留文件回退

每个项目按以下顺序解析兼容 CLI：项目本地安装、应用设置或环境变量指定路径、应用随包候选、GUI 进程 `PATH`。执行时固定 `cwd` 为项目根，使用参数数组而非 shell 字符串，设置超时和输出上限。

CLI 不存在、版本不兼容或命令失败时，core 回退到只读文件推断，并在快照中返回 `source`、`limitations` 和诊断信息。UI 显示非阻断提示，不把 CLI 缺失误报成项目损坏。

### 8. renderer 采用项目层、状态层、内容层三段布局

左侧导航顶部是常驻项目切换器和项目管理入口，其下是当前项目的工作台导航。首页只显示提案状态列或紧凑状态分组，不放外置任务列表。提案详情首屏以 task summary、精确分段进度和章节化任务清单为主，proposal、design、specs 作为相邻标签或次级导航。

进度条固定 10 段，每段内部单独承载 0 到 100% 填充，因此 83% 是 8 段完整加第 9 段 30%。字体采用 macOS 与跨平台可用的中英文现代 sans-serif fallback，正文保持常规字重，标题仅在必要层级加重；布局压缩空白但保留阅读行高。

### 9. 本地内容按不可信输入处理

所有文档路径先以当前项目的 `openspecPath` 为基准解析，再验证规范化路径仍位于该根目录内。Markdown 使用结构化解析与白名单清洗，不允许脚本、事件属性、`javascript:` URL 或任意外部资源执行。应用资源使用严格 CSP，自定义协议只服务打包资源。

### 10. 使用 Electron Forge 建立可重复打包流程

仓库提供开发启动、单元测试、静态检查、打包和 make 脚本，先支持 macOS arm64/x64 的本地构建。第一阶段以未签名本地包完成验收，签名、公证与自动更新在分发需求明确后另立变更。

选择 Forge 是因为它覆盖 Electron 官方推荐的打包生命周期并减少自维护脚本；是否采用 Vite 插件由实现时的最小可用 renderer 构建验证决定，不影响进程与 IPC 边界。

## Risks / Trade-offs

- [Electron 安装包明显大于 Web 工具] -> 以复用成熟 Node/前端实现和零端口体验换取体积；首版不引入额外运行时。
- [不同 OpenSpec 版本输出不一致] -> CLI 适配层做结构校验，失败时回退文件解析并显示数据来源。
- [扫描大型目录耗时] -> 限深、排除高成本目录、禁止跟随符号链接，并允许用户取消或只导入单项目。
- [项目在应用外被移动或卸载] -> 注册项保留失效状态，允许重新关联且不阻塞其他项目。
- [迁移视觉时引入功能回退] -> 复用旧 renderer 结构和样式，以截图、关键视口和任务进度边界用例做对比。
- [旧实现与新实现短期重复] -> 在新应用完成等价验证前接受重复，避免提前删除唯一可运行版本。

## Migration Plan

1. 建立 Electron/Forge 骨架、安全窗口配置和测试入口，先让空项目状态可运行。
2. 搬迁 core 文件与单元测试，保持单项目解析输出等价。
3. 实现注册表、导入/扫描/切换/移除/重新关联及 IPC 合约。
4. 搬迁 renderer 和样式，将 HTTP fetch 替换为 preload API，再加入项目切换与错误状态。
5. 完成文件边界、Markdown 清洗、CLI 回退、并发切换和注册表故障测试。
6. 执行 WorldTourCasino 与至少一个其他 OpenSpec 项目的人工验收、桌面/最小窗口截图校验和 macOS 打包验证。
7. 在新仓库写入恢复提示词，记录原始实现位置、架构决策、当前 change、测试命令和下一步。
8. 独立应用通过后仍保留旧实现；清理旧代码必须由后续独立 OpenSpec change 决定。

回滚方式：新应用尚未替代旧入口，出现阻断问题时直接继续使用 WorldTourCasino 中现有 Workbench；注册表位于应用数据目录，删除注册项也不会影响项目文件。
