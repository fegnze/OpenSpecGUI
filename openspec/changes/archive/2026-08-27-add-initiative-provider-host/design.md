## Context

OpenSpecGUI 当前通过 `workspace.js` 一次建立 Changes、Specs 与 Archives 快照，`WorkbenchService` 以项目级 revision 保护读取，main/preload 只暴露固定 IPC，renderer 则由单个 `app.js` 同时承担路由、状态和页面渲染。参见 [proposal.md](./proposal.md) 的动机与范围。

Initiative 引入两个不同问题：普通专项需要跨仓库一致的声明式组织方式，Resource Program 等复合专项则需要保留自己的信息架构和交互。两者都必须运行在现有 Electron 安全边界内，且不能让项目内容注册代码、任意 IPC 或本地服务。首个 WTC 适配还跨越两个独立仓库，因此契约必须可复制验证，而不能依赖两个仓库同时存在。

## Goals / Non-Goals

**Goals:**

- 在同一项目快照中维护互不替代的官方 Change 索引与 Initiative 索引。
- 建立受信任 Provider、通用 Initiative 和专用 Initiative App 的稳定内部边界。
- 让复杂专项按需加载数据，并继承项目 revision、刷新、主题、导航、错误隔离与安全读取能力。
- 分阶段交付宿主内核、普通专项体验和首个 `wtc-resource-program-v1` 专用 App，每阶段可独立验收。

**Non-Goals:**

- 不建立由仓库动态安装或执行的插件系统，也不承诺第三方 ABI。
- 不编辑 Initiative、Program 或 OpenSpec 工件，不做跨项目 Portfolio 与远程同步。
- 不把 Provider 专有数据强行并入全局 Change 搜索或官方 OpenSpec 状态机。
- 不在本 Change 中删除 WorldTourCasino 的静态 Dashboard 或无 GUI CLI。

## Decisions

### 1. Initiative 是平行索引，不是 OpenSpec Change 的父级生命周期

工作区快照增加 `initiatives`、Provider 诊断和 Change 关系索引，但现有 `changes` 保持完整。Change 关系只允许 `owned` 和 `related`：没有唯一有效 `owned` 关系的 Change 仍可在独立范围中定位，多重 `owned` 产生诊断而不触发自动裁决。

选择该模型是因为 OpenSpec 生命周期已有权威目录和 CLI；把 Initiative 变成 Change 容器会导致未被 Provider 发现的 Change 消失。替代方案是只在 Initiative 内列 Change，但会破坏当前工作台的完整性，因此不采用。

### 2. Provider 与 App 均由应用构建时静态注册

main 侧维护可信 `InitiativeProvider` registry，renderer 侧维护可信 `InitiativeApp` registry。仓库只能提供声明式数据，不能提供模块路径、HTML、脚本或命令。宿主使用 `providerId + initiativeId` 作为复合身份，Provider 返回的 descriptor 只包含可验证纯数据：契约版本、身份、类型、标题、摘要、展示状态、健康诊断、Change 关系和 `{ mode, appId }` 展示信息。

普通专项由内置 `openspec-generic-initiative-v1` Provider 扫描固定 `initiative.yaml`。专用 Provider 各自声明固定、有界的发现签名；宿主内核不根据目录名猜 Program 类型。

该方案比运行仓库插件少扩展性，但能保持当前只读导入和 Electron sandbox。未来若需要第三方 Provider，应通过独立的签名安装与权限设计 Change 处理。

### 3. 发现摘要与专用数据加载分层

Provider 接口按职责分为概念上的 `discover`、`fingerprint`、`load` 和 `readArtifact`。`workspace:load` 只执行有界发现并返回 descriptor，不加载大型成果正文或完整专用快照。用户进入专用 Initiative 后才加载 overview、索引和当前页面所需数据，成果正文再按稳定 ID 惰性读取。

这避免 Resource Program 拖慢没有进入专项的普通 OpenSpec 工作流，也使 Provider 故障可以逐个隔离。把完整 Program 数据塞入公共工作区快照虽然实现简单，但增加启动耗时、IPC payload 和信息泄露面，因此不采用。

### 4. IPC 使用固定操作，不提供通用 Provider 调用器

新增固定的 Initiative 加载与成果读取操作；请求必须包含 `projectId`、workspace revision、`providerId`、`initiativeId`，成果读取还必须包含当前 source hash 与稳定 `artifactId`。main 根据当前项目和 registry 重新解析 Provider/Initiative，校验 payload 大小、资源白名单、realpath、符号链接和 revision 后返回结构化数据。

preload 只暴露窄方法，不提供 `provider.call(method, args)`、路径读取、目录枚举、进程执行或网络代理。项目切换或刷新后，旧异步响应即使晚到也因 revision 不匹配而被丢弃。

### 5. Initiative App 是宿主内模块，不是 iframe 沙箱

可信 App 遵循 `mount`、`update`、`dispose` 生命周期，只挂载到宿主提供的内容根。宿主管理项目选择、顶层导航、主题、刷新、返回位置、错误边界和顶层 route；App 管理自己的子路由和专有视图，并通过宿主 API 请求数据。App 样式必须限定在挂载根和共享 theme token 内。

