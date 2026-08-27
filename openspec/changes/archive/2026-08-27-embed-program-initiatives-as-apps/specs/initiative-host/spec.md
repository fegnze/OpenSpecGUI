## MODIFIED Requirements

### Requirement: 专用 Initiative 必须由受信任 Provider 发现并归一化

系统 SHALL 同时支持普通 Initiative 的受信任声明解析和独立 Initiative App 的固定 manifest 发现。独立应用只归一化 `id`、`type`、`title`、`summary`、健康诊断、关联 Change ID 与 `presentationMode` 等基础身份；仓库内容不得注册宿主 renderer 模块、Provider 代码、命令或外部 URL。manifest 的静态应用根只在用户打开应用后通过受限本地协议读取，发现阶段不得加载页面或执行项目代码。

#### Scenario: 专用 Provider 发现自定义复合体

- **WHEN** 固定位置存在版本受支持且边界有效的 `initiative-app.json`
- **THEN** 系统把其基础身份加入 Initiative 列表并保留 `presentationMode=embedded-app`
- **AND** 不解析该专项的状态、工作分解、门禁、成果或页面数据

#### Scenario: 项目声明未知 Provider

- **WHEN** Initiative App manifest 的版本或 presentation 未被当前应用支持
- **THEN** 系统显示可安全读取的基础身份和“不支持此应用”诊断
- **AND** 不猜测专项数据，也不加载项目 HTML

#### Scenario: Provider 发现结果不确定

- **WHEN** 发现结果包含重复 Initiative ID、项目外路径、符号链接或无法稳定复现的候选
- **THEN** 系统拒绝不确定结果并记录诊断
- **AND** 不影响普通 Initiative、其他独立应用或官方 Change

### Requirement: Initiative App 必须在宿主边界内接管专用内容区

系统 SHALL 允许独立 Initiative App 在 OpenSpecGUI 的受控内容区域内以独立原生渲染视图提供自己的完整信息架构和路由。宿主 MUST 保留项目切换、顶层导航、返回、刷新、错误边界和视图生命周期；独立 App MUST 保留自己的 DOM、CSS、数据模型和内部导航。系统 MUST NOT 通过 iframe、宿主 DOM 模块或专项 renderer 重建已有应用。

#### Scenario: 打开专用 Initiative App

- **WHEN** 用户打开 `presentationMode=embedded-app` 且声明与静态入口有效的 Initiative
- **THEN** 宿主保持应用外壳并在内容占位区挂载独立原生视图
- **AND** 视图加载专项自己的应用入口，不复制项目切换器或专项 UI 到宿主 renderer

#### Scenario: 专用 App 渲染失败

- **WHEN** 独立 App 在文件校验、加载或渲染过程中失败
- **THEN** 宿主显示限定于该 Initiative 的错误状态和重试入口
- **AND** 项目导航、独立 Change 和其他 Initiative 保持可用

#### Scenario: 禁止 iframe 回退

- **WHEN** 专项已提供可独立运行的本地 Dashboard
- **THEN** 系统直接加载该项目自有应用
- **AND** 不要求专项另行实现 OpenSpecGUI Provider snapshot、成果 IPC 或宿主组件

### Requirement: Initiative 数据访问必须经过版本化安全请求

普通 Initiative 的宿主 renderer 数据读取 MUST 继续使用当前项目、workspace revision 和稳定资源 ID 的命名请求。独立 Initiative App MUST 在隔离视图中通过受限本地应用协议读取自身静态内容，宿主不得向其暴露通用路径、目录枚举、环境变量、命令执行、宿主 IPC 或网络代理，也不得为其提供项目专用数据接口。

#### Scenario: 使用稳定成果 ID 读取文档

- **WHEN** 普通 Initiative 请求当前 revision 已登记的成果 ID
- **THEN** 主进程重新校验当前项目、资源白名单和真实路径后返回内容
- **AND** renderer 不提交本机绝对路径

#### Scenario: 请求未登记资源或执行能力

- **WHEN** embedded App 尝试调用宿主 preload、任意 IPC、路径读取或通用网络代理
- **THEN** 系统拒绝请求且不返回相关内容
- **AND** App 只能使用自身已验证本地协议 origin 的页面能力

#### Scenario: 使用过期 workspace revision 请求数据

- **WHEN** 项目已经切换或应用会话已销毁，而旧异步结果随后到达
- **THEN** 系统拒绝旧结果且不恢复旧视图
- **AND** 旧项目内容不得覆盖当前界面

### Requirement: Initiative 必须随项目变化受控刷新并保持深链接

系统 SHALL 继续刷新普通 Initiative 的受控输入，并 SHALL 对独立 Initiative App 的 manifest 与静态应用根执行有界文件指纹检查而不解析专项内部模型。刷新 MUST 保留稳定的项目、Initiative 和不透明应用内相对 URL；失败时 MUST 显示刷新失败，不得把旧页面冒充为当前权威状态。

#### Scenario: Initiative 权威输入变化

- **WHEN** 外部工具修改普通 Initiative Provider 声明的输入
- **THEN** 系统检测变化并重新加载该 Initiative
- **AND** 保留有效的通用页面位置

#### Scenario: 独立应用刷新

- **WHEN** 用户刷新或活动窗口满足 embedded App 的条件刷新策略
- **THEN** 系统在静态应用输出变化后刷新当前独立视图
- **AND** 不执行项目生成器或读取专项权威文件来生成宿主快照

#### Scenario: 刷新产生无效 Initiative

- **WHEN** 最新 manifest、静态应用根或普通 Initiative 输入无法通过校验
- **THEN** 系统显示刷新失败并销毁或隐藏失效的独立视图
- **AND** 不把上一版页面标记为当前权威状态

#### Scenario: 恢复 Initiative 深链接

- **WHEN** 用户打开包含项目、Initiative 和 embedded App 安全相对位置的受支持深链接
- **THEN** 系统选择对应项目并恢复该应用位置
- **AND** 未知 Initiative、外部 origin 或无效相对位置只产生受控未找到状态
