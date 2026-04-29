# Task 处理规范

本文档定义主 Claude 处理 `event_task.json` 的标准。任何 task 都必须处理，不能因为它看起来像通知、提示、bot 评论、外部阻塞或暂时不可行动就跳过。

## 总原则

1. 启动后先读取 `event_task.json` 和 `event_state.json`。
2. 只要 `event_task.json.events` 非空，就先处理 task 队列，不先 scout 新 PR。
3. `pending` 和 `blocked` task 都要纳入主 Claude 队列处理。
4. 每个 task 都要形成可审查结果：已修复、已回复、已确认无需行动、已记录阻塞原因，或已明确放弃并记录原因。
5. 处理完后必须按 `doc/event-task-state-maintenance.md` 同步更新 `event_state.json` baseline，并从 `event_task.json` 删除对应 task。
6. 只删除 task 不算完成；未推进 baseline 的 task 可能在下一轮扫描中重建。

## 通用处理步骤

对每个 task 按以下顺序执行：

1. 记录 `task.id`、`task.prKey`、`task.type`、`task.status`、`task.boundary` 和 `task.details`。
2. 用 `gh pr view`、`gh pr checks`、issue comments、review comments、reviews 等命令读取最新 PR 状态。
3. 对照 task 类型判断该做什么行动。
4. 如果需要代码修改，在 `candidates/<owner_repo>/` 中完成修改、提交、push，并保留验证证据。
5. 如果需要回复评论或 review thread，必须回复；不要把评论 task 当成“通知”忽略。
6. 如果暂时无法由 agent 解决，也要调查并记录阻塞 owner、原因、最新证据和下一次可行动条件。
7. 完成后更新 `event_state.json` 对应 baseline，再从 `event_task.json` 删除该 task。
8. 处理一个 task 后重新读取 `event_task.json`，继续队列。

## `CI_FAILURE`

必须处理失败 CI：

- 查看失败项：`gh pr checks <number> --repo <owner>/<repo>`。
- 必要时打开失败 job 日志或 workflow run。
- 判断失败属于代码、测试、格式、类型、构建、配置、权限、外部服务还是维护者侧条件。
- 如果 agent 可修复，必须本地修复、验证、commit、push。
- 如果是维护者权限、secret、label、外部服务或 contributor metadata 阻塞，必须记录证据和阻塞 owner。

完成条件：

- 已修复并 push，或已确认最新失败不由 agent 可解决但已记录/回复；
- baseline 记录当前 `statusCheckState`、`failingChecks`、`pendingChecks`、`headSha`；
- 删除对应 task。

## `REVIEW_CHANGES_REQUESTED`

必须处理 review requested changes：

- 读取 reviews 和 review comments。
- 逐条判断 reviewer 真实意图。
- 需要改代码时，修改、验证、commit、push。
- 需要解释时，回复原 review thread，不用顶层评论替代 inline thread。
- 如果 review decision 仍是 `CHANGES_REQUESTED`，但所有可行动内容已处理，也要推进 baseline 并删除 task；后续新 review/comment 会生成新 task。

完成条件：

- 已修改或回复所有当前可行动 review 内容；
- `baseline.reviewDecision`、`headSha` 和 maintainer comment baseline 已推进到该 task boundary；
- 删除对应 task。

## `MAINTAINER_COMMENT`

维护者评论永远不能当作普通通知忽略。

必须：

- 阅读评论原文和上下文；
- 判断是要求修改、询问、建议、拒绝、说明 merge 条件还是纯状态更新；
- 需要修改时修改并回复；
- 需要回答时直接回复；
- 不需要行动时记录理由，例如 maintainer 明确表示等待、已解决或只是说明状态。

完成条件：

- 已回复、已修改并回复，或已记录不需要回复的明确原因；
- 仅推进 `commentBaselines.maintainer`；
- 删除对应 task。

## `BOT_COMMENT`

Bot 评论不能因为来源是 bot 就忽略。

必须：

- 判断 bot 是 CI/reporting bot、review bot、format bot、security bot、CLA/DCO bot 还是 repository automation；
- 对真实问题采取行动；
- 对已处理或误报的问题留下必要回复或记录；
- 对 bot review comments，确认是否已经出现非 bot 回复；如果已全部有人回复，扫描器可自动清理，否则主 Claude 必须处理。

完成条件：

- 已修复、已回复、或已记录不需要行动的证据；
- 仅推进 `commentBaselines.bot`；
- 删除对应 task。

## `NEW_COMMENT`

`NEW_COMMENT` 表示非维护者、非 bot、非当前 contributor 的新评论或 review 活动。

必须：

- 阅读评论上下文；
- 判断是否需要回复、修改、澄清或记录；
- 如果只是用户提问，也要回答；
- 如果是噪音、重复或与 PR 无关，也要记录处理理由。

完成条件：

- 已做必要回复/修改，或已记录无需行动的理由；
- 仅推进 `commentBaselines.user`；
- 删除对应 task。

## `NEEDS_REBASE`

必须处理 rebase/mergeability 问题：

- 查看最新 `mergeStateStatus`、`mergeable`、base/head 分支。
- `BEHIND` 通常需要 fetch upstream 后 rebase 或 merge base。
- `DIRTY` / `CONFLICTING` 需要解决冲突。
- 如果是上游策略或权限导致不能 rebase，记录阻塞 owner 和证据。

完成条件：

- 已 rebase/解决冲突并 push，或已记录明确阻塞；
- baseline 更新 `mergeStateStatus`、`mergeable`、`isDraft`、`unresolvedReviewThreadCount`、`headSha` 等状态字段；
- 删除对应 task。

## 非 task 事件

以下事件不进入 `event_task.json`：

- `CI_PASSED`
- `REVIEW_APPROVED`
- `READY_TO_MERGE`

它们只更新 observed/log 状态。主 Claude 不需要删除 task，但如果在 PR 跟进中看到这些状态，应记录到项目记录里。

## 阻塞也必须闭环

外部阻塞不是跳过理由。阻塞 task 的完成方式是：

- 调查最新 GitHub 状态；
- 明确阻塞 owner：`contributor`、`maintainer`、`human`、`infra` 或 `automation`；
- 记录证据、命令和下一步条件；
- 必要时回复 PR；
- 推进 handled baseline 并删除 task，等待后续新状态或新评论重新生成 task。
