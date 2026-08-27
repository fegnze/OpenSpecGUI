# Initiative Host 与 Generic 基线

## 冻结范围

- 无 Initiative：既有 `empty-specs` UI fixture 保持标准 Changes、Specs 与 Archives 工作流。
- 普通 Initiative：`release-readiness` 固定有效清单、一个声明式成果和 `owned` / `related` 关系。
- Provider 失败：`invalid-contract` 固定未知 schema 诊断；单元 fixture 另覆盖崩溃、重复 ID、不稳定结果与未知版本。
- WTC Resource Program：`test/fixtures/wtc-resource-program-v1/` 固定 Provider v1 schema、sidecar、canonical input、expected descriptor/overview/artifact index、负例与 source hash；本阶段不注册 WTC Provider。

## 零回归基线

- 旧深链接 `#view=changes` 继续归一化为 `#view=overview`。
- renderer 继续使用 `app://renderer`、`contextIsolation`、sandbox、无 `nodeIntegration` 与 `connect-src 'none'`。
- 既有视觉基线覆盖执行台、提案任务/文档、规范、归档、项目菜单和项目管理；Initiative 新增宽桌面、暗色及 820x640 基线。
- 全部官方 Change 始终保留在 `snapshot.changes`；Initiative 关系索引只派生独立范围与冲突诊断。

## Host / Generic 复验

- `npm test`：41/41 通过，包含旧工作流 E2E 与真实可信 Initiative App 的 mount/update/dispose、错误重试、焦点恢复和项目切换清理。
- `npm run check`：37 个 JavaScript 文件语法检查通过。
- `npm run test:visual`：非更新模式 1/1 通过，未改写视觉基线。
- `npm run package`：Electron Forge macOS arm64 打包通过。
- `npx openspec validate add-initiative-provider-host --strict` 与 `git diff --check` 通过。
- 失败 Provider 的 discover 基线与后续 fingerprint 检查保持一致；稳定失败不会触发条件刷新风暴，历史成功快照以 attention/diagnostic 显式降级。
- Initiative IPC 统一限制总 payload、允许字段、字符串格式和长度；2 MiB 输入在进入服务前拒绝。
- Change 关系索引同时识别 active 与 archive 原 ID，但独立 Change 范围只包含 active Change。
- Initiative 的三处异步 loading 状态使用 `role=status` 与 polite live region；完整 E2E 中的 Initiative 列表、详情及其他核心页面 axe 检查通过。
- Generic Provider 将含清单校验错误的结果标记为非权威部分结果：逐 ID 推进当前有效条目的 last-good 缓存，仅失败条目回退到 attention/stale 历史快照并同时暴露 `INVALID_GENERIC_INITIATIVE`；缺失且未报错的 ID 视为合法删除。状态转换回归覆盖 A1/B1 → stale A1/B2 → stale A1/stale B2，确保 B 不会回退到 B1。
