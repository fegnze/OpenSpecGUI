## MODIFIED Requirements

### Requirement: 导入包含 OpenSpec 的项目
系统 SHALL 允许用户选择本地项目根目录，将有效的普通 Git 工作树、Git worktree 或直接包含可读 `openspec/` 的既有项目加入工作台。OpenSpec 可用性 SHALL 独立于 Git 项目登记。

#### Scenario: 导入有效项目根目录
- **WHEN** 用户选择的目录直接包含可读的 `openspec/` 子目录
- **THEN** 系统将该目录注册为项目并切换到该项目，继续兼容没有 Git 元数据的既有 OpenSpec 项目

#### Scenario: 导入普通 Git 工作树或 worktree
- **WHEN** 用户选择一个有效的 Git 工作树或 linked worktree 根目录，该目录没有可读的 `openspec/`
- **THEN** 系统登记并打开该项目，将 OpenSpec 标为不可用

#### Scenario: 所选目录不是 OpenSpec 项目
- **WHEN** 用户选择的目录没有可读的 `openspec/`，也不是有效的 Git 工作树根目录
- **THEN** 系统不写入项目注册表，并说明没有发现有效的 Git 或 OpenSpec 项目

### Requirement: 扫描目录发现候选项目
系统 SHALL 允许用户选择一个父目录，在有界深度内发现符合登记条件的普通 Git 工作树、Git worktree 和既有 OpenSpec 项目，并在用户确认后导入所选候选项。

#### Scenario: 批量发现多个项目
- **WHEN** 用户扫描的父目录下同时存在有效的普通 Git 仓库、linked worktree 和 OpenSpec 项目
- **THEN** 系统列出符合条件的候选项目及其路径，分别标记 OpenSpec 可用性，并允许用户选择一个或多个项目导入

#### Scenario: 扫描忽略高成本目录和符号链接
- **WHEN** 扫描路径包含符号链接、`.git`、`node_modules` 或构建产物目录
- **THEN** 系统不进入这些目录，且扫描保持在约定的最大深度内

### Requirement: 项目身份去重
系统 MUST 依据规范化后的真实项目根路径识别同一项目，避免通过相对路径、别名或重复扫描产生多个注册项。同一 Git 仓库中真实路径不同的工作树 MUST 保有可分别选择的注册项。

#### Scenario: 重复导入已注册项目
- **WHEN** 用户导入的目录与某个已注册项目解析到同一真实路径
- **THEN** 系统保留单一注册项并切换到已有项目

#### Scenario: 登记同一仓库的两个工作树
- **WHEN** 用户分别导入同一 Git 仓库的主工作树和位于另一目录的 linked worktree
- **THEN** 系统保留两个注册项，可以分别选择，每个项目视图使用该工作树当前检出的内容

### Requirement: 快速切换当前项目
系统 SHALL 在主要导航区域持续提供项目切换入口，并确保任一时刻只有一个当前项目驱动项目范围的工作台内容。

#### Scenario: 切换项目
- **WHEN** 用户从项目切换器选择另一已注册且有效的项目
- **THEN** 系统清除上一项目当前的选择和内容，加载新项目的能力绑定与钩子记录
- **AND** 当新项目具有可用 OpenSpec 时，用户可以查看新项目的提案与规范

### Requirement: 修复失效项目路径
系统 SHALL 明确标识已移动、已卸载或不可读的项目，并允许用户为该注册项重新选择路径或将其移除。有效 Git 工作树中 OpenSpec 的缺失或不可读 MUST 仅影响该项目的 OpenSpec 可用性。

#### Scenario: 启动时项目路径失效
- **WHEN** 已注册项目的目录不再可读，或该目录不再符合 Git 与既有 OpenSpec 项目的任一登记条件
- **THEN** 系统保留该注册项并显示失效状态，不因单个失效项目阻止其他项目使用

#### Scenario: 重新关联项目路径
- **WHEN** 用户为失效项目选择一个有效的新路径
- **THEN** 系统保留原注册项身份并更新其路径后加载项目内容

#### Scenario: 已登记 Git 项目的 OpenSpec 可用性变化
- **WHEN** 同一有效 Git 工作树的 `openspec/` 在切换检出版本或刷新后从可读变为缺失或不可读，或恢复可读
- **THEN** 系统更新该工作树的 OpenSpec 可用状态，保留登记和项目能力绑定
