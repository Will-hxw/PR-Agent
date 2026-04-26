# PR Agent

PR Agent 是一个用于持续寻找、提交和跟进 GitHub 开源 PR 的本地工作区。核心目标是产出小而准确、容易被维护者接受的真实贡献，而不是批量制造低质量 PR。

---

## 文档入口

- [`AGENT.md`](AGENT.md)：代理执行工作流。先读这里。
- [`doc/pr_rule.md`](doc/pr_rule.md)：PR 质量、范围、验证和 Review 协作规则。
- [`run-claude-agent.js`](run-claude-agent.js)：Claude CLI 启动与提醒脚本。

职责边界：

- 流程写在 `AGENT.md`。
- PR 质量判断写在 `doc/pr_rule.md`。
- 启动方式和脚本参数写在 `README.md`。

---

## 工作区结构

```text
<repo-root>
|-- AGENT.md
|-- doc/pr_rule.md
|-- README.md
|-- run-claude-agent.js
|-- agent.config.example.json
|-- LICENSE
|-- candidates/          # clone 下来的候选仓库
|-- records/             # 每个项目的尝试记录
`-- .claude_agent_logs/  # 脚本运行日志
```

运行产物和候选仓库默认不应混入提交。开始和结束工作时都检查：

```bash
git status --short --branch
```

---

## 前置要求

- Node.js 可用。
- Claude CLI 可用，Windows 默认命令为 `claude.cmd`。
- GitHub CLI `gh` 已登录并有创建 PR 的权限。
- Git 可用。
- 网络能访问 GitHub。

快速检查：

```bash
node --version
gh auth status
git --version
node --check run-claude-agent.js
```

---

## 本地配置

公开仓库不保存个人 GitHub 登录名。首次运行事件监听前，复制示例配置并填写自己的账号：

```bash
cp agent.config.example.json agent.config.json
```

Windows PowerShell 可用：

```powershell
Copy-Item agent.config.example.json agent.config.json
```

`agent.config.json` 示例：

```json
{
  "contributorLogin": "your-github-login"
}
```

也可以不创建本地配置文件，改用环境变量：

```bash
PR_AGENT_CONTRIBUTOR_LOGIN=your-github-login node run-claude-agent.js --enable-event-listener
```

PowerShell：

```powershell
$env:PR_AGENT_CONTRIBUTOR_LOGIN = "your-github-login"
node run-claude-agent.js --enable-event-listener
```

---

## 快速启动

最简启动：

```bash
node run-claude-agent.js
```

推荐启动事件监听；PR review 和 CI 检查统一通过 event listener 处理：
```bash
node run-claude-agent.js \
  --idle-seconds 300 \
  --initial-delay-seconds 8 \
  --nudge-cooldown-seconds 30 \
  --max-nudges 0 \
  --effort max \
  --claude-command claude.cmd \
  --enable-event-listener \
  --event-poll-interval 3600000 \
  --event-notification \
  --event-subagent
