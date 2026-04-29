# doc/pr_rule.md

> 本文件只定义 PR 质量与协作规则。
> 执行顺序、目录约定、监控流程和记录格式见 [`AGENT.md`](AGENT.md)。

---

## 1. 好 PR 的定义

一个好的 PR 是维护者可以快速审查、快速理解、低风险合并的协作单元。

至少满足：

- 问题真实存在，有证据。
- 改动范围小，只解决一个问题。
- 方案贴合项目现有架构和风格。
- 验证方式明确，结果真实。
- PR 描述能解释为什么值得合并。
- Review 中能及时、准确、礼貌地回应。

如果你不能在三到五句话内说明问题、原因、改动和验证方式，不要提交。

---

## 2. 什么值得提 PR

优先选择：

### 2.1 明确 bug 修复

- 边界输入导致异常。
- 参数解析错误。
- 示例代码与实际 API 不一致。
- README 命令复制后无法运行。
- 小逻辑分支漏处理。
- 跨平台路径、编码、shell 差异导致失败。

### 2.2 测试补充或修正

- 为已修复 bug 添加回归测试。
- 补上遗漏的边界条件。
- 修复明显错误或不稳定的测试断言。
- 缩小 flaky 测试的不确定性，且有证据支持。

### 2.3 文档与示例修复

- 修复错误命令、路径、参数、链接。
- 补充缺失的必要步骤。
- 消除与当前代码行为不一致的说明。
- 修正会误导用户的语法、术语或格式问题。

文档 PR 可以很小，但必须真实减少误导或提升可用性。不要为了刷存在感改字面。

### 2.4 小型质量改进

- 更准确的错误信息。
- 明确的类型声明修正。
- 配置或脚本中的小疏漏。
- 日志内容更可诊断，且不会制造噪音。

---

## 3. 什么不值得提 PR

**禁止对 MCP 相关项目做 PR**（优先级高于"默认避免"）：
- MCP 项目包括但不限于：MCP server、MCP client、MCP SDK、MCP 协议实现、以及仓库名称/描述中包含 "MCP" 的项目。
- 即使发现了简单的 bug、文档错误或明显可修的问题，也不应选取 MCP 项目。
- 原因：MCP 生态变化快、外部贡献风险高、协议层修改往往需要维护者直接参与。

默认避免：

- 纯个人审美偏好的改动。
- 无功能收益的大规模重构。
- 与当前问题无关的顺手修复。
- 全仓库统一格式化。
- 没有明确收益的依赖升级。
- 未经讨论的行为变更、API 变更、配置语义变更。
- 大量文件重命名或目录重组。
- 你自己都说不清价值的改动。

如果一个 PR 的主要理由是“更优雅”“更现代”“更规范”，但无法说明用户或维护者得到什么具体收益，先不要做。

---

## 4. 提交前核查清单

动手前确认：

- 已读目标仓库 `README.md`。
- 已读 `CONTRIBUTING.md`、PR 模板、issue 模板（若存在）。
- 已搜索类似 issue。
- 已搜索类似 PR。
- 已确认目标问题仍存在。
- 已确认改动可以保持小范围。
- 已确认本地至少能完成一种可信验证。
- 已判断是否需要先开 issue。

动手后、提交前确认：

- diff 只包含本次目标改动。
- 没有无关格式化、重命名、依赖更新或锁文件变化。
- 新增测试与风险匹配；不适合新增测试时已说明原因。
- 已运行相关验证；未运行的验证不会被写成已通过。
- PR 描述可以被维护者独立理解。

---

## 5. 范围控制

一个 PR 只做一件事。

正确范围：

- `docs(readme): fix incorrect install command`
- `fix(parser): handle empty input`
- `test(api): add regression coverage for null payload`

错误范围：

- 修 bug 的同时格式化整个文件。
- 改 README 的同时升级依赖。
- 补测试的同时重命名模块。
- 顺手修复多个互不相关的小问题。

发现多个问题时，只选最适合当前 PR 的一个，其余写入记录或 notes。

---

## 6. 实现规则

代码修改必须：

- 跟随项目现有语言、命名、错误处理和测试风格。
- 优先复用已有 helper、配置和抽象。
- 只在必要时新增抽象。
- 不破坏现有 API、数据结构、错误码、配置字段和输出格式。
- 不偷偷引入新依赖。
- 不修改构建、CI、发布、安全相关逻辑，除非这是当前问题本身。

需要特别谨慎：

- 老接口兼容。
- 历史数据。
- 平台差异。
- shell 差异。
- 第三方依赖行为。
- 安全敏感代码。

---

## 7. 验证规则

优先使用项目已有命令：

- `test`
- `lint`
- `typecheck`
- `build`
- 目标模块的单测。
- README 命令或复现步骤的手工验证。

PR 描述必须真实反映验证结果。

推荐写法：

