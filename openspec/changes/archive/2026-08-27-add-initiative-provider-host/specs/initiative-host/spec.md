## Purpose

为 OpenSpecGUI 提供项目无关且受隔离的 Initiative 宿主，使项目能够用通用声明组织相关 Change 和成果，同时保持官方 OpenSpec Change 完整可见。

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
- **AND** 不要求项目创建 Initiative 清单或安装 Provider

#### Scenario: Initiative 解析失败

- **WHEN** 某个 Initiative 无效或引用未知 Change
- **THEN** 系统为该 Initiative 显示受控诊断
- **AND** 不得隐藏、重分类或阻止读取任何官方 Change、Spec 或 Archive

### Requirement: 普通 Initiative 必须由受信任 Provider 发现并归一化

系统 SHALL 只允许应用静态注册的 Generic Provider 从固定 `initiative.yaml` 声明发现普通 Initiative。Provider MUST 返回统一基础描述；仓库内容 MUST NOT 注册或注入可执行 Provider 代码、命令、模块、HTML 或外部 URL。

#### Scenario: 发现有效普通 Initiative

- **WHEN** 固定位置存在版本受支持且边界有效的普通 Initiative 声明
- **THEN** 系统把其通用摘要加入 Initiative 列表
- **AND** 不执行项目代码或猜测未声明的数据

#### Scenario: Provider 发现结果不确定

- **WHEN** 发现结果包含重复 Initiative ID、项目外路径或无法稳定复现的候选
- **THEN** 系统拒绝不确定结果并记录诊断
- **AND** 不影响其他 Initiative 或官方 Change

### Requirement: Initiative 数据访问必须经过版本化安全请求

系统 MUST 只允许 renderer 使用包含当前 `projectId`、workspace revision、`providerId`、`initiativeId` 和稳定成果 ID 的命名操作读取普通 Initiative 数据。主进程 MUST 重新校验当前项目、Initiative、资源白名单、真实路径和 revision；不得向 renderer 暴露任意路径、目录枚举、进程执行或通用网络代理。

#### Scenario: 使用稳定成果 ID 读取文档

- **WHEN** 通用详情请求当前 Initiative 已登记的成果 ID
- **THEN** 主进程解析并验证其真实路径后返回受控内容
- **AND** renderer 不需要也不能提交本机绝对路径

#### Scenario: 使用过期 workspace revision 请求数据

- **WHEN** 项目已经切换或刷新，而旧页面提交旧 revision 的请求
- **THEN** 系统拒绝旧结果并要求重新加载当前 Initiative
- **AND** 旧项目内容不得覆盖当前界面

#### Scenario: 请求未登记资源或执行能力

- **WHEN** 页面请求未知成果 ID、任意路径、命令、环境变量或网络代理
- **THEN** 系统拒绝请求且不返回相关内容

### Requirement: Initiative 必须随项目变化受控刷新并保持深链接

系统 SHALL 将普通 Initiative 的固定声明和已登记成果纳入当前项目变化检测，并在输入实际变化后使对应快照失效和重新加载。刷新 MUST 保留稳定的项目、Initiative 与成果深链接；失败时 MUST 显示当前数据已失效或刷新失败。

#### Scenario: Initiative 权威输入变化

- **WHEN** 外部工具修改普通 Initiative 声明或已登记成果
- **THEN** 系统检测变化并重新加载该 Initiative
- **AND** 保留有效的通用页面位置

#### Scenario: 刷新产生无效 Initiative

- **WHEN** 最新输入无法通过 Generic Provider 校验
- **THEN** 系统显示刷新失败和 Provider 诊断
- **AND** 明确区分上一版可读数据与当前无效输入

#### Scenario: 恢复 Initiative 深链接

- **WHEN** 用户打开包含项目、Initiative 和稳定成果 ID 的受支持深链接
- **THEN** 系统选择对应项目并恢复通用页面状态
- **AND** 未知 Initiative 或成果 ID 只产生受控未找到状态
