# Agent Workbench

Agent Workbench（Agent 工作台）是团队的本地桌面应用。成员在这里给项目选用 Skills、MCP、Tools 和基础规范，连接个人账号，接入 Codex、Claude Code 或 DeepSeek Harness。工作台可登记 Git 仓库和独立 worktree。带有 `openspec/` 的项目还可直接浏览提案、专项、规范与归档。

## 功能

- 添加单个项目，或在父目录内扫描并区分 Git 与 OpenSpec 项目
- 在侧栏快速切换项目，维护失效路径、重新关联或移除注册项
- 切换项目时恢复上次访问的项目页面。底部「宿主接入」可检测本机 Codex、Claude Code 和 DeepSeek Harness 桌面版的版本、查看支持的事件，并一键接入或解除用户级钩子
- 按进行中、待归档、需要处理查看提案状态
- 在提案详情首屏查看 task 阶段、当前任务和精确分段进度
- 阅读 proposal、design、tasks、delta specs、正式 specs 和归档记录
- 在活跃提案或归档详情展开「验收记录」查看 JSON 附件清单。选中文件后才读取第一段原文，使用「下一段」继续阅读
- 从活跃提案详情检查、预览并确认归档，可审阅正式规范的完整文件差异；无需 AI Agent、聊天历史或模型服务
- 在同一项目内并列管理独立 OpenSpec Changes、普通 Initiative 与独立 Initiative App
- 自动发现 `openspec/initiatives/<id>/initiative.yaml` 普通专项，并以通用页面展示关联 Change 与登记成果
- 从 `openspec/<collection>/<id>/initiative-app.json` 固定深度发现独立专项应用，并在原生隔离视图中原样运行项目自己的静态 Dashboard
- 使用统一的工作台图标标识侧栏、Dock、Finder 和应用包
- 优先使用项目 OpenSpec CLI，CLI 不可用时自动回退为文件推断
- 多个项目共用一个 Electron 实例。文档 OAuth 授权期间临时监听本机回环地址接收回调

## 项目能力绑定

在侧栏「Agent 配置 → 能力绑定」查看当前应用收录的 Skills、MCP、Tools 和基础规范。同一版本的工作台向所有项目展示相同的目录。选择项目和目标宿主，预览版本与权限后确认启用。新项目初始均未启用。独立 worktree 可以选择不同版本和连接参数。本机显示别名按能力 ID 保存。

在「Agent 配置 → 钩子记录」按时间查看当前工作树的回执。可筛选 Codex、Claude Code 或 DeepSeek Harness，点击事件名查看当时的能力绑定与检查版本。回执会说明规则放行、拒绝或跳过的原因。工作台能观测到的检查超时会单独记录。宿主提前结束钩子时可能没有回执，工具的实际结果可在宿主会话中核对。

维护者在 `src/capabilities/catalog.json` 和配套目录中收录能力，随应用发版。规则文件可使用 YAML 元数据 `workbench.requires` 声明键值约束。工作台在绑定前报告同一范围内互相冲突的规则及其来源。

- **Skills** 包含飞书缺陷 Agent 和 WTC 的 git-commit。飞书缺陷工作流使用个人 Meegle 身份及项目字段映射，在「能力绑定」中选中飞书缺陷，打开「项目设置」即可填写项目键、默认视图或缺陷、字段映射、工程与发布信息。「账号与授权」分别检查 Meegle、飞书个人身份和消息条件。「配置文件」可关联已有 JSON。绑定后的版本详情提供本机 SKILL.md 的路径，配套脚本与参考资料位于同一目录。git-commit 依赖 WTC 的工程脚本和提交约定。
- **MCP** 的 cv-test1 固定使用团队提供的 Streamable HTTP 地址。成员填写个人 Bearer Token 后可验证握手、查看服务报告的版本和返回的工具。
- **Tools** 包含飞书文档和 Google Drive。在「能力绑定」选择工作树、宿主和版本，启用后打开「连接设置」，在系统浏览器授权。成员可在能力详情展开「在 Agent 中验证」并复制提示词。
- **基础规范** 包含可移植路径、任务范围、变更验证和「归档前同步正式规范」。在一个宿主选用归档规则后，当前工作树的桌面和受控 Agent 归档都要求先同步正式规范。其他工作树可以独立选择。WorldTourCasino 本身已要求先同步。

从早期版本升级后，原有项目绑定和显示别名继续保留。旧全局绑定和本机自定义条目可在「能力绑定 → 旧版记录」查看原始备份路径。固定使用飞书缺陷 Skill 1.1.0 的项目，可在「项目绑定」预览并采用 1.2.0，以便按当前工作树和宿主自动读取设置。继续使用旧快照时，可通过 `--binding` 指定配置文件。