iframe/webview 会形成双导航、双主题和跨上下文通信问题，也仍需项目 HTTP 服务；直接复用旧页面因此不采用。App 不是不可信代码沙箱，可信边界来自静态打包与代码审查。

### 6. 先拆分宿主路由，再接入专用 App

现有集中式 renderer 先抽出 Host Router、Initiative 页面状态和 App registry，保持当前执行台、规范、归档及旧深链接行为不变。随后增加 Initiative 列表与通用详情，最后接入 WTC App。App 异常由挂载边界捕获并降级到 descriptor/诊断页；卸载必须清理事件、异步任务与焦点。

该顺序避免在约 950 行集中式 renderer 中直接叠加项目专用分支。一次性重写整个 renderer 风险更高，也超出本 Change。

### 7. 刷新由统一调度器与 Provider fingerprint 驱动

宿主保留手动刷新、项目切换和窗口重新聚焦检查，并在窗口可见且存在活动项目时低频检查 Provider 声明的有界 fingerprint；窗口隐藏、最小化或项目切换后暂停旧检查。fingerprint 只统计 Provider 契约允许的输入，不解析全文。变化后宿主递增项目 revision、重新发现 descriptor，并只在用户仍位于同一稳定 route 时恢复 App 子路由和筛选。

Provider 解析失败时保留上一版只读快照仅供明确标记的历史参考，不能把它标成当前权威状态。相比为每个项目启动 watcher/SSE 服务，该方案复用单一桌面生命周期，且不会产生端口和进程所有权。

### 8. WTC Provider/App 作为第三阶段的首个真实适配

宿主内核和 Generic Initiative 验收后，应用静态注册 `wtc-resource-program-v1` Provider 与 Resource Program App。Provider 按 WorldTourCasino Change `adapt-resource-program-as-initiative-provider` 的 sidecar、descriptor、overview snapshot、artifact index 和成果读取契约实现可信只读解析；App 以原生组件重建 Program、Workstream、Change、gate、contract、任务、阅读视角和 Mermaid 体验。

OpenSpecGUI 不导入或执行 WTC 仓库 JavaScript。双方各自保存同版本正反 fixture 与预期结果，并用 schema version 和 fixture source hash 检查漂移；可选的同机集成测试不能成为任一仓库独立构建的前提。现有受控 OpenSpec CLI 状态读取继续仅服务官方 Change 状态，不作为 Initiative Provider 执行入口。

### 9. Markdown 与 Mermaid 沿用 renderer 安全模型并增加专用拒绝测试

成果正文由 main 以文本和已验证媒体类型返回。renderer 先在 inert DOM 中按标签、属性和协议白名单净化 Markdown；Mermaid 使用应用本地固定版本、strict 安全级别和独立图块状态，生成 SVG 后再次拒绝脚本、事件属性、外部 URL 与 `foreignObject`。未知或超限内容降级为源码或受控错误，不影响其他成果。

### 10. 验收按基础、通用和专用三层组织

基础层验证零 Initiative、Provider 故障隔离、重复 ID、stale revision、安全 IPC 和项目切换；通用层验证 manifest、Change 关系、成果与通用页面；专用层验证 WTC fixture、Program 页面等价、全部 Mermaid、深链接、刷新和恶意输入。视觉验收覆盖宽桌面、紧凑桌面、820×640、明暗主题、键盘、焦点恢复和严重可访问性规则。

## Risks / Trade-offs

- [一个 Change 同时包含宿主与首个专用适配，范围仍较大] → 用三阶段 tasks 和独立门禁推进，宿主/Generic 未通过时不得开始 WTC UI，WTC 失败不阻止基础能力验收。
- [双方复制 fixture 可能漂移] → 为 fixture 和 schema 固定版本与 source hash，任一契约改动要求两个仓库的协调 Change 与独立测试同时更新。
- [低频 fingerprint 对大型仓库造成 I/O] → 只检查活动项目、可见窗口和 Provider 有界输入，缓存目录信息并合并短时间内重复刷新。
- [App 样式或异常污染宿主] → 限定挂载根、共享 token、显式 dispose 和 App 级错误边界，并增加项目切换与重复挂载测试。
- [Program 页面能力遗漏导致过早替换旧工具] → WTC 静态 Dashboard 保持正式后备，只有双仓库等价与独立验证通过后才允许另建退役 Change。

## Migration Plan

1. 冻结现有无 Initiative 项目 fixture、路由、安全和视觉基线。
2. 增加 descriptor、Provider registry、工作区索引、固定 IPC 与 fixture Provider；验证现有 Change 行为零回归。
3. 增加 Generic Initiative schema、发现、关系计算、列表与通用详情，完成独立验收。
4. 抽出 Host Router 与 App 生命周期，完成主题、焦点、刷新和错误隔离验收。
5. 按固定契约接入 WTC Provider 与 Resource Program App，运行双方 fixture、功能等价、安全和双端视觉验证。
6. 发布时默认启用 Host/Generic；WTC App 只有在兼容契约存在时出现，版本不兼容时降级为 descriptor 诊断。

回滚时可先从静态 registry 禁用 WTC Provider/App，普通 OpenSpec 与 Generic Initiative 保持可用；若宿主基础出现回归，则回退 Initiative 路由和 IPC，项目原有 Changes/Specs/Archives 数据不需要迁移。WorldTourCasino 静态 Dashboard 始终提供恢复路径。