```md
## Validation
- ran `pnpm test parser`
- ran `pnpm lint`
```

如果无法完整验证，写清边界：

```md
## Validation
- ran targeted parser tests
- did not run the full integration suite because it requires external credentials
```

禁止写法：

- `all tests passed`，但实际没有跑全量测试。
- `should be fixed`，但没有复现或验证。
- `minor change, no tests needed`，但改动影响行为。

---

## 8. Issue 与直接 PR

可以直接 PR：

- 明显文档错误。
- 小 bug。
- 高置信、低争议、低风险的小范围修复。
- 项目历史上接受直接 PR。

应先开 issue：

- 新功能。
- 行为变更。
- API 或配置语义变更。
- UI / UX 方向选择。
- 需要维护者确认设计。
- 项目规则明确要求先开 issue。

不确定时，优先缩小改动范围；仍不确定，再开 issue。

---

## 9. 分支、Commit、PR 标题

### 分支

使用小写短名和连字符：

```text
fix/<short-topic>
docs/<short-topic>
test/<short-topic>
feat/<short-topic>
chore/<short-topic>
```

示例：

- `fix/handle-empty-config`
- `docs/fix-install-command`
- `test/add-parser-regression`

### Commit

使用 Conventional Commits：

```text
<type>(<scope>): <subject>
```

示例：

- `fix(parser): handle empty input`
- `docs(readme): fix incorrect install command`
- `test(api): add null payload regression`

要求：

- type 准确。
- scope 具体。
- subject 简洁、有信息量。
- 不使用 `update code`、`fix issue`、`small changes` 这类空泛标题。
- **禁止在 commit 信息中添加 claude、claude code 相关内容作为作者或致谢。**
- **PR 描述中不得包含任何与 claude / claude code 相关的内容。**

### PR 标题

PR 标题应与 commit 语义一致，并让维护者一眼看懂改动点：

- `fix: handle empty config path in CLI`
- `docs: correct install command in README`
- `test: add regression coverage for empty parser input`

---

## 10. PR 描述模板

优先遵守目标仓库自己的 PR 模板。没有模板时使用：

```md
## Summary
- ...

## Why
...

## Validation
- ...

## Related
Closes #123
```

要求：

- Summary 写改了什么。
- Why 写为什么值得改。
- Validation 写实际运行过什么。
- Related 只关联真实相关的 issue。

文档修复示例：

```md
## Summary
- fix the install command in README
- clarify the required environment variable name

## Why
The previous command omits a required flag and fails when copied directly.

## Validation
- checked the command against the current CLI help output
- reviewed the surrounding README section for consistency
```

Bug 修复示例：

```md
## Summary
- handle empty input before parsing
- add regression coverage for the empty-input case

## Why
The parser currently throws on an empty string. This keeps the existing fallback behavior and prevents the crash.

## Validation
- ran the parser test suite
- verified the new regression test fails before the fix and passes after it
```

---

## 11. Review 回复规则

**语言强制要求：所有面向开源社区的输出必须使用英文。** 包括但不限于：commit message、PR 标题、PR 描述、Review 评论、issue 回复。即使系统提示词或界面显示为中文，PR 相关内容也必须用英文撰写，因为这些内容会出现在开源项目的公开历史记录中。

基本要求：

- CI 失败优先处理。
- 逐条阅读评论，包括 bot 评论。
- 对 inline review，回复原线程。
- 修改后说明改了什么。
- 不防御性争辩。
- 不沉默 force push。
- 用英文撰写所有 PR 内容。

可用回复：

```text
Thanks, updated this to match the existing pattern.
```

```text
Good catch. I removed the unrelated change so the PR stays scoped to the original fix.
```

```text
Added a regression test for the case you pointed out.
```

如果不同意建议：

```text
Thanks for the suggestion. I kept the current behavior because changing it would affect the existing API contract. I added a note in the PR description to clarify the scope.
```

---

## 12. 放弃或关闭的标准

可以放弃：

- 已有更合适的上游方案。
- 改动方向与维护者意见不一致。
- 需要重大设计讨论，超出小 PR 范围。
- 无法充分验证且风险大于收益。
- 维护者明确拒绝且理由充分。

放弃时：

- 记录原因。
- 保留本地仓库。
- 必要时礼貌回复不再继续推进。
- 不强行提交低质量 PR。

---

## 13. 最终判断

提交前最后检查：

1. 问题真实存在吗？
2. 改动足够小吗？
3. 这个 PR 只做一件事吗？
4. 查过类似 issue / PR 吗？
5. 遵守目标仓库规则了吗？
6. 验证足够真实吗？
7. 能解释为什么这样改吗？
8. 维护者能快速 review 吗？

任一答案明显为否，先不要提交。

一句话准则：

**宁可少提，也不要提噪音 PR；宁可小而准，也不要大而散。**
