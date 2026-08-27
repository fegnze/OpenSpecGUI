# OpenSpec GUI

OpenSpec GUI 是一个独立、无端口的本地桌面工作台。它集中管理多个项目，直接读取每个项目的 `openspec/`，并以提案状态首页和 task 优先详情展示 OpenSpec 内容。

## 功能

- 添加单个项目，或在父目录内扫描多个 OpenSpec 项目
- 在侧栏快速切换项目，维护失效路径、重新关联或移除注册项
- 按进行中、待归档、需要处理查看提案状态
- 在提案详情首屏查看 task 阶段、当前任务和精确分段进度
- 阅读 proposal、design、tasks、delta specs、正式 specs 和归档记录
- 在同一项目内并列管理独立 OpenSpec Changes 与跨 Change 的 Initiative/专项
- 自动发现 `openspec/initiatives/<id>/initiative.yaml` 普通专项，并以通用页面展示关联 Change 与登记成果
- 通过内置 `wtc-resource-program-v1` Provider 展示 Resource Program 型专项，支持 Program 治理、归档任务回顾、四种成果阅读视角和 Mermaid 原位图形
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

WTC Resource Program 的真实仓库兼容测试默认跳过，不会把外部路径写死到本仓库。需要执行时显式提供项目路径：

```bash
OPENSPEC_GUI_WTC_PROJECT=/path/to/WorldTourCasino \
  node --test test/wtc-resource-program-compatibility.test.js
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
- Initiative Provider 与 Initiative App 只能由 OpenSpec GUI 静态注册；项目声明不能加载脚本、命令、模块、HTML、iframe、URL 或网络代理
- 专用 App 只能按稳定 ID 读取当前 Provider 白名单内的成果，revision 与 source hash 变化后旧请求立即失效
- Mermaid 使用本地固定版本、strict 模式、受控 SVG 校验和作用域主题样式，不连接 CDN
- Electron 权限请求默认拒绝，外部窗口与非 `app://` 导航默认拒绝
- OpenSpec CLI 使用参数数组执行，固定项目 cwd，并设置超时与输出上限

## OpenSpec

OpenSpec 生命周期以仓库当前 active change 为准。查询与验证示例：

```bash
openspec list
openspec validate --all --strict --no-interactive
```
