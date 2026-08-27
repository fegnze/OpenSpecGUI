## Purpose

为 OpenSpecGUI 提供可扩展且受隔离的 Initiative 宿主，使项目能够同时组织普通专项和具有自定义文件模型、发现逻辑及专用界面的复合专项，同时保持官方 OpenSpec Change 完整可见。

## ADDED Requirements

### Requirement: Initiative 必须是 Change 之外的可选项目级对象

系统 SHALL 在当前项目中独立建立 OpenSpec Change 索引和 Initiative 索引。Initiative MUST 只引用官方 Change，不得复制或替代 proposal、design、spec、tasks、sync 与 archive 生命周期；没有主要 Initiative 归属的 Change MUST 继续作为独立 Change 展示。

#### Scenario: 项目同时包含独立 Change 和 Initiative

- **WHEN** 当前项目包含未归属专项的 Change，以及引用其他 Change 的 Initiative
- **THEN** 系统在“全部提案”中展示全部官方 Change
- **AND** 在 Initiative 入口中展示专项
- **AND** 未归属 Change 在独立 Change 范围中保持可达

#### Scenario: 项目不包含 Initiative

- **WHEN** 当前项目只有标准 `openspec/changes` 与 `openspec/specs`
- **THEN** 系统保持既有执行台、规范和归档行为
- **AND** 不要求项目创建 Initiative 清单或安装专用 Provider

#### Scenario: Initiative 解析失败

- **WHEN** 某个 Initiative 无效、引用未知 Change 或缺少对应 Provider
- **THEN** 系统为该 Initiative 显示受控诊断
- **AND** 不得隐藏、重分类或阻止读取任何官方 Change、Spec 或 Archive

### Requirement: 专用 Initiative 必须由受信任 Provider 发现并归一化

系统 SHALL 允许应用内置或显式安装的受信任 Initiative Provider 使用固定、有界的签名发现专用 Initiative。每个 Provider MUST 返回统一的 Initiative 描述，至少包含 `id`、`providerId`、`type`、`title`、`summary`、`status`、`health`、关联 Change ID 与 `presentationMode`；仓库内容 MUST NOT 注册或注入可执行 Provider 代码。

#### Scenario: 专用 Provider 发现自定义复合体

- **WHEN** 一个已安装 Provider 在当前项目中发现其声明的固定文件签名并完成校验
- **THEN** 系统把 Provider 返回的通用摘要加入 Initiative 列表
- **AND** 保留该 Initiative 的专用类型与展示模式

#### Scenario: 项目声明未知 Provider

- **WHEN** Initiative 数据声明的 Provider ID 或契约版本未被当前应用支持
- **THEN** 系统显示 Initiative 的可安全读取基础身份和“缺少 Provider”诊断
- **AND** 不执行项目脚本、Initiative Provider CLI、HTML 或 JavaScript 以尝试加载该 Provider

#### Scenario: Provider 发现结果不确定

- **WHEN** Provider 返回重复 Initiative ID、项目外路径或无法稳定复现的候选集合
- **THEN** 系统拒绝不确定结果并记录 Provider 诊断
- **AND** 不影响其他 Provider 的发现结果

### Requirement: Initiative App 必须在宿主边界内接管专用内容区

系统 SHALL 允许专用 Initiative App 在 OpenSpecGUI 的受控内容区域内提供自己的信息架构和子路由。宿主 MUST 保留项目切换、顶层导航、主题、刷新、错误边界和深链接所有权；专用 App MUST NOT 使用 iframe、独立项目 HTTP 服务或直接 Node/文件系统能力。

#### Scenario: 打开专用 Initiative App

- **WHEN** 用户打开 `presentationMode=custom` 且对应模块可用的 Initiative
- **THEN** 宿主保持应用外壳并在内容区域挂载专用 App
- **AND** 专用 App 可以展示自身页面和内部导航，而不复制项目切换器或启动外部服务

#### Scenario: 专用 App 渲染失败

- **WHEN** 专用 App 在加载或渲染过程中失败
- **THEN** 宿主显示限定于该 Initiative 的错误状态和重试入口
- **AND** 项目导航、独立 Change 和其他 Initiative 保持可用

#### Scenario: 禁止 iframe 回退

- **WHEN** 专用 Initiative 已有浏览器 Dashboard 或本地服务页面
- **THEN** 系统不得通过 iframe、webview 或自动启动项目服务的方式嵌入该页面
- **AND** 专用模块必须消费宿主提供的受控数据接口

### Requirement: Initiative 数据访问必须经过版本化安全请求

系统 MUST 只允许 renderer 使用包含当前 `projectId`、workspace revision、`providerId`、`initiativeId` 和稳定资源 ID 的命名操作读取 Initiative 数据。主进程 MUST 重新校验当前项目、Provider、Initiative、资源白名单、真实路径和 revision；不得向 renderer 暴露任意路径、目录枚举、进程执行或通用网络代理。

#### Scenario: 使用稳定成果 ID 读取文档

- **WHEN** 专用 App 请求当前 Initiative 已登记的成果 ID
- **THEN** 主进程解析并验证其真实路径后返回受控内容
- **AND** renderer 不需要也不能提交本机绝对路径

#### Scenario: 使用过期 workspace revision 请求数据

- **WHEN** 项目已经切换或刷新，而专用 App 提交旧 revision 的请求
- **THEN** 系统拒绝旧结果并要求重新加载当前 Initiative
- **AND** 旧项目内容不得覆盖当前界面

#### Scenario: 请求未登记资源或执行能力

- **WHEN** 专用 App 请求未知成果 ID、任意路径、命令、环境变量或网络代理
- **THEN** 系统拒绝请求且不返回相关内容

### Requirement: Initiative 必须随项目变化受控刷新并保持深链接

系统 SHALL 将 Provider 声明的有界输入纳入当前项目变化检测，并在输入实际变化后使对应 Initiative 快照失效和重新加载。刷新 MUST 保留稳定的项目、Initiative、专用子路由和成果深链接；失败时 MUST 显示当前数据已失效或刷新失败，不得把旧数据冒充为当前权威状态。

#### Scenario: Initiative 权威输入变化

- **WHEN** 外部工具修改 Provider 已声明的 Initiative 输入
- **THEN** 系统检测变化并重新加载该 Initiative
- **AND** 保留用户当前专用页面、筛选和稳定成果位置

#### Scenario: 刷新产生无效 Initiative

- **WHEN** 最新输入无法通过 Provider 校验
- **THEN** 系统显示刷新失败和 Provider 诊断
- **AND** 明确区分上一版可读数据与当前无效权威输入

#### Scenario: 恢复 Initiative 深链接

- **WHEN** 用户打开包含项目、Provider、Initiative 和专用子路由的受支持深链接
- **THEN** 系统选择对应项目并恢复专用页面状态
- **AND** 未知 Provider、Initiative、路由或成果 ID 只产生受控未找到状态
