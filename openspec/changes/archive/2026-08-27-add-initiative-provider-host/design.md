## Context

OpenSpecGUI 通过工作区快照建立 Changes、Specs 与 Archives 索引，主进程以项目级 revision 保护读取，renderer 由集中式入口同时承担路由、状态和页面渲染。参见 [proposal.md](./proposal.md) 的动机与范围。

普通 Initiative 需要跨项目一致的声明式组织方式，同时必须保持 Electron 安全边界，不能让项目内容注册代码、任意 IPC 或本地服务。

## Goals / Non-Goals

**Goals:**

- 在同一项目快照中维护互不替代的官方 Change 索引与 Initiative 索引。
- 建立受信任 Generic Provider、通用详情和关系索引的稳定内部边界。
- 让普通 Initiative 继承项目 revision、刷新、导航、错误隔离与安全读取能力。
- 使用仓库内中性合成 fixture 独立验证全部通用行为。

**Non-Goals:**

- 不建立由仓库动态安装或执行的插件系统，也不承诺第三方 ABI。
- 不编辑 Initiative 或 OpenSpec 工件，不做跨项目 Portfolio 与远程同步。
- 不解析消费项目专属文件模型，不提供项目专属 Provider snapshot 或 renderer 页面。
- 不把 Initiative 专有数据并入官方 OpenSpec 状态机。

## Decisions

### 1. Initiative 是平行索引，不是 OpenSpec Change 的父级生命周期

工作区快照增加 `initiatives`、Provider 诊断和 Change 关系索引，但现有 `changes` 保持完整。Change 关系只允许 `owned` 和 `related`：没有唯一有效 `owned` 关系的 Change 仍可在独立范围中定位，多重 `owned` 产生诊断而不触发自动裁决。

OpenSpec 生命周期已有权威目录和 CLI；把 Initiative 变成 Change 容器会导致未被发现的 Change 消失，因此不采用。

### 2. Generic Provider 由应用静态注册

主进程维护可信 Provider registry，默认只注册 OpenSpecGUI 自有的 Generic Provider。项目只能在固定目录提供版本化 `initiative.yaml`，不能提供模块路径、HTML、脚本或命令。Provider 返回的 descriptor 只包含可验证纯数据和已登记成果引用。

该方案保持当前只读导入和 Electron sandbox。消费项目特有结构不通过新增宿主 Provider 扩展。

### 3. 工作区摘要与成果读取分层

`workspace:load` 只执行有界发现并返回 descriptor，不加载成果正文。用户打开通用 Initiative 后，成果按稳定 ID 惰性读取。这样可限制启动 I/O、IPC payload 和信息泄露面。

### 4. IPC 使用固定操作

Initiative 成果请求包含当前 `projectId`、workspace revision、`providerId`、`initiativeId`、source hash 与稳定成果 ID。主进程重新解析当前项目并校验资源白名单、realpath、符号链接、媒体类型和大小。

preload 只暴露窄方法，不提供通用 Provider 调用器、路径读取、目录枚举、进程执行或网络代理。项目切换或刷新后，旧异步响应因 revision 不匹配而丢弃。

### 5. renderer 只提供通用 Initiative 页面

从集中式 renderer 抽出 Host Router 和 Initiative 页面状态，保持执行台、规范、归档及既有深链接行为。通用详情只展示 descriptor、Change 关系、成果和诊断，不按项目类型创建分支或组件。

### 6. 刷新由统一调度器与声明指纹驱动

宿主保留手动刷新、项目切换和窗口聚焦检查，只对活动项目的固定 Initiative 声明与登记成果做有界 fingerprint。变化后递增项目 revision、重新发现 descriptor，并在稳定路由仍有效时恢复页面位置。

### 7. 验收只使用中性合成输入

基础层验证零 Initiative、Provider 故障隔离、重复 ID、stale revision、安全 IPC 和项目切换；通用层验证 manifest、Change 关系、成果与详情页。测试与视觉基线不包含任何消费项目文件、名称、页面或业务数据。

## Risks / Trade-offs

- [Generic 清单表达能力有限] -> 保持宿主模型稳定；复杂专项交给后续公开静态应用协议，而不是扩张 Provider schema。
- [低频 fingerprint 对大型项目造成 I/O] -> 只检查活动项目和固定有界输入，缓存目录信息并合并重复刷新。
- [无效清单影响工作区] -> 按 Initiative 隔离诊断，完整 Change 索引和其他 Initiative 保持可用。

## Migration Plan

1. 冻结无 Initiative 项目的路由、安全和视觉基线。
2. 增加 descriptor、Generic Provider registry、工作区索引、固定 IPC 与中性 fixture。
3. 增加 Generic Initiative schema、发现、关系计算、列表与通用详情。
4. 抽出 Host Router，完成刷新、焦点和错误隔离验收。
5. 运行全量单元、安全、E2E、语法、打包和 OpenSpec strict validation。

回滚时移除 Initiative 入口和 Generic Provider 注册；项目原有 Changes、Specs 与 Archives 数据不需要迁移。
