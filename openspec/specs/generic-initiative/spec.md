# Generic Initiative Specification

## Purpose

为不需要自定义文件模型或专用界面的 Initiative 提供稳定、可移植的声明式组织方式，使多个仓库能够用同一份清单表达专项目标、Change 归属、成果和健康状态。

## Requirements

### Requirement: 普通 Initiative 必须使用标准清单自动发现

系统 SHALL 只从 `openspec/initiatives/<initiative-id>/initiative.yaml` 发现普通 Initiative。目录名与清单 ID MUST 一致，清单版本 MUST 受支持，清单中的引用和成果路径 MUST 保持在当前项目的 `openspec` 根内；普通 Initiative 不得声明 renderer 模块、脚本、命令或外部服务。

#### Scenario: 发现有效普通 Initiative

- **WHEN** 标准 Initiative 目录包含版本受支持、ID 一致且引用有效的 `initiative.yaml`
- **THEN** 系统自动把它加入当前项目的 Initiative 列表
- **AND** 其展示模式为通用页面

#### Scenario: 标准清单包含越界路径

- **WHEN** `initiative.yaml` 引用绝对路径、父目录、符号链接目标或当前 `openspec` 根之外的文件
- **THEN** 系统拒绝该引用并显示受控诊断
- **AND** 不返回目标内容

#### Scenario: 普通 Initiative ID 冲突

- **WHEN** 同一项目中两个普通 Initiative 声明相同 ID，或同一候选被多个 Provider 歧义匹配
- **THEN** 系统不得静默选择其中一个
- **AND** 将冲突标记为需要处理，同时保持其他 Initiative 和 Change 可用

### Requirement: Initiative 与 Change 必须使用明确的关系语义

标准清单 SHALL 使用 `owned` 或 `related` 关系引用官方 Change。`owned` 表示 Change 主要由该 Initiative 组织，`related` 只表达关联且不改变 Change 的独立性；没有任何有效 `owned` 关系的 Change MUST 被确定性归类为独立 Change。一个 Change 被多个 Initiative 同时声明为 `owned` 时，系统 MUST 报告归属冲突而不得任意选择。

#### Scenario: 计算独立 Change

- **WHEN** 一个官方 Change 没有被任何有效 Initiative 以 `owned` 关系引用
- **THEN** 系统将其列入独立 Change 范围
- **AND** `related` 引用不改变该结论

#### Scenario: Change 存在唯一归属

- **WHEN** 一个官方 Change 只被一个有效 Initiative 以 `owned` 关系引用
- **THEN** 系统在 Initiative 详情中展示该 Change 的主要归属
- **AND** 该 Change 仍保留在“全部提案”中

#### Scenario: Change 存在多重归属

- **WHEN** 两个或更多 Initiative 同时以 `owned` 关系引用同一 Change
- **THEN** 系统显示归属冲突诊断
- **AND** 不将该 Change 从官方 Change 索引中删除或隐藏

### Requirement: 普通 Initiative 必须使用通用详情页

系统 SHALL 以统一页面展示普通 Initiative 的身份、目标、状态、健康诊断、关联 Change 和已登记成果。通用页面 MUST 只消费已校验的描述和稳定成果 ID，不得因为清单内容注入 HTML、脚本或任意路径读取。

#### Scenario: 阅读普通 Initiative

- **WHEN** 用户打开有效普通 Initiative
- **THEN** 通用详情提供概览、关联 Changes 与成果入口
- **AND** 用户无需安装项目专用模块

#### Scenario: 引用的 Change 或成果失效

- **WHEN** 最新项目状态中某个 Change 或成果引用不再有效
- **THEN** 通用详情显示限定于该引用的诊断
- **AND** 其他有效内容保持可读
