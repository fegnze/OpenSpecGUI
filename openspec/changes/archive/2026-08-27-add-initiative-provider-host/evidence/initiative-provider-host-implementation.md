# Initiative Provider Host Implementation Evidence

## 结论

OpenSpecGUI 已同时承载独立 OpenSpec Changes 与普通 Initiative。通用 Host 只运行应用内静态注册的 Generic Provider；项目仓库只能提供受 schema 约束的声明式数据，不能提供脚本、模块、命令、HTML、URL、网络代理或任意 IPC method。

## 交付结构

- `openspec/initiatives/<initiative-id>/initiative.yaml` 由 Generic Provider 自动发现，使用通用列表和详情页。
- Host Router 保存 project、provider 与 initiative 路由；刷新、项目切换、revision/source hash 变化和渲染异常均受隔离。
- 普通成果只按当前项目、revision、source hash 和稳定成果 ID 惰性读取。

## 安全边界

- 请求绑定当前 project ID、workspace revision、provider ID、initiative ID、source hash 与稳定 artifact ID，并限制 request/response 大小。
- 每次惰性读取重新验证白名单、逐段符号链接、realpath、允许根、媒体类型和正文上限。
- Markdown 经不可执行的白名单净化；renderer 保持 sandbox、无 Node、无任意网络访问，也不监听端口。

## 合成验证

中性 fixture 覆盖普通 Initiative 与独立 Change 共存、owned 冲突不隐藏 Change、成果读取、恶意 Markdown、条件刷新、深链接恢复、最小窗口、可访问性和文本边界。验证不依赖任何消费项目仓库、schema、页面、截图或业务断言。

## 验证记录

- `npm test`：Host、Generic、安全和既有工作流测试通过。
- `npm run test:e2e` 与 `npm run test:visual`：中性场景通过。
- `npm run check`、`npm run package`、OpenSpec strict validation 与 `git diff --check`：通过。

## 恢复与后续边界

GUI 不可用时，项目 OpenSpec 文件不受影响。复杂专项应通过公开的通用静态应用协议保留自己的数据模型、DOM、CSS、路由和验证流程；OpenSpecGUI 不新增消费项目专属 Provider 或 renderer。
