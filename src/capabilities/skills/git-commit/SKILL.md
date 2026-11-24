---
name: git-commit
description: WorldTourCasino 项目 Git 提交与推送流程。用户明确要求“提交”“推送”或 git push 时使用；负责精确暂存、远端同步、结构化提交结果和多仓库顺序，不负责补做任务收口。
allowed-tools: Bash, Read, Glob
---

# Git 提交与推送

此版本仅用于已绑定的 WorldTourCasino 仓库及其工作树。使用 Node.js 和 Git，并按该仓库的 AGENTS.md、项目脚本及相对文档路径执行。以下命令中的 `SKILL_DIR` 表示当前宿主实际加载的本 Skill 目录，应先按此位置设置 shell 变量。仓库工作目录继续使用目标检出。

## 边界

- 明确的提交或推送指令授权执行当前已收口且范围明确的任务，不再二次确认。
- 只消费最后一次实质修改后仍有效的测试、审查、验收和 OpenSpec 提醒结论；不启动新一轮实现、广泛测试、review 或提交后复审。
- 收口缺失、范围含糊、硬门禁失败或同步冲突需要语义裁决时，在继续改变 Git 状态前停止。
- 只提交当前任务文件，不混入其他协作者或工作区既有修改；不得用 `git add .` 绕过范围边界。

## 固定规则

- 主项目忽略构建产物：`res_*/flavor/index.html`、`main*.css`、`project.json`、`js_src/common/util/Config.js`、`resource_list/**/*.json`。
- 功能相关的 `res_*/resource_dirs.json`、外部脚本、版本与发布参数须纳入明确任务范围。构建验证的临时环境修改按 hunk 恢复，不整文件丢弃功能配置；无法区分时说明具体歧义再裁决。
- 多仓库按 `docs/`、`vscode-extensions/`、主项目顺序分别提交。
- 提交信息默认使用中文，不得包含 AI 标识。
- 主项目标题使用 `[类型] 产品代号：描述`；非业务变更可省略产品代号。子项目使用 `docs: 描述` 或 `扩展名: 描述`。
- 提交信息必须包含简洁标题和真实变更详情。类型或产品映射不明确时读取：
  - `docs/工程-工具/ai-rules/shared/git-commit-types.md`
  - `docs/工程-工具/ai-rules/WTC/git-commits.md`
- 需要详细提交信息模板或示例时，读取 `references/commit-message.md`。

## 两批次快速路径

普通“提交并推送”只执行两个确定性批次。`scripts/git_commit_helper.js` 只操作显式文件路径，使用范围摘要检测状态漂移；`prepare` 执行一次 fetch，`deliver` 执行一次 push，但不执行 stash、rebase 或冲突解决。命令失败时才拆开诊断或进入条件恢复。

该路径覆盖已配置 upstream、任务文件明确且收口有效的单仓或多仓提交，包括存在无关脏文件的工作区。多仓库可并行 `prepare`，再按 `docs/`、`vscode-extensions/`、主项目顺序 `deliver`。以下少数场景不强塞进两批次：push-only、初始分支无 upstream、远端领先、non-fast-forward 和需要语义裁决的冲突。

### 批次一：prepare

对任务文件逐个传入 `--path`，一次完成范围预检、远端 fetch 和状态绑定：

```bash
node "$SKILL_DIR/scripts/git_commit_helper.js" prepare \
  --repo . --path <file> [--path <file> ...]
```

程序在 fetch 前拒绝无 upstream、构建产物、已有 staged 内容或不完整任务范围；fetch 后再次绑定分支、upstream、remote、任务内容和暂存区，并返回 `token.head`、`token.scopeDigest`、任务范围、其他脏文件及 ahead/behind。确认待提交范围、提交说明和推送目标与有效收口一致。

已有有效 OpenSpec 归档提醒时直接复用；没有时只运行一次 `npm run --silent list:openspec`。仅当提交涉及 `openspec/` 时运行 `npm run check:openspec`。

### 批次二：deliver

确认批次一结果后，将 token 原样传入，一次完成提交、推送和完整报告：

```bash
node "$SKILL_DIR/scripts/git_commit_helper.js" deliver \
  --repo . --path <file> [--path <file> ...] \
  --expected-head <token.head> \
  --expected-scope-digest <token.scopeDigest> \
  --message "<标题>" --message "<详情>" [--message "<其他段落>"]
```

程序重新确认 token，精确 `git add`，核对 cached 与最终 commit 路径，执行 `git diff --cached --check`，创建提交，推送到配置的 upstream 并验证 ahead/behind 为 0。成功结果返回 `commitInfo`、`delivery` 和 `remainingChanges`，供最终回复直接组织为一个结构。

若 `git add` 后的门禁或 commit hook 失败，程序保留精确暂存结果，不自动 reset。若 push 失败，程序保留已创建的本地提交并返回完整 hash；不得重复 commit。

### 覆盖与停止条件

| 场景 | 结果 |
| --- | --- |
| 普通提交、存在无关脏文件 | 两批次完成，只提交显式路径 |
| 构建产物、已有 staged、范围或分支漂移 | 在写入前阻断 |
| `BEHIND>0` | `prepare` 停止，读取 `references/sync-recovery.md` |
| commit hook 或 cached 门禁失败 | `deliver` 停止并保留精确暂存 |
| prepare 后远端推进 | `deliver` 保留本地提交并以 non-fast-forward 停止 |
| 多仓库 | 批次一可并行，批次二按固定仓库顺序执行 |
| push-only、无 upstream 或冲突需裁决 | 使用原子命令或手动路径，不伪装成快路径 |

`preflight`、`sync-check`、`commit`、`report` 原子命令保留给失败诊断和不满足快路径前提的场景；普通成功路径不得重新拆回四段调用。`git fetch` 不改写工作树，因此脏工作区不预先 stash。

## 完整结果

最终回复使用一个人读的“提交结果”结构，不使用原始 Git 日志代码块，也不在摘要和详情中重复同一事实。按以下视觉层级展示：

- 先用三级标题展示提交标题，标题使用普通文本，不用反引号包裹整个标题；
- 紧接一个两行引述块：第一行展示推送状态、分支与 ahead/behind，第二行展示完整 hash 和提交者姓名/邮箱，使身份信息保持完整但降低视觉权重；
- “提交说明”和“文件变更”使用四级标题，其内容分别使用数字列表；
- 总计使用普通强调文本，仍未提交的工作区边界使用普通文本，不为单值字段创建无序列表。

`deliver.commitInfo` 是提交元数据和逐文件统计的结构化真源；`delivery` 是推送与同步状态的结构化真源。普通成功结果不返回或展示远端、upstream、作者、作者/提交时间、原始 commit/push 输出、`fullLog` 或内部记忆记录；只有失败诊断或用户明确要求原始 Git 输出时才使用 `report` 等原子命令。执行耗时和性能对比只在当前会话按需携带，不属于固定提交结果。变更大纲、验证结果和 OpenSpec 提醒需要补充时，也放进同一个“提交结果”结构；没有 tasks 100% 的 active Change 时，不输出空的 OpenSpec 提醒。多仓库或多提交在该结构内分别列项。

## 条件恢复

仅在这些情况读取 `references/sync-recovery.md`：

- `BEHIND>0`；
- push 被 non-fast-forward 拒绝；
- rebase、stash 或 stash 恢复失败。

普通 `BEHIND=0` 提交不得为了保险预加载恢复流程、创建 stash 或运行 no-op rebase。
