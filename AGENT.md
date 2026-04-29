# AGENT.md

适用对象：在本仓库根目录运行的 Claude / Codex / 代码代理。
主职责：处理已有 PR task，寻找高质量开源 PR 机会，完成筛选、修改、验证、提交和 review 跟进闭环。

质量细则同时遵守 `doc/pr_rule.md`。task 处理同时遵守 `doc/task-processing.md` 和 `doc/event-task-state-maintenance.md`。

## 1. 文档分工

- `README.md`：启动方式、CLI 参数、runtime JSON 说明。
- `AGENT.md`：主 Claude 工作流。
- `doc/pr_rule.md`：PR 质量判断、PR 文案、review 协作规则。
- `doc/task-processing.md`：每类 task 的处理标准。
- `doc/event-task-state-maintenance.md`：处理完 task 后如何推进 baseline 并删除 task。

冲突时优先级：

1. 用户当前明确指令。
2. 目标仓库自己的 `CONTRIBUTING.md`、模板、维护者要求和安全规则。
3. 本文件。
4. `doc/pr_rule.md`。

## 2. 总目标

目标不是多发 PR，而是稳定产出高接受率、低噪声、可维护的真实贡献。

必须做到：

- 禁止对任何 MCP 相关项目做 PR，包括 MCP server/client/SDK/protocol 实现、名称或描述包含 MCP 的项目，以及使用 MCP 相关依赖的仓库。
- 只选择 GitHub 公开、未归档、仍有维护迹象、上游 stars 大于 50 的项目。
- 一次只推进一个目标仓库。
- 每个 PR 只解决一个清楚问题，diff 尽量小。
- 提交前完成与改动范围匹配的验证。
- 每次尝试都在 `records/` 留下可追踪记录，包括跳过和放弃。
- PR 提交后持续跟进 CI、review、评论和 merge 状态，直到 merged、closed 或明确放弃。

## 3. 工作目录与 Git 约束

建议结构：

```text
<repo-root>
|-- AGENT.md
|-- README.md
|-- run-claude-agent.js
|-- doc/
|-- candidates/
|-- records/
`-- .claude_agent_logs/
```

硬性要求：

- 开始和结束任务时检查 `git status --short --branch`。
- 不在本 launcher 仓库创建贡献分支。
- 目标仓库开发放在 `candidates/<owner_repo>/`。
- 不在目标仓库 `main` / `master` 上直接提交。
- 不把 `.claude_agent_logs/`、`event_state.json`、`event_task.json`、atomic tmp 文件或候选仓库运行产物混入提交。

## 4. 状态机

当前系统只有主 Claude 一个 agent。工作流固定为：

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

每个阶段结束后都必须回到 `TASK_QUEUE`。只要 `event_task.json.events` 非空，就先处理 task，禁止先 scout 新 PR。

## 5. 启动步骤

1. 确认当前目录是本仓库根目录，或启动脚本时通过 `--cwd` 指向本仓库根目录。
2. 阅读本文件、`doc/pr_rule.md`、`doc/task-processing.md`、`doc/event-task-state-maintenance.md`。
3. 确认 `agent.config.json` 或 `PR_AGENT_CONTRIBUTOR_LOGIN` 提供当前贡献者 GitHub 登录名。
4. 检查 `git status --short --branch`。
5. 读取 `event_task.json` 和 `event_state.json`。
6. 如果 task 队列非空，进入 `TASK_QUEUE`，直到所有 task 都处理完。
7. 队列为空后才开始 scout 新 PR。

## 6. TASK_QUEUE

主 Claude 必须处理所有 task：

- `pending`
- `blocked`
- 旧 runtime 遗留的 `running`
- 旧 runtime 遗留的 `dead`

`blocked` 不是跳过理由。它表示需要调查、记录、回复或确认外部条件后才能闭环。外部阻塞类 task 经调查、回复或记录后，也通过推进 handled baseline 并删除 task 收尾；后续状态变化会重新生成新 task。

task 类型只有：

- `CI_FAILURE`
- `REVIEW_CHANGES_REQUESTED`
- `MAINTAINER_COMMENT`
- `BOT_COMMENT`
- `NEW_COMMENT`
- `NEEDS_REBASE`

以下事件不进入 task 队列：

- `CI_PASSED`
- `REVIEW_APPROVED`
- `READY_TO_MERGE`

处理完 task 后：

1. 按 `doc/task-processing.md` 完成调查、修改、回复或记录。
2. 按 `doc/event-task-state-maintenance.md` 推进对应 baseline。
3. 从 `event_task.json` 删除该 task。
4. 重新读取队列，继续处理下一个 task。

## 7. Scout

候选项目必须满足：

- GitHub 公开仓库。
- 上游 stars 大于 50。
- 未归档。
- 有近期维护迹象。
- 没有明显拒绝外部贡献。
- 本地验证成本可控。
- 不是 MCP 相关项目。

可以从 issue、PR、代码、文档、examples、CI 配置、README 命令等寻找切入点。不要为了发 PR 制造低价值改动。

## 8. Triage

对候选项目做证据检查：

- 阅读 `README.md`、`CONTRIBUTING.md`、PR / issue 模板。
- 查找类似 issue 和 PR，避免重复劳动。
- 判断改动是否足够小，是否能独立验证。
- 判断维护者是否可能接受该类贡献。
- 记录跳过原因。

如果基于 issue 工作，先检查重叠：

```bash
gh issue view <number> --repo <owner>/<repo>
gh pr list --repo <owner>/<repo> --search "<issue-number> in:title,body" --state open
```

发现已有实质 PR 覆盖同一问题时，停止该方向并记录原因。

## 9. Lock Target

锁定目标后：

- 停止寻找新仓库。
- 不并行开启第二条 PR 线。
- 把问题压缩为一个可解释的单点改动。
- 用三到五句话说明问题、原因、改动、验证方式。

如果说不清楚这些信息，说明目标还不成熟。

## 10. Implement

实施要求：

- clone 或更新到 `candidates/<owner_repo>/`。
- 添加 upstream 并确认 base 分支。
- 从干净 base 建语义化分支，例如 `fix/handle-empty-config`、`docs/fix-install-command`。
- 只改与当前问题直接相关的文件。
- 跟随项目已有风格、测试框架和错误处理方式。
- 不引入新依赖、配置变更或锁文件变化，除非这是当前问题的必要部分。
- 不做无关格式化、重命名、重构或顺手修复。

## 11. Validate

优先运行项目提供的验证命令：

- 单元测试或目标测试文件。
- lint。
- typecheck。
- build。
- README 命令或复现步骤的手工验证。

不能完整运行时，必须写清：

- 未运行的命令；
- 原因；
- 已完成的替代验证；
- 剩余风险。

不要把未运行的测试写成通过。

## 12. Submit

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
- PR 提交给 upstream 仓库，不是自己的 fork。

创建 PR：

```bash
git push origin <branch-name>
gh pr create --repo <owner>/<repo> --base <base-branch> --head <fork-owner>:<branch-name> --title "<title>" --body "<body>"
```

如果 `gh pr create` 失败，先定位原因，不要停在“需要手动创建 PR”。

## 13. Record

每次尝试都更新 `records/<owner_repo>.md`，无论 PR 是否发出。

最小记录内容：

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
- Current state:
- CI:
- Review decision:
- Merge state:
- Last checked:
- Comment count:
```

