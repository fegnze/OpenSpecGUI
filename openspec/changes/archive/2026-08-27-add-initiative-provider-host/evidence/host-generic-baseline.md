# Initiative Host 与 Generic 基线

## 冻结范围

- 无 Initiative：`empty-specs` UI fixture 保持标准 Changes、Specs 与 Archives 工作流。
- 普通 Initiative：`release-readiness` 使用中性有效清单、一个声明式成果和 `owned` / `related` 关系。
- Provider 失败：`invalid-contract` 固定未知 schema 诊断；单元 fixture 另覆盖崩溃、重复 ID、不稳定结果与未知版本。

## 零回归基线

- 既有 Change 深链接继续归一化为当前受支持路由。
- renderer 继续使用 `app://renderer`、`contextIsolation`、sandbox、无 `nodeIntegration` 与 `connect-src 'none'`。
- 视觉基线覆盖执行台、提案任务/文档、规范、归档、项目菜单、项目管理、Initiative 列表和通用详情。
- 全部官方 Change 始终保留在 `snapshot.changes`；Initiative 关系索引只派生独立范围与冲突诊断。

## Host / Generic 复验

- `npm test`：通用 Host、Generic、安全、E2E 与既有工作流全部通过。
- `npm run check`：JavaScript 语法检查通过。
- `npm run test:visual`：非更新模式通过，未改写无关视觉基线。
- `npm run package`：Electron Forge macOS arm64 打包通过。
- OpenSpec strict validation 与 `git diff --check` 通过。
- 失败 Provider 的 discover 基线与后续 fingerprint 检查保持一致；稳定失败不会触发刷新风暴。
- Initiative 请求统一限制 payload、允许字段、字符串格式和长度，超限输入在进入服务前拒绝。
- Change 关系索引同时识别 active 与 archive 原 ID，但独立 Change 范围只包含 active Change。
- Generic Provider 将含清单校验错误的结果标记为非权威部分结果，仅失败条目回退到带诊断的历史快照。
