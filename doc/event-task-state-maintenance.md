# event task / state 手工维护规则

本文档只说明 `event_task.json` 与 `event_state.json` 的人工维护规则。正常路径下，task-backed 事件由 launcher/subagent claim 并处理，主 Agent 不直接处理、删除或手工编辑 task。

## 操作前提

- 人工编辑运行时 JSON 前，必须先停止正在运行的 event listener / launcher。
- 不要在 listener 运行期间手工编辑 `event_task.json` 或 `event_state.json`；listener 保存前会检测磁盘变更并尝试重载重放，但这只是防 lost update 的保护，不是人工并行写入接口。
- `update.sh` 只用于按启动路径刷新 JSON，不是人工删除或确认 task 的替代入口。
- `event_state.json` 与 `event_task.json` 的 `runtimeRevision` 必须保持一致；人工编辑两个文件时不要改成不同 revision。
- 如果 listener 无法停止，先不要编辑 JSON；应记录需要处理的 `task.id`、`prKey`、`type` 和最新 GitHub 状态，等 listener 停止后再维护。

## 核心规则

- `event_task.json` 只是当前活跃任务队列。
- `event_state.json.prs[prKey].baseline` 才是“已处理到哪里”的记录。
- 删除 task 不等于标记底层事件已处理。
- 如果删除评论类 task，但没有推进对应评论 baseline，下一次扫描可能重新生成同一个 `MAINTAINER_COMMENT`、`BOT_COMMENT` 或 `NEW_COMMENT` task。
- `event_state.json.prs[prKey].observed` 是上次看到的快照，用于判断状态变化通知；不要把 `observed` 当作已处理标记。

## 优先路径

subagent 派发的任务不要手工编辑两个 JSON 文件。subagent 完成工作后输出带 `nonce` 的结构化 `task result`，launcher 只接受最终消息中的唯一 result 行，然后刷新 GitHub 状态，并按结果推进 state baseline、删除 task、block task 或进入 retry。

只有 listener 已停止、且需要人工确认或解除异常 runtime 状态时，才需要人工维护 JSON。

## 评论类 task 完成后如何更新

评论类 task 使用 category-scoped baseline：

- `MAINTAINER_COMMENT` -> `baseline.commentBaselines.maintainer`
- `BOT_COMMENT` -> `baseline.commentBaselines.bot`
- `NEW_COMMENT` -> `baseline.commentBaselines.user`

listener 停止后，人工完成评论类 task 时：

1. 在 `event_task.json` 中用精确的 `id`、`prKey`、`type` 找到该 task。
2. 在 `event_state.json.prs[prKey]` 中找到对应 PR entry。
3. 将 task 的 `boundary.issueCommentCursor`、`boundary.reviewCommentCursor`、`boundary.reviewCursor` 复制到对应 category baseline。
4. 将 `baseline.updatedAt` 和该 PR entry 的 `updatedAt` 设置为 `boundary.snapshotUpdatedAt`；如果没有该字段，则使用当前 ISO 时间。
5. 从 `event_task.json` 中只删除这个 task。
6. 编辑后解析校验两个 JSON 文件。

`NEW_COMMENT` 完成后的目标结构示例：

```json
{
  "prs": {
    "owner/repo#123": {
      "baseline": {
        "commentBaselines": {
          "user": {
            "issueCommentCursor": "<copy from task.boundary.issueCommentCursor>",
            "reviewCommentCursor": "<copy from task.boundary.reviewCommentCursor>",
            "reviewCursor": "<copy from task.boundary.reviewCursor>"
          }
        }
      }
    }
  }
}
```

处理 `NEW_COMMENT` 时不要推进 `maintainer` 或 `bot` baseline；每个 category 独立推进。

## 状态型 task 完成后如何更新

状态型 task 包括 `CI_FAILURE`、`REVIEW_CHANGES_REQUESTED`、`NEEDS_REBASE`。

状态型 task 会由 launcher 先做 actionability 分类：

- `pending`：agent 可行动，或暂时无法判断是否可行动。
- `blocked`：明确需要 contributor、maintainer、人类决策或基础设施处理，不应继续普通自动重试。

`blocked` 是 task 状态；`needs_human`、`needs-contributor-action`、`needs-maintainer-action` 等只应作为 `blockReason` / `blockOwner` / `unblockHint` 表达，不要新增为 status。

只有重新检查 GitHub 并确认触发条件已经消失后，才允许手工清除：

- `CI_FAILURE`：最新 status checks 不再失败。
- `REVIEW_CHANGES_REQUESTED`：最新 review decision 不再是 `CHANGES_REQUESTED`。
- `NEEDS_REBASE`：最新 `mergeStateStatus` 不再是 `BEHIND` / `DIRTY`，且 `mergeable` 不是 `CONFLICTING`。

如果触发条件仍然存在，保留 task。直接删除只会让 scanner 重新生成 task，或者隐藏真实待处理工作。

如果 blocked task 的 `blockOwner` 是：

- `contributor`：等待 PR 作者 push 新 commit、rebase、补 DCO / signature / PR metadata。
- `maintainer`：等待维护者改 label、权限、review decision、仓库设置或 secret。
- `human`：等待人工判断是否继续处理。
- `infra`：等待外部服务、runner、权限系统或基础设施恢复。
- `automation`：launcher 已阻止普通重试，需要先重新检查最新快照。

外部条件处理完成后，不要直接猜测删除；先重新查看最新 PR 状态。如果触发条件已经消失，按下面 baseline 字段更新并删除 task；如果最新快照变成 agent 可行动，允许把 task 改回 `pending`，并重置 `attemptCount`、`lastAttemptAt`、`nextRetryAt`、`lastError`、`claimedAt`、`runningPid`、`lastOutputAt`、`blockReason`、`blockOwner`、`blockCategory`、`unblockHint`、`blockedSnapshot`。

listener 停止后，人工清除已解决的状态型 task 前，应先用 GitHub 最新快照更新 PR baseline 字段：

- `statusCheckState`
- `reviewDecision`
- `mergeStateStatus`
- `mergeable`
- `isDraft`
- `unresolvedReviewThreadCount`
- `headSha`
- `updatedAt`

`READY_TO_MERGE` 是 notify-only，不应出现在 `event_task.json`。

## 校验

人工编辑后，至少运行 JSON 解析校验：

```powershell
node -e "JSON.parse(require('fs').readFileSync('event_state.json','utf8')); JSON.parse(require('fs').readFileSync('event_task.json','utf8')); console.log('ok')"
```

不要把 `.claude_agent_logs/`、`event_state.json` 或 `event_task.json` 混入贡献提交。
