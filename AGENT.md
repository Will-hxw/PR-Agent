# AGENT.md

> 适用对象：在本仓库根目录中运行的 Codex / Claude / 代码代理
> 主职责：寻找高质量开源 PR 机会，完成从筛选、分析、修改、提交到 Review 跟进的闭环
> 质量细则：同时遵守 [`doc/pr_rule.md`](doc/pr_rule.md)
---

## 1. 文档分工

- `README.md`：项目入口、启动命令、`run-claude-agent.js` 参数说明。
- `AGENT.md`：代理执行一轮开源贡献的主工作流和硬性约束。
- `doc/pr_rule.md`：判断 PR 是否值得做、如何写 PR、如何回复 Review 的质量规则。

不要在 `AGENT.md` 和 `doc/pr_rule.md` 中重复维护同一类内容。流程写在这里，质量判断写在 `doc/pr_rule.md`。

### 优先级

当规则冲突时，按以下顺序处理：

1. 用户在当前任务中的明确指令。
2. 目标仓库自己的 `CONTRIBUTING.md`、模板、维护者要求和安全规则。
3. 本文件的执行流程。
4. `doc/pr_rule.md` 的 PR 质量细则。

如果目标仓库规则与本地规则不同，优先遵守目标仓库规则，并在记录中写明原因。

---

## 2. 总目标

目标不是“多发 PR”，而是稳定产出高接受率、低噪音、可维护的真实贡献。

必须做到：

- 只选择 GitHub 公开、未归档、仍有维护迹象、上游 stars 大于 50 的项目。
- 一次只推进一个目标仓库；当前仓库进入 `PR 已提交` 或 `已记录放弃` 后，才开始下一个。
- 每个 PR 只解决一个清楚的问题，diff 尽量小。
- 提交前完成与改动范围匹配的验证。
- 每次尝试都在 `records/` 中留下可追溯记录，包括跳过和放弃。
- PR 提交后持续跟进 CI、Review、评论和 merge 状态，直到 merged、closed 或明确放弃。

优先方向：

- Agent / AI tools / automation tools
- skills / developer tools / CLI / productivity tools
- LLM / RAG / inference / eval / prompt tooling
- CV / OCR / multimodal / dataset tooling
- OS / systems / infra / backend / frontend / full-stack
- 文档清楚、测试可运行、维护者活跃的小中型项目

---

## 3. 工作目录与 Git 约束

工作根目录：

```text
<repo-root>
```

建议结构：

```text
<repo-root>
|-- AGENT.md
|-- doc/
|-- README.md
|-- run-claude-agent.js
|-- agent.config.example.json
|-- candidates/          # 候选仓库工作副本
|   `-- owner_repo/
|-- records/             # 每次尝试的记录
|   `-- owner_repo.md
|-- .claude_agent_logs/  # 运行日志，禁止纳入贡献内容
```

硬性要求：

- 开始和结束任务时都检查 `git status --short --branch`。
- 不要删除因为“暂时没有找到 PR 点”而 clone 下来的候选仓库。
- 修改本仓库文档或脚本时，同样遵守最小改动和验证要求。
- 对目标仓库开发时，不在 `main` / `master` 上直接提交；使用语义化短分支名。

---

## 4. 状态机

每轮工作只处于以下一个状态：

```text
STARTUP
-> MONITOR_OPEN_PRS
-> SCOUT
-> TRIAGE
-> LOCK_TARGET
-> IMPLEMENT
-> VALIDATE
-> SUBMIT_PR
-> RECORD
-> MONITOR_OPEN_PRS
-> FINISHED or SKIPPED
```

如果 Review 或 CI 产生新事件，优先回到 `MONITOR_OPEN_PRS` 处理已有 PR，再决定是否继续寻找新项目。

---

## 5. 启动步骤

每次新任务开始时按顺序执行：

1. 确认当前目录是本仓库根目录，或启动脚本时通过 `--cwd` 指向本仓库根目录。
2. 阅读本文件和 `doc/pr_rule.md`。
3. 确认 `agent.config.json` 或 `PR_AGENT_CONTRIBUTOR_LOGIN` 提供了当前贡献者的 GitHub 登录名。
4. 检查 `git status --short --branch`，确认本仓库是否已有未处理改动。
5. 确保 `records/`、`candidates/` 存在；不存在则创建。
6. 先检查所有 open PR 状态，再开始新的 scout。

检查 open PR 必须以 GitHub 当前数据为准，不能凭记忆：

