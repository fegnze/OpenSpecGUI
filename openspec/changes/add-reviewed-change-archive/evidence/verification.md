# 归档功能验证

验证日期：2026-10-26（Asia/Shanghai）。实现与检查均在当前仓库完成，写入测试仅使用临时合成项目。

## 已完成

- 活跃 Change 的任务和文档详情均提供“归档…”入口，展示产物与任务检查、逐项警告接受、完整规范差异和目录目标。
- 兼容 CLI 在临时快照中计算结果，确认后只提交已审阅的规范字节及完整 Change 移动；任务统计复用 CLI，覆盖嵌套任务和示例复选框。
- 文件内容、目录身份、CLI 选择与规则内容、日期或目标变化使旧预览失效。主进程校验请求来源、项目、revision 和计划身份，独立 Initiative App 无归档权限。
- 重复提交去重，写入期间阻止项目切换和应用退出；失败时保留备份并尝试安全恢复，重启后只核对实际状态，不自动覆盖文件。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 115 项通过，0 失败，0 跳过 |
| `npm run check` | 49 个 JS 文件语法检查通过 |
| `openspec validate add-reviewed-change-archive --strict --no-interactive` | 通过 |
| `openspec validate desktop-workbench --type spec --strict --no-interactive` | 通过 |
| `npm run test:visual` | 既有工作台关键界面基线通过 |
| 打包源码一致性校验 | arm64 应用内 29 个生产源码文件与工作区一致 |
| 打包版 `test/archive-e2e.test.js` | 3 项通过，覆盖预览及归档、无 CLI 降级、Finder 环境运行项目本地 CLI |
| `git diff --check` | 通过 |

核心测试包含真实 CLI 的新增、修改、重命名、规范退役、无增量及已同步处理。提交测试逐字节核对规范结果，确认二进制附件、元数据及空目录保留；对规范新增、修改、删除和目录移动的 15 个阶段注入失败，验证安全恢复。另覆盖进程中断、保留 mtime 的等长修改、目录替换、外部编辑器保有原文件句柄时的迟到写入、目标碰撞和权限拒绝。

界面已在真实 Electron 中验证宽窗口浅色、820×640 最小窗口深色、键盘取消及焦点恢复，无严重可访问性问题。截图位于仓库 `artifacts/archive-preview-wide-light.png` 与 `artifacts/archive-preview-minimum-dark.png`。

## 本机构建

应用：`out/OpenSpec GUI-darwin-arm64/OpenSpec GUI.app`。

标准双架构打包尝试在 Electron 下载阶段失败，镜像重试长时间无进展后停止。最终以已安装的 Electron 43.4.1 arm64 运行时制作临时 ZIP，使用仓库 `forge.config.js` 的相同打包配置离线构建，并运行 `scripts/verify-package.js --arch arm64`。此构建随后执行上述打包版端到端测试。本次只更新并验证 arm64 构建，现有 x64 输出不代表本次版本。

## 实际限制

- 依赖兼容的 OpenSpec CLI；文件推断仅用于浏览，不能代替归档计算。Finder 环境缺少 Node 时，可用应用自身的 Node 模式运行项目本地 CLI。
- 临时快照是受信 CLI 的文件输入隔离，不是 OS 级任意命令沙箱。外部 standalone store 或无法在快照中复现的自定义工作流会明确拒绝归档。
- 不解释自然语言项目规则，不判断实现是否验收，不支持批量归档或撤销成功归档。
- 不承诺跨文件事务原子性或控制外部编辑器；遇到外部写入冲突时保留内容并呈现恢复状态。
- 未执行当前仓库 Change 的真实归档；本变更保留为完成实现、等待用户验收的活跃 Change。
