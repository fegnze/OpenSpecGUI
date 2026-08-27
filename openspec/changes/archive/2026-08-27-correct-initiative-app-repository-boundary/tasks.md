## 1. 清理历史归档

- [x] 1.1 删除只记录消费项目 Provider、专项 UI 或真实兼容结果的 evidence
- [x] 1.2 将 `add-initiative-provider-host` 归档收敛为通用 Host 与 Generic Initiative 历史，移除专项 schema、Provider snapshot、renderer 和业务模型内容
- [x] 1.3 将 `build-multi-project-desktop-app` 归档中的真实来源、路径、样本和验收对象改为仓库内中性合成示例

## 2. 审计工作树边界

- [x] 2.1 保留当前删除旧专项 contracts、Provider、fixture、renderer 和测试的改动，不恢复或重建专项实现
- [x] 2.2 从 HEAD 精确恢复两张无关 Initiative 详情视觉基线，保留通用 Initiative 列表基线变更
- [x] 2.3 审计 README、docs、正式 specs、源码和测试，确保只描述公开 Initiative App 协议并只依赖中性合成 fixture

## 3. 验证与规范同步

- [x] 3.1 运行 `npm test`、语法检查、OpenSpec strict validation 和 `git diff --check`
- [x] 3.2 扫描全部 tracked 文件和当前工作树，确认受限标识仅存在于 correction proposal 的最小审计说明，且没有残留专项模型内容
- [x] 3.3 将 `embedded-initiative-app` delta 智能合并到正式 spec，并再次严格验证正式 specs
