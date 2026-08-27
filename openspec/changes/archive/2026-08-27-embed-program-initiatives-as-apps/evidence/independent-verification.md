# Embedded Initiative App 独立验证（Generic-only）

## Verdict

**Accepted**

未发现未关闭的 P1/P2。实现、协议、生命周期、合成测试、公开发现契约和最新文件路径竞态修复均通过；此前唯一 P2 已关闭。

## Findings

无未关闭 findings。

## 已关闭 Finding

### P2-1: 通用仓库曾把真实消费项目的页面等价验收写成自身门禁

- `README.md` 现已发布 `docs/contracts/initiative-app-v1.schema.json` 作为发现文件规范，并明确 OpenSpecGUI 只使用合成 fixture，消费项目验证不构成交叉仓库门禁。
- `docs/TASK_RECOVERY_PROMPT.md` 现已明确独立 App 通用边界只运行仓库内合成 fixture；消费项目自行验证其静态应用，不属于 OpenSpecGUI 验收门禁。
- 两处均不再要求真实项目、原页面等价、消费项目截图或跨仓库验收证据，符合 proposal 与 `embedded-initiative-app` spec 的所有权边界。

## 已通过项

### 通用所有权边界

- 对当前 `src/`、`test/`、`README.md`、active `docs/`、本 Change proposal/design/specs/tasks/evidence 和正式 specs 做文本扫描，未发现消费项目名称、缩写、专项 Provider ID、专项契约或资源专项实现。历史 archive/provenance 文档按复核约定排除。
- 默认 registry 只注册 Generic Initiative Provider 与通用 Embedded Initiative App Provider；宿主不持有消费项目 schema、模型、成果解析器、renderer App、页面依赖或业务断言。
- 独立应用只从固定深度的 `openspec/<collection>/<id>/initiative-app.json` 发现。manifest 只提供基础身份、`webRoot`、`entry` 和静态宿主动作映射；发现阶段不执行项目代码。
- 通用公开契约 `docs/contracts/initiative-app-v1.schema.json` 的 `$id`、manifest `schemaVersion`、`embedded-app` presentation 和允许动作与运行时协议常量一致。
- `test/embedded-initiative-app.test.js` 与 `test/e2e.test.js` 只使用临时目录中的合成项目和合成静态 App，不含外部仓库路径或消费项目 fixture。

### 文件描述符与路径修复

- `readRegularFile()` 使用 `O_NOFOLLOW` 打开文件，对打开句柄执行 `fstat`，并在读取前后分别复验无符号链接路径链、realpath、目录链身份及目标 `dev/ino`。
- 聚焦合成竞态复验覆盖两种旧攻击窗口：中间目录替换为根外符号链接后保持替换，以及打开根外文件后立即恢复原目录。前者以“拒绝符号链接路径”拒绝，后者以“打开文件与已验证路径不一致”拒绝，均未返回根外内容。
- fingerprint/discover 与 `prepareApp(includeContent=true)` 共同经过 `readStaticSnapshot()` 和同一个 `readRegularFile()` 读取边界。

### 通用协议、View 与生命周期

- custom protocol 只提供当前 instance 内存快照中的已知静态文件，拒绝坏编码、点段、编码斜杠、反斜杠、NUL、未知 authority、未允许 method 和未知 MIME。
- `openspec.open-change` 是静态动作 registry 中的通用动作，只接受当前 instance、当前 project/revision、固定 JSON 结构和合法 Change ID，并重新解析官方 active/archive Change 索引。
- `WebContentsView` 使用非持久独立 session，无 preload、Node 或通用 IPC，启用 sandbox、context isolation 与 web security；权限、下载、新窗口、外部网络和跨 instance 导航被拒绝。
- mount/dispose、generation、边界裁剪、隐藏、焦点返回、崩溃和 stale result 均有合成测试覆盖。

## 验证记录

- 首轮 `node --test test/embedded-initiative-app.test.js test/e2e.test.js`：13/13 通过；全部输入均为仓库内合成 fixture。
- P2 关闭后聚焦运行 `node --test test/embedded-initiative-app.test.js`：12/12 通过，包含公开发现契约与运行时协议版本一致性测试。
- 公开 schema 静态一致性复验：`$id`、`$schema` const、manifest version 和允许动作均与运行时导出一致。
- `npm run check`：38 个 JavaScript 文件语法检查通过。
- `npx openspec validate embed-program-initiatives-as-apps --strict --no-interactive`：通过。
- `git diff --check`：通过。

## 复核范围

本轮及 P2 关闭复验均未访问任何真实消费项目，未读取或比较截图，未做像素级、页面等价或消费项目业务验收。除本证据文件外，独立验证者未修改 tasks 或实现。
