# 通用宿主与回归基线

## 冻结点

本基线以 `6f1cfbd` 后的 OpenSpecGUI 通用工作台能力为保留边界。专项接入只增加声明发现、本地静态协议和原生 View 生命周期，不改变 OpenSpec Change 生命周期，也不把任何消费项目的专项模型迁入宿主。

## 文件依赖图

| 能力 | 保留入口 | 所有权边界 |
| --- | --- | --- |
| 无 Initiative / 项目注册 | `project-registry.js`、`workbench-service.js`、`workspace.js` | Host 通用能力 |
| 独立 Change | `workspace.js`、Change renderer | 官方 `openspec/changes` |
| Spec 与 Archive | `workspace.js`、文档读取 IPC、通用 Markdown reader | 官方 `openspec/specs` 与 `changes/archive` |
| 普通 Initiative | `generic-initiative-provider.js`、`initiative-provider-registry.js`、通用 Initiative detail | 固定 YAML descriptor 与登记成果 |
| 独立 Initiative App | `embedded-initiative-app-provider.js`、`embedded-initiative-app-protocol.js`、`embedded-initiative-app-host.js` | Host 只发现、导航、隔离承载 |
| 项目自有应用 | 目标项目的 `initiative-app.json` 与 `webRoot` | 项目拥有 HTML、CSS、数据模型、路由、依赖和测试 |

## 删除边界

删除项目专用 Provider、模型/schema 镜像、artifact parser、专项 renderer、复制的页面依赖、专项 fixture 与宿主重建版视觉基线。保留 Generic Initiative 的安全成果读取和全部 Change/Spec/Archive 页面。

## 回归入口

- `test/workspace.test.js`：无 Initiative、Changes、Specs、Archives。
- `test/initiative.test.js`：Generic Initiative、关系索引与成果读取。
- `test/e2e.test.js`：通用工作台、普通 Initiative 与 embedded App 导航。
- `test/visual.spec.js`：通用工作台视觉基线。
- `test/embedded-initiative-app.test.js`：manifest、协议、动作、指纹与原生 View 生命周期。
