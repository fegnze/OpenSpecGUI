## 1. 基线与契约

- [x] 1.1 固定无 Initiative、普通 Initiative、Provider 失败和 WTC Resource Program 的正反 fixture，并记录现有 Changes/Specs/Archives、旧深链接、安全测试和视觉基线
- [x] 1.2 定义版本化 `InitiativeDescriptor`、`changeRefs`、诊断、presentation、Provider fingerprint 和稳定资源 ID 数据 schema
- [x] 1.3 定义 main `InitiativeProvider` 与 renderer `InitiativeApp` 的静态 registry、生命周期和错误隔离契约，禁止仓库声明可执行模块
- [x] 1.4 与 WorldTourCasino 冻结 `wtc-resource-program-v1` schema version、sidecar、canonical fixture、expected snapshot 和 fixture source hash

## 2. Initiative Host 核心

- [x] 2.1 实现静态 Provider registry、版本协商、逐 Provider 发现隔离和 descriptor 规范化
- [x] 2.2 实现独立 Change、`owned`、`related`、多重归属、悬空引用和重复 Initiative ID 的确定性关系索引与诊断
- [x] 2.3 将 Initiative descriptor 与 Provider 诊断接入工作区快照，保持完整官方 Change 索引且不加载专用正文
- [x] 2.4 实现 Provider 有界 fingerprint、活动项目缓存和 revision 失效，验证零 Initiative 项目不增加项目专用代码路径
- [x] 2.5 增加 Provider 崩溃、超限 descriptor、不稳定结果、未知版本和多个 Provider 并存的单元测试

## 3. 安全服务与 IPC

- [x] 3.1 在 WorkbenchService 实现按 `projectId`、revision、`providerId`、`initiativeId` 惰性加载专用数据的固定服务方法
- [x] 3.2 实现按当前 source hash 和稳定 `artifactId` 读取成果，并在每次请求重新校验白名单、realpath、符号链接、媒体类型和 payload 上限
- [x] 3.3 增加固定 Initiative IPC 与窄 preload API，不暴露任意 Provider method、路径、目录、进程、环境变量或网络代理
- [x] 3.4 验证项目切换、刷新、晚到响应和过期 source hash/revision 均拒绝旧请求
- [x] 3.5 增加路径穿越、换符号链接、任意仓库脚本/CLI/HTML/URL、超大 payload 和未登记成果安全反例

## 4. Generic Initiative

- [x] 4.1 定义并校验 `openspec/initiatives/<initiative-id>/initiative.yaml`，限制 schema、ID、引用、成果路径和声明式字段
- [x] 4.2 实现 Generic Provider 的固定目录发现、稳定排序、普通 Initiative descriptor 和成果白名单
- [x] 4.3 实现普通 Initiative 列表与通用详情，展示目标、状态、health、关联 Changes、成果和受控诊断
- [x] 4.4 实现独立 Change 范围与“全部提案”并存交互，确保 `related` 不改变独立性且归属冲突不隐藏 Change
- [x] 4.5 覆盖有效、无 Initiative、ID 冲突、悬空 Change、越界成果、符号链接和未知 schema 的单元/E2E 测试

## 5. 宿主路由与 Initiative App 生命周期

- [x] 5.1 从集中式 renderer 中抽出 Host Router、顶层页面状态与稳定 route 解析，保持现有执行台、规范、归档和旧链接行为
- [x] 5.2 增加 Initiative 顶层入口、列表、通用详情、Provider 诊断和返回执行台路径
- [x] 5.3 实现 App `mount/update/dispose`、限定挂载根、主题 token、焦点恢复和 App 级错误边界
- [x] 5.4 实现包含项目、Provider、Initiative、专用子路由和稳定资源 ID 的深链接序列化、恢复与受控未找到状态
- [x] 5.5 实现手动、窗口聚焦和可见窗口低频 fingerprint 刷新，暂停隐藏窗口检查并在刷新后恢复稳定子路由和筛选
- [x] 5.6 验证重复挂载、项目切换、App 异常、重试和 dispose 不遗留监听器、异步写入或不可达焦点

## 6. Host 与 Generic 阶段验收

- [x] 6.1 运行全部现有单元、E2E、安全、语法和打包检查，证明无 Initiative 项目零回归
- [x] 6.2 在宽桌面、紧凑桌面和 820×640、明暗主题下验证 Initiative 列表、通用详情、诊断、键盘顺序、焦点与无页面级横向溢出
- [x] 6.3 更新确定性视觉基线并运行 axe、文本溢出和主要操作可达性检查
- [x] 6.4 由未参与 Host/Generic 实现的评审者确认 Provider 隔离、安全 IPC、普通 Initiative 和 Change 完整性通过后，才开始 WTC 专用适配

## 7. WTC Resource Program Provider

- [x] 7.1 只在 WorldTourCasino 提供同版本 `provider-contract-ready` schema/fixture evidence 后，注册内置 `wtc-resource-program-v1` Provider
- [x] 7.2 实现固定 sidecar 与 `program.json` 入口发现，支持零、一、多个 Program 且不写死 DH Initiative ID
- [x] 7.3 实现 derived `summaryStatus`、health/gate/milestone 摘要和 Program/Change 引用校验，不执行 WTC checker 或仓库代码
- [x] 7.4 实现分层 `descriptor`、`overviewSnapshot`、`artifactIndex` 与按 ID 成果读取，并校验契约版本、source hash 和稳定排序
- [x] 7.5 使用 canonical 正反 fixture 验证重复 ID、未知版本、悬空 Change、无效 gate/contract、符号链接、路径逃逸、过期请求和恶意内容

## 8. Resource Program Initiative App

- [x] 8.1 实现 Program 总览、Workstream、Change、gate、milestone、contract lock、blocker 和 assignment 专用视图
- [x] 8.2 实现归档 Change 官方 tasks 全量回顾、未完成/全部筛选、精确计数和空态
- [x] 8.3 实现成果目录、taxonomy、关键结论/方案设计/验证证据/全部档案四种阅读视角与稳定成果定位
- [x] 8.4 实现安全 Markdown 阅读和 Mermaid 原位图形/源码切换，采用本地固定依赖、strict 配置、图块隔离和惰性滚动渲染
- [x] 8.5 实现 Program、Change、artifact、lens、section、Diagram 深链接及输入变化后的刷新恢复和受控失效
- [x] 8.6 验证专用 App 不复制宿主项目导航、不启动 loopback 服务、不使用 iframe/webview/fetch/Node API 且样式不污染宿主

## 9. 协同验证与交付

- [x] 9.1 对比两仓库 canonical fixture、schema version、expected snapshot 与 source hash，证明契约字节和语义一致
- [x] 9.2 验证 WTC 当前 Program 的总览、归档任务、四种阅读视角、41 张 Mermaid、深链接、刷新和错误隔离达到静态 Dashboard 功能等价
- [x] 9.3 在宽桌面、820×640 与明暗主题完成 Resource Program App 的视觉、键盘、焦点、无障碍和 canvas/SVG 非空检查
- [x] 9.4 运行全部单元、E2E、安全、视觉、语法、打包与 OpenSpec strict validation，并记录实现证据和跨仓库版本
- [x] 9.5 由未参与实现的评审者执行安全与功能等价复验；存在未关闭 P1/P2 或 WTC delivery gate 未满足时给出 Rework
- [x] 9.6 更新 README 与恢复说明，明确 Initiative Host/Generic/WTC 边界、无动态项目代码、无端口运行及静态 Dashboard 后备