```powershell
$login = if ($env:PR_AGENT_CONTRIBUTOR_LOGIN) { $env:PR_AGENT_CONTRIBUTOR_LOGIN } else { (Get-Content agent.config.json | ConvertFrom-Json).contributorLogin }
$items = @()
for ($page = 1; $page -le 10; $page++) {
  $result = gh api --method GET search/issues -f q="author:$login is:pr state:open" -F per_page=100 -F page=$page -f sort=updated | ConvertFrom-Json
  $pageItems = @($result.items)
  $items += $pageItems
  if ($pageItems.Count -lt 100) { break }
}
$items |
  Where-Object { ($_.repository_url -replace '^https://api.github.com/repos/', '') -notlike "$login/*" } |
  Select-Object number,html_url,@{Name='repository';Expression={$_.repository_url -replace '^https://api.github.com/repos/', ''}}
```

对需要处理的 PR，再查看完整状态：

```bash
gh pr view <number> --repo <owner>/<repo> --json mergeStateStatus,reviewDecision,statusCheckRollup,isDraft,mergeable
gh pr checks <number> --repo <owner>/<repo>
gh api repos/<owner>/<repo>/issues/<number>/comments
gh api repos/<owner>/<repo>/pulls/<number>/comments
gh api repos/<owner>/<repo>/pulls/<number>/reviews
```

---

## 6. 主工作流

### 6.1 Monitor：先处理已有 PR

只要存在 open PR，就先确认：

- CI 是否失败、挂起或需要重跑。
- 是否有维护者、人类 reviewer、bot 的新评论。
- `reviewDecision` 是否变为 `CHANGES_REQUESTED` 或 `APPROVED`。
- `mergeStateStatus` 是否变为 `BEHIND`、`BLOCKED`、`DIRTY`。
- 本地记录是否需要更新。

CI 失败优先级最高。必须先获取失败详情，再进入对应 `candidates/` 仓库本地复现和修复。不要在没有日志或测试证据时猜根因。

### 6.2 Scout：寻找候选项目

候选项目必须满足：

- GitHub 公开仓库。
- 上游 stars 大于 50。
- 未归档。
- 有近期维护迹象。
- 没有明显拒绝外部贡献。
- 本地验证成本可控，至少能完成静态检查或针对性验证。

可以通过 issue、PR、代码、文档、examples、CI 配置、README 命令等寻找切入点；不要求必须基于已有 issue。

### 6.3 Triage：筛掉不适合的项目

对候选项目做快速证据检查：

- 阅读 `README.md`、`CONTRIBUTING.md`、PR / issue 模板。
- 查找类似 issue 和 PR，避免重复劳动。
- 判断改动是否足够小，是否能独立验证。
- 判断维护者是否可能接受该类贡献。
- 记录跳过原因，不要强行制造低价值 PR。

如果基于某个 issue 工作，先做重叠检查：

```bash
gh issue view <number> --repo <owner>/<repo>
gh pr list --repo <owner>/<repo> --search "<issue-number> in:title,body" --state open
```

发现已有实质性 PR 覆盖同一问题时，停止该方向并记录跳过原因。

### 6.4 Lock Target：锁定一个仓库和一个问题

一旦锁定目标：

- 停止寻找新仓库。
- 不并行开启第二条 PR 线。
- 将问题压缩为一个可解释的单点改动。
- 按 `doc/pr_rule.md` 判断该改动是否值得直接 PR，还是应先开 issue。

如果无法用三到五句话说明“问题是什么、为什么存在、改了什么、如何验证”，说明目标还不够成熟。

### 6.5 Implement：最小实现

实施要求：

- clone 或更新到 `candidates/<owner_repo>/`。
- 添加 upstream 并确认 base 分支。
- 从干净 base 建分支，例如 `fix/handle-empty-config`、`docs/fix-install-command`。
- 只改与当前问题直接相关的文件。
- 跟随项目已有风格、测试框架和错误处理方式。
- 不引入新依赖、配置变更、锁文件变化，除非这是当前问题的必要部分。
- 不做无关格式化、重命名、重构或“顺手修复”。

### 6.6 Validate：提交前验证

优先运行项目提供的验证命令：

- 单元测试或目标测试文件。
- lint。
- typecheck。
- build。
- README 命令或复现步骤的手工验证。

如果不能完整运行，必须写清：

- 未运行的命令。
- 原因。
- 已完成的替代验证。
- 剩余风险。

不要把未运行的测试写成“通过”。

### 6.7 Submit：提交与创建 PR

提交前检查：

```bash
git status --short
git diff --stat
git diff
```

提交要求：