在侧栏底部打开「宿主接入」，选择 Codex 或 Claude Code，核对当前用户配置和共享钩子路径后点击「一键接入」。工作台会补齐 `SessionStart` 和 `PreToolUse`。Codex 显示「待信任」时，在宿主打开 `/hooks` 审阅并信任入口。Claude Code 在目标工作树的新会话中按提示确认工作区信任。工作台关闭后，钩子继续使用应用自带的运行环境。解除接入只移除工作台为该宿主登记的项目，已有手工配置和另一宿主共用的程序会保留。

DeepSeek Harness 桌面版也可以在「宿主接入」一键接入。工作台读取应用自带的 `dsh` 版本，将 Cordis 插件登记到 desktop profile 的 `cordis.patch.yml`。在「能力绑定」选择 DeepSeek Harness 和目标项目后，新会话可获得已选规范与 Skill。插件通过宿主工具权限接口检查受支持的本机文件编辑。工作台里的 MCP 连接测试和宿主会话中的 MCP 注册各有独立状态。

个人授权信息使用系统凭据服务加密后保存在应用用户目录。工作台绑定状态和宿主实际加载状态分别显示。原生接入进度见[工作台任务清单](openspec/changes/add-agent-workbench/tasks.md)。

### 在 Agent 会话中使用文档工具

在「宿主接入」接入目标宿主，然后从已绑定的工作树打开新会话。DeepSeek Harness 通过插件调用原生文档工具。Codex 和 Claude Code 的启动钩子会提供稳定程序路径，Agent 可通过 shell 运行该程序，加上 `--tools codex` 或 `--tools claude`，从标准输入传入 `{"action":"list"}` 查看当前可用的操作与参数。工具每次调用都核对工作树、宿主和绑定版本。

- **飞书文档**　3.0 支持读取 docx 和知识库中的新版文档，并可创建全文评论或文末批注。在飞书自建应用后台开通用户身份权限 `docx:document`、`wiki:node:read`、`docs:document.comment:create` 和 `offline_access`，发布后登记回调 `http://127.0.0.1:47921/oauth/callback`，在工作台填写 App ID、App Secret 和一份本人可访问的文档。已有 1.0/2.0 绑定可继续读取 docx 正文。要使用知识库和评论，在所选宿主升级绑定至 3.0，并按提示补充授权。
- **Google Drive**　使用启用了 Drive API 的桌面 OAuth 客户端，授权范围为 `drive.metadata.readonly`。Agent 可按名称前缀或文件夹列出文件，也可按 ID 查看名称、类型、修改时间和浏览链接。

先用「用工作台的飞书工具读取〈文档链接〉，返回正文开头的一句话」或「用工作台的 Google Drive 工具列出最多 3 个文件的名称和 ID」验证实际读取。要验证写入，请选择可评论的测试文档，明确要求「在〈测试文档链接〉的文末添加一条‘测试’批注，返回评论 ID、所在段落链接，以及该段是否列出了这条评论」。文末批注定位到最后一个含内容的段落或媒体块。工具返回评论 ID、块位置及飞书在该块上列出评论 ID 的情况。选用飞书 3.0 的成员可以请 Agent 用原回执的 `blockId` 和 `commentId` 核对原位置和当前文末。飞书客户端中的实际展示需在原文档查看。

## 开发

从源码运行需要 Node.js 22.13.0 或更高版本，macOS 应用自带运行环境。

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

发现文件规范见 [`docs/contracts/initiative-app-v1.schema.json`](docs/contracts/initiative-app-v1.schema.json)。Agent Workbench 使用合成 fixture 验证发现、校验和挂载边界；消费项目独立验证自己的静态应用，二者互不构成交叉仓库门禁。

## 打包

```bash
npm run package:mac:arm64
npm run package:mac:x64
npm run package:mac
npm run make
```

`npm run package:mac:arm64` 与 `npm run package:mac:x64` 分别构建并验证单一架构；`npm run package:mac`（也是 `npm run package`）依次构建并验证两种 macOS 架构。每次打包都会覆盖同架构的旧输出，且命令仅在目标 `app.asar` 中的生产源码与当前工作区一致时成功。

本地构建位于 `out/Agent Workbench-darwin-arm64/Agent Workbench.app` 和 `out/Agent Workbench-darwin-x64/Agent Workbench.app`。本地包可以直接打开体验，应用菜单「检查更新…」会说明当前包的更新渠道状态。

### 团队整包发布

成员首次安装与自己 Mac 架构相符的团队签名版。后续从应用菜单检查更新，查看版本说明并在准备好后确认重启。从 OpenSpec GUI 0.7.0 或更早版本首次迁移时，退出旧应用，再手动安装并打开 Agent Workbench。旧更新器按原产品名查找发行包。新应用复用原数据目录、系统凭据身份和已登记宿主的固定入口。项目选用、别名和个人授权保存在同一应用用户目录。

发行机需具备团队的 Developer ID Application 证书、相应私钥，以及通过 `xcrun notarytool store-credentials` 配置的钥匙串凭据。在发行环境设置以下变量。

