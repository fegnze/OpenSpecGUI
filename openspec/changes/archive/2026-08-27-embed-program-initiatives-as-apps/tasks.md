## 1. 冻结通用宿主基线

- [x] 1.1 冻结 Host、Generic Initiative、独立 Change、Spec 和 Archive 的通用回归基线
- [x] 1.2 固定 `initiative-app.json` schema、保留 collection 清单、基础 descriptor 和 `embedded-app` presentation 契约
- [x] 1.3 为零/一/多个应用、不同 collection、未知版本、ID 冲突、路径越界、符号链接和无效首页建立正反 fixture

## 2. 实现独立应用发现与本地协议

- [x] 2.1 实现固定深度 manifest 发现、realpath 校验、诊断隔离和有界静态应用文件指纹
- [x] 2.2 注册 standard/secure 的 `openspec-initiative-app` scheme，并为每次 mount 建立不透明 instance origin 与严格根目录映射
- [x] 2.3 实现 Content-Type、CSP、`nosniff`、文件大小和 URL 解码边界，拒绝点段、坏编码、NUL、反斜杠、符号链接、外部协议和越界文件
- [x] 2.4 实现静态宿主动作 registry 与 `openspec.open-change`，校验 instance、method、Content-Type、payload、project、revision、Change ID、realpath 和符号链接

## 3. 实现 WebContentsView 宿主

- [x] 3.1 在 main process 实现 embedded App instance 的 mount、load、hide、refresh、dispose 和 generation 隔离
- [x] 3.2 使用独立非持久 session 和无 preload、无 Node、sandbox、context isolation、web security 的固定 WebPreferences
- [x] 3.3 增加 renderer 占位区与受限 bounds IPC，通过 ResizeObserver、窗口 resize、侧栏断点、全屏和缩放同步 View 边界
- [x] 3.4 拦截权限、下载、新窗口、外部网络、跨 instance 导航和拖放导航，并将加载失败、crash 与 unresponsive 限定为 Initiative 错误
- [x] 3.5 将 pathname、query 和 hash 作为不透明子路由保存和恢复，保证返回、刷新、项目切换和旧异步结果不会恢复错误 View
- [x] 3.6 在项目菜单、modal、路由离开和窗口关闭时正确隐藏或销毁 View，恢复焦点且不留下输入死区

## 4. 删除项目专用重实现

- [x] 4.1 删除项目专用 Provider、模型、schema validator、artifact parser 和全部契约镜像
- [x] 4.2 删除专项 renderer、App registry 和复制的页面依赖
- [x] 4.3 删除 Provider/snapshot/artifact fixture、专项单元测试和宿主重建版视觉基线
- [x] 4.4 收缩 Initiative IPC 和 WorkbenchService，保留 Generic Initiative、安全文档读取、关系索引、revision 和故障隔离
- [x] 4.5 更新 README 与恢复文档，说明独立 Change、普通 Initiative 和 embedded Initiative App 三种入口及所有权边界

## 5. 通用自动化验收

- [x] 5.1 补充 manifest、custom protocol、动作 registry、导航、安全 header、fingerprint 和 stale session 单元测试
- [x] 5.2 使用合成 Initiative App 补充 View mount/dispose、快速切换、旧响应、renderer crash、modal 遮挡、焦点恢复和资源释放测试
- [x] 5.3 使用合成 Initiative App 验证首页、相对资源、内部路由、通用 Finder 动作、刷新和深链接恢复
- [x] 5.4 验证独立 View 使用有效内容边界、页面非空且不覆盖宿主；不保存消费项目截图或比较消费项目页面像素
- [x] 5.5 运行无 Initiative、Generic、Changes/Specs/Archives 全量回归、辅助技术检查、`npm test`、`npm run test:visual`、`npm run check`、打包和 `git diff --check`

## 6. 独立验证、同步与归档

- [x] 6.1 由未参与实现的验证者独立复核零项目专用知识、协议安全、View 生命周期和通用回归，并给出 Accepted 或 Rework
- [x] 6.2 关闭独立复核中的 P1/P2，并记录不包含消费项目内容的最终验证证据
- [x] 6.3 在 Accepted 后先同步 `embedded-initiative-app`、`initiative-host` 和 `workbench-visual-system` 到正式 specs，并严格验证主 specs
- [x] 6.4 同步完成后归档 `embed-program-initiatives-as-apps`，确认 active Change 列表和工作区状态符合提交边界
