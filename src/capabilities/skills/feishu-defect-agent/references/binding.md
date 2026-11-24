# 绑定与适配

首次接入、启动 Target、字段歧义或通道缺失时阅读。先诊断，再通过 `prepare` 一次完成本轮准备，准备就绪后才运行 `start`。

## 共享配置与个人身份

每个工作树使用自己的绑定。成员在工作台的飞书缺陷项目设置表单中填写项目键、来源、字段和消息配置。通过该工作台安装的 Skill 从当前 Git 工作树或其子目录运行时自动找到对应设置。若需指定已有单项目 JSON，传入 `--binding FILE`，其相对仓库路径以该文件的目录为基准。自动选择和显式选择同一文件共用原有运行状态。旧版独立安装仍支持 Skill 根目录的 `projects.local.json`。参见[绑定示例](../assets/binding.example.json)。

| 字段 | 语义 |
| --- | --- |
| `version` | 配置格式版本，当前为 `1` |
| `host` | 飞书项目服务域名 |
| `project_key` | 经项目查询确认的权威键；URL 的空间短名不能直接冒充它 |
| `work_item_type` | 真实缺陷类型键 |
| `sources` | `{kind: "issue"\|"view", id}` 数组；一个或多个来源 |
| `fields` | 标题、状态、优先级、当前状态负责人、描述及可选附件的实际字段键 |
| `owners_semantics` | 经元数据确认后设为 `current_state_operator`，不能用此声明代替实际核对 |
| `issue_url_template` | 可核对的缺陷链接模板，供卡片使用；支持 `{issue_id}`、`{project_key}`、`{work_item_type}` |
| `budgets` | 候选数量、调度摘要与子任务结果的输出上限 |
| `repositories` | 工程身份、模块路由及交付适配；缺省仓库/分支在启动前从当前工作目录发现并由使用者选择 |
| `release_provider` | 可选的项目默认交付平台名，例如 `"Jenkins"`；`choices.project_defaults` 将它作为向导提示 |
| `notifications` | 与项目数据能力独立的消息提供方和项目 APP 参数；个人收件人独立保存，QA 群在本轮选择 |
| `identity_source` | 账号绑定服务的可选读取入口，配置为 `{host, file}`。项目维护者填写已信任的 SSH 主机别名和服务端私有映射文件的绝对路径 |
| `handoff` | 当前工程约定的本地交接目录；不默认建立云文档 |
| `cli.profile` | 可选的官方 CLI 逻辑凭证槽名；`--profile` 可覆盖，各使用者仍解析自己机器的个人授权 |

工作台将项目设置保存在应用用户目录。固定可复用项包括项目键、缺陷字段、交接目录、默认发布平台和通用适配入口。启动向导里的本轮选择保存到运行记录。项目规则文件有需要时可引用配置入口。

项目默认用 Jenkins 时，在完整绑定中增加 `"release_provider": "Jenkins"` 即可。它只缩小 ASK 的候选范围，不是具体任务、权限或默认环境；任务、环境、验证方式、分支和 QA 群由本轮选择并保存到个人运行记录。个人入口或只对本轮适用的 hooks 需要持久化时，用个人受保护的完整绑定经 `--binding FILE` 调用；它是显式替代文件，不会合并或覆盖项目配置。

CLI profile 优先使用 `--profile`，项目配置里的 `cli.profile` 保存逻辑槽名。个人 access/refresh token 留在官方凭证设施。本机绑定通过 `app_id` 或 `app_id_env` 和 `app_secret_env` 引用消息应用凭据。

项目配置了账号绑定服务时，Skill 在启动预检、发卡、补 @ 和恢复通知事务时自动读取最新映射。服务端文件必须是权限为 `0600` 的普通文件，且绑定的 `app_id` 必须与当前消息应用一致。服务不可读或应用不匹配时，相关动作返回具体诊断，已有运行状态仍可查看。

本机映射默认读取状态根的 `identities.json`，服务端映射覆盖同键的本机条目。维护者可用 `--identity-map FILE` 显式指定受保护的替代文件。格式如下，本机文件的 `app_id` 可选，提供后须与当前消息应用一致。映射和来源配置的改变不使已有 `run_id` 失效。

```json
{
  "version": 1,
  "app_id": "EXAMPLE_FEISHU_APP_ID",
  "actors": {
    "EXAMPLE_PROJECT_USER_KEY": {
      "receive_id_type": "open_id",
      "receive_id": "EXAMPLE_OPEN_ID"
    }
  }
}
```

