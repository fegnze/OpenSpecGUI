## ADDED Requirements

### Requirement: 提供用户审阅后的命名管理操作
系统 SHALL 在活跃 Change 详情提供归档入口，允许用户基于文件检查和结果预览主动完成归档。系统 MUST 保持浏览能力独立于写操作，MUST NOT 因用户查看页面、任务全部完成或应用刷新而自动归档。

#### Scenario: 从活跃 Change 详情发起归档
- **WHEN** 用户在任务视图或上下文文档视图中查看一个活跃 Change
- **THEN** 用户可从一致的详情操作入口发起归档检查，且确认前不会修改项目文件

#### Scenario: 状态提示不等于归档授权
- **WHEN** 工作台将某个 Change 显示为待归档
- **THEN** 界面将其解释为任务状态提示，仍要求用户检查、审阅并确认后才执行归档

#### Scenario: 查看正式规范或归档记录
- **WHEN** 用户阅读正式规范或已有归档记录
- **THEN** 系统不展示可执行的活跃 Change 归档操作，既有阅读、搜索和复制功能继续可用

## MODIFIED Requirements

### Requirement: 限制本地文件访问范围
系统 MUST 仅允许渲染界面通过明确命名并校验的操作读取当前注册项目中的 OpenSpec 内容或提交用户已审阅确认的 Change 归档，且 MUST NOT 向渲染环境暴露任意文件系统、通用写入或进程执行能力。归档请求 MUST 绑定当前项目和预览结果，独立 Initiative App MUST NOT 获得归档写入权限。

#### Scenario: 请求当前项目之外的文档
- **WHEN** 渲染界面提交的文档路径解析到当前 OpenSpec 根目录之外
- **THEN** 系统拒绝请求且不返回目标文件内容

#### Scenario: Markdown 包含可执行内容
- **WHEN** 被读取的 Markdown 包含脚本、事件处理器或不受信任的外部资源
- **THEN** 系统以不可执行的安全内容呈现，不运行其中代码

#### Scenario: 提交伪造的归档范围
- **WHEN** 渲染界面提交任意文件路径、文件内容、执行命令或其他项目的归档计划
- **THEN** 系统拒绝请求，且只允许由主进程校验并保存的当前项目归档计划执行

#### Scenario: 独立专项应用请求归档
- **WHEN** 独立 Initiative App 或不受信任的页面尝试调用归档操作
- **THEN** 系统拒绝调用，且不扩大专项应用的既有权限

### Requirement: 兼容不同项目的 OpenSpec 状态来源
系统 SHALL 优先使用项目可用的 OpenSpec CLI 获取结构化状态，并在 CLI 不可用或不兼容时通过只读文件解析提供可用的提案、任务和规范视图。系统 SHALL 独立检查归档所需的 CLI 能力；能够查询状态 MUST NOT 被视为能够安全归档，文件推断 MUST NOT 代替归档写入能力。

#### Scenario: 项目 CLI 可用
- **WHEN** 当前项目可解析到兼容的 OpenSpec CLI
- **THEN** 系统使用其结构化结果并展示对应状态

#### Scenario: 项目 CLI 不可用
- **WHEN** 当前项目无法解析到兼容的 OpenSpec CLI
- **THEN** 系统回退到文件推断并明确标识数据来源或受限能力

#### Scenario: CLI 仅支持浏览所需能力
- **WHEN** CLI 可以查询提案状态，但不支持可靠的归档计算或结果预览
- **THEN** 工作台继续展示内容，归档入口说明不可用原因，并且不通过简化目录移动绕过规范同步检查
