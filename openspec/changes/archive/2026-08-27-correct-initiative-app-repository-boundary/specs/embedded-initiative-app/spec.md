## MODIFIED Requirements

### Requirement: 宿主不得包含专项数据适配器或重建界面

系统 MUST 将 embedded Initiative 的宿主契约限制为基础身份、静态应用根、View 边界、生命周期、不透明内部位置和预定义宿主动作。宿主仓库 MUST NOT 为任何消费项目复制业务 schema、解析内部实体关系、读取专项正文、注册专项 renderer App，或保存消费项目专属知识与兼容性资产。

#### Scenario: 接入新的复合专项

- **WHEN** 任意项目提供受支持的独立应用声明
- **THEN** 系统使用同一发现与承载机制打开其自有应用
- **AND** 不新增该专项的数据 Provider、模型镜像、CSS 或页面组件

#### Scenario: 专项增加内部能力

- **WHEN** 独立 Dashboard 增加页面、状态或成果类型且保持静态应用契约兼容
- **THEN** OpenSpecGUI 无需修改即可显示新能力
- **AND** 专项内部变化只由专项自己的测试与发布流程负责

#### Scenario: 通用宿主进行自动化验证

- **WHEN** OpenSpecGUI 验证独立应用发现、挂载、导航、刷新或销毁
- **THEN** 测试只使用仓库内中性合成的通用 Initiative App fixture
- **AND** OpenSpecGUI 不保存消费项目的模型、页面、截图、专项断言或跨仓库测试依赖

#### Scenario: 审计通用宿主仓库

- **WHEN** 维护者扫描生产代码、正式规范、fixture、测试、文档和历史归档
- **THEN** 除记录清理原因的最小 correction 审计说明外，不存在消费项目名称、标识、绝对路径、专属 schema、Provider、renderer、测试数据或兼容性证据
- **AND** 历史示例只使用中性合成项目和仓库内资源