```
---

## 脚本做什么

`run-claude-agent.js` 封装 Claude CLI 的 `stream-json` 模式，主要负责：

- 启动 Claude。
- 发送初始 prompt。
- 在长时间无输出时自动补发提醒。
- 可选轮询 GitHub PR 事件并提醒处理 review、CI、评论和 merge 状态变化。
- 写入结构化运行日志。

脚本只负责调度。是否值得改、怎么改、怎么验证、是否提交 PR，仍以 `AGENT.md` 和 `doc/pr_rule.md` 为准。

---

## PR 目标规则

- 只向 upstream 开源仓库创建 PR，不要向自己的 fork 或个人仓库创建 PR。
- 如果目标仓库在 `<contributor-login>/*` 下，先确认它是否只是 fork；fork 内部 PR 不会把改动送到上游，不能作为开源贡献结果记录。
- 正确流程是把分支 push 到自己的 fork，然后用 `gh pr create --repo <upstream-owner>/<upstream-repo> --head <fork-owner>:<branch-name>` 向 upstream 创建 PR。
- 事件监听生成 `event_state.json` / `event_task.json` 时会跳过 `agent.config.json` 中 `contributorLogin` 名下的 open PR，避免把自己的 fork PR 纳入 review / CI 跟进队列。

---

## CLI 参数

### 基础参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--cwd` | 当前仓库根目录 | Claude 工作目录；`event_state.json` / `event_task.json` 仍固定写入 launcher 根目录 |
| `--prompt` | 内置提示 | 发送给 Claude 的初始提示和后续提醒内容 |
| `--claude-command` | Windows: `claude.cmd`；其他平台: `claude` | Claude CLI 命令 |
| `--effort` | `max` | Claude 思考强度：`low` / `middle` / `high` / `xhigh` / `max` |
| `--show-thinking` | `false` | 在终端显示 thinking 事件 |
| `--show-raw-events` | `false` | 打印原始 JSON 事件 |
| `--help`, `-h` | - | 显示帮助 |

### 空闲提醒参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--idle-seconds` | `300` | 连续无输出多少秒后补发提示 |
| `--initial-delay-seconds` | `8` | 启动后等待多少秒发送首条提示 |
| `--nudge-cooldown-seconds` | `30` | 两次提醒之间的最小间隔 |
| `--max-nudges` | `0` | 最大提醒次数；`0` 表示不限制 |

### 事件监听参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--enable-event-listener` | `false` | 开启 GitHub PR 事件轮询 |
| `--event-poll-interval` | `3600000` | 事件轮询间隔，单位毫秒，默认 1 小时 |
| `--event-notification` | `true` | 开启系统通知 |
| `--no-event-notification` | - | 关闭系统通知 |
| `--event-subagent` | `true` | task-backed 事件使用子任务处理 |
| `--no-event-subagent` | - | 禁用 subagent；与 `--enable-event-listener` 冲突并直接报错退出 |

---

## 监控模式

脚本只保留事件监听作为 PR review / CI 检查入口：

| 模式 | 开关 | 用途 |
|---|---|---|
| Event listener | `--enable-event-listener` | 轮询 open PR，发现 CI、Review、评论、merge 状态变化 |

事件模型分为两类：

- task-backed：`CI_FAILURE`、`REVIEW_CHANGES_REQUESTED`、`MAINTAINER_COMMENT`、`BOT_COMMENT`、`NEW_COMMENT`、`NEEDS_REBASE`
- notify-only：`CI_PASSED`、`REVIEW_APPROVED`、`READY_TO_MERGE`

事件监听的硬规则：

- 启动时和每次轮询必须调用同一个 `generateEventJson()` 入口生成 `event_state.json` / `event_task.json`；subagent 派发只能发生在该入口完成并保存之后，启动刷新产生的 runnable task 也由 launcher/subagent claim，不交给主 Agent 手工处理。
- 只要 `event_task.json` 中仍存在同 `prKey + type` 的 task，就视为去重命中，不会重复建 task。
- task 成功后直接从 `event_task.json` 删除，不保留 handled 历史项；subagent 完成时输出结构化 `task result`，由 launcher 自动删除、block 或 retry。
- 主 Agent 不直接处理、删除或手工编辑 task。只有在 listener 已停止、且需要人工维护运行时 JSON 时，才按 `doc/event-task-state-maintenance.md` 更新 `event_state.json` 的 handled baseline 并清理对应 task。
- task 失败最多自动尝试 5 次；超过上限后变成 `dead`。`dead` 只在底层触发条件仍然存在时继续阻塞同类事件；如果触发条件消失，会在后续扫描中自动回收。
- `CI_FAILURE`、`REVIEW_CHANGES_REQUESTED`、`NEEDS_REBASE` 这类状态型 task 只有在 GitHub 最新状态里的触发条件消失后才允许清除；如果 subagent 报告 `resolved` 但触发条件仍存在，应进入 `blocked`，如果报告 `blocked` / `needs_human`，launcher 直接保留为 `blocked`。
- 状态型 task 在扫描和失败重试前会先做 actionability 分类：明确需要 contributor、maintainer、人类决策或基础设施处理的任务直接进入 `blocked`，只有 agent 可行动或无法确定的任务才会进入自动派发。
- 成功后的状态刷新以 GitHub 最新数据为准；评论类 cursor 只推进到 task 创建时的 boundary，然后立即对该 PR 局部重扫，避免吞掉处理中途到达的新评论。
- 评论 backlog 按 `MAINTAINER_COMMENT`、`BOT_COMMENT`、`NEW_COMMENT` 三类独立跟踪，同一轮扫描里最多可并存三条评论 task。
- 配置的 contributor login 自己发布的评论和 review 不生成 `NEW_COMMENT`，避免 agent 回复后再把自己的回复派发成新任务。

具体处理流程以 `AGENT.md` 的 Review / CI 跟进规则和 `doc/event-task-state-maintenance.md` 的状态维护规则为准。

---

## 运行产物

日志写入：

```text
<repo-root>/.claude_agent_logs/
|-- claude_stream_YYYYMMDD_HHMMSS.jsonl
`-- claude_actions_YYYYMMDD_HHMMSS.log
```

事件监听状态固定写入 launcher 根目录；`--cwd` 只影响 Claude 工作目录，不改变以下 runtime JSON 的位置：

```text
<repo-root>/event_state.json
<repo-root>/event_task.json
```

这些文件是本地运行状态，已由 `.gitignore` 忽略。两者会写入同一个 `runtimeRevision`；如果两个文件的 revision 不一致，launcher 会拒绝加载，避免使用不同轮次的 state/task 组合继续派发。

### `event_task.json`

只保留活跃或失败未清理的 task。关键字段：

- `runtimeRevision`
- `status`: `pending | running | blocked | dead`
- `attemptCount`
- `lastAttemptAt`
- `nextRetryAt`
- `lastError`
- `claimedAt`
- `runningPid`
- `lastOutputAt`
- `blockOwner`
- `blockCategory`
- `unblockHint`
- `blockedSnapshot`
- `boundary`

`blocked` 是队列状态，表示不应继续普通自动重试；`blockOwner` / `blockCategory` / `unblockHint` 说明需要谁处理、属于哪类阻塞、如何解除。典型 `blockOwner` 包括 `contributor`、`maintainer`、`human`、`infra`、`automation`。

`dead` task 不是永久历史项：只有在底层触发条件仍然存在时才继续阻塞 dedupe；如果触发条件消失，会在后续扫描中自动回收。

手工解除 `dead` task 阻塞时：

- 方案一：直接删除该 task 条目。
- 方案二：手动改回 `pending`，并重置：
  - `attemptCount: 0`
  - `lastAttemptAt: null`
  - `nextRetryAt: 当前时间`
  - `lastError: null`
  - `claimedAt: null`
  - `runningPid: null`
  - `lastOutputAt: null`
  - `blockOwner: null`
  - `blockCategory: null`
  - `unblockHint: null`
  - `blockedSnapshot: null`

### `event_state.json`
评论 baseline 按 `maintainer` / `bot` / `user` 三个 category 独立跟踪；评论 task 成功时只推进对应 category 的 cursor。

保存每个 PR 的 handled baseline 和 last observed snapshot。评论流按来源拆分为：

- `runtimeRevision`
- `commentBaselines.maintainer.issueCommentCursor`
- `commentBaselines.maintainer.reviewCommentCursor`
- `commentBaselines.maintainer.reviewCursor`
- `commentBaselines.bot.issueCommentCursor`
- `commentBaselines.bot.reviewCommentCursor`
- `commentBaselines.bot.reviewCursor`
- `commentBaselines.user.issueCommentCursor`
- `commentBaselines.user.reviewCommentCursor`
- `commentBaselines.user.reviewCursor`

另外还会记录：

- `statusCheckState`
- `reviewDecision`
- `mergeStateStatus`
- `mergeable`
- `isDraft`
- `unresolvedReviewThreadCount`
- `headSha`

---

## 常用 GitHub 命令

获取当前账号所有 upstream open PR：

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

查看单个 PR 状态：

```bash
gh pr view <number> --repo <owner>/<repo> --json mergeStateStatus,reviewDecision,statusCheckRollup,isDraft,mergeable
```

查看 CI：

```bash
gh pr checks <number> --repo <owner>/<repo>
```

查看 PR conversation comments：

```bash
gh api repos/<owner>/<repo>/issues/<number>/comments
```

查看 review comments：

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments
```

查看 reviews：

```bash
gh api repos/<owner>/<repo>/pulls/<number>/reviews
```

创建 PR：

```bash
git push origin <branch-name>
gh pr create --repo <owner>/<repo> --base <base-branch> --head <fork-owner>:<branch-name> --title "<title>" --body "<body>"
```

这里的 `<owner>/<repo>` 必须是 upstream 仓库，不是 `<contributor-login>/*` fork。

---

## 维护原则

- 修改工作流时先改 `AGENT.md`。
- 修改 PR 质量标准时先改 `doc/pr_rule.md`。
- 修改脚本参数或启动方式时同步更新本 README。
- 文档命令必须能真实执行，不保留已知错误命令。

## 许可证

本项目使用 MIT License，见 [`LICENSE`](LICENSE)。