## 身份验证引导

- `AUTHENTICATION_REQUIRED` 表示当前 Meegle profile 没有可用登录。立即转入授权引导，告诉用户官方页面、要做的操作和预计确认次数；当前工程要求同意，或当前会话尚无启动认证的授权时，用宿主 ASK（不可用时按宿主规则询问）取得同意，再发起一次。使用已确认的 host 和 profile 调用官方 `meegle auth login`，无交互浏览器时按已安装 CLI 帮助使用官方设备码流程；用户完成后复核 `user me` 并续接原启动选择。失败或过期不自动重开；host 不符、项目权限不足、CLI/网络故障分别处理，不能当作认证过期。
- `ACTOR_NOTIFICATION_REQUIRED` 或私聊映射未核验表示可能已有有效项目账号。先用权威项目人员资料和当前消息应用复核 IM 映射。若没有可用的飞书个人身份，自动引导用官方飞书个人授权（宿主提供时使用 `lark-shared`），同样遵守上述本人确认规则；不要让用户第一步手填 `open_id`，也不要重登 Meegle。授权后核对是同一人，并核对收件人标识属于当前消息应用；另一个应用的 `open_id` 或同名不能证明匹配。自动核验仍不成功时，用 ASK 说明剩下哪项需要本人确认；未核验不写映射、不发送。仅将核验通过的映射交给本轮 `actor_target` 或保存到个人映射文件。

## 启动前向导

新建 Target 前先运行 `choices`。它从个人状态目录列出当前飞书身份、当前项目绑定最近最多三组不同的已结束运行配置；候选含模式、仓库与分支、本轮缺陷或视图、QA 群及已记录的发布选择。不显示旧运行的命令、凭据或任务详情。

有记录时集中展示候选。优先使用当前宿主实际可用的 ASK 工具（例如 Codex 的提问工具或 Claude Code 的 `AskUserQuestion`）；不可用时以编号供用户回复。每项列清所用模式、仓库与分支、缺陷来源、已核对的群，以及直接修复的发布管道、目的地和核验方式：

- **沿用上轮**：按展示的配置一次确认；可同样从最近其他记录中选择。
- **沿用但修改**：选择一组，只提供要改的仓库、分支、来源、群、模式或发布选择。例如“沿用上轮，仅把 QA 群换成 X”。
- **自定义**：以当前工作目录的仓库与检出分支为候选，集中确认范围、模式和群；直接修复再确认发布选择。

本轮模式必须明确；整组候选已展示模式时，用户一次确认即可。旧记录缺少发布目的地或核验方式等信息时，只补问实际缺项。当前 Git 分支与已选分支不符时，先引导按工程约定切换，再准备；不自动切分支。准备阶段不写缺陷签名、不派发 worker、不创建宿主 Target。

`prepare --input FILE` 接收本轮选择，例如：

```json
{
  "repository": {"path": ".", "branch": "当前已选分支"},
  "qa": {"chat_id": "EXAMPLE_CHAT_ID"},
  "mode": "repair",
  "sources": [{"kind": "view", "id": "EXAMPLE_VIEW_ID"}],
  "release": {"pipeline": "已选 Jenkins 任务", "destination": "已选测试槽位", "verification": "核对目标环境实际版本和来源提交"}
}
```

沿用记录时用 `reuse_run_id` 指向 `choices` 返回的 `run_id`，仍显式传入本轮已确认的 `mode`。可用 `repository`、`sources`、`qa`、`release` 覆盖对应选项，其他选项沿用；覆盖值也可从其他候选中选取。候选若附 `source_count`，则 `sources` 是预览；沿用时不传 `sources`，即可使用完整来源。例如沿用原仓库和视图，只换 QA 群：

```json
{"reuse_run_id": "所选历史运行 ID", "mode": "triage", "qa": {"chat_id": "EXAMPLE_NEW_CHAT_ID"}}
```

未选历史记录时，`repository` 可省略以发现当前仓库和检出分支；显式 `path` 从当前工作目录解析，多路由可用 `repository.id` 选择。已有共享工程路由和交付适配仍须匹配该工程。`qa` 必须来自本轮明确选择的记录、`chat_id` 或 `{"link":"飞书群链接"}`。

内置群链接解析接受 `https://applink.feishu.cn/client/chat/open?chatId=oc_...`，兼容同路径 `chat_id` 参数和 `applink.larksuite.com`；链接必须只包含一个明确群 ID。只有 opaque 邀请 token 的分享链接无法从中可靠取得 chat_id，此时引导获取 chat_id，不访问邀请链接或自动加入群。自定义消息提供方可通过可信的只读 preflight 能力解析，但同样要回读确认唯一群。

