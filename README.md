# PR Agent

PR Agent 是一个用于持续寻找、提交和跟进 GitHub 开源 PR 的单 Claude Agent 工作区。当前架构只保留主 Claude：launcher 负责启动 Claude、刷新 runtime JSON、记录日志；所有 task 都由主 Claude 处理闭环。

## 文档入口

- `AGENT.md`：主 Claude 工作流与执行规则。
- `doc/pr_rule.md`：PR 质量、范围、验证和 review 协作规则。
- `doc/task-processing.md`：`event_task.json` 中每类 task 的处理规范。
- `doc/event-task-state-maintenance.md`：处理完 task 后如何维护 `event_state.json` 与 `event_task.json`。
- `run-claude-agent.js`：Claude CLI 启动、空闲提醒和 PR 事件 JSON 刷新脚本。

## 工作区结构

```text
<repo-root>
|-- AGENT.md
|-- README.md
|-- run-claude-agent.js
|-- update.sh
|-- agent.config.example.json
|-- doc/
|-- candidates/          # 候选仓库工作副本
|-- records/             # 每个项目的尝试记录
`-- .claude_agent_logs/  # 本地运行日志
```

运行状态文件、日志和候选仓库不属于对外贡献内容。开始和结束工作时检查：

```bash
git status --short --branch
```

## 前置要求

- Node.js 可用。
- Claude CLI 可用，Windows 默认命令为 `claude.cmd`。
- GitHub CLI `gh` 已登录，并有创建 PR、读取 PR 状态和回复评论的权限。
- Git 可用。
- 网络可访问 GitHub。

快速检查：

```bash
node --version
gh auth status
git --version
node --check run-claude-agent.js
```

## 本地配置

公开仓库不保存个人 GitHub 登录名。首次运行前复制配置：

```bash
cp agent.config.example.json agent.config.json
```

Windows PowerShell：

```powershell
Copy-Item agent.config.example.json agent.config.json
```

示例：

```json
{
  "contributorLogin": "your-github-login",
  "readyToMergeReviewMode": "require-approval"
}
```

也可使用环境变量：

```bash
PR_AGENT_CONTRIBUTOR_LOGIN=your-github-login node run-claude-agent.js
```

`readyToMergeReviewMode` 默认是 `require-approval`。如目标仓库没有强制 review approval，可设为 `allow-no-review-required`，让 `reviewDecision=null` 且 CI 成功、可合并、无 unresolved review threads 的 PR 记录为 ready 状态。该设置不会放行 `CHANGES_REQUESTED` 或 `REVIEW_REQUIRED`。

`PR_AGENT_GH_PROXY_MODE` 默认是 `inherit`，所有 `gh` 命令继承当前 shell 的代理环境。若需要排查代理链路，可临时设置 `PR_AGENT_GH_PROXY_MODE=direct`；该模式只在 `gh` 子进程中移除 proxy 环境变量。

## 快速启动

默认启动：

```bash
node run-claude-agent.js
```

默认流程：

1. 启动前先调用 `generateEventJson()` 刷新 `event_state.json` / `event_task.json`。
2. 启动主 Claude。
3. 主 Claude 先处理 `event_task.json` 中所有 task。
4. 队列为空后才 scout 新 PR。
5. event listener 每 `3600000ms` 再次刷新 runtime JSON，只写文件和日志。

只启动主 Claude、不刷新 PR event JSON：

```bash
node run-claude-agent.js --no-event-listener
```

一次性刷新 runtime JSON：

```bash
bash update.sh
```

`update.sh` 复用启动刷新路径。若已有 listener 持有 active lock，会输出 `event JSON skipped: active listener lock` 并以退出码 `2` 结束；open PR search 失败会以 strict refresh 失败退出。

## CLI 参数

### 基础参数

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `--cwd` | 当前目录 | Claude 工作目录；runtime JSON 仍固定写入 launcher 根目录 |
| `--prompt` | 内置提示 | 发送给主 Claude 的初始提示和后续提醒 |
| `--claude-command` | Windows: `claude.cmd`；其他平台: `claude` | Claude CLI 命令 |
| `--effort` | `max` | Claude 思考强度：`low` / `middle` / `high` / `xhigh` / `max` |
| `--show-thinking` | `true` | 在终端显示主 Claude thinking 事件 |
| `--no-show-thinking` | - | 隐藏 thinking 事件 |
| `--show-tool-results` | `false` | 显示 tool result 详情 |
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
| `--enable-event-listener` | `true` | 启动刷新并开启后续轮询刷新 |
| `--no-event-listener` | - | 不刷新 runtime JSON，只启动主 Claude |
| `--event-poll-interval` | `3600000` | 轮询刷新间隔，单位毫秒 |
| `--ready-to-merge-review-mode` | `require-approval` | `READY_TO_MERGE` 判定模式，可设为 `allow-no-review-required` |

旧的事件 worker、终端输出和系统通知参数已删除；传入这些参数会报 unknown argument。

## 事件模型

`event_task.json` 只包含以下六类 task：

- `CI_FAILURE`
- `REVIEW_CHANGES_REQUESTED`
- `MAINTAINER_COMMENT`
- `BOT_COMMENT`
- `NEW_COMMENT`
- `NEEDS_REBASE`

以下事件不进入 task 队列，只更新 observed/log 状态：

- `CI_PASSED`
- `REVIEW_APPROVED`
- `READY_TO_MERGE`

`mergeStateStatus=BLOCKED` 本身不生成 task。`NEEDS_REBASE` 只由 `BEHIND`、`DIRTY` 或 `mergeable=CONFLICTING` 触发。

## Runtime JSON

runtime 文件固定写入 launcher 根目录：

```text
event_state.json
event_task.json
```

两者会写入同一个 `runtimeRevision`。如果 revision 不一致，launcher 会拒绝加载并输出恢复提示。恢复规则见 `doc/event-task-state-maintenance.md`。

### `event_task.json`

新写入 task 只使用：

- `id`
- `prKey`
- `type`
- `severity`
- `createdAt`
- `status`
- `blockedAt`
- `blockReason`
- `blockOwner`
- `blockCategory`
- `unblockHint`
- `blockedSnapshot`
- `boundary`
- `details`

有效 `status` 为 `pending` 和 `blocked`。

### `event_state.json`

`baseline` 记录已处理位置，`observed` 记录最近扫描快照。评论 baseline 按 category 独立维护：

- `commentBaselines.maintainer`
- `commentBaselines.bot`
- `commentBaselines.user`

状态型 baseline 记录 CI、review、merge、draft、unresolved threads、`headSha` 等字段。主 Claude 删除 task 前必须推进对应 baseline。

## 主工作流

主 Claude 的循环是：

```text
STARTUP
-> TASK_QUEUE
-> SCOUT
-> TRIAGE
-> LOCK_TARGET
-> IMPLEMENT
-> VALIDATE
-> SUBMIT_PR
-> RECORD
-> TASK_QUEUE
```

每个阶段结束后都回到 `TASK_QUEUE`。只要队列非空，就先处理 task。具体任务处理标准见 `doc/task-processing.md`。

## 常用 GitHub 命令

查看当前账号 upstream open PR：

```bash
gh pr list --state open --author @me
```

查看 PR 状态：

```bash
gh pr view <number> --repo <owner>/<repo> --json mergeStateStatus,reviewDecision,statusCheckRollup,isDraft,mergeable
gh pr checks <number> --repo <owner>/<repo>
```

查看评论和 review：

```bash
gh api repos/<owner>/<repo>/issues/<number>/comments
gh api repos/<owner>/<repo>/pulls/<number>/comments
gh api repos/<owner>/<repo>/pulls/<number>/reviews
```

创建 PR：

```bash
git push origin <branch-name>
gh pr create --repo <owner>/<repo> --base <base-branch> --head <fork-owner>:<branch-name> --title "<title>" --body "<body>"
```

这里的 `<owner>/<repo>` 必须是 upstream 仓库，不是自己的 fork。

## 验证

修改脚本或文档后至少运行：

```bash
node --check run-claude-agent.js
node --test tests/run-claude-agent.test.js
node run-claude-agent.js --help
git diff --check
```

## 许可证

本项目使用 MIT License，见 `LICENSE`。
