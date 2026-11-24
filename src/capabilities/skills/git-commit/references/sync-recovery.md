# 远端同步与恢复

只在仓库落后 upstream、push 被 non-fast-forward 拒绝，或同步恢复失败时读取。

## 已提交任务、工作区干净

先前 fetch 已取得 upstream 状态时，直接执行：

```bash
git rebase @{upstream}
git push
```

## 已提交任务、仍有无关修改

1. 记录当前 stash 数量为 `STASH_BEFORE`。
2. 只对阻止 rebase 的剩余无关路径创建带唯一说明的 path-scoped stash；不要 stash 已提交范围，也不要使用无法核对范围的全局 stash。
3. 确认 stash 数量增加后执行 `git rebase @{upstream}`。
4. rebase 成功后 push。
5. 仅当 stash 数量确实由本次操作增加时，恢复本次新建的 stash；禁止无条件 `stash pop`。

恢复后核对这些文件仍为未暂存状态。若恢复产生冲突，保留可恢复状态并报告，不得丢弃用户改动。

## Push 被拒绝

重新执行一次 `git fetch <remote>`，检查 ahead/behind：

- 远端领先：按上面的 rebase 路径处理；
- 远端未领先但仍被拒绝：停止并报告远端、分支和错误；
- 完成一次 fetch/rebase 后再次 push 仍失败：停止，不无限重试。

## 冲突边界

- 可机械解决且不改变既定语义的 rebase 冲突：解决后继续，并复验受影响硬门禁。
- 涉及业务语义、提交范围或用户修改归属：停止并请求裁决。
- 任何失败路径都优先保证用户未提交修改可恢复，并明确报告临时 stash 是否仍存在。
