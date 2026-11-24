## Context

现有工作台支持 Codex 和 Claude Code。DeepSeek Harness 桌面版在应用内附带 CLI，宿主使用 Cordis 加载 desktop profile 的补丁和插件。

## Goals / Non-Goals

本次覆盖本机桌面会话的一键登记、解除、项目绑定及原生检查。远程会话和 Web profile 独立配置。

## Decisions

- 用应用内 CLI 检测版本。插件随应用放在可被宿主直接导入的目录，引用工作台共享钩子和当前用户数据。
- 在 desktop profile 的用户补丁中加入有独立 ID 的一项。根据本机台账处理重复操作、写入中断、路径变更及外部修改。
- 使用稳定宿主 ID `dsh` 存储项目绑定。`system-prompt/assemble` 提供上下文，`tools.guard` 检查本机工作树中已绑定的规则，交由宿主继续作出权限判断。
- 在线连接验证与宿主暴露的工具分别显示。旧版飞书缺陷 Skill 通过显式绑定文件读取该项目的 DSH 设置。

## Risks / Trade-offs

0.x 版宿主的 API 会随次版本变化。本次以本机发布的 0.2.2-rc.5 验收。无法确定工作树映射时跳过项目专属内容，宿主加载状态与工作台文件登记分别验证。
