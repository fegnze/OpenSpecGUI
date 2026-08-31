# OpenSpec GUI

OpenSpec GUI 是一个独立、无端口的本地桌面工作台。它集中管理多个项目，直接读取每个项目的 `openspec/`，并以提案状态首页和 task 优先详情展示 OpenSpec 内容。

## 功能

- 添加单个项目，或在父目录内扫描多个 OpenSpec 项目
- 在侧栏快速切换项目，维护失效路径、重新关联或移除注册项
- 按进行中、待归档、需要处理查看提案状态
- 在提案详情首屏查看 task 阶段、当前任务和精确分段进度
- 阅读 proposal、design、tasks、delta specs、正式 specs 和归档记录
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
