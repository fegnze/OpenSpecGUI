# OpenSpec GUI

OpenSpec GUI 是一个独立、无端口的本地桌面工作台。它集中管理多个项目，直接读取每个项目的 `openspec/`，并以提案状态首页和 task 优先详情展示 OpenSpec 内容。

## 功能

- 添加单个项目，或在父目录内扫描多个 OpenSpec 项目
- 在侧栏快速切换项目，维护失效路径、重新关联或移除注册项
- 按进行中、待归档、需要处理查看提案状态
- 在提案详情首屏查看 task 阶段、当前任务和精确分段进度
- 阅读 proposal、design、tasks、delta specs、正式 specs 和归档记录
- 从活跃提案详情检查、预览并确认归档，可审阅正式规范的完整文件差异；无需 AI Agent、聊天历史或模型服务
- 在同一项目内并列管理独立 OpenSpec Changes、普通 Initiative 与独立 Initiative App
- 自动发现 `openspec/initiatives/<id>/initiative.yaml` 普通专项，并以通用页面展示关联 Change 与登记成果
- 从 `openspec/<collection>/<id>/initiative-app.json` 固定深度发现独立专项应用，并在原生隔离视图中原样运行项目自己的静态 Dashboard
- 使用统一的 OpenSpec GUI 专属图标标识侧栏、Dock、Finder 和应用包
- 优先使用项目 OpenSpec CLI，CLI 不可用时自动回退为文件推断
- 单实例 Electron 应用，不启动项目专属服务，也不监听 HTTP 端口

## 开发

环境要求：Node.js 22 或更高版本。

```bash
npm install
npm start
```

替换 `src/renderer/assets/app-icon-source.jpeg` 后，重新生成 Dock PNG 与 macOS ICNS：

```bash
npm run icons:build
```

应用内部品牌位独立使用 `src/renderer/assets/product-mark.png`，不复用 APPICON。

若 Electron 官方下载源不可用，可以只为安装命令指定镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

## 验证

```bash
npm test
npm run check
npm audit
npm run package
npm run make
npm run package:mac:arm64
npm run package:mac:x64
openspec validate build-multi-project-desktop-app --strict --no-interactive
```

端到端测试会启动 Electron 并将截图写入 `artifacts/`：

```bash
npm run test:e2e
npm run test:visual
```

独立 Initiative App 的发现、协议、动作和原生 View 生命周期有独立聚焦测试：

```bash
node --test test/embedded-initiative-app.test.js
```

发现文件规范见 [`docs/contracts/initiative-app-v1.schema.json`](docs/contracts/initiative-app-v1.schema.json)。OpenSpec GUI 只用合成 fixture 验证发现、校验和挂载边界；消费项目独立验证自己的静态应用，二者互不构成交叉仓库门禁。

## 打包

```bash
npm run package:mac:arm64
npm run package:mac:x64
npm run package:mac
npm run make
```

`npm run package:mac:arm64` 与 `npm run package:mac:x64` 分别构建并验证单一架构；`npm run package:mac`（也是 `npm run package`）依次构建并验证两种 macOS 架构。每次打包都会覆盖同架构的旧输出，且命令仅在目标 `app.asar` 中的生产源码与当前工作区一致时成功。

未签名的 macOS `.app` 位于 `out/OpenSpec GUI-darwin-arm64/OpenSpec GUI.app` 和 `out/OpenSpec GUI-darwin-x64/OpenSpec GUI.app`；执行 `npm run make` 后的 `.zip` 也位于 `out/`。签名、公证与自动更新不在首版范围内。

## 项目数据

项目注册表保存在 Electron 的用户数据目录，不写入被导入项目：

- macOS：`~/Library/Application Support/OpenSpec GUI/projects.json`
- Windows：`%APPDATA%/OpenSpec GUI/projects.json`
- Linux：`~/.config/OpenSpec GUI/projects.json`

注册表使用真实路径去重并原子替换，保留最近完整备份。移除项目只删除注册项，不删除项目文件。

## 审阅后归档

活跃提案的任务和文档详情均提供“归档…”入口。工作台先检查产物与任务、运行结构校验，再展示正式规范的新增、修改或删除差异及完整变更目录的归档位置。没有增量规范或已经同步时，只移动变更目录；有规范更新时，确认按钮显示“同步规范并归档”。未完成任务或产物须逐项明确接受，校验或规则合并失败不能绕过。

“待归档”表示任务状态提示，不代表实现已经验收。GUI 不读取 Agent 会话，也不根据代码或测试推断需求是否完成；用户可以用任意工具处理内容，再回到界面检查。

归档需要本地 CLI 支持带根目录信息的 `status --json`、`list --json`、`validate --json` 和 `archive --json --yes`。GUI 优先解析项目 CLI，在受限的临时文件快照中计算结果，确认前不修改导入项目，确认后仅提交预览中的规范结果与目录移动。CLI 不可用、仅支持状态查询、自定义工作流无法在快照中复现，或项目指向外部 standalone store 时，浏览仍可用，归档入口会说明原因。开发环境可用 `node --test test/archive.test.js` 验证 CLI 兼容性。

预览后相关文件、CLI、目录身份或归档日期变化，旧确认即失效；目标已存在时不会覆盖。写入期间暂时阻止切换或移除项目，并等待提交结束再退出应用。首期不提供批量归档、跳过校验或撤销成功归档。

发生写入失败时，系统尝试恢复本次修改；遇到其他工具的新修改时保留文件和备份。归档操作记录保存在上述用户数据目录的 `archive-operations/`，文件备份保存在相应规范文件旁的 `.gui-<操作 ID>.bak` 或 `.next` 文件中。界面会显示需要恢复的目录、记录位置和处理说明；请先备份并核对记录中的原始/期望内容与项目实际状态，手动恢复为原状态或完成预期归档后刷新。未决状态解决前，同一项目只能浏览，不能继续归档。系统不会在重启时自动覆盖文件，也不会用 Git 重置项目。

## 安全边界

- renderer 启用 `contextIsolation` 和 sandbox，关闭 Node integration
- renderer 只通过 `window.openSpecGUI` 的命名操作访问主进程
- 文档读取限定在当前项目的真实 `openspec` 根目录内
- Markdown 按不可信输入处理，移除脚本、事件属性和危险 URL
- 普通 Initiative 只解析固定 YAML 契约；独立 App manifest 只能声明基础身份、项目内静态根、首页和宿主预定义动作，不能声明命令、模块、任意 URL、iframe、IPC 或网络代理
- 独立 App 的静态文件先经过 realpath、符号链接、大小、数量和内容指纹校验，再以内存快照通过短生命周期 custom protocol 提供
- 独立 App 使用无 preload、无 Node、sandbox、context isolation、web security 的非持久 session 和 `WebContentsView`，只允许当前 instance origin
- 页面内部模型、路由、Markdown、Mermaid 和视觉依赖归独立 App 所有，宿主不注入 CSS，也不重建专项 UI
- Electron 权限请求默认拒绝，外部窗口与非 `app://` 导航默认拒绝
- OpenSpec CLI 使用参数数组执行，固定项目 cwd，并设置超时与输出上限

## OpenSpec

OpenSpec 生命周期以仓库当前 active change 为准。查询与验证示例：

```bash
openspec list
openspec validate --all --strict --no-interactive
```
