## Why

团队成员也使用 DeepSeek Harness 桌面版。工作台需要为这台宿主提供与其他宿主一致的项目选用与可逆接入入口，并遵循它自己的配置和工具权限机制。

## What Changes

- 在「宿主接入」检测 DeepSeek Harness 桌面版，预览并一键登记或解除本机 Cordis 插件。
- 在「能力绑定」按工作树和 DeepSeek Harness 保存选用项及其个人设置。
- 在受支持的本机工作目录中，通过原生上下文和工具检查接口运行工作台规则。

## Capabilities

### New Capabilities

- `deepseek-harness-integration`：DeepSeek Harness 桌面宿主接入及项目绑定。

### Modified Capabilities

## Impact

涉及 Electron 主进程、项目绑定、独立钩子、应用打包和桌面 profile 的用户补丁。
