# event task / state 手工维护规则

本文档只说明 `event_task.json` 与 `event_state.json` 的人工维护规则。正常路径下，task-backed 事件由 launcher/subagent claim 并处理，主 Agent 不直接处理、删除或手工编辑 task。

## 操作前提

- `update.sh` 只用于按启动路径刷新 JSON，不是人工删除或确认 task 的替代入口；如果 active listener lock 存在，它会 skipped，不代表已经刷新成功；如果 open PR search 失败，它会以 strict refresh 失败退出，不能把旧 JSON 当作成功刷新结果。
- `event_state.json` 与 `event_task.json` 的 `runtimeRevision` 必须保持一致；人工编辑两个文件时不要改成不同 revision。
- 如果 listener 无法停止，先不要编辑 JSON；应记录需要处理的 `task.id`、`prKey`、`type` 和最新 GitHub 状态，等 listener 停止后再维护。

## 核心规则

- `event_task.json` 只是当前活跃任务队列。
- `event_state.json.prs[prKey].baseline` 才是“已处理到哪里”的记录。
- 删除 task 不等于标记底层事件已处理。
- 如果删除评论类 task，但没有推进对应评论 baseline，下一次扫描可能重新生成同一个 `MAINTAINER_COMMENT`、`BOT_COMMENT` 或 `NEW_COMMENT` task。
- `event_state.json.prs[prKey].observed` 是上次看到的快照，用于判断状态变化通知；不要把 `observed` 当作已处理标记。

## 优先路径

subagent 派发的任务不要手工编辑两个 JSON 文件。subagent 完成工作后输出带 `nonce` 的结构化 `task result`，launcher 只接受最终消息中的唯一 result 行，然后刷新 GitHub 状态，并按结果推进 state baseline、删除 task、block task 或进入 retry。comment-backed task 报告 `resolved` / `not_actionable` 时必须带 `evidence`（`replyUrl`、`checkedCommand`、`reasonCategory` 或 `rationale` 之一），否则 launcher 会拒绝结果并保持 task 可重试。

只有 listener 已停止、且需要人工确认或解除异常 runtime 状态时，才需要人工维护 JSON。

## 一次性刷新

普通 `node run-claude-agent.js` 不刷新 `event_state.json` / `event_task.json`，也不会派发 PR event task。runtime JSON 只由以下入口刷新：

- `node run-claude-agent.js --enable-event-listener` 的启动刷新和后续轮询。
- `update.sh` 的一次性刷新。

`update.sh` 复用启动刷新路径，但不启动 subagent 派发。结果语义如下：

- `event JSON updated`，退出码 `0`：本次刷新完成。
- `event JSON skipped: active listener lock`，退出码 `2`：已有 listener 正在持有 lock，本次没有刷新。
- `event JSON update failed: ...`，退出码 `1`：刷新失败，需要按错误信息定位。

`update.sh` 背后的 GitHub 请求统一通过串行 `gh` 队列执行，并对 `EOF`、TLS handshake、`schannel`、connection reset、timeout 等临时传输错误做有限重试；404/410/not found 代表业务结果，不应按传输错误重试。若失败集中在代理链路，可用 `PR_AGENT_GH_PROXY_MODE=direct bash update.sh` 临时验证，该模式只清除 `gh` 子进程的 proxy 环境变量。

event listener 的轮询刷新必须先完成再派发。open PR search 失败时，本轮不派发任何旧 task；单个 PR snapshot 刷新失败时，本轮跳过该 `prKey` 的 task 派发，避免基于陈旧状态启动 subagent。

## 评论类 task 完成后如何更新

评论类 task 使用 category-scoped baseline：

- `MAINTAINER_COMMENT` -> `baseline.commentBaselines.maintainer`
- `BOT_COMMENT` -> `baseline.commentBaselines.bot`
- `NEW_COMMENT` -> `baseline.commentBaselines.user`

`BOT_COMMENT` 的正常自动路径会跟踪触发 task 的 bot review comment ID；这些 review comment 全部出现非 bot 回复后，listener 会推进 `baseline.commentBaselines.bot` 并删除该 task。人工维护只用于 listener 停止后仍需修复异常 runtime 状态的情况。

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
`mergeStateStatus=BLOCKED` 只是 GitHub 汇总状态信号，不是 task-backed 事件；它不应单独生成 `NEEDS_REBASE` 或其他 task。是否需要行动由 status checks、review decision、mergeable、draft、unresolved threads 等具体字段判断。

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

## revision mismatch 恢复

`event_state.json` 与 `event_task.json` 的 `runtimeRevision` 不一致时，launcher 会拒绝加载并输出 state/task 文件路径、revision、mtime 和恢复提示。该错误通常说明两个 JSON 来自不同保存轮次，继续派发会造成 baseline 与 task 队列不一致。

处理步骤：

1. 停止 event listener / launcher，确认没有进程继续写入 runtime JSON。
2. 记录错误信息中的两个文件路径、revision、mtime 和 size。
3. 分别解析两个 JSON，确认哪一份是较新的可信状态；不要只改其中一个 `runtimeRevision` 来绕过检查。
4. 如果有备份或版本快照，恢复同一轮次的 `event_state.json` 与 `event_task.json`。
5. 如果必须人工修复，按本文档规则同步 baseline 和 task 队列后，再让两个文件使用同一个新的 `runtimeRevision`。
6. 运行下方 JSON 解析校验后再重启 listener。

## 校验

人工编辑后，至少运行 JSON 解析校验：

```powershell
node -e "JSON.parse(require('fs').readFileSync('event_state.json','utf8')); JSON.parse(require('fs').readFileSync('event_task.json','utf8')); console.log('ok')"
```

不要把 `.claude_agent_logs/`、`event_state.json`、`event_task.json` 或 `event_state.json.*.tmp` / `event_task.json.*.tmp` 混入贡献提交。
