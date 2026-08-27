# Embedded Initiative App Specification

## Purpose

定义 OpenSpecGUI 对项目自有独立 Initiative 应用的通用发现、本地静态加载、原生视图承载和隔离契约，使复杂专项保留完整程序边界而不要求宿主复制其数据模型或用户界面。

## Requirements

### Requirement: 独立 Initiative 应用必须通过固定声明发现

系统 SHALL 只从固定深度的 `openspec/<collection>/<initiative-id>/initiative-app.json` 发现独立应用，并 MUST 排除官方 Change、Spec、Archive 等保留目录。声明 MUST 包含受支持版本、与目录一致的 ID、类型、标题、摘要、项目内静态应用根和首页；发现过程 MUST NOT 执行项目代码、导入项目模块或读取专项内部模型。

#### Scenario: 发现不同类别的独立专项

- **WHEN** 项目在不同非保留 collection 下包含多个有效 `initiative-app.json`
- **THEN** 系统以稳定顺序列出这些 Initiative
- **AND** 不要求宿主预先知道各专项的内部目录结构或数据 schema

#### Scenario: 声明无效或发生冲突

- **WHEN** 声明版本未知、ID 不一致、路径越界、使用符号链接或与其他 Initiative ID 冲突
- **THEN** 系统显示受控诊断且不加载该应用
- **AND** 独立 Change 与其他有效 Initiative 保持可用

### Requirement: 独立应用必须通过受限本地协议加载

系统 MUST 为每个 mounted Initiative 签发不透明、短生命周期的本地应用 origin，并 MUST 只从 manifest 已验证的静态应用根提供文件。协议 MUST 拒绝绝对路径、父目录、反斜杠、坏百分号编码、NUL、符号链接、未允许的方法和应用根外文件；manifest MUST NOT 声明命令、可执行文件、任意 URL 或项目模块。

#### Scenario: 加载应用首页和相对资源

- **WHEN** 用户打开有效的 embedded Initiative
- **THEN** 系统从该应用实例的受限 origin 加载声明首页及其根内相对页面和静态资源
- **AND** 不启动项目服务、不开放端口，也不执行仓库代码

#### Scenario: 请求越过应用根

- **WHEN** 页面请求点段、编码穿越、符号链接目标、`file:` URL 或应用根外资源
- **THEN** 系统返回受控未找到或拒绝
- **AND** 不读取或泄露目标内容

### Requirement: 宿主必须在独立渲染视图中不改写应用

系统 SHALL 在宿主内容区域使用独立原生渲染上下文加载应用自己的页面。宿主 MUST NOT 把页面注入自身 DOM、应用宿主 CSS、重建专项组件或改变应用内部路由；应用获得内容占位区的完整可用宽高，并在窗口、侧栏和工具栏尺寸变化时同步更新边界。

#### Scenario: 打开项目自有应用

- **WHEN** 独立应用入口加载成功
- **THEN** 独立视图直接加载该应用自己的 HTML、CSS、页面导航和交互
- **AND** 宿主不创建对应的业务 DOM、不注入 CSS，也不解释页面内容

#### Scenario: 调整宿主窗口

- **WHEN** 用户调整窗口、最大化、全屏或触发宿主侧栏断点
- **THEN** 独立视图始终与内容占位区边界一致
- **AND** 不覆盖宿主导航、不留输入死区，也不裁切应用左右内容

### Requirement: 独立应用渲染与导航必须受隔离

独立应用 MUST 在无 Node、无宿主 preload、无通用 IPC、启用 sandbox、context isolation 和 web security 的独立 session 中运行。系统 MUST 只允许当前应用实例的本地协议 origin，拒绝权限、下载、新窗口、`file:`、外部网络和跨 Initiative 导航。

#### Scenario: 页面尝试访问宿主能力

- **WHEN** embedded 页面尝试访问 Node、宿主 IPC、任意文件、权限或外部网络
- **THEN** 请求被拒绝且不泄露项目或系统数据
- **AND** 宿主外壳与其他项目状态不受影响

#### Scenario: 页面执行自身内部导航

- **WHEN** 页面导航到同一应用实例下的相对路径、query 或 hash
- **THEN** 导航正常完成并可被宿主保存为不透明的应用内位置
- **AND** 宿主不解析该位置对应的专项语义

### Requirement: 宿主动作映射必须保持固定且通用

manifest MAY 将应用已有的同源请求路径映射到宿主预定义动作 ID。主进程 MUST 对当前 instance、方法、Content-Type、payload 大小、当前项目、workspace revision 和动作参数重新校验；动作 registry MUST 由 OpenSpecGUI 静态定义，项目不得声明处理代码、任意 IPC 或网络代理。

#### Scenario: 应用调用已声明的 OpenSpec 动作

- **WHEN** 页面向声明路径提交符合契约的 `open-change` 请求
- **THEN** 系统只对当前项目官方索引中的 Change 执行打开操作
- **AND** 页面保持原请求路径和交互，无需专项 renderer 适配

#### Scenario: 应用伪造动作请求

- **WHEN** 页面使用未知路径、错误方法、超限 body、其他项目 ID 或过期 revision
- **THEN** 系统拒绝请求
- **AND** 不执行部分动作或回退为通用文件访问

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

### Requirement: 刷新与故障必须保持应用所有权

系统 SHALL 对 manifest 和静态应用根执行有界文件指纹检查，并 SHALL 在手动刷新或活动窗口的条件检查发现输出变化后，恢复同一安全相对 URL。系统 MUST NOT 执行项目生成器或解析专项权威输入；页面加载、渲染进程或文件校验失败 MUST 限定在当前 Initiative，并 MUST 提供重试和返回入口。

#### Scenario: 应用输出发生变化

- **WHEN** 外部工具更新 manifest 或静态应用根内的文件
- **THEN** 系统使旧应用会话失效并重新加载当前页面
- **AND** path、query 和 hash 在仍有效时保持不变

#### Scenario: 应用加载或渲染失败

- **WHEN** 静态文件校验失败、页面加载失败或渲染进程退出
- **THEN** 宿主隐藏或销毁失效视图并显示当前 Initiative 的受控错误状态
- **AND** 项目导航、独立 Change 和其他 Initiative 仍可操作