输出 `ready`、`preparation_id`、`selection`、`diagnostics` 和 `expires_at`。检查个人身份及项目元数据、仓库/分支、APP 凭证可用性、目标群和机器人在群、当前操作者通知映射；直接修复另查当前分支的交接目录和交付 hooks。缺项给具体补齐动作；机器人不在群时引导将对应机器人加入该群。当前操作者通知映射缺失时可在本轮输入 `actor_target: {receive_id_type,receive_id}` 提供已核验收件人。

每次准备都必须显式传入 `mode`，示例中的 `repair` 不是默认值。「直接修复」要求 validate/commit/push/publish/verify 全部入口齐备；「仅排查」传入 `"mode": "triage"`，不沿用发布选择，无需发布 hooks 或交接目录，但仍须核对当前授权飞书账号的私聊映射和本轮 QA 群。运行结果见 [仅排查](operations.md#仅排查)。

### 发布管道确认

发布管道是 `repair` Target 的必要条件。启动前从工程既有说明和可信配置发现入口，把以下信息并入同一次集中确认；有多条管道或多个测试槽位时先让使用者选择：

- 实际发布入口：本地脚本、CI/Jenkins 任务或工程专用工具，以及 validate → commit → push → publish → verify 各阶段对应的既有命令。
- 本次目的地：产品或风格、测试/正式环境、具体槽位或部署目标，以及使用的源码分支或提交。不能按脚本默认值推断本轮目的地。
- 所需运行环境、个人凭据和适用发布权限；只读取或核对已有配置，不在准备阶段发起真实构建、上传或发布来探测权限。
- 发布日志的实际入口、参数和换行规则，以仓库脚本或流水线定义为准。写法及 WTC-Web 示例见 [发布日志规范](operations.md#发布日志规范)。
- 核验依据：如何读取实际发布标识及来源提交、如何确认目标已使用该次产物；单纯推送 Git、触发 CI、回显预期版本或模拟发布均不能代替真实发布核验。

把本轮确认的任务名、目的地和核验方式分别记录为 `release.pipeline`、`release.destination`、`release.verification`，下轮可选择沿用。不填凭据、带密钥的 URL 或命令。`release` 只是对已确认发布选择的记录；命令与实际目标仍由当前可信 hooks 决定。记录与 hook 实际行为不符时先修正并重新准备，不从旧命令或默认参数推断目的地。

入口缺失时，不把诊断当作最终答复。汇总 `RELEASE_SELECTION_REQUIRED.fields`、`DELIVERY_CONFIGURATION_REQUIRED.phase`、`DELIVERY_EXECUTABLE_REQUIRED.phase`，连同未解决的权限和核验缺口用 ASK 集中补齐。给出能够执行的选项：「使用已核对的入口」（有候选才显示）、「提供现有入口的位置」（如 Jenkins 任务页、脚本路径或已有适配配置）、「本轮改为仅排查」。只问所缺项；用户提供页面或命令位置后，先只读核对权限、项目关联和回执，再接已有的可信适配；单有网页 URL 不算五阶段已接通。不索取 token，不把回答中的任意命令直接写成 hook。无法核对时保留待补项，继续 `repair` 前必须补齐；不自动降级。

`prepare` 静态核验五阶段 argv 和首个程序的可执行性，未证明脚本参数、发布凭据、部署连通性或实际发布成功；Agent 仍须完成上述确认，不能把 `ready:true` 当作已验证可上线。

用户选择 `triage` 时，启动摘要记录“本轮仅排查与补证”。后续要修复交付时重新选择并准备 `repair` Target。

准备结果与用户已确认的选择一致时，直接用 `start --input FILE` 传入 `{"preparation_id":"本轮准备回执","confirmed":true}`，无需再问一遍。`confirmed` 记录已取得本轮明确选择，不是额外审批。回执保存在个人状态目录，绑定项目配置和当前 actor，有效期 10 分钟；启动重新核对环境。沿用历史选项也必须重新 `prepare` 和 `start`，建立新 run；同一回执重复启动才复用同一 run。恢复既有运行时用 `resume`，沿用原运行已冻结的选择和检查点。

## 字段与来源

`fields.owners` 表示**当前状态负责人**。依据当前空间与工作项类型元数据确认后，设置 `owners_semantics: "current_state_operator"`；不能拿“实际负责人”、报告人或同名人员替代。负责人数组包含本人即可进入后续筛选；明确空数组才是未分配，缺失或不可读属于未知。

`fields.state` 和 `fields.priority` 绑定真实字段键及可识别值。示例状态键为 `work_item_status`；CLI 返回的 `work_item_attribute.work_item_name` 会在没有 `name` 时归一化为 `name`，供示例标题使用。仍需核对当前类型元数据。默认优先安排 Blocker 且处于 OPEN/REOPEN 的可执行条目；不同项目使用内部枚举或多语言显示值时，先核对元数据，不根据标签猜转换关系。需要 QA 补证时，依据该缺陷实际状态及允许流转查询 `EVIDENCE_LACK`，不能仅因视图筛选不包含该状态就断言它不存在。

视图来源读取真实成员及完整分页，不能推测筛选条件后用近似查询代替。多个来源按项目、类型和缺陷 ID 去重。临时指定来源通过 `prepare --input FILE` 的 `sources` 传入，只覆盖本次运行，不改共享绑定。

```json
{
  "sources": [
    {"kind": "issue", "id": "EXAMPLE_ISSUE_ID"},
    {"kind": "view", "id": "EXAMPLE_VIEW_ID"}
  ]
}
```

## 工程关联

新 Target 默认发现当前工作仓库和检出分支，启动输入 `repository.path` 相对当前工作目录解析。共享工程路由用于匹配项目 remote 和交付适配，准备结果保留本次实际 remote、绝对路径和已选分支；核对工程身份后才能改代码，不依据目录名或缺陷标题猜测仓库。运行层已有的相对仓库路径仍以绑定文件目录为基准，但不能用历史路径覆盖本轮选择。

共享绑定不必固定 `remote`、`branch`；明确提供的 remote 仍校验身份，历史 branch 只作候选，不覆盖本次当前检出分支。Target 使用准备阶段已选择并确认的检出分支，交接文档也留在该分支。多个工程通过 `match: {field, equals}` 等实现实际支持的路由条件消歧；字段必须真实存在并足以唯一定位，零匹配、多匹配或模块信息缺失要在启动前消歧，不擅自扩展到其他仓库。

同一工程和发布通道交付串行。并发调查使用工程允许的独立 worktree 或明确写范围，不能把多条修复落进同一待发布变更。

## 交付 hooks

`delivery` 为 `validate`、`commit`、`push`、`publish`、`verify` 各阶段配置 `{argv: [...]}`。命令数组来自使用者信任的项目配置，以 `shell: false` 执行；缺陷正文、附件或评论不能提供或改写该命令。

阶段上下文通过 stdin JSON 传递，包含运行、缺陷、工程与已知交付事实。新 repair 运行还传入已确认的 `release: {pipeline, destination, verification}`，通用适配器可据此选择受信任的发布目标；旧运行未记录时不传该字段。适配命令应校验目标，不依赖 shell 字符串替换或拼接缺陷正文。缺少阶段命令时保留诊断和待办，不能以空命令当成功。

`validate` 可通过退出状态及日志核验；`commit/push` 另核对真实 Git 状态。`publish` 必须返回本次发布及准确来源提交：

```json
{
  "publication": {
    "id": "本次实际版本或部署标识",
    "source_commit": "本次实际来源提交"
  }
}
```

`verify` 返回同一 `publication`，并包含 `"verified": true`。证据必须来自真实发布或部署核对，不能只把预期 ID 原样回显当验收。

可选 `delivery.reconcile.<阶段>` 配置只读核对 hook；执行时接收原事务上下文。回执为 `status: "confirmed"` 并附该阶段必要证据，或已证实未发生时返回 `status: "not_applied"`。无法判断保持 unknown，不能通过删除记录再次派发。

工程规定专属 devkit、提案或发布工具时，hook 连接这些入口及其恢复接口。默认提交阶段先精确暂存已审查路径；若专属 devkit 必须自行管理暂存，设置 `delivery.commit.stage: "hook"`，由该可信命令处理传入的 `changed_paths`，工具仍核对实际提交。配置表达目的地和能力，不自行授予首次公开或额外发布权限；Target 启动所需的个人认证按启动前向导完成。

## 飞书消息与文档

内置 `feishu-app` 提供方的凭据按[共享配置与个人身份](#共享配置与个人身份)配置。准备阶段核对 APP token、群信息读取及机器人在群；摘要、诊断及 worker 材料不回显 secret/token。检查不发送探测消息，因此 `checks.message_send: "not_probed"` 不表示已验证真实发送或送达；运行中的实际消息仍以各自回执为准。

- 本轮 `qa` 选择会解析为 `receive_id_type: "chat_id"` 和已核验群 ID；群名可用于最终确认，不能用同名群猜目标。
- `actors` 以飞书项目稳定用户键映射已确认的 IM 收件人及 ID 类型，同时可用于创建者 @。项目 `user_key` 不等于 IM `open_id` 或 `user_id`；@ 使用已核验的 `open_id` 或 `user_id`，不能直接使用项目键。
- 仅排查结果卡片和直接修复的交接卡片均私聊当前授权飞书账号。没有收件人映射时在启动前引导补齐；不根据缺陷内容、姓名或浏览器账号推断目的地。QA 群卡片的创建者逐条按需核验，无法映射仍按既定 creator_mention 待办处理。
- 可信 argv 消息适配器使用 `provider: "command"` 和 `argv` 数组，以 stdin JSON 接收既定消息及目标，成功时返回 `{status: "confirmed", reference: "可核对消息标识"}`。启动前另配 `preflight.argv`：stdin 为 `{version:1,phase:"preflight",actor:{id},qa:{receive_id_type:"chat_id",receive_id}}` 或 `qa:{link}`，只读回执须为 `{ready:true,bot_in_chat:true,qa:{receive_id_type:"chat_id",receive_id,name?}}`；明确 chat_id 输入必须回到同一群。未配置 preflight 不视为准备就绪。实际未发送返回 `status: "pending"` 和具体原因；不确定结果不能冒充 pending 再发。保持短命调用，不另建常驻消息网关。

QA 卡片 @ 的目标只取缺陷详情的 `create_by`，包括官方 `work_item_attribute.create_by` 形态；不以当前负责人、报告人或姓名相同的成员替代。解析先使用合并后的显式 `notifications.actors[creatorProjectKey]`；没有显式映射时，读取项目 `person`，将 `person.out_id` 仅作为 `union_id` 候选，经 Contact 查询核对响应 `union_id` 与候选一致后取 IM `open_id`。`person.lark_user_id` 也仅作为 `user_id` 候选，必须以该类型查询 Contact、确认返回 `user_id` 完全相等且存在有效 `open_id` 后才可桥接；ID 保留原始精度，不接受已失真的数值。另可使用该权威人员资料中的完整 email，通过 `batch_get_id` 得到唯一且 email 一致的 IM 身份。不按姓名搜索匹配，不把跨租户或无权限响应视为身份确认。

创建者缺失、权限不足或桥接失败，只记录 `creator_mention: pending` 及原因，QA 群卡片仍可发送，后续缺陷继续处理。补齐映射后，`update-notification` 仅对已有 confirmed 的 `feishu-app` QA 消息按原 `message_id` 执行 PATCH，再 GET 回读核对；保留原消息 ID，不新发替代卡片。回执保留 `alert: "not_guaranteed_for_message_update"`：编辑已有卡片加入 `<at>` 无法保证产生新的推送提醒，新发卡片可直接包含真实 `<at>`。

`issue_url_template` 必须对应该空间真实缺陷 URL。URL 中空间短名可能与权威 `project_key` 不同，此时模板使用已确认的固定短名；不要把 opaque project_key 拼成错误链接。

`handoff.directory` 相对本轮源码仓库解析，默认 `docs/defect-handoffs`；项目可改为允许的其他目录，准备时核对不会逃出当前 checkout。`park` 在本次已选分支生成可提交文档后返回 `pending_commit` 及路径；主 Agent 审查后按工程约定单独提交该文档并推送，用 `handoff-result --input FILE` 提供 `{"commit_oid": "实际完整提交OID"}`。命令核对单文件提交、当前内容与提交 blob 一致、提交已包含于目标远端分支，再同步共享文档回执为 confirmed。此路径不触发产品发布；不能把生成成功报告为已提交。个人缓存中的原始响应和日志仍不提交。

本技能默认使用当前工程文件交接。使用者明确选择云文档时，沿用实际项目的文档入口与身份约束。

评论、群卡片、个人卡片和交接文档分别保存回执；一个成功不能替代其他通道。已知准备缺口应在 Target 启动前解决；运行中权限撤销、机器人被移群等意外失效记录具体待办或停止受影响通道，保留检查点并继续不依赖该通道的独立工作，不在缺陷执行中临时启动配置向导。

官方 CLI 参数与元数据以已安装版本的帮助为准：[Meegle CLI](https://github.com/larksuite/meegle-cli)。
