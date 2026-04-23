# PR Agent

`D:\Desktop\pr` 是一个用于持续寻找、提交和跟进 GitHub 开源 PR 的本地工作区。核心目标是产出小而准确、容易被维护者接受的真实贡献，而不是批量制造低质量 PR。

---

## 文档入口

- [`AGENT.md`](AGENT.md)：代理执行工作流。先读这里。
- [`pr_rule.md`](pr_rule.md)：PR 质量、范围、验证和 Review 协作规则。
- [`run-claude-agent.js`](run-claude-agent.js)：Claude CLI 启动与提醒脚本。

职责边界：

- 流程写在 `AGENT.md`。
- PR 质量判断写在 `pr_rule.md`。
- 启动方式和脚本参数写在 `README.md`。

---

## 工作区结构

```text
D:\Desktop\pr
|-- AGENT.md
|-- pr_rule.md
|-- README.md
|-- run-claude-agent.js
|-- candidates/          # clone 下来的候选仓库
|-- records/             # 每个项目的尝试记录
|-- notes/               # 临时筛选笔记
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

## 快速启动

最简启动：

```bash
node run-claude-agent.js
```

推荐启动 Review 监控和事件监听：
```bash
node run-claude-agent.js \
  --cwd "D:\Desktop\pr" \
  --idle-seconds 300 \
  --initial-delay-seconds 8 \
  --nudge-cooldown-seconds 30 \
  --max-nudges 0 \
  --effort max \
  --claude-command claude.cmd \
  --enable-review-monitor \
  --review-check-interval 14400 \
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
- 可选定时扫描记录中的 PR。
- 可选轮询 GitHub 事件并提醒处理。
- 写入结构化运行日志。

脚本只负责调度。是否值得改、怎么改、怎么验证、是否提交 PR，仍以 `AGENT.md` 和 `pr_rule.md` 为准。

---

## CLI 参数

### 基础参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--cwd` | `D:\Desktop\pr` | Claude 工作目录 |
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

### Review 监控参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--enable-review-monitor` | `false` | 开启定时 Review 检查 |
| `--review-check-interval` | `14400` | Review 检查间隔，单位秒，默认 4 小时 |

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

脚本支持两类监控，可同时开启：

| 模式 | 开关 | 用途 |
|---|---|---|
| Review monitor | `--enable-review-monitor` | 定时提醒检查已提交 PR 的 Review 状态 |
| Event listener | `--enable-event-listener` | 轮询 open PR，发现 CI、Review、评论、merge 状态变化 |

事件模型分为两类：

- task-backed：`CI_FAILURE`、`REVIEW_CHANGES_REQUESTED`、`MAINTAINER_COMMENT`、`BOT_COMMENT`、`NEW_COMMENT`、`NEEDS_REBASE`、`READY_TO_MERGE`
- notify-only：`CI_PASSED`、`REVIEW_APPROVED`

事件监听的硬规则：

- 只要 `event_task.json` 中仍存在同 `prKey + type` 的 task，就视为去重命中，不会重复建 task。
- task 成功后直接从 `event_task.json` 删除，不保留 handled 历史项。
- task 失败最多自动尝试 5 次；超过上限后变成 `dead`。`dead` 只在底层触发条件仍然存在时继续阻塞同类事件；如果触发条件消失，会在后续扫描中自动回收。
- 成功后的状态刷新以 GitHub 最新数据为准；评论类 cursor 只推进到 task 创建时的 boundary，然后立即对该 PR 局部重扫，避免吞掉处理中途到达的新评论。
- 评论 backlog 按 `MAINTAINER_COMMENT`、`BOT_COMMENT`、`NEW_COMMENT` 三类独立跟踪，同一轮扫描里最多可并存三条评论 task。

具体处理流程以 `AGENT.md` 的 Review 与 CI 跟进规则为准。

---

## 运行产物

日志写入：

```text
D:\Desktop\pr\.claude_agent_logs\
|-- claude_stream_YYYYMMDD_HHMMSS.jsonl
`-- claude_actions_YYYYMMDD_HHMMSS.log
```

事件监听状态写入工作区根目录：

```text
D:\Desktop\pr\event_state.json
D:\Desktop\pr\event_task.json
```

这些文件是本地运行状态，已由 `.gitignore` 忽略。

### `event_task.json`

只保留活跃或失败未清理的 task。关键字段：

- `status`: `pending | running | dead`
- `attemptCount`
- `lastAttemptAt`
- `nextRetryAt`
- `lastError`
- `claimedAt`
- `runningPid`
- `boundary`

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

### `event_state.json`
评论 baseline 按 `maintainer` / `bot` / `user` 三个 category 独立跟踪；评论 task 成功时只推进对应 category 的 cursor。

保存每个 PR 的 handled baseline 和 last observed snapshot。评论流按来源拆分为：

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

获取当前账号所有 open PR：

```bash
gh search prs --author Will-hxw --state open --limit 100
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

---

## 维护原则

- 修改工作流时先改 `AGENT.md`。
- 修改 PR 质量标准时先改 `pr_rule.md`。
- 修改脚本参数或启动方式时同步更新本 README。
- 文档命令必须能真实执行，不保留已知错误命令。