- Commit message 使用 Conventional Commits：`<type>(<scope>): <subject>`。
- 一个 commit 只做一类事情。
- PR 标题与 commit 语义一致。
- PR 描述包含 Summary、Why、Validation、Related issue（如有）。

所有 PR 必须通过 `gh pr create` 创建。禁止以“需要手动创建 PR”为理由停止。

```bash
git push origin <branch-name>
gh pr create --repo <owner>/<repo> --base <base-branch> --head <fork-owner>:<branch-name> --title "<title>" --body "<body>"
```

如果 `gh pr create` 失败，先定位具体原因：

- 认证或权限问题：检查 `gh auth status`。
- 分支不存在：确认 `git push` 是否成功。
- 已有 PR：用 `gh pr view` 获取 URL 并记录。
- 仓库要求 issue 或模板：遵守上游规则后重试。

### 6.8 Record：记录结果

每次尝试都更新 `records/<owner_repo>.md`，无论 PR 是否发出。

文件名规则：小写，将 `/` 替换为 `_`，必要时追加 issue 或 PR 编号。

最小模板：

```md
# owner/repo

## 基本信息
- Date:
- URL:
- Stars:
- Category:
- Local path:
- Why chosen:

## 问题与改动
- Problem found:
- Evidence:
- Existing issue / PR check:
- Change made:
- Validation:

## 结果
- Issue:
- PR:
- Result: submitted | skipped | abandoned | waiting-review | merged | closed
- Reason:
- Notes:

## Review 状态
- Current state: WAITING | CHECKING | RESPONDING | BLOCKED | FINISHED
- CI:
- Review decision:
- Merge state:
- Last checked:
- Comment count:
```

记录要具体写事实，不写空泛结论。

---

## 7. Review 与 CI 跟进

PR 提交后，工作没有结束。

必须持续关注：

- CI / checks。
- reviewer 评论。
- bot review 评论。
- maintainer 评论。
- mergeability 和 rebase 状态。

事件处理顺序：

1. `CI_FAILURE` / `ERROR`：立即查看日志，本地复现，修复并 push。
2. `CHANGES_REQUESTED`：逐条阅读 review，修改或解释，并回复原线程。
3. 维护者评论：优先理解意图，再决定修改、回答或放弃。
4. bot 评论：逐条判断是否真实问题，不能因为是 bot 就忽略。
5. `BEHIND` / 冲突：确认上游变化后 rebase 或 merge upstream，避免无谓冲突。

回复 review 时：

- 对 inline review comment，回复原 review thread，不发散成顶层评论。
- 用英文回复英文项目。
- 说明做了什么，不写防御性长篇解释。
- 如果不采纳建议，给出具体原因。

可以放弃跟进的情况：

- 维护者明确拒绝且理由充分。
- 需要重大架构变更，超出当前小 PR 范围。
- 上游已有更合适方案。
- 目标仓库明确不接受该类贡献。
- 长时间无响应且继续跟进收益很低。

放弃也必须记录原因和当前状态。

---

## 8. 自动化与事件监听

`run-claude-agent.js` 是本目录的主启动脚本。它负责：

- 启动 Claude CLI。
- 通过 `stream-json` 发送初始提示和空闲提醒。
- 可选开启事件监听。
- 写入运行日志。

脚本只负责调度和提醒，不替代工程判断。任何修改、提交和 PR 仍必须按本文件与 `doc/pr_rule.md` 执行。

事件监听的运行规则：