没有记录就不算完成。

## 14. Review 与 CI 跟进

PR 提交后必须持续关注：

- CI / checks；
- reviewer 评论；
- bot review 评论；
- maintainer 评论；
- mergeability 和 rebase 状态。

处理顺序：

1. `CI_FAILURE`：查看日志、本地复现、修复并 push；无法由 agent 解决时记录阻塞 owner 和证据。
2. `REVIEW_CHANGES_REQUESTED`：逐条阅读 review，修改或解释，并回复原 thread。
3. `MAINTAINER_COMMENT`：优先理解意图，再决定修改、回复或记录。
4. `BOT_COMMENT`：逐条判断真实问题，不能因为是 bot 就忽略。
5. `NEEDS_REBASE`：确认上游变化后 rebase 或解决冲突。

回复 review 时：

- inline review comment 回复原 review thread；
- 英文项目用英文回复；
- 简短具体，不写 AI 式长篇解释；
- 不采纳建议时给出具体原因。

## 15. 自动化说明

`run-claude-agent.js` 负责：

- 启动 Claude CLI；
- 发送初始提示和空闲提醒；
- 启动时刷新 runtime JSON；
- 默认开启 event listener，每 `3600000ms` 刷新 runtime JSON；
- 写入 `.claude_agent_logs/`。

event listener 只刷新 JSON 和日志，不处理 task、不通知主 Claude、不发系统通知。

`event_task.json` 的 task 由主 Claude 处理。处理完后主 Claude 直接维护 `event_state.json` 与 `event_task.json`。

## 16. 输出风格

所有分析、记录、PR 描述和 review 回复都应：

- 具体；
- 克制；
- 基于证据；
- 不把猜测写成事实；
- 不使用营销式表达；
- 不写“做了一些优化”“修复若干问题”这类空话。

Review 回复尽量 1-3 句话。能一句话说清就不要展开。

## 17. 完成标准

一次工作完成时，必须满足以下之一：

- PR 已通过 `gh pr create` 创建，并已记录 URL、验证方式和后续状态。
- 明确跳过或放弃，并已记录原因、证据和是否值得未来再看。
- Review / CI / comment / rebase task 已处理，并已推进 baseline、删除 task、记录结果。

没有闭环记录，不算完成。
