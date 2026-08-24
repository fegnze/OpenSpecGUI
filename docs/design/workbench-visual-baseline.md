# OpenSpec GUI 视觉基线

## 选定方向

产品基线采用“均衡密度”，并吸收高密度探索中的紧凑提案行元数据对齐。该方向在首次理解、最小窗口、文档阅读和无障碍余量上更稳定，同时保留日常高频扫描所需的密度。

- `DESIGN_VARIANCE: 3`
- `MOTION_INTENSITY: 2`
- `VISUAL_DENSITY: 7`
- 页面定位：安静的本地执行工作台，而不是营销页、监控大屏或卡片式仪表盘
- 运行时：原生 HTML、CSS custom properties、现有 Lucide 资源，不引入前端框架、组件库或动画库

## Token 基线

### 排版

- 界面字体：`-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", sans-serif`
- 机器字体：`"SFMono-Regular", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace`
- 页面标题：28px / 500；区块标题：17px / 500；正文和控件：14px；辅助信息：11-12px
- monospace 仅用于机器 ID、任务编号、时间和精确数值

### 空间与形状

- 4px 基础网格；控件高度 36-40px；提案行基线 64-72px；任务行基线 42-44px
- 页面间距宽桌面 28-44px，紧凑桌面 22-28px，最小桌面 16-20px
- 控件与行使用 4-5px 小圆角；对话框使用 6px；内容区不嵌套装饰性卡片

### 表面与语义

| 角色 | 浅色 | 深色 |
| --- | --- | --- |
| Canvas | `#f2f4f3` | `#0c1012` |
| Primary surface | `#fbfcfb` | `#141a1c` |
| Secondary surface | `#eef2f0` | `#20282b` |
| Primary text | `#20292b` | `#e9eeec` |
| Secondary text | `#5d696b` | `#a5b0ad` |
| Border | `#d5ddda` | `#303a3d` |
| Focus / selection | `#2056b3` | `#91b5ff` |
| Success | `#08735f` | `#56d9b7` |
| Warning | `#9b5d08` | `#f4b652` |
| Danger / attention | `#a73e32` | `#ff887c` |

状态同时使用文字或图标，颜色不作为唯一信息来源。焦点与选择使用蓝色；成功、警告和异常颜色只表达真实语义状态。

### 动效

- `fast: 120ms`，用于颜色、边界和悬浮反馈
- `standard: 180ms`，用于同页状态切换和折叠
- 不使用页面入场、滚动编排、循环装饰或磁吸交互
- `prefers-reduced-motion: reduce` 下移除位移、旋转和非必要过渡

## 布局基线

- 宽桌面 `>= 1280px`：224px 完整侧栏；详情主任务流与窄上下文栏并列
- 紧凑桌面 `960-1279px`：184px 窄侧栏；上下文移到主内容下方
- 最小桌面 `820-959px`：72px 图标导航轨道；工具栏保留项目入口；正文单栏优先展示提案或当前任务
- 首页固定为项目上下文、刷新状态、四项摘要和按进行中、待归档、需要处理排序的状态分组
- 状态组内的提案卡片保留名称、机器 ID、状态、精确进度和更新时间；点击摘要后切换到对应状态的紧凑提案列表
- 最小桌面在执行台状态组容器内横向滚动并露出下一组提示，不产生页面级横向滚动
- 文档正文使用受控行宽；表格、代码块、长链接和机器 ID 只在自身容器滚动或换行

## 评审矩阵

| 维度 | 结论 |
| --- | --- |
| 首次理解 | 均衡方向的标题、摘要、当前任务和上下文层级最清晰 |
| 日常扫描 | 采用高密度方向的提案行元数据对齐，避免牺牲行内可读性 |
| 最小窗口 | 820x640 使用图标轨道和单栏主路径，首个相关提案保持可见 |
| 文档阅读 | 14px 正文、稳定行高、受控行宽优于高密度方向 |
| 无障碍 | 更大的行高、控件尺寸和状态间距提供更可靠的键盘与文本放大余量 |

## 参考截图

- `workbench-visual-baseline/balanced-overview-1440x930-light.png`
- `workbench-visual-baseline/balanced-overview-820x640-light.png`
- `../../test/visual-baselines/overview-ready-filtered-wide-light.png`（状态摘要聚焦列表）
- `workbench-visual-baseline/balanced-detail-1440x930-light.png`
- `workbench-visual-baseline/balanced-detail-820x640-light.png`
- `workbench-visual-baseline/balanced-document-1440x930-dark.png`
- `workbench-visual-baseline/balanced-document-820x640-dark.png`

这些截图是方向基线，不是像素回归基线。正式 Electron 页面实现后，审阅通过的图片由 `test/visual-baselines/` 管理。
