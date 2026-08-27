# WTC Resource Program Provider Implementation

## 1. 结论

OpenSpecGUI 已内置注册 `wtc-resource-program-v1` Provider，并独立消费 WorldTourCasino 的固定声明式契约。Provider 不 require、spawn 或调用 WTC 的 JavaScript、checker、CLI、Dashboard 服务、HTML 或项目声明模块；renderer 仍只能通过宿主固定的 Initiative load/read-artifact IPC 访问数据。

本证据覆盖 tasks 7.1–7.5，不声明 Resource Program Initiative App 或最终双仓库功能等价已经完成。

## 2. 上游合同门禁

- WorldTourCasino baseline：`968b2441151815a301989ea3c46a7eed8ebc3e84`
- 上游证据：`openspec/programs/dh-browser-progressive-resource-reorganization/evidence/resource-program-initiative-provider-contract-ready.md`
- 上游 task 6.1：已完成
- Provider ID / schema version：`wtc-resource-program-v1` / `1`
- canonical source hash：`754e6c7b6f3a7434138e4484fa9679d7e0fe61a8cb923dcf3dc311f2d565dc17`

OpenSpecGUI 中的五份 canonical/expected/negative 文件 SHA-256 与上游证据逐字节一致：

| 文件 | SHA-256 |
| --- | --- |
| `canonical-input.json` | `4f2b645fab6ad2d64147180bf18417883c6cc0f6c9fa45d6aec31ed4c3ba34d1` |
| `expected-descriptor.json` | `7455d1f1d75b04ff123eefa289b873c684de4ea6b81bd17d3a418cf1cc8193ab` |
| `expected-overview.json` | `4d71634e5120732ae91ab16770bb7b035e8fc97d49424ba99b5eba6fb9c9258b` |
| `expected-artifact-index.json` | `4f74062fca696498311a48907ec6f6cd33237af5e7ddcca46e254f084a01fd2a` |
| `negative-cases.json` | `564dafefe8be48c167b4e3de70c7b9f14bea75e8d86c1705cdee9e8daa854f4f` |

`fixture-contract.json` 另外固定十份内置 schema 的 SHA-256，fixture freeze test 会逐文件检查漂移。

## 3. 实现边界

- 发现只枚举 `openspec/programs` 直接子目录，并要求固定 `initiative-provider.json` 与 `program.json` 入口；零、一、多个 Program 都有测试，不依赖 DH Initiative ID。
- sidecar 只接受 `$schema`、`schemaVersion`、`providerId`、`initiativeId`、`summary`。每份权威 JSON 和全部 Program contract schema 都逐段拒绝符号链接、保持边界，并使用受支持的递归 JSON Schema 子集校验。
- discovery 只建立 descriptor 白名单、authority-only source records 和 hash；overview、taxonomy 章节、Mermaid 图目录与正文分别在 `load` 和 `readArtifact` 阶段生成或读取。
- WTC raw descriptor 被归一化为 Host `InitiativeDescriptor`：`type=resource-program`、derived status、health、owned Change refs、`presentation={mode: custom, appId: resource-program-v1}`。
- `summaryStatus` 只按 `invalid > blocked > needs-review > in-progress > complete` 派生。gate、milestone、Change、assignment、blocker 与 contract Change 引用在 Provider 内复核。
- contract lock 通过逐段安全读取独立重算路径集合摘要；锁定文件内容与登记 hash 不一致时返回 `CONTRACT_HASH_MISMATCH`，不调用 WTC checker。
- 成果读取每次重建当前白名单与 source hash，再校验稳定 artifact ID、允许根、完整路径链、realpath、符号链接、media type 和 2 MiB 上限；artifact index 不含正文或 Mermaid source。
- artifact 和 reading section 的空摘要在输出边界以标题、heading 或登记路径提供确定性非空 fallback；canonical 中已有摘要保持不变。
- fingerprint 只扫描当前项目 `openspec/programs` 与 `openspec/changes` 的有界声明式文件状态，不读取项目代码、环境、网络或服务。

## 4. 独立 fixture 与安全反例

`test/wtc-resource-program-provider.test.js` 覆盖：

- canonical descriptor、overview、artifact index 与 WTC expected JSON 逐对象一致；
- 未知 Provider/version、ID mismatch、执行字段和递归 output fragment schema 反例；
- 零、一、多个 Program、跨目录重复 ID 尝试、坏候选隔离和静态 registry；
- 悬空 Change、无效 gate/milestone/contract/blocker 引用与不受支持 schema 关键字；
- 正确 contract lock hash、锁定文件 mutation 后 hash mismatch，以及 external `$ref` 诊断去重；
- 确定性输出、非权威文件不改变 source hash、权威输入改变 source hash；
- canonical 与真实文件系统两条路径下的空 artifact/reading section summary fallback；
- 未登记 artifact、路径逃逸、最终文件和中间目录符号链接、2 MiB 上限、过期 source hash；
- 包含 script、事件属性和外部 URL 的 Markdown 仅作为文本返回，Provider 不执行内容。

## 5. 真实 WTC 只读兼容

使用 OpenSpecGUI 内置 Provider 直接读取 `/Users/ghost/work/WorldTourCasino`，未加载 WTC 脚本：

| 项目 | 结果 |
| --- | --- |
| Program | 1 |
| Workstream | 9 |
| Change | 5 |
| gate | 10 |
| artifact | 63 |
| Mermaid diagram metadata | 41 |
| Provider diagnostics | 0 |
| descriptor/load source hash | 均为 `d318dec72e08263104ebdbf6281f6efcaea6c7b859cd3fb81e5c78aab7ee42e4` |

随机选择白名单成果 `artifact-2dffc5fe5efaaa00` 后，按 ID 惰性读取成功，返回 `text/markdown` 与登记 metadata。

## 6. 验证记录

- `node --test test/initiative-contract-fixture.test.js test/wtc-resource-program-provider.test.js`：14/14 通过。
- `npm test`：当前合并工作树 65/67 通过；全部 Provider、Host、Generic、安全和非 GUI 回归通过，2 个 task 8 Resource Program App E2E 失败已移交 UI 实现者处理，不属于 tasks 7.1–7.5 的 Provider 失败。
- `npm run check`：46 个文件语法检查通过。
- `npm run package`：arm64 Darwin package 通过。
- `npx openspec validate add-initiative-provider-host --strict --no-interactive`：通过。
- `git diff --check`：通过。
