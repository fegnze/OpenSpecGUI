# OpenSpec GUI

OpenSpec GUI 是一个独立、无端口的本地桌面工作台。它集中管理多个项目，直接读取每个项目的 `openspec/`，并以提案状态首页和 task 优先详情展示 OpenSpec 内容。

## 功能

- 添加单个项目，或在父目录内扫描多个 OpenSpec 项目
- 在侧栏快速切换项目，维护失效路径、重新关联或移除注册项
- 按进行中、待归档、需要处理查看提案状态
- 在提案详情首屏查看 task 阶段、当前任务和精确分段进度
- 阅读 proposal、design、tasks、delta specs、正式 specs 和归档记录
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
```

## 打包

```bash
npm run package
npm run make
```

未签名的 macOS `.app` 与 `.zip` 产物位于 `out/`。签名、公证与自动更新不在首版范围内。

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
- Electron 权限请求默认拒绝，外部窗口与非 `app://` 导航默认拒绝
- OpenSpec CLI 使用参数数组执行，固定项目 cwd，并设置超时与输出上限

## OpenSpec

当前实现由 change `build-multi-project-desktop-app` 管理：

```bash
openspec status --change build-multi-project-desktop-app
openspec instructions apply --change build-multi-project-desktop-app --json
```

原始 Workbench 暂时保留在 `/Users/ghost/work/WorldTourCasino/tools/openspec-workbench`，只有后续独立 OpenSpec change 才能决定清理。
