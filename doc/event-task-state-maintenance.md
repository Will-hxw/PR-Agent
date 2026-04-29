# event task / state 维护规则

本文档说明主 Claude 处理完 task 后如何维护 `event_task.json` 与 `event_state.json`。当前架构没有 task 派发进程；launcher 只刷新 JSON，task 闭环由主 Claude 完成。

## 文件职责

- `event_task.json` 是当前待处理 task 队列，只保留活跃 task。
- `event_state.json.prs[prKey].baseline` 是“已经处理到哪里”的记录。
- `event_state.json.prs[prKey].observed` 是上一次扫描看到的快照，用于识别状态变化，不代表已处理。
- 两个文件必须使用同一个 `runtimeRevision`。

删除 task 前必须推进对应 baseline。只删 `event_task.json` 不推进 baseline，会导致下一轮扫描重建同一个 task。

## 刷新入口

以下入口只负责刷新 runtime JSON：

- `node run-claude-agent.js` 启动时的刷新；
- event listener 每 `3600000ms` 的轮询刷新；
- `update.sh` 一次性刷新。

刷新逻辑统一走 `generateEventJson()`。它会更新 `event_state.json`、`event_task.json` 和 action log，但不会启动 task worker、不会向主 Claude 注入提醒、不会发系统通知。

## task 状态

当前有效状态只有：

- `pending`：等待主 Claude 处理。
- `blocked`：已经识别为外部条件、维护者、人类决策、infra 或暂不可行动，但仍必须由主 Claude 调查、记录、回复或收尾。

旧 runtime 中遗留的 `running` / `dead` 会在加载时归一为 `pending`，交回主 Claude 队列。旧字段 `claimedAt`、`runningPid`、`lastOutputAt`、`resultNonce`、`attemptCount`、`nextRetryAt`、`lastError` 不再写入新的 task。

## 通用删除流程

处理完一个 task 后：

1. 停止并发编辑，确认没有另一个进程正在写 runtime JSON。
2. 读取并解析 `event_state.json` 与 `event_task.json`。
3. 用 `task.id` 精确定位要删除的 task；同时核对 `prKey` 与 `type`。
4. 根据 task 类型推进 `event_state.json.prs[prKey].baseline`。
5. 从 `event_task.json.events` 删除该 task。
6. 给两个文件写入同一个新的 `runtimeRevision`。
7. 重新解析两个 JSON，并检查 `runtimeRevision` 一致。

不要批量删除同一 PR 的所有 task，除非每个 task 都已经按类型完成并推进 baseline。

## 评论类 task

评论类 task 使用独立 category baseline：

- `MAINTAINER_COMMENT` -> `baseline.commentBaselines.maintainer`
- `BOT_COMMENT` -> `baseline.commentBaselines.bot`
- `NEW_COMMENT` -> `baseline.commentBaselines.user`

完成后，把 task 的：

- `boundary.issueCommentCursor`
- `boundary.reviewCommentCursor`
- `boundary.reviewCursor`

复制到对应 category。不要推进其他 category。

同时更新：

- `baseline.updatedAt`
- PR entry 的 `updatedAt`

时间优先使用 `task.boundary.snapshotUpdatedAt`，没有时使用当前 ISO 时间。

## 状态型 task

状态型 task 包括：

- `CI_FAILURE`
- `REVIEW_CHANGES_REQUESTED`
- `NEEDS_REBASE`

主 Claude 处理后，即使底层状态仍然需要 maintainer、contributor、human 或 infra 继续动作，也可以通过“已调查/已回复/已记录阻塞”推进 handled baseline 并删除 task。后续只有相关字段变化、新 commit 或新评论才重新生成 task。

状态型 baseline 应从最新确认过的 PR snapshot 写入：

- `statusCheckState`
- `failingChecks`
- `pendingChecks`
- `reviewDecision`
- `mergeStateStatus`
- `mergeable`
- `isDraft`
- `unresolvedReviewThreadCount`
- `headSha`
- `updatedAt`

`CI_FAILURE` 至少要更新 check 状态和 `headSha`。
`REVIEW_CHANGES_REQUESTED` 至少要更新 review decision、`headSha`，并推进 maintainer comment baseline 到 task boundary。
`NEEDS_REBASE` 至少要更新 merge/rebase 相关字段和 `headSha`。

## 非 task 事件

以下事件只更新 observed/log，不进入 `event_task.json`：

- `CI_PASSED`
- `REVIEW_APPROVED`
- `READY_TO_MERGE`

不要手工把这些事件加入 task 队列。

## revision mismatch

如果两个 JSON 的 `runtimeRevision` 不一致，launcher 会拒绝加载。恢复步骤：

1. 停止 launcher/listener。
2. 分别解析两个 JSON，确认哪个文件较新、哪个 task/baseline 是可信状态。
3. 不要只改其中一个文件的 revision 来绕过检查。
4. 按本文规则同步 task 队列和 baseline。
5. 写入同一个新的 `runtimeRevision`。
6. 运行 JSON 解析校验。

校验命令：

```powershell
node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('event_state.json','utf8')); const t=JSON.parse(fs.readFileSync('event_task.json','utf8')); if (s.runtimeRevision !== t.runtimeRevision) throw new Error('revision mismatch'); console.log('ok')"
```

不要把 `.claude_agent_logs/`、`event_state.json`、`event_task.json` 或 `event_state.json.*.tmp` / `event_task.json.*.tmp` 混入贡献提交。
