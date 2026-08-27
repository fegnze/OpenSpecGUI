## ADDED Requirements

### Requirement: Initiative 界面必须延续工作台的响应式与可访问边界

系统 SHALL 让 Initiative 列表和普通详情在宽桌面、紧凑桌面与最小窗口中保持主要导航和操作可达，并 SHALL 在明暗主题、键盘操作和辅助技术下延续宿主的视觉层级、语义状态及可见焦点。

#### Scenario: 最小窗口浏览 Initiative

- **WHEN** 用户在最小支持窗口中打开 Initiative 列表或通用详情
- **THEN** 项目切换、顶层导航、返回入口、标题、健康状态和首个主要操作均可到达
- **AND** 页面没有文字截断、控件重叠或非预期页面级横向滚动

#### Scenario: 仅使用键盘浏览 Initiative

- **WHEN** 用户只使用键盘从 Initiative 列表打开通用详情并返回宿主
- **THEN** 焦点按可预测顺序移动
- **AND** 页面离开后焦点返回可用的宿主位置

#### Scenario: Initiative 显示失败状态

- **WHEN** Initiative 清单或成果加载失败
- **THEN** 错误边界使用与工作台一致的语义、可访问名称和重试操作
- **AND** 不因错误内容改变外壳尺寸或遮挡全局导航