- task-backed 事件统一进入 subagent，不再依赖主会话手工完成闭环。
- 目前 task-backed 事件包括：`CI_FAILURE`、`REVIEW_CHANGES_REQUESTED`、`MAINTAINER_COMMENT`、`BOT_COMMENT`、`NEW_COMMENT`、`NEEDS_REBASE`。
- 启动时和每次轮询必须调用同一个 `generateEventJson()` 入口生成 `event_state.json` / `event_task.json`；subagent 派发只能发生在该入口完成并保存之后。
- `CI_PASSED`、`REVIEW_APPROVED`、`READY_TO_MERGE` 只通知，不写 task。
- 去重语义是“同 `prKey + type` 的 task 仍存在时不重复建 task”，不是全局唯一。
- task 成功后会直接从 `event_task.json` 删除：subagent 完成时输出结构化 `task result`，由 launcher 自动删除、block 或 retry；主代理亲自处理并确认完成时，可以直接删除对应 task 条目；失败会重试，达到上限后进入 `dead`。
- 主代理手工删除 task 前，必须先按 `doc/event-task-state-maintenance.md` 更新 `event_state.json` 的 handled baseline；只删除 `event_task.json` 不代表事件已处理，下一次扫描可能重新生成同类 task。
- `CI_FAILURE`、`REVIEW_CHANGES_REQUESTED`、`NEEDS_REBASE` 这类状态型 task 只有在 GitHub 最新状态里的触发条件消失后才允许清除；如果 subagent 报告 `resolved` 但触发条件仍存在，应进入 `blocked`；如果报告 `blocked` / `needs_human`，launcher 直接保留为 `blocked`。
- 状态型 task 会先按 actionability 分类：明确需要 contributor、maintainer、人类决策或基础设施处理的任务直接 `blocked`；agent 可行动或无法确定的任务才允许自动派发。
- `pending` / `dead` task 只在底层触发条件仍然成立时继续保留；如果触发条件消失，会在后续扫描中自动回收，不再阻塞 dedupe。
- 评论 backlog 按 `MAINTAINER_COMMENT`、`BOT_COMMENT`、`NEW_COMMENT` 三类独立跟踪，同一轮扫描里可以并存，不再折叠成单条评论 task。
- 配置的 contributor login 自己发布的评论和 review 不生成 `NEW_COMMENT`，避免 agent 回复后再把自己的回复派发成新任务。

运行产物：

- `.claude_agent_logs/claude_stream_*.jsonl`
- `.claude_agent_logs/claude_actions_*.log`
- `event_state.json`
- `event_task.json`

这些文件是本地运行状态，不属于开源贡献内容。

`event_task.json` 中 task 状态说明：

- `pending`：等待派发。
- `running`：当前 launcher 已 claim 并启动 subagent。
- `blocked`：subagent 或 launcher 判断当前任务不应继续普通重试，需要人工、外部条件或维护者决策。
- `dead`：达到自动重试上限；仅当底层触发条件仍然存在时继续阻塞同 `prKey + type` 的去重，触发条件消失后会被自动回收。

`blocked` task 通过 `blockOwner`、`blockCategory`、`unblockHint` 和 `blockedSnapshot` 说明阻塞责任、类别、解除条件和当时看到的 GitHub 状态；不要把 `needs_human` 或 `needs-contributor-action` 当作独立 status。

`running` task 会记录 `claimedAt`、`runningPid` 和 `lastOutputAt`；重启恢复时优先按最后输出时间判断是否超时。

如果 `dead` task 阻塞了后续同类事件，人工处理方式只有两种：

- 直接删除该 task 条目，彻底解除阻塞。
- 手动改回 `pending`，并同时重置 `attemptCount`、`lastAttemptAt`、`nextRetryAt`、`lastError`、`claimedAt`、`runningPid`、`lastOutputAt`、`blockOwner`、`blockCategory`、`unblockHint`、`blockedSnapshot`。

`event_state.json` 中评论 baseline 采用 category-scoped 结构：

- `commentBaselines.maintainer.issueCommentCursor`
- `commentBaselines.maintainer.reviewCommentCursor`
- `commentBaselines.maintainer.reviewCursor`
- `commentBaselines.bot.issueCommentCursor`
- `commentBaselines.bot.reviewCommentCursor`
- `commentBaselines.bot.reviewCursor`
- `commentBaselines.user.issueCommentCursor`
- `commentBaselines.user.reviewCommentCursor`
- `commentBaselines.user.reviewCursor`

评论 task 成功时，只推进对应 category 的 cursor；其他 category 的 baseline 不会被一并推进。手工维护步骤见 `doc/event-task-state-maintenance.md`。

如果运行环境支持 subagent，且任务能独立并行，可用于信息收集、CI 失败调查或多个 PR 状态检查。主代理必须保留最终决策权，并避免多个 agent 同时修改同一工作树。

---

## 9. 输出风格

所有分析、记录、PR 描述和 Review 回复都应满足：

- 具体。
- 克制。
- 基于证据。
- 不把猜测写成事实。
- 不使用营销式表达。
- 不用“做了一些优化”“修复若干问题”这类空话。

推荐写法：

- `fix README install command by adding the missing --config flag`
- `add regression coverage for empty parser input`
- `handle null payload before reading nested fields`

---

## 10. 完成标准

一次工作完成时，必须满足以下之一：

- PR 已通过 `gh pr create` 创建，并已记录 URL、验证方式和后续状态。
- 明确跳过或放弃，并已记录原因、证据和是否值得未来再看。
- Review / CI 事件已处理，并已记录结果。

没有记录，就不算完成。
