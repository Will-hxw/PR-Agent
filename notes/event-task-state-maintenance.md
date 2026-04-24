# event task / state 手工维护规则

本文档只说明 `event_task.json` 与 `event_state.json` 的手工维护规则。

## 核心规则

- `event_task.json` 只是当前活跃任务队列。
- `event_state.json.prs[prKey].baseline` 才是“已处理到哪里”的记录。
- 删除 task 不等于标记底层事件已处理。
- 如果删除评论类 task，但没有推进对应评论 baseline，下一次扫描可能重新生成同一个 `MAINTAINER_COMMENT`、`BOT_COMMENT` 或 `NEW_COMMENT` task。
- `event_state.json.prs[prKey].observed` 是上次看到的快照，用于判断状态变化通知；不要把 `observed` 当作已处理标记。

## 优先路径

subagent 派发的任务不要手工编辑两个 JSON 文件。subagent 完成工作后输出成功 ack，launcher 会刷新 GitHub 状态、推进对应 state baseline，并删除 task。

只有主 Agent 亲自处理并确认某个 task 已完成时，才需要手工维护 JSON。

## 评论类 task 完成后如何更新

评论类 task 使用 category-scoped baseline：

- `MAINTAINER_COMMENT` -> `baseline.commentBaselines.maintainer`
- `BOT_COMMENT` -> `baseline.commentBaselines.bot`
- `NEW_COMMENT` -> `baseline.commentBaselines.user`

主 Agent 手工完成评论类 task 时：

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

只有重新检查 GitHub 并确认触发条件已经消失后，才允许手工清除：

- `CI_FAILURE`：最新 status checks 不再失败。
- `REVIEW_CHANGES_REQUESTED`：最新 review decision 不再是 `CHANGES_REQUESTED`。
- `NEEDS_REBASE`：最新 `mergeStateStatus` 不再是 `BEHIND` / `DIRTY`，且 `mergeable` 不是 `CONFLICTING`。

如果触发条件仍然存在，保留 task。直接删除只会让 scanner 重新生成 task，或者隐藏真实待处理工作。

手工清除已解决的状态型 task 前，应先用 GitHub 最新快照更新 PR baseline 字段：

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

手工编辑后，至少运行 JSON 解析校验：

```powershell
node -e "JSON.parse(require('fs').readFileSync('event_state.json','utf8')); JSON.parse(require('fs').readFileSync('event_task.json','utf8')); console.log('ok')"
```

不要把 `.claude_agent_logs/`、`event_state.json` 或 `event_task.json` 混入贡献提交。
