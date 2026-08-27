## 1. 基线与通用契约

- [x] 1.1 固定无 Initiative、普通 Initiative 和 Provider 失败的中性正反 fixture，并记录 Changes、Specs、Archives、深链接、安全测试和视觉基线
- [x] 1.2 定义版本化 `InitiativeDescriptor`、`changeRefs`、诊断、presentation、Provider fingerprint 和稳定资源 ID 数据约定
- [x] 1.3 定义 main `InitiativeProvider` 的静态 registry、生命周期和错误隔离契约，禁止仓库声明可执行模块

## 2. Initiative Host 核心

- [x] 2.1 实现静态 Generic Provider registry、版本协商、发现隔离和 descriptor 规范化
- [x] 2.2 实现独立 Change、`owned`、`related`、多重归属、悬空引用和重复 Initiative ID 的确定性关系索引与诊断
- [x] 2.3 将 Initiative descriptor 与 Provider 诊断接入工作区快照，保持完整官方 Change 索引且不加载成果正文
- [x] 2.4 实现 Provider 有界 fingerprint、活动项目缓存和 revision 失效，验证零 Initiative 项目不增加项目专用代码路径
- [x] 2.5 增加 Provider 崩溃、超限 descriptor、不稳定结果、未知版本和冲突的单元测试

## 3. 安全服务与 IPC

- [x] 3.1 实现按当前项目、revision、Provider、Initiative 与稳定成果 ID 读取普通 Initiative 成果的固定服务方法
- [x] 3.2 每次请求重新校验白名单、realpath、符号链接、媒体类型和 payload 上限
- [x] 3.3 增加窄 preload API，不暴露任意 Provider method、路径、目录、进程、环境变量或网络代理
- [x] 3.4 验证项目切换、刷新、晚到响应和过期 source hash/revision 均拒绝旧请求
- [x] 3.5 增加路径穿越、符号链接替换、执行字段、超大 payload 和未登记成果安全反例

## 4. Generic Initiative

- [x] 4.1 定义并校验 `openspec/initiatives/<initiative-id>/initiative.yaml`，限制 schema、ID、引用、成果路径和声明式字段
- [x] 4.2 实现 Generic Provider 的固定目录发现、稳定排序、普通 Initiative descriptor 和成果白名单
- [x] 4.3 实现普通 Initiative 列表与通用详情，展示目标、状态、health、关联 Changes、成果和受控诊断
- [x] 4.4 实现独立 Change 范围与“全部提案”并存交互，确保 `related` 不改变独立性且归属冲突不隐藏 Change
- [x] 4.5 覆盖有效、无 Initiative、ID 冲突、悬空 Change、越界成果、符号链接和未知 schema 的单元/E2E 测试

## 5. 宿主路由与刷新

- [x] 5.1 从集中式 renderer 中抽出 Host Router 与顶层页面状态，保持执行台、规范、归档和旧链接行为
- [x] 5.2 增加 Initiative 顶层入口、列表、通用详情、Provider 诊断和返回执行台路径
- [x] 5.3 实现手动与窗口聚焦的有界 fingerprint 刷新，并在刷新后恢复稳定通用路由
- [x] 5.4 验证项目切换、重复加载、错误重试和晚到异步结果不会污染当前视图

## 6. 通用验收与交付

- [x] 6.1 运行全部单元、E2E、安全、语法和打包检查，证明无 Initiative 项目零回归
- [x] 6.2 在宽桌面、紧凑桌面和最小窗口、明暗主题下验证 Initiative 列表、通用详情、诊断、键盘顺序与焦点
- [x] 6.3 使用中性合成 fixture 更新确定性视觉基线，并运行可访问性、文本溢出和主要操作可达性检查
- [x] 6.4 更新 README 与恢复说明，明确普通 Initiative 的声明边界、无动态项目代码和无端口运行
