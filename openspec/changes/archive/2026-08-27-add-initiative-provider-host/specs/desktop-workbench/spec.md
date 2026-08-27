## ADDED Requirements

### Requirement: 项目工作台必须并列承载独立 Change 与普通 Initiative

系统 SHALL 在同一项目外壳中为 OpenSpec 执行台和 Initiative 提供互不替代的主要入口。OpenSpec 执行台 MUST 继续展示全部活动 Change 的官方状态；Initiative 入口 MUST 展示普通专项的通用摘要和详情。

#### Scenario: 从执行台进入 Initiative

- **WHEN** 当前项目同时包含活动 Change 和普通 Initiative
- **THEN** 用户可以分别进入执行台或 Initiative 列表
- **AND** 两个入口共享当前项目、主题、刷新和全局导航上下文

#### Scenario: 从 Initiative 返回执行台

- **WHEN** 用户在普通 Initiative 详情中选择顶层执行台入口
- **THEN** 系统返回当前项目的完整 Change 状态总览
- **AND** 不启动新的应用窗口、浏览器页面或项目服务

#### Scenario: Initiative 状态异常

- **WHEN** 当前项目的一个 Initiative 数据无效
- **THEN** 工作台在 Initiative 范围内显示异常状态
- **AND** 执行台、规范、归档、项目管理和其他 Initiative 继续正常工作
