## ADDED Requirements

### Requirement: Initiative 界面必须延续工作台的响应式与可访问边界

系统 SHALL 让 Initiative 列表、普通详情和专用 Initiative App 挂载区在宽桌面、紧凑桌面与 820×640 最小窗口中保持主要导航和操作可达，并 SHALL 在明暗主题、键盘操作和辅助技术下延续宿主的视觉层级、语义状态及可见焦点。专用 App MUST 使用受作用域约束的样式，不得覆盖宿主导航、主题 token 或全局交互状态。

#### Scenario: 最小窗口浏览 Initiative

- **WHEN** 用户在 820×640 窗口中打开 Initiative 列表、通用详情或专用 App
- **THEN** 项目切换、顶层导航、返回入口、标题、健康状态和首个主要操作均可到达
- **AND** 页面没有文字截断、控件重叠或非预期页面级横向滚动

#### Scenario: 仅使用键盘进入和离开专用 App

- **WHEN** 用户只使用键盘从 Initiative 列表打开专用 App、操作其内部导航并返回宿主
- **THEN** 焦点按可预测顺序在宿主与专用内容之间移动
- **AND** App 卸载后焦点返回可用的宿主位置，不落入已移除内容

#### Scenario: 专用 App 在不同主题下显示状态

- **WHEN** 用户在专用 App 中切换明暗主题或系统启用 reduced motion
- **THEN** 文本、边界、焦点、诊断和选择状态保持足够区分
- **AND** App 不以自有全局样式覆盖宿主主题或引入不必要循环动画

#### Scenario: 专用 App 显示失败状态

- **WHEN** 专用 App 加载或渲染失败
- **THEN** 错误边界使用与工作台一致的语义、可访问名称和重试操作
- **AND** 不因错误内容改变外壳尺寸或遮挡全局导航