| 变量 | 内容 |
| --- | --- |
| `OPENSPEC_GUI_UPDATE_URL` | 团队成员可直接读取的固定 HTTPS 基址，可含站点子目录 |
| `OPENSPEC_GUI_SIGN_IDENTITY` | 完整的 Developer ID Application 签名身份名称（含团队 ID） |
| `OPENSPEC_GUI_NOTARY_PROFILE` | 本机 notarytool 钥匙串配置名 |
| `OPENSPEC_GUI_RELEASE_NOTES` | 成员检查新版时看到的更新说明 |
| `OPENSPEC_GUI_RELEASE_WEBROOT` | 发布时对应 HTTPS 基址的静态站点目录，本机或挂载的 POSIX 文件系统，支持硬链接和原子重命名 |

1. 在仓库内更新目录与应用版本，用 `npm run release:mac` 生成两个架构的候选包。脚本解开实际 ZIP，核对包内生产文件、版本、架构、更新源、签名团队与公证票据，并将结果写入 `out/release/<版本>/darwin/<架构>/`。
2. 在相同源码和发行配置下运行 `npm run release:publish`。脚本先放置两个带版本号的 ZIP，经 HTTPS 回读并核对全部 SHA-256 后，逐架构原子替换 `RELEASES.json`。若两个架构的索引切换之间中断，两侧仍各自指向可用包。以同一组候选文件重试即可补齐。机器异常退出留下 `.openspec-gui-release-lock` 时，确认无发布任务后清理该临时目录再重试。
3. 静态站点应让 `RELEASES.json` 每次重新验证缓存，带版本的 ZIP 可长期缓存。使用对象存储时也可以从候选目录先上传两个版本包，经线上核对摘要后再替换两个索引。

## 项目数据

项目注册表保存在本机的 Electron 用户数据目录。目录沿用首次发行的名称 `OpenSpec GUI`，升级后可直接读取。各平台的默认位置如下。

- macOS：`~/Library/Application Support/OpenSpec GUI/projects.json`
- Windows：`%APPDATA%/OpenSpec GUI/projects.json`
- Linux：`~/.config/OpenSpec GUI/projects.json`

注册表使用真实路径去重并原子替换，保留最近完整备份。移除项目只删除注册项，不删除项目文件。

## 审阅后归档

活跃提案的任务和文档详情均提供“归档…”入口。工作台先检查产物与任务、运行结构校验，再展示正式规范的新增、修改或删除差异及完整变更目录的归档位置。没有增量规范或已经同步时，只移动变更目录；有规范更新时，确认按钮显示“同步规范并归档”。未完成任务或产物须逐项明确接受，校验或规则合并失败不能绕过。

“待归档”表示任务状态提示，不代表实现已经验收。GUI 不读取 Agent 会话，也不根据代码或测试推断需求是否完成；用户可以用任意工具处理内容，再回到界面检查。

归档需要本地 CLI 支持带根目录信息的 `status --json`、`list --json`、`validate --json` 和 `archive --json --yes`。GUI 优先解析项目 CLI，在受限的临时文件快照中计算结果，确认前不修改导入项目，确认后仅提交预览中的规范结果与目录移动。CLI 不可用、仅支持状态查询、自定义工作流无法在快照中复现，或项目指向外部 standalone store 时，浏览仍可用，归档入口会说明原因。开发环境可用 `node --test test/archive.test.js` 验证 CLI 兼容性。

从 Finder 启动时也会发现 nvm、Homebrew 和常见用户目录中的全局 CLI，无需先从终端启动应用。查询与归档共用发现逻辑，优先级为项目 CLI、显式配置、随应用提供的 CLI、`PATH`，最后检查上述安装位置；nvm 的多个安装按版本从新到旧查找。Node 脚本优先使用同目录的 Node，其次使用 `PATH` 中的 Node，均不可用时使用应用自身的 Node 运行时。

预览后相关文件、CLI、目录身份或归档日期变化，旧确认即失效；目标已存在时不会覆盖。写入期间暂时阻止切换或移除项目，并等待提交结束再退出应用。首期不提供批量归档、跳过校验或撤销成功归档。

Agent 可从「宿主接入」复制共享钩子程序的路径，在已登记的项目工作树内调用该程序。程序接受 `--archive preflight <change>`，输出与桌面相同的规范差异、警告、目标和 `reviewFingerprint`。向用户展示预检结果并取得归档授权后，调用 `--archive commit <change> --review <reviewFingerprint>`。每项已接受的警告追加一个 `--accept-warning <id>`。受控入口会在临时快照中用项目的 OpenSpec CLI 重新计算归档结果，然后核对审阅指纹，通过与桌面相同的写入事务提交已确认的内容。写入中断后命令返回非零退出码，结果中给出恢复状态和操作记录位置。选用「变更验证」或「归档前同步规范」的宿主会在项目上下文中收到入口路径。

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
