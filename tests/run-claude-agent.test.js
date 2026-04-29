const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

process.env.PR_AGENT_CONTRIBUTOR_LOGIN = "example-user";

const agent = require(path.join(__dirname, "..", "run-claude-agent.js"));

function createLogger() {
  return {
    lines: [],
    writeLine(line) {
      this.lines.push(line);
    },
  };
}

function createListener(overrides = {}) {
  const runtimeDir = path.join(os.tmpdir(), `pr-agent-runtime-${process.pid}-${Date.now()}-${Math.random()}`);
  return new agent.EventListener({
    cwd: process.cwd(),
    eventPollIntervalMs: 1000,
    stateFile: path.join(runtimeDir, "event_state.json"),
    taskFile: path.join(runtimeDir, "event_task.json"),
    eventListenerLockFile: path.join(os.tmpdir(), `pr-agent-event-listener-${process.pid}-${Date.now()}-${Math.random()}.lock`),
    ...overrides,
  }, createLogger());
}

function makeActivity({
  stream = "issue_comment",
  id,
  createdAt,
  authorLogin,
  authorType = "User",
  authorAssociation = "NONE",
  body = "",
  state = null,
  updatedAt = createdAt,
  inReplyTo = null,
} = {}) {
  return {
    stream,
    id: String(id),
    createdAt,
    updatedAt,
    authorLogin,
    authorType,
    authorAssociation,
    body,
    state,
    inReplyTo,
    url: `https://example.com/${stream}/${id}`,
  };
}

function makeSnapshot(overrides = {}) {
  const snapshot = {
    prKey: "demo/repo#1",
    owner: "demo",
    repo: "repo",
    prNumber: 1,
    url: "https://github.com/demo/repo/pull/1",
    state: "OPEN",
    mergedAt: null,
    updatedAt: "2026-04-24T00:00:00.000Z",
    reviewDecision: null,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    isDraft: false,
    headSha: "sha-1",
    headRefName: "feature/demo",
    baseRefName: "main",
    unresolvedReviewThreadCount: 0,
    statusCheckState: "NONE",
    failingChecks: [],
    pendingChecks: [],
    issueComments: [],
    reviewComments: [],
    reviews: [],
    reviewRequests: [],
    ...overrides,
  };

  snapshot.issueComments = [...snapshot.issueComments].sort(agent.compareActivityChronologically);
  snapshot.reviewComments = [...snapshot.reviewComments].sort(agent.compareActivityChronologically);
  snapshot.reviews = [...snapshot.reviews].sort(agent.compareActivityChronologically);
  snapshot.issueCommentCursor = agent.buildCursor(snapshot.issueComments);
  snapshot.reviewCommentCursor = agent.buildCursor(snapshot.reviewComments);
  snapshot.reviewCursor = agent.buildCursor(snapshot.reviews);
  return snapshot;
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || "task-1",
    prKey: overrides.prKey || "demo/repo#1",
    type: overrides.type || "NEW_COMMENT",
    severity: overrides.severity || agent.TASK_EVENT_SEVERITY.NEW_COMMENT,
    createdAt: overrides.createdAt || "2026-04-24T00:01:00.000Z",
    status: overrides.status || agent.TASK_STATUS.PENDING,
    blockedAt: overrides.blockedAt || null,
    blockReason: overrides.blockReason || null,
    blockOwner: overrides.blockOwner || null,
    blockCategory: overrides.blockCategory || null,
    unblockHint: overrides.unblockHint || null,
    blockedSnapshot: overrides.blockedSnapshot || null,
    boundary: overrides.boundary || agent.normalizeBoundary(null),
    details: overrides.details || {},
  };
}

async function createRuntimeFiles(prefix = "pr-agent-runtime-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    stateFile: path.join(dir, "event_state.json"),
    taskFile: path.join(dir, "event_task.json"),
    lockFile: path.join(dir, "event-listener.lock"),
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(await predicate(), "condition was not met before timeout");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || path.join(__dirname, ".."),
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, "");
}

function makeGhCommandError(message, overrides = {}) {
  const error = new Error(message);
  error.code = overrides.code || "ECOMMAND";
  error.stderr = overrides.stderr || "";
  error.exitCode = overrides.exitCode ?? 1;
  error.timedOut = overrides.timedOut === true;
  return error;
}

test("gh command runner serializes concurrent commands in FIFO order", async () => {
  const started = [];
  const completed = [];
  const releases = [];
  let active = 0;
  const runner = new agent.GhCommandRunner(async (_command, args) => {
    active += 1;
    assert.equal(active, 1);
    started.push(args.join(" "));
    return new Promise((resolve) => {
      releases.push(() => {
        active -= 1;
        completed.push(args.join(" "));
        resolve({ stdout: "{}", stderr: "", code: 0, signal: null, timedOut: false });
      });
    });
  }, {
    maxAttempts: 1,
    retryDelayMs: 0,
  });

  const first = runner.run(["api", "one"]);
  const second = runner.run(["api", "two"]);
  const third = runner.run(["api", "three"]);

  await waitFor(() => started.length === 1);
  releases.shift()();
  await waitFor(() => started.length === 2);
  releases.shift()();
  await waitFor(() => started.length === 3);
  releases.shift()();
  await Promise.all([first, second, third]);

  assert.deepStrictEqual(started, ["api one", "api two", "api three"]);
  assert.deepStrictEqual(completed, ["api one", "api two", "api three"]);
});


test("gh command runner retries transient transport errors only", async () => {
  let attempts = 0;
  const retryingRunner = new agent.GhCommandRunner(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw makeGhCommandError("command failed (code 1): gh api repos/demo/repo :: Get \"https://api.github.com/repos/demo/repo\": EOF");
    }
    return { stdout: "{\"ok\":true}", stderr: "", code: 0, signal: null, timedOut: false };
  }, {
    maxAttempts: 3,
    retryDelayMs: 0,
  });

  const retried = await retryingRunner.run(["api", "repos/demo/repo"]);
  assert.equal(JSON.parse(retried.stdout).ok, true);
  assert.equal(attempts, 2);

  let notFoundAttempts = 0;
  const notFoundRunner = new agent.GhCommandRunner(async () => {
    notFoundAttempts += 1;
    throw makeGhCommandError("command failed (code 1): gh api repos/demo/missing :: HTTP 404: Not Found");
  }, {
    maxAttempts: 3,
    retryDelayMs: 0,
  });

  await assert.rejects(
    () => notFoundRunner.run(["api", "repos/demo/missing"]),
    /Not Found/,
  );
  assert.equal(notFoundAttempts, 1);
});


test("gh direct proxy mode clears proxy environment variables", () => {
  const direct = agent.buildGhCommandEnv({
    PR_AGENT_GH_PROXY_MODE: "direct",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    HTTP_PROXY: "http://127.0.0.1:7890",
    ALL_PROXY: "http://127.0.0.1:7890",
    http_proxy: "http://127.0.0.1:7890",
    KEEP_ME: "1",
  });

  assert.equal(direct.HTTPS_PROXY, undefined);
  assert.equal(direct.HTTP_PROXY, undefined);
  assert.equal(direct.ALL_PROXY, undefined);
  assert.equal(direct.http_proxy, undefined);
  assert.equal(direct.KEEP_ME, "1");
  assert.equal(direct.PR_AGENT_GH_PROXY_MODE, "direct");

  const inherit = agent.buildGhCommandEnv({
    PR_AGENT_GH_PROXY_MODE: "inherit",
    HTTPS_PROXY: "http://127.0.0.1:7890",
  });
  assert.equal(inherit.HTTPS_PROXY, "http://127.0.0.1:7890");
});

async function createFakeClaudeCommand(dir) {
  if (process.platform === "win32") {
    const commandPath = path.join(dir, "fake-claude.cmd");
    await fs.writeFile(commandPath, "@echo off\r\nexit /b 0\r\n", "utf8");
    return commandPath;
  }
  const commandPath = path.join(dir, "fake-claude.sh");
  await fs.writeFile(commandPath, "#!/usr/bin/env sh\nexit 0\n", { encoding: "utf8", mode: 0o755 });
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function createFakeClaudeOutputCommand(dir, events) {
  const scriptPath = path.join(dir, "fake-claude-output.js");
  const lines = events.map((event) => JSON.stringify(event));
  await fs.writeFile(scriptPath, [
    "const lines = " + JSON.stringify(lines) + ";",
    "for (const line of lines) console.log(line);",
  ].join("\n"), "utf8");

  if (process.platform === "win32") {
    const commandPath = path.join(dir, "fake-claude-output.cmd");
    await fs.writeFile(commandPath, "@echo off\r\nnode \"%~dp0fake-claude-output.js\"\r\n", "utf8");
    return commandPath;
  }

  const commandPath = path.join(dir, "fake-claude-output.sh");
  await fs.writeFile(commandPath, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-claude-output.js\"\n", { encoding: "utf8", mode: 0o755 });
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

async function createAgentWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-agent-main-"));
  await fs.mkdir(path.join(dir, "doc"), { recursive: true });
  await fs.writeFile(path.join(dir, "AGENT.md"), "# AGENT\n", "utf8");
  await fs.writeFile(path.join(dir, "doc", "pr_rule.md"), "# Rules\n", "utf8");
  return dir;
}

async function createUpdateScriptWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-agent-update-"));
  await fs.copyFile(path.join(__dirname, "..", "run-claude-agent.js"), path.join(dir, "run-claude-agent.js"));
  await fs.copyFile(path.join(__dirname, "..", "update.sh"), path.join(dir, "update.sh"));
  return dir;
}

function createIsolatedListener(runtime, overrides = {}) {
  return createListener({
    stateFile: runtime.stateFile,
    taskFile: runtime.taskFile,
    eventListenerLockFile: runtime.lockFile,
    ...overrides,
  });
}


test("state-backed trigger helper tracks active PR states", () => {
  assert.equal(agent.isTaskTriggerActive("CI_FAILURE", makeSnapshot({ statusCheckState: "FAILED" })), true);
  assert.equal(agent.isTaskTriggerActive("CI_FAILURE", makeSnapshot({ statusCheckState: "SUCCESS" })), false);
  assert.equal(agent.isTaskTriggerActive("REVIEW_CHANGES_REQUESTED", makeSnapshot({
    reviewDecision: "CHANGES_REQUESTED",
  })), true);
  assert.equal(agent.isTaskTriggerActive("NEEDS_REBASE", makeSnapshot({
    mergeStateStatus: "BEHIND",
  })), true);
  assert.equal(agent.isTaskTriggerActive("NEEDS_REBASE", makeSnapshot({
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
  })), false);
  assert.equal(agent.isTaskTriggerActive("READY_TO_MERGE", makeSnapshot({
    reviewDecision: "APPROVED",
    statusCheckState: "SUCCESS",
    mergeable: "MERGEABLE",
    unresolvedReviewThreadCount: 0,
  })), false);
});


test("mergeStateStatus BLOCKED alone is not task-backed", async () => {
  const listener = createListener();

  await listener._scanSnapshot(makeSnapshot({
    prKey: "demo/repo#33",
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    statusCheckState: "SUCCESS",
    reviewDecision: "APPROVED",
  }));

  assert.equal(listener.taskManager.events.length, 0);
});


test("state-backed actionability separates agent work from human blockers", () => {
  const dco = agent.classifyStateBackedActionability("CI_FAILURE", makeSnapshot({
    statusCheckState: "FAILED",
    failingChecks: [{ label: "DCO / Developer Certificate of Origin", conclusion: "FAILURE" }],
  }));
  assert.equal(dco.actionability, agent.TASK_ACTIONABILITY.NEEDS_CONTRIBUTOR_ACTION);
  assert.equal(dco.shouldBlock, true);
  assert.equal(dco.blockOwner, "contributor");
  assert.equal(dco.blockReason, "needs-contributor-action");

  const permission = agent.classifyStateBackedActionability("CI_FAILURE", makeSnapshot({
    statusCheckState: "FAILED",
    failingChecks: [{ label: "Resource not accessible by integration", conclusion: "FAILURE" }],
  }));
  assert.equal(permission.actionability, agent.TASK_ACTIONABILITY.NEEDS_MAINTAINER_ACTION);
  assert.equal(permission.blockOwner, "maintainer");

  const lint = agent.classifyStateBackedActionability("CI_FAILURE", makeSnapshot({
    statusCheckState: "FAILED",
    failingChecks: [{ label: "lint / eslint", conclusion: "FAILURE" }],
  }));
  assert.equal(lint.actionability, agent.TASK_ACTIONABILITY.ACTIONABLE_BY_AGENT);
  assert.equal(lint.shouldBlock, false);

  const reviewWithoutComments = agent.classifyStateBackedActionability("REVIEW_CHANGES_REQUESTED", makeSnapshot({
    reviewDecision: "CHANGES_REQUESTED",
  }));
  assert.equal(reviewWithoutComments.actionability, agent.TASK_ACTIONABILITY.NEEDS_MAINTAINER_ACTION);
  assert.equal(reviewWithoutComments.shouldBlock, true);

  const reviewWithOnlyApproval = agent.classifyStateBackedActionability("REVIEW_CHANGES_REQUESTED", makeSnapshot({
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [
      makeActivity({
        stream: "review",
        id: 990,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "MEMBER",
        state: "APPROVED",
      }),
    ],
  }));
  assert.equal(reviewWithOnlyApproval.actionability, agent.TASK_ACTIONABILITY.NEEDS_MAINTAINER_ACTION);

  const reviewWithComments = agent.classifyStateBackedActionability("REVIEW_CHANGES_REQUESTED", makeSnapshot({
    reviewDecision: "CHANGES_REQUESTED",
    reviewComments: [
      makeActivity({
        stream: "review_comment",
        id: 991,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "MEMBER",
        body: "Please update this line.",
      }),
    ],
  }));
  assert.equal(reviewWithComments.actionability, agent.TASK_ACTIONABILITY.ACTIONABLE_BY_AGENT);
  assert.equal(reviewWithComments.shouldBlock, false);

  const rebase = agent.classifyStateBackedActionability("NEEDS_REBASE", makeSnapshot({
    mergeStateStatus: "DIRTY",
    mergeable: "CONFLICTING",
  }));
  assert.equal(rebase.actionability, agent.TASK_ACTIONABILITY.NEEDS_CONTRIBUTOR_ACTION);
  assert.equal(rebase.shouldBlock, true);
});


test("status rollup uses the latest run for each check label", () => {
  const result = agent.classifyStatusChecks([
    {
      workflowName: "pull-request-lint",
      name: "Require Contributor Statement",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-04-24T10:34:27Z",
    },
    {
      workflowName: "pull-request-lint",
      name: "Require Contributor Statement",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-04-24T14:28:35Z",
    },
    {
      workflowName: "pull-request-lint",
      name: "Validate PR title",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      completedAt: "2026-04-24T14:28:39Z",
    },
  ]);

  assert.equal(result.state, "SUCCESS");
  assert.equal(result.checkCount, 2);
  assert.deepStrictEqual(result.failingChecks, []);
});


test("status rollup keeps unknown completed conclusions out of failing checks", () => {
  const result = agent.classifyStatusChecks([
    {
      workflowName: "third-party",
      name: "New conclusion",
      status: "COMPLETED",
      conclusion: "STALE_UNKNOWN",
      completedAt: "2026-04-24T14:28:39Z",
    },
  ]);

  assert.equal(result.state, "PENDING");
  assert.deepStrictEqual(result.failingChecks, []);
  assert.deepStrictEqual(result.pendingChecks, [
    {
      label: "third-party / New conclusion",
      status: "UNKNOWN",
      conclusion: "STALE_UNKNOWN",
    },
  ]);
});


test("status rollup still treats known failure conclusions as failed", () => {
  const result = agent.classifyStatusChecks([
    {
      workflowName: "ci",
      name: "Unit tests",
      status: "COMPLETED",
      conclusion: "FAILURE",
      completedAt: "2026-04-24T14:28:39Z",
    },
  ]);

  assert.equal(result.state, "FAILED");
  assert.deepStrictEqual(result.failingChecks, [
    {
      label: "ci / Unit tests",
      status: "COMPLETED",
      conclusion: "FAILURE",
    },
  ]);
});


test("stable id ordering is deterministic for mixed id strings", () => {
  const createdAt = "2026-04-24T00:01:00.000Z";
  const sorted = [
    makeActivity({ id: "a", createdAt }),
    makeActivity({ id: "2", createdAt }),
    makeActivity({ id: "B", createdAt }),
    makeActivity({ id: "10", createdAt }),
  ].sort(agent.compareActivityChronologically);

  assert.deepStrictEqual(sorted.map((activity) => activity.id), ["10", "2", "B", "a"]);
  assert.equal(agent.compareStableId("B", "a"), -1);
});


test("normalizeBoundary validates snapshotUpdatedAt", () => {
  assert.equal(agent.normalizeBoundary({
    snapshotUpdatedAt: "2026-04-24T00:10:00.000Z",
  }).snapshotUpdatedAt, "2026-04-24T00:10:00.000Z");

  assert.equal(agent.normalizeBoundary({
    snapshotUpdatedAt: "not-a-date",
  }).snapshotUpdatedAt, null);

  assert.equal(agent.normalizeBoundary({
    snapshotUpdatedAt: "",
  }).snapshotUpdatedAt, null);

  assert.equal(agent.normalizeBoundary({
    snapshotUpdatedAt: 123,
  }).snapshotUpdatedAt, null);
});


test("dedupe helper matches any existing task for the same PR and type", () => {
  const manager = new agent.EventTaskManager();
  manager.events = [
    makeTask({ id: "pending", prKey: "demo/repo#1", type: "NEW_COMMENT", status: agent.TASK_STATUS.PENDING }),
    makeTask({ id: "blocked", prKey: "demo/repo#2", type: "NEW_COMMENT", status: agent.TASK_STATUS.BLOCKED }),
  ];

  assert.equal(manager.hasTaskForPrAndType("demo/repo#1", "NEW_COMMENT"), true);
  assert.equal(manager.hasTaskForPrAndType("demo/repo#2", "NEW_COMMENT"), true);
  assert.equal(manager.hasTaskForPrAndType("demo/repo#1", "BOT_COMMENT"), false);
  assert.equal(manager.hasTaskForPrAndType("demo/repo#4", "NEW_COMMENT"), false);
});


test("GraphQL args validate numeric variables as GraphQL Int values", () => {
  assert.deepStrictEqual(
    agent.buildGhGraphQLArgs("query", {
      owner: "demo",
      repo: "repo",
      prNumber: 2147483647,
      after: "cursor",
      omitted: null,
    }),
    [
      "api",
      "graphql",
      "-f",
      "query=query",
      "-f",
      "owner=demo",
      "-f",
      "repo=repo",
      "-F",
      "prNumber=2147483647",
      "-f",
      "after=cursor",
    ],
  );

  assert.throws(() => agent.buildGhGraphQLArgs("query", { prNumber: 2147483648 }), /prNumber is outside Int range/);
  assert.throws(() => agent.buildGhGraphQLArgs("query", { prNumber: 1.5 }), /prNumber is outside Int range/);
  assert.throws(() => agent.buildGhGraphQLArgs("query", { prNumber: Number.NaN }), /prNumber is outside Int range/);
  assert.throws(() => agent.buildGhGraphQLArgs("query", { prNumber: Number.POSITIVE_INFINITY }), /prNumber is outside Int range/);
});


test("atomic json writes target file and leaves no temp file behind", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pr-agent-atomic-"));
  const filePath = path.join(dir, "event_state.json");

  try {
    await agent.writeJsonFileAtomic(filePath, { ok: true });

    assert.deepStrictEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { ok: true });
    assert.deepStrictEqual(await fs.readdir(dir), ["event_state.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test("saveAll logs repair context when the second runtime file write fails", async () => {
  const listener = createListener();
  listener.state.save = async () => {};
  listener.taskManager.save = async () => {
    throw new Error("disk full after state write");
  };

  await assert.rejects(() => listener.saveAll(), /disk full after state write/);
  assert.ok(listener.actionLogger.lines.some((line) => (
    line.includes("runtime_save_failed file=task")
    && line.includes("repair=")
    && line.includes("restore a consistent pair")
  )));
});


test("runtime temp file patterns are gitignored", async () => {
  const result = await runProcess("git", [
    "check-ignore",
    "-v",
    "event_state.json.1.2.uuid.tmp",
    "event_task.json.1.2.uuid.tmp",
  ]);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /event_state\.json\.\*\.tmp/);
  assert.match(result.stdout, /event_task\.json\.\*\.tmp/);
});

test("startup and polling only refresh runtime JSON", async () => {
  const listener = createListener();
  const calls = [];
  listener.generateEventJson = async () => {
    calls.push("generate");
    return true;
  };

  await listener.bootstrapRefresh();
  assert.deepStrictEqual(calls, ["generate"]);

  calls.length = 0;
  await listener._runPollCycle();
  assert.deepStrictEqual(calls, ["generate"]);
  assert.equal(Object.prototype.hasOwnProperty.call(listener, "_dispatchRunnableTasks"), false);
});

test("event listener start only loads and schedules polling", async () => {
  const listener = createListener();
  const calls = [];
  listener.load = async () => {
    calls.push("load");
  };
  listener._scheduleNext = () => {
    calls.push("schedule");
  };

  await listener.start();

  assert.deepStrictEqual(calls, ["load", "schedule"]);
  assert.equal(listener.enabled, true);
});

test("removed event worker and notification CLI flags are unknown", async () => {
  const help = await runProcess(process.execPath, ["run-claude-agent.js", "--help"]);
  assert.equal(help.code, 0);
  assert.equal(/event-subagent|show-subagent-output|event-notification/i.test(help.stdout), false);

  for (const flag of ["--event-subagent", "--no-event-subagent", "--show-subagent-output", "--event-notification"]) {
    const result = await runProcess(process.execPath, ["run-claude-agent.js", flag]);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unknown argument|未知参数/);
  }
});

test("handled state-backed baseline suppresses the same active trigger until details change", async () => {
  const listener = createListener();
  const failedSnapshot = makeSnapshot({
    prKey: "demo/repo#70",
    updatedAt: "2026-04-24T00:01:00.000Z",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "ci / Unit tests", conclusion: "FAILURE" }],
  });
  const handledTask = {
    prKey: failedSnapshot.prKey,
    type: "CI_FAILURE",
    boundary: agent.buildBoundaryFromSnapshot(failedSnapshot),
  };

  listener.state.applyTaskSuccess(handledTask, failedSnapshot);
  await listener._scanSnapshot(makeSnapshot({
    ...failedSnapshot,
    updatedAt: "2026-04-24T00:02:00.000Z",
  }));
  assert.deepStrictEqual(listener.taskManager.events, []);

  await listener._scanSnapshot(makeSnapshot({
    ...failedSnapshot,
    updatedAt: "2026-04-24T00:03:00.000Z",
    failingChecks: [{ label: "ci / Integration", conclusion: "FAILURE" }],
  }));
  assert.deepStrictEqual(listener.taskManager.events.map((event) => event.type), ["CI_FAILURE"]);
});


test("standalone refresh uses only bootstrap JSON generation", async () => {
  const listener = createListener();
  const calls = [];
  listener.bootstrapRefresh = async () => {
    calls.push("bootstrap");
    return true;
  };

  const refreshed = await agent.refreshEventJsonOnce({ listener }, createLogger());

  assert.equal(refreshed.listener, listener);
  assert.equal(refreshed.updated, true);
  assert.equal(refreshed.skippedReason, null);
  assert.deepStrictEqual(calls, ["bootstrap"]);
});


test("refreshEventJsonOnce reports skipped when lock is active", async () => {
  const runtime = await createRuntimeFiles();
  try {
    const first = createIsolatedListener(runtime);
    first._fetchOpenPrList = async () => [];
    assert.equal(await first.generateEventJson(), true);

    const second = createIsolatedListener(runtime);
    second._fetchOpenPrList = async () => {
      throw new Error("second listener should not scan while lock is active");
    };
    const result = await agent.refreshEventJsonOnce({ listener: second }, second.actionLogger);

    assert.equal(result.listener, second);
    assert.equal(result.updated, false);
    assert.equal(result.skippedReason, "active_listener_lock");
    assert.ok(second.actionLogger.lines.some((line) => line.includes("event_listener_lock_active")));
    first.stop();
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("refreshEventJsonOnce strict mode rejects open PR search failures", async () => {
  const listener = createListener();
  listener._fetchOpenPrList = async () => {
    throw new Error("gh search failed");
  };

  await assert.rejects(
    () => agent.refreshEventJsonOnce({ listener, strict: true }, listener.actionLogger),
    /open PR search failed/,
  );
  assert.equal(listener.lastRefreshResult.searchFailed, true);
});


test("update.sh exits failed when contributor login is missing", async () => {
  const workspace = await createUpdateScriptWorkspace();
  try {
    const result = await runProcess("bash", ["update.sh"], {
      cwd: workspace,
      env: {
        ...process.env,
        PR_AGENT_CONTRIBUTOR_LOGIN: "",
        PR_AGENT_READY_TO_MERGE_REVIEW_MODE: "",
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /event JSON update failed:/);
    assert.match(result.stderr, /contributorLogin|PR_AGENT_CONTRIBUTOR_LOGIN/);
  } finally {
    await waitFor(async () => {
      try {
        await fs.rm(workspace, { recursive: true, force: true });
        return true;
      } catch (error) {
        if (error.code === "EBUSY" || error.code === "ENOTEMPTY" || error.code === "EPERM") {
          return false;
        }
        throw error;
      }
    }, 2000);
  }
});


test("main bootstrap without listener does not create event tasks", async () => {
  const workspace = await createAgentWorkspace();
  try {
    const fakeClaude = await createFakeClaudeCommand(workspace);
    const result = await runProcess(process.execPath, [
      "run-claude-agent.js",
      "--cwd",
      workspace,
      "--claude-command",
      fakeClaude,
      "--no-event-listener",
      "--initial-delay-seconds",
      "60",
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const actionLogs = (await fs.readdir(path.join(workspace, ".claude_agent_logs")))
      .filter((name) => name.startsWith("claude_actions_"));
    assert.equal(actionLogs.length, 1);
    const logText = await fs.readFile(path.join(workspace, ".claude_agent_logs", actionLogs[0]), "utf8");
    assert.match(logText, /bootstrap_skipped reason=event_listener_disabled/);
    assert.doesNotMatch(logText, /bootstrap_done/);
    assert.doesNotMatch(logText, /event_listener_lock_acquired/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});


test("main stream output shows thinking system and tool results by default", async () => {
  const workspace = await createAgentWorkspace();
  try {
    const fakeClaude = await createFakeClaudeOutputCommand(workspace, [
      {
        type: "system",
        subtype: "init",
        session_id: "session-main",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "checking the queue" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "event_task.json" } },
            { type: "text", text: "main visible text" },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "line one\nline two" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        num_turns: 1,
        total_cost_usd: 0.5,
      },
    ]);
    const result = await runProcess(process.execPath, [
      "run-claude-agent.js",
      "--cwd",
      workspace,
      "--claude-command",
      fakeClaude,
      "--no-event-listener",
      "--initial-delay-seconds",
      "60",
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const plain = stripAnsi(result.stdout);
    assert.match(plain, /\[system\] init session=session-main/);
    assert.match(plain, /\[thinking\] checking the queue/);
    assert.match(plain, /\[tool\] Read \{"file_path":"event_task\.json"\}/);
    assert.match(plain, /main visible text/);
    // tool-result is hidden by default
    assert.ok(!plain.includes("[tool-result]"), "tool-result should not appear by default");
    assert.match(plain, /\[result\] success turns=1 cost=\$0\.500000/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});


test("main stream output shows tool results when --show-tool-results is passed", async () => {
  const workspace = await createAgentWorkspace();
  try {
    const fakeClaude = await createFakeClaudeOutputCommand(workspace, [
      {
        type: "system",
        subtype: "init",
        session_id: "session-main",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "checking the queue" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "event_task.json" } },
            { type: "text", text: "main visible text" },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "line one\nline two" },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        num_turns: 1,
        total_cost_usd: 0.5,
      },
    ]);
    const result = await runProcess(process.execPath, [
      "run-claude-agent.js",
      "--cwd",
      workspace,
      "--claude-command",
      fakeClaude,
      "--no-event-listener",
      "--initial-delay-seconds",
      "60",
      "--show-tool-results",
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const plain = stripAnsi(result.stdout);
    assert.match(plain, /\[tool-result\] tool-1 line one\\nline two/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});


test("generateEventJson uses injected fetchPrSnapshot", async () => {
  const runtime = await createRuntimeFiles();
  try {
    let fetchCount = 0;
    const listener = createIsolatedListener(runtime, {
      fetchPrSnapshot: async (prKey) => {
        fetchCount += 1;
        return makeSnapshot({
          prKey,
          statusCheckState: "FAILED",
          failingChecks: [{ label: "lint / eslint", conclusion: "FAILURE" }],
        });
      },
    });
    listener._fetchOpenPrList = async () => [{ prKey: "demo/repo#71" }];

    await listener.generateEventJson();
    listener.stop();

    assert.equal(fetchCount, 1);
    const taskFile = JSON.parse(await fs.readFile(runtime.taskFile, "utf8"));
    assert.equal(taskFile.events.length, 1);
    assert.equal(taskFile.events[0].type, "CI_FAILURE");
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("PR scan failure log uses per-failure timestamp and gh diagnostics", async () => {
  const runtime = await createRuntimeFiles();
  try {
    let fetchCount = 0;
    const listener = createIsolatedListener(runtime, {
      snapshotRetryDelayMs: 0,
      fetchPrSnapshot: async () => {
        fetchCount += 1;
        const error = makeGhCommandError("Get \"https://api.github.com/repos/demo/repo/issues/1/comments\": EOF");
        error.ghCommandKind = "rest";
        error.ghAttempt = 3;
        throw error;
      },
    });
    listener._fetchOpenPrList = async () => [
      { prKey: "demo/repo#72" },
      { prKey: "demo/repo#73" },
    ];

    await listener.generateEventJson();
    listener.stop();

    const failures = listener.actionLogger.lines.filter((line) => line.includes("pr_scan_failed"));
    assert.equal(fetchCount, 6);
    assert.equal(failures.length, 2);
    assert.match(failures[0], /pr=demo\/repo#72 attempt=3 commandKind=rest ghAttempt=3/);
    assert.match(failures[1], /pr=demo\/repo#73 attempt=3 commandKind=rest ghAttempt=3/);
    assert.doesNotMatch(failures[0], /^\[.*\] event_tick .*\[.*\]/);
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("second refresh skips while active listener holds runtime lock", async () => {
  const runtime = await createRuntimeFiles();
  try {
    const first = createIsolatedListener(runtime);
    first._fetchOpenPrList = async () => [];

    const second = createIsolatedListener(runtime);
    second._fetchOpenPrList = async () => {
      throw new Error("second listener should not scan while lock is active");
    };

    assert.equal(await first.generateEventJson(), true);
    assert.equal(await second.generateEventJson(), false);
    assert.ok(second.actionLogger.lines.some((line) => line.includes("event_listener_lock_active")));
    first.stop();
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("listener reloads external task deletion before next poll save", async () => {
  const runtime = await createRuntimeFiles();
  try {
    const snapshot = makeSnapshot({
      prKey: "demo/repo#72",
      updatedAt: new Date().toISOString(),
      issueComments: [
        makeActivity({
          id: 720,
          createdAt: "2026-04-24T00:01:00.000Z",
          authorLogin: "maintainer",
          authorAssociation: "OWNER",
          body: "Please update this.",
        }),
      ],
    });
    const listener = createIsolatedListener(runtime, {
      fetchPrSnapshot: async () => snapshot,
    });
    listener._fetchOpenPrList = async () => [{ prKey: snapshot.prKey }];

    await listener.generateEventJson();
    const firstTasks = JSON.parse(await fs.readFile(runtime.taskFile, "utf8"));
    assert.equal(firstTasks.events.length, 1);

    const stateFile = JSON.parse(await fs.readFile(runtime.stateFile, "utf8"));
    const taskFile = JSON.parse(await fs.readFile(runtime.taskFile, "utf8"));
    stateFile.prs[snapshot.prKey].baseline.commentBaselines.maintainer = agent.buildBoundaryFromCategorySnapshot(snapshot, "maintainer");
    stateFile.prs[snapshot.prKey].baseline.updatedAt = snapshot.updatedAt;
    taskFile.events = [];
    await agent.writeJsonFileAtomic(runtime.stateFile, stateFile);
    await agent.writeJsonFileAtomic(runtime.taskFile, taskFile);

    await listener._runPollCycle();
    listener.stop();

    const finalTasks = JSON.parse(await fs.readFile(runtime.taskFile, "utf8"));
    assert.deepStrictEqual(finalTasks.events, []);
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("runtime mutation retries after an external write and preserves it", async () => {
  const runtime = await createRuntimeFiles();
  try {
    const listener = createIsolatedListener(runtime);
    await agent.writeJsonFileAtomic(runtime.stateFile, {
      schemaVersion: 1,
      runtimeRevision: "base",
      prs: {},
      lastSyncAt: "2026-04-24T00:00:00.000Z",
    });
    await agent.writeJsonFileAtomic(runtime.taskFile, {
      schemaVersion: 1,
      runtimeRevision: "base",
      events: [],
    });

    await listener._withRuntimeMutation("test_conflict_retry", async ({ attempt }) => {
      if (attempt === 1) {
        await agent.writeJsonFileAtomic(runtime.taskFile, {
          schemaVersion: 1,
          runtimeRevision: "base",
          events: [
            makeTask({
              id: "external-task",
              prKey: "demo/repo#80",
              type: "NEW_COMMENT",
            }),
          ],
        });
      }
      listener.taskManager.add(
        "demo/repo#81",
        "BOT_COMMENT",
        agent.TASK_EVENT_SEVERITY.BOT_COMMENT,
        { snapshotSummary: "bot" },
        agent.normalizeBoundary(null),
      );
    });

    listener.stop();

    const taskFile = JSON.parse(await fs.readFile(runtime.taskFile, "utf8"));
    assert.equal(taskFile.events.some((event) => event.id === "external-task"), true);
    assert.equal(taskFile.events.some((event) => event.prKey === "demo/repo#81"), true);
    assert.ok(listener.actionLogger.lines.some((line) => line.includes("runtime_save_conflict")));
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("non-default cwd still points prompt and runtime files at launcher root", async () => {
  const runtime = await createRuntimeFiles();
  try {
    const listener = createListener({
      cwd: runtime.dir,
      stateFile: runtime.stateFile,
      taskFile: runtime.taskFile,
    });
    const prompt = agent.buildDefaultPrompt();

    assert.equal(listener.config.cwd, runtime.dir);
    assert.equal(listener.state.filePath, runtime.stateFile);
    assert.equal(listener.taskManager.filePath, runtime.taskFile);
    assert.match(prompt, new RegExp(agent.STATE_FILE.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
    assert.match(prompt, new RegExp(agent.TASK_FILE.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("revision mismatch includes recovery diagnostics", async () => {
  const runtime = await createRuntimeFiles();
  try {
    await agent.writeJsonFileAtomic(runtime.stateFile, {
      schemaVersion: 1,
      runtimeRevision: "state-revision",
      prs: {},
      lastSyncAt: "2026-04-24T00:00:00.000Z",
    });
    await agent.writeJsonFileAtomic(runtime.taskFile, {
      schemaVersion: 1,
      runtimeRevision: "task-revision",
      events: [],
    });
    const listener = createIsolatedListener(runtime);

    await assert.rejects(
      () => listener.load(),
      (error) => {
        assert.match(error.message, /Runtime JSON revision mismatch: state=state-revision task=task-revision/);
        assert.match(error.message, /stateFile=/);
        assert.match(error.message, /taskFile=/);
        assert.match(error.message, /mtime=/);
        assert.match(error.message, /Stop the listener before editing runtime JSON/);
        return true;
      },
    );
  } finally {
    await fs.rm(runtime.dir, { recursive: true, force: true });
  }
});


test("ready to merge is info-only and does not create a task", async () => {
  const listener = createListener();
  await listener._scanSnapshot(makeSnapshot({
    prKey: "demo/repo#8",
    reviewDecision: "APPROVED",
    statusCheckState: "SUCCESS",
    mergeable: "MERGEABLE",
    unresolvedReviewThreadCount: 0,
  }));

  assert.equal(listener.taskManager.events.length, 0);
  assert.equal(listener.actionLogger.lines.some((line) => line.includes("type=READY_TO_MERGE")), true);
});


test("ready to merge keeps requiring approval by default", async () => {
  const snapshot = makeSnapshot({
    prKey: "demo/repo#80",
    reviewDecision: null,
    statusCheckState: "SUCCESS",
    mergeable: "MERGEABLE",
    unresolvedReviewThreadCount: 0,
  });

  assert.equal(agent.isReadyToMergeFromRaw(snapshot), false);

  const listener = createListener();
  await listener._scanSnapshot(snapshot);

  assert.equal(listener.taskManager.events.length, 0);
  assert.equal(listener.actionLogger.lines.some((line) => line.includes("type=READY_TO_MERGE")), false);
});


test("ready to merge can allow repositories without required review", async () => {
  const snapshot = makeSnapshot({
    prKey: "demo/repo#81",
    reviewDecision: null,
    statusCheckState: "SUCCESS",
    mergeable: "MERGEABLE",
    unresolvedReviewThreadCount: 0,
  });

  assert.equal(agent.isReadyToMergeFromRaw(snapshot, {
    readyToMergeReviewMode: "allow-no-review-required",
  }), true);

  const listener = createListener({
    readyToMergeReviewMode: "allow-no-review-required",
  });
  await listener._scanSnapshot(snapshot);

  assert.equal(listener.taskManager.events.length, 0);
  assert.equal(listener.actionLogger.lines.some((line) => line.includes("type=READY_TO_MERGE")), true);
});


test("ready to merge no-review mode does not bypass explicit blockers", () => {
  const options = { readyToMergeReviewMode: "allow-no-review-required" };
  const ready = {
    reviewDecision: null,
    statusCheckState: "SUCCESS",
    mergeable: "MERGEABLE",
    unresolvedReviewThreadCount: 0,
  };

  assert.equal(agent.isReadyToMergeFromRaw(makeSnapshot({ ...ready, reviewDecision: "CHANGES_REQUESTED" }), options), false);
  assert.equal(agent.isReadyToMergeFromRaw(makeSnapshot({ ...ready, reviewDecision: "REVIEW_REQUIRED" }), options), false);
  assert.equal(agent.isReadyToMergeFromRaw({ ...makeSnapshot(ready), reviewDecision: undefined }, options), false);
  assert.equal(agent.isReadyToMergeFromRaw(makeSnapshot({ ...ready, isDraft: true }), options), false);
  assert.equal(agent.isReadyToMergeFromRaw(makeSnapshot({ ...ready, statusCheckState: "PENDING" }), options), false);
  assert.equal(agent.isReadyToMergeFromRaw(makeSnapshot({ ...ready, mergeable: "CONFLICTING" }), options), false);
  assert.equal(agent.isReadyToMergeFromRaw(makeSnapshot({ ...ready, unresolvedReviewThreadCount: 1 }), options), false);
});


test("ready to merge no-review mode does not repeat unchanged info event", async () => {
  const listener = createListener({
    readyToMergeReviewMode: "allow-no-review-required",
  });
  const snapshot = makeSnapshot({
    prKey: "demo/repo#82",
    reviewDecision: null,
    statusCheckState: "SUCCESS",
    mergeable: "MERGEABLE",
    unresolvedReviewThreadCount: 0,
  });

  await listener._scanSnapshot(snapshot);
  await listener._scanSnapshot(snapshot);

  const readyLines = listener.actionLogger.lines.filter((line) => line.includes("type=READY_TO_MERGE"));
  assert.equal(readyLines.length, 1);
});


test("mixed comment batch is split into maintainer bot and user tasks", async () => {
  const listener = createListener();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#2",
    updatedAt: "2026-04-24T00:10:00.000Z",
    issueComments: [
      makeActivity({
        id: 100,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "MEMBER",
        body: "maintainer note",
      }),
      makeActivity({
        id: 101,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "bot note",
      }),
      makeActivity({
        id: 102,
        createdAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "contributor",
        body: "user note",
      }),
    ],
  });

  await listener._scanSnapshot(snapshot);

  const tasksByType = Object.fromEntries(listener.taskManager.events.map((event) => [event.type, event]));
  assert.deepStrictEqual(Object.keys(tasksByType).sort(), ["BOT_COMMENT", "MAINTAINER_COMMENT", "NEW_COMMENT"]);

  assert.deepStrictEqual(
    tasksByType.MAINTAINER_COMMENT.details.activities.map((activity) => activity.authorLogin),
    ["maintainer"],
  );
  assert.equal(tasksByType.MAINTAINER_COMMENT.details.latestActivity.authorLogin, "maintainer");

  assert.deepStrictEqual(
    tasksByType.BOT_COMMENT.details.activities.map((activity) => activity.authorLogin),
    ["review-bot[bot]"],
  );
  assert.equal(tasksByType.BOT_COMMENT.details.latestActivity.authorLogin, "review-bot[bot]");

  assert.deepStrictEqual(
    tasksByType.NEW_COMMENT.details.activities.map((activity) => activity.authorLogin),
    ["contributor"],
  );
  assert.equal(tasksByType.NEW_COMMENT.details.latestActivity.authorLogin, "contributor");
});


test("edited existing comments create category tasks", async () => {
  const oldSnapshot = makeSnapshot({
    prKey: "demo/repo#83",
    updatedAt: "2026-04-24T00:05:00.000Z",
    issueComments: [
      makeActivity({
        id: 810,
        createdAt: "2026-04-24T00:01:00.000Z",
        updatedAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "placeholder maintainer note",
      }),
      makeActivity({
        id: 811,
        createdAt: "2026-04-24T00:02:00.000Z",
        updatedAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "placeholder bot note",
      }),
      makeActivity({
        id: 812,
        createdAt: "2026-04-24T00:03:00.000Z",
        updatedAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "external-user",
        body: "placeholder user note",
      }),
    ],
  });
  const editedSnapshot = makeSnapshot({
    prKey: oldSnapshot.prKey,
    updatedAt: "2026-04-24T00:10:00.000Z",
    issueComments: [
      makeActivity({
        id: 810,
        createdAt: "2026-04-24T00:01:00.000Z",
        updatedAt: "2026-04-24T00:07:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "edited maintainer request",
      }),
      makeActivity({
        id: 811,
        createdAt: "2026-04-24T00:02:00.000Z",
        updatedAt: "2026-04-24T00:08:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "edited bot failure details",
      }),
      makeActivity({
        id: 812,
        createdAt: "2026-04-24T00:03:00.000Z",
        updatedAt: "2026-04-24T00:09:00.000Z",
        authorLogin: "external-user",
        body: "edited user follow-up",
      }),
    ],
  });
  const listener = createListener();
  const entry = listener.state.getOrInit(oldSnapshot.prKey);
  entry.baseline = agent.baselineFromSnapshot(oldSnapshot);

  await listener._scanSnapshot(editedSnapshot);

  const tasksByType = Object.fromEntries(listener.taskManager.events.map((event) => [event.type, event]));
  assert.deepStrictEqual(Object.keys(tasksByType).sort(), ["BOT_COMMENT", "MAINTAINER_COMMENT", "NEW_COMMENT"]);
  assert.deepStrictEqual(
    tasksByType.MAINTAINER_COMMENT.details.activities.map((activity) => activity.excerpt),
    ["edited maintainer request"],
  );
  assert.deepStrictEqual(
    tasksByType.BOT_COMMENT.details.activities.map((activity) => activity.excerpt),
    ["edited bot failure details"],
  );
  assert.deepStrictEqual(
    tasksByType.NEW_COMMENT.details.activities.map((activity) => activity.excerpt),
    ["edited user follow-up"],
  );
});


test("activity summaries preserve review reply parent ids", () => {
  const summary = agent.createActivitySummary(makeActivity({
    stream: "review_comment",
    id: 900,
    createdAt: "2026-04-24T00:01:00.000Z",
    authorLogin: "example-user",
    inReplyTo: "899",
    body: "handled",
  }));

  assert.equal(summary.inReplyTo, "899");
});


test("review comment normalization preserves reply parent ids", () => {
  const normalized = agent.normalizeReviewComment({
    id: 901,
    created_at: "2026-04-24T00:01:00.000Z",
    updated_at: "2026-04-24T00:01:00.000Z",
    in_reply_to_id: 900,
    user: {
      login: "example-user",
      type: "User",
    },
    body: "handled",
    html_url: "https://example.com/review-comment/901",
  });

  assert.equal(normalized.stream, "review_comment");
  assert.equal(normalized.id, "901");
  assert.equal(normalized.inReplyTo, "900");
});


test("bot comment task is removed when all triggering review comments have human replies", async () => {
  const listener = createListener();
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#84",
    reviewComments: [
      makeActivity({
        stream: "review_comment",
        id: 910,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "first bot review comment",
      }),
      makeActivity({
        stream: "review_comment",
        id: 911,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "second bot review comment",
      }),
    ],
  });
  await listener._scanSnapshot(firstSnapshot);

  assert.equal(listener.taskManager.events.length, 1);
  assert.equal(listener.taskManager.events[0].type, "BOT_COMMENT");
  assert.deepStrictEqual(listener.taskManager.events[0].details.awaitingReplyReviewCommentIds, ["910", "911"]);

  await listener._scanSnapshot(makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:05:00.000Z",
    reviewComments: [
      ...firstSnapshot.reviewComments,
      makeActivity({
        stream: "review_comment",
        id: 912,
        createdAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "example-user",
        inReplyTo: "910",
        body: "handled first",
      }),
      makeActivity({
        stream: "review_comment",
        id: 913,
        createdAt: "2026-04-24T00:04:00.000Z",
        authorLogin: "example-user",
        inReplyTo: "911",
        body: "handled second",
      }),
    ],
  }));

  assert.equal(listener.taskManager.events.length, 0);
  const entry = listener.state.getOrInit(firstSnapshot.prKey);
  assert.equal(entry.baseline.commentBaselines.bot.reviewCommentCursor.lastId, "911");
  assert.ok(listener.actionLogger.lines.some((line) => line.includes("reason=bot_review_comments_replied replied=2")));
});


test("bot comment task stays pending when only some review comments have human replies", async () => {
  const listener = createListener();
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#85",
    reviewComments: [
      makeActivity({
        stream: "review_comment",
        id: 920,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "first bot review comment",
      }),
      makeActivity({
        stream: "review_comment",
        id: 921,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "second bot review comment",
      }),
    ],
  });
  await listener._scanSnapshot(firstSnapshot);

  await listener._scanSnapshot(makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:04:00.000Z",
    reviewComments: [
      ...firstSnapshot.reviewComments,
      makeActivity({
        stream: "review_comment",
        id: 922,
        createdAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "example-user",
        inReplyTo: "920",
        body: "handled first",
      }),
    ],
  }));

  assert.equal(listener.taskManager.events.length, 1);
  const task = listener.taskManager.events[0];
  assert.equal(task.type, "BOT_COMMENT");
  assert.deepStrictEqual(task.details.replyResolution.awaitedIds, ["920", "921"]);
  assert.deepStrictEqual(task.details.replyResolution.repliedIds, ["920"]);
  assert.deepStrictEqual(task.details.replyResolution.unresolvedIds, ["921"]);
});


test("bot comment task is not removed by bot replies", async () => {
  const listener = createListener();
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#86",
    reviewComments: [
      makeActivity({
        stream: "review_comment",
        id: 930,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "bot review comment",
      }),
    ],
  });
  await listener._scanSnapshot(firstSnapshot);

  await listener._scanSnapshot(makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:03:00.000Z",
    reviewComments: [
      ...firstSnapshot.reviewComments,
      makeActivity({
        stream: "review_comment",
        id: 931,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        inReplyTo: "930",
        body: "bot follow-up",
      }),
    ],
  }));

  assert.equal(listener.taskManager.events.length, 1);
  assert.deepStrictEqual(listener.taskManager.events[0].details.replyResolution.unresolvedIds, ["930"]);
});


test("legacy bot comment task falls back to activity ids for reply cleanup", async () => {
  const listener = createListener();
  const botComment = makeActivity({
    stream: "review_comment",
    id: 940,
    createdAt: "2026-04-24T00:01:00.000Z",
    authorLogin: "review-bot[bot]",
    authorType: "Bot",
    body: "legacy bot review comment",
  });
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#87",
    reviewComments: [botComment],
  });
  listener.state.getOrInit(firstSnapshot.prKey).baseline = agent.baselineFromSnapshot(firstSnapshot);
  listener.taskManager.add(
    firstSnapshot.prKey,
    "BOT_COMMENT",
    agent.TASK_EVENT_SEVERITY.BOT_COMMENT,
    {
      activities: [agent.createActivitySummary(botComment)],
      latestActivity: agent.createActivitySummary(botComment),
    },
    agent.buildBoundaryFromCategorySnapshot(firstSnapshot, "bot"),
  );

  await listener._scanSnapshot(makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:03:00.000Z",
    reviewComments: [
      botComment,
      makeActivity({
        stream: "review_comment",
        id: 941,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "example-user",
        inReplyTo: "940",
        body: "handled",
      }),
    ],
    reviews: [
      makeActivity({
        stream: "review",
        id: 942,
        createdAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        state: "COMMENTED",
        body: "bot review summary",
      }),
    ],
  }));

  assert.equal(listener.taskManager.events.length, 0);
  assert.ok(listener.actionLogger.lines.some((line) => line.includes("reason=bot_review_comments_replied replied=1")));
});


test("own contributor comments do not create comment tasks", async () => {
  const listener = createListener();
  await listener._scanSnapshot(makeSnapshot({
    prKey: "demo/repo#9",
    issueComments: [
      makeActivity({
        id: 500,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "example-user",
        body: "my own follow-up",
      }),
      makeActivity({
        id: 501,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "external-user",
        body: "external question",
      }),
    ],
  }));

  assert.equal(listener.taskManager.events.length, 1);
  assert.equal(listener.taskManager.events[0].type, "NEW_COMMENT");
  assert.deepStrictEqual(
    listener.taskManager.events[0].details.activities.map((activity) => activity.authorLogin),
    ["external-user"],
  );

  const ownOnlyListener = createListener();
  await ownOnlyListener._scanSnapshot(makeSnapshot({
    prKey: "demo/repo#10",
    issueComments: [
      makeActivity({
        id: 502,
        createdAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "example-user",
        body: "my own status update",
      }),
    ],
  }));

  assert.equal(ownOnlyListener.taskManager.events.length, 0);
});


test("human login containing bot is not classified as bot when authorType is User", () => {
  assert.equal(agent.classifyActivityCategory(makeActivity({
    id: 503,
    createdAt: "2026-04-24T00:04:00.000Z",
    authorLogin: "robotics-maintainer",
    authorType: "User",
    authorAssociation: "OWNER",
  })), "maintainer");
  assert.equal(agent.classifyActivityCategory(makeActivity({
    id: 504,
    createdAt: "2026-04-24T00:05:00.000Z",
    authorLogin: "review-bot[bot]",
    authorType: "User",
  })), "bot");
});


test("collectNewActivities detects replacement comments when count stays the same", () => {
  const snapshot = makeSnapshot({
    prKey: "demo/repo#3",
    issueComments: [
      makeActivity({
        id: 200,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "reviewer",
        body: "replacement comment",
      }),
    ],
  });

  const result = agent.collectNewActivities(snapshot, {
    issueCommentCursor: {
      count: 1,
      lastId: "100",
      lastCreatedAt: "2026-04-24T00:01:00.000Z",
    },
    reviewCommentCursor: agent.emptyCursor(),
    reviewCursor: agent.emptyCursor(),
  }, "user");

  assert.deepStrictEqual(result.items.map((item) => item.id), ["200"]);
  assert.deepStrictEqual(result.counts, {
    issueComments: 1,
    reviewComments: 0,
    reviews: 0,
  });
});


test("collectNewActivities detects edited issue comments with unchanged id", () => {
  const oldComment = makeActivity({
    id: 210,
    createdAt: "2026-04-24T00:01:00.000Z",
    updatedAt: "2026-04-24T00:01:00.000Z",
    authorLogin: "maintainer",
    authorAssociation: "OWNER",
    body: "old maintainer comment",
  });
  const editedComment = makeActivity({
    id: 210,
    createdAt: "2026-04-24T00:01:00.000Z",
    updatedAt: "2026-04-24T00:05:00.000Z",
    authorLogin: "maintainer",
    authorAssociation: "OWNER",
    body: "edited maintainer comment",
  });
  const snapshot = makeSnapshot({
    prKey: "demo/repo#3",
    issueComments: [editedComment],
  });

  const result = agent.collectNewActivities(snapshot, {
    issueCommentCursor: agent.buildCursor([oldComment]),
    reviewCommentCursor: agent.emptyCursor(),
    reviewCursor: agent.emptyCursor(),
  }, "maintainer");

  assert.deepStrictEqual(result.items.map((item) => item.id), ["210"]);
  assert.equal(result.items[0].body, "edited maintainer comment");
  assert.deepStrictEqual(result.counts, {
    issueComments: 1,
    reviewComments: 0,
    reviews: 0,
  });
});


test("collectNewActivities detects edited review comments with unchanged id", () => {
  const oldComment = makeActivity({
    stream: "review_comment",
    id: 220,
    createdAt: "2026-04-24T00:02:00.000Z",
    updatedAt: "2026-04-24T00:02:00.000Z",
    authorLogin: "maintainer",
    authorAssociation: "OWNER",
    body: "old review comment",
  });
  const editedComment = makeActivity({
    stream: "review_comment",
    id: 220,
    createdAt: "2026-04-24T00:02:00.000Z",
    updatedAt: "2026-04-24T00:06:00.000Z",
    authorLogin: "maintainer",
    authorAssociation: "OWNER",
    body: "edited review comment",
  });
  const snapshot = makeSnapshot({
    prKey: "demo/repo#3",
    reviewComments: [editedComment],
  });

  const result = agent.collectNewActivities(snapshot, {
    issueCommentCursor: agent.emptyCursor(),
    reviewCommentCursor: agent.buildCursor([oldComment]),
    reviewCursor: agent.emptyCursor(),
  }, "maintainer");

  assert.deepStrictEqual(result.items.map((item) => item.id), ["220"]);
  assert.equal(result.items[0].body, "edited review comment");
  assert.deepStrictEqual(result.counts, {
    issueComments: 0,
    reviewComments: 1,
    reviews: 0,
  });
});


test("collectNewActivities de-duplicates edited comments when cursor id disappeared", () => {
  const editedComment = makeActivity({
    id: 230,
    createdAt: "2026-04-24T00:03:00.000Z",
    updatedAt: "2026-04-24T00:06:00.000Z",
    authorLogin: "maintainer",
    authorAssociation: "OWNER",
    body: "edited maintainer comment",
  });
  const snapshot = makeSnapshot({
    prKey: "demo/repo#3",
    issueComments: [editedComment],
  });

  const result = agent.collectNewActivities(snapshot, {
    issueCommentCursor: {
      count: 1,
      lastId: "deleted-comment",
      lastCreatedAt: "2026-04-24T00:02:00.000Z",
      itemFingerprints: {
        230: "previous-fingerprint",
      },
    },
    reviewCommentCursor: agent.emptyCursor(),
    reviewCursor: agent.emptyCursor(),
  }, "maintainer");

  assert.deepStrictEqual(result.items.map((item) => item.id), ["230"]);
  assert.equal(result.counts.issueComments, 1);
});


test("open PR search filter ignores PRs in own repositories", () => {
  assert.equal(
    agent.shouldTrackOpenPrSearchItem({
      repository_url: "https://api.github.com/repos/example-user/servers",
      number: 1,
    }),
    false,
  );

  assert.equal(
    agent.shouldTrackOpenPrSearchItem({
      repository_url: "https://api.github.com/repos/modelcontextprotocol/servers",
      number: 4013,
    }),
    true,
  );
});


test("cleanup removes already tracked PRs in own repositories", async () => {
  const listener = createListener();
  const snapshot = makeSnapshot({ prKey: "example-user/servers#1" });

  listener.state.setObservedSnapshot(snapshot.prKey, snapshot);
  listener.taskManager.add(
    snapshot.prKey,
    "BOT_COMMENT",
    agent.TASK_EVENT_SEVERITY.BOT_COMMENT,
    { snapshotSummary: "own repo task" },
    agent.buildBoundaryFromSnapshot(snapshot),
  );

  await listener._cleanupTerminalPrs(new Set());

  assert.deepStrictEqual(listener.state.keys(), []);
  assert.deepStrictEqual(listener.taskManager.events, []);
  assert.equal(listener.actionLogger.lines.some((line) => line.includes("reason=ignored_own_repository")), true);
});


test("scan refreshes existing task details only with monotonic boundary", async () => {
  const listener = createListener();
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#14",
    updatedAt: "2026-04-24T00:10:00.000Z",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "ci-old", conclusion: "FAILURE" }],
  });
  await listener._scanSnapshot(firstSnapshot);

  const newerSnapshot = makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:11:00.000Z",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "ci-new", conclusion: "FAILURE" }],
  });
  await listener._scanSnapshot(newerSnapshot);

  const task = listener.taskManager.events[0];
  assert.equal(task.details.failingChecks[0].label, "ci-new");
  assert.equal(task.boundary.snapshotUpdatedAt, "2026-04-24T00:11:00.000Z");

  const olderSnapshot = makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:09:00.000Z",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "ci-regressed", conclusion: "FAILURE" }],
  });
  await listener._scanSnapshot(olderSnapshot);

  assert.equal(task.details.failingChecks[0].label, "ci-new");
  assert.equal(task.boundary.snapshotUpdatedAt, "2026-04-24T00:11:00.000Z");
  assert.equal(listener.actionLogger.lines.some((line) => line.includes("event_boundary_regressed")), true);
});


test("scan blocks non-actionable state-backed tasks before main queue handling", async () => {
  const listener = createListener();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#52",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "DCO / Developer Certificate of Origin", conclusion: "FAILURE" }],
  });

  await listener._scanSnapshot(snapshot);

  const task = listener.taskManager.events[0];
  assert.equal(task.type, "CI_FAILURE");
  assert.equal(task.status, agent.TASK_STATUS.BLOCKED);
  assert.equal(task.blockReason, "needs-contributor-action");
  assert.equal(task.blockOwner, "contributor");
  assert.equal(task.blockCategory, "ci");
  assert.match(task.unblockHint, /Contributor/);
  assert.equal(task.blockedSnapshot.statusCheckState, "FAILED");
  assert.ok(listener.actionLogger.lines.some((line) => line.includes("event_task_blocked")));
});


test("scan unblocks blocked state-backed task when latest snapshot becomes actionable", async () => {
  const listener = createListener();
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#53",
    updatedAt: "2026-04-24T00:10:00.000Z",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "DCO", conclusion: "FAILURE" }],
  });
  await listener._scanSnapshot(firstSnapshot);
  assert.equal(listener.taskManager.events[0].status, agent.TASK_STATUS.BLOCKED);

  const actionableSnapshot = makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:20:00.000Z",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "lint / eslint", conclusion: "FAILURE" }],
  });
  await listener._scanSnapshot(actionableSnapshot);

  const task = listener.taskManager.events[0];
  assert.equal(task.status, agent.TASK_STATUS.PENDING);
  assert.equal(task.blockReason, null);
  assert.equal(task.blockOwner, null);
  assert.equal(task.details.failingChecks[0].label, "lint / eslint");
  assert.ok(listener.actionLogger.lines.some((line) => line.includes("event_task_unblocked")));
});


test("comment success advances only the matching category baseline", () => {
  const state = new agent.EventState();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#4",
    issueComments: [
      makeActivity({
        id: 300,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "bot comment",
      }),
      makeActivity({
        id: 301,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "maintainer comment",
      }),
    ],
  });

  state.applyTaskSuccess({
    prKey: snapshot.prKey,
    type: "BOT_COMMENT",
    boundary: agent.buildBoundaryFromCategorySnapshot(snapshot, "bot"),
  }, snapshot);

  const entry = state.getOrInit(snapshot.prKey);
  assert.equal(entry.baseline.commentBaselines.bot.issueCommentCursor.lastId, "300");
  assert.equal(entry.baseline.commentBaselines.maintainer.issueCommentCursor.lastId, null);
  assert.equal(entry.baseline.commentBaselines.user.issueCommentCursor.lastId, null);
});


test("review changes requested success advances maintainer review baselines only", () => {
  const state = new agent.EventState();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#15",
    reviewDecision: "CHANGES_REQUESTED",
    issueComments: [
      makeActivity({
        id: 310,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "maintainer issue comment",
      }),
      makeActivity({
        id: 311,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "bot issue comment",
      }),
    ],
    reviewComments: [
      makeActivity({
        stream: "review_comment",
        id: 320,
        createdAt: "2026-04-24T00:03:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "maintainer review comment",
      }),
      makeActivity({
        stream: "review_comment",
        id: 321,
        createdAt: "2026-04-24T00:04:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "bot review comment",
      }),
    ],
    reviews: [
      makeActivity({
        stream: "review",
        id: 330,
        createdAt: "2026-04-24T00:05:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "changes requested",
        state: "CHANGES_REQUESTED",
      }),
      makeActivity({
        stream: "review",
        id: 331,
        createdAt: "2026-04-24T00:06:00.000Z",
        authorLogin: "external-user",
        body: "user review",
        state: "COMMENTED",
      }),
    ],
  });

  state.applyTaskSuccess({
    prKey: snapshot.prKey,
    type: "REVIEW_CHANGES_REQUESTED",
    boundary: agent.buildBoundaryFromCategorySnapshot(snapshot, "maintainer"),
  }, snapshot);

  const entry = state.getOrInit(snapshot.prKey);
  assert.equal(entry.baseline.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(entry.baseline.commentBaselines.maintainer.issueCommentCursor.lastId, "310");
  assert.equal(entry.baseline.commentBaselines.maintainer.reviewCommentCursor.lastId, "320");
  assert.equal(entry.baseline.commentBaselines.maintainer.reviewCursor.lastId, "330");
  assert.equal(entry.baseline.commentBaselines.bot.issueCommentCursor.lastId, null);
  assert.equal(entry.baseline.commentBaselines.user.reviewCursor.lastId, null);
});


test("review task success preserves new maintainer comments after task boundary", async () => {
  const originalSnapshot = makeSnapshot({
    prKey: "demo/repo#16",
    updatedAt: "2026-04-24T00:01:00.000Z",
    reviewDecision: "CHANGES_REQUESTED",
    issueComments: [
      makeActivity({
        id: 340,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "Please change this.",
      }),
    ],
    reviews: [
      makeActivity({
        stream: "review",
        id: 341,
        createdAt: "2026-04-24T00:01:30.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "changes requested",
        state: "CHANGES_REQUESTED",
      }),
    ],
  });
  const refreshedSnapshot = makeSnapshot({
    prKey: originalSnapshot.prKey,
    updatedAt: "2026-04-24T00:03:00.000Z",
    reviewDecision: "APPROVED",
    issueComments: [
      ...originalSnapshot.issueComments,
      makeActivity({
        id: 342,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "One more follow-up.",
      }),
    ],
    reviews: originalSnapshot.reviews,
  });
  const listener = createListener();
  listener.saveAll = async () => {};
  const task = listener.taskManager.add(
    originalSnapshot.prKey,
    "REVIEW_CHANGES_REQUESTED",
    agent.TASK_EVENT_SEVERITY.REVIEW_CHANGES_REQUESTED,
    { snapshotSummary: "old review task" },
    agent.buildBoundaryFromCategorySnapshot(originalSnapshot, "maintainer"),
  );

  listener.state.applyTaskSuccess(task, originalSnapshot);
  listener.taskManager.remove(task.id);
  await listener._scanSnapshot(refreshedSnapshot);

  const tasks = listener.taskManager.events;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].type, "MAINTAINER_COMMENT");
  assert.deepStrictEqual(tasks[0].details.activities.map((activity) => activity.id), ["342"]);
  const entry = listener.state.getOrInit(originalSnapshot.prKey);
  assert.equal(entry.baseline.commentBaselines.maintainer.issueCommentCursor.lastId, "340");
});


test("baseline snapshots preserve CI check details", () => {
  const failingChecks = [{ label: "ci / Unit tests", conclusion: "FAILURE" }];
  const pendingChecks = [{ label: "ci / Integration", status: "PENDING" }];
  const snapshot = makeSnapshot({
    statusCheckState: "FAILED",
    failingChecks,
    pendingChecks,
  });

  const baseline = agent.baselineFromSnapshot(snapshot);

  assert.deepStrictEqual(baseline.failingChecks, failingChecks);
  assert.deepStrictEqual(baseline.pendingChecks, pendingChecks);

  failingChecks[0].label = "mutated";
  pendingChecks[0].label = "mutated";
  assert.equal(baseline.failingChecks[0].label, "ci / Unit tests");
  assert.equal(baseline.pendingChecks[0].label, "ci / Integration");
});


test("normalizeBaseline backfills missing check arrays", () => {
  const baseline = agent.normalizeBaseline({
    statusCheckState: "FAILED",
    reviewDecision: "CHANGES_REQUESTED",
  });

  assert.deepStrictEqual(baseline.failingChecks, []);
  assert.deepStrictEqual(baseline.pendingChecks, []);
});


test("CI task success updates baseline status and check details", () => {
  const state = new agent.EventState();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#12",
    statusCheckState: "FAILED",
    failingChecks: [{ label: "ci / Unit tests", conclusion: "FAILURE" }],
    pendingChecks: [{ label: "ci / Integration", status: "PENDING" }],
  });

  state.applyTaskSuccess({
    prKey: snapshot.prKey,
    type: "CI_FAILURE",
    boundary: agent.buildBoundaryFromSnapshot(snapshot),
  }, snapshot);

  const entry = state.getOrInit(snapshot.prKey);
  assert.equal(entry.baseline.statusCheckState, "FAILED");
  assert.deepStrictEqual(entry.baseline.failingChecks, snapshot.failingChecks);
  assert.deepStrictEqual(entry.baseline.pendingChecks, snapshot.pendingChecks);
});


test("merge task success also updates baseline check details", () => {
  const state = new agent.EventState();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#13",
    statusCheckState: "PENDING",
    failingChecks: [],
    pendingChecks: [{ label: "ci / Integration", status: "PENDING" }],
    mergeStateStatus: "BEHIND",
  });

  state.applyTaskSuccess({
    prKey: snapshot.prKey,
    type: "NEEDS_REBASE",
    boundary: agent.buildBoundaryFromSnapshot(snapshot),
  }, snapshot);

  const entry = state.getOrInit(snapshot.prKey);
  assert.equal(entry.baseline.statusCheckState, "PENDING");
  assert.deepStrictEqual(entry.baseline.failingChecks, []);
  assert.deepStrictEqual(entry.baseline.pendingChecks, snapshot.pendingChecks);
});


test("blocked comment task preserves category boundary", async () => {
  const snapshot = makeSnapshot({
    prKey: "demo/repo#73",
    issueComments: [
      makeActivity({
        id: 730,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "bot note",
      }),
      makeActivity({
        id: 731,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "maintainer",
        authorAssociation: "OWNER",
        body: "maintainer note",
      }),
    ],
  });
  const listener = createListener({
    fetchPrSnapshot: async () => snapshot,
  });
  listener.saveAll = async () => {};
  const task = listener.taskManager.add(
    snapshot.prKey,
    "BOT_COMMENT",
    agent.TASK_EVENT_SEVERITY.BOT_COMMENT,
    { snapshotSummary: "bot comment" },
    agent.buildBoundaryFromCategorySnapshot(snapshot, "bot"),
  );
  listener.taskManager.block(
    task.id,
    "waiting for human confirmation",
    task.details,
    task.boundary,
    { blockOwner: "human", blockCategory: "comment" },
  );

  const updated = listener.taskManager.getById(task.id);
  assert.equal(updated.status, agent.TASK_STATUS.BLOCKED);
  assert.equal(updated.boundary.issueCommentCursor.lastId, "730");
  assert.equal(updated.boundary.issueCommentCursor.count, 1);
});


test("pending comment task is refreshed in place instead of duplicated", async () => {
  const listener = createListener();
  const firstSnapshot = makeSnapshot({
    prKey: "demo/repo#6",
    issueComments: [
      makeActivity({
        id: 400,
        createdAt: "2026-04-24T00:01:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "first bot note",
      }),
    ],
  });

  await listener._scanSnapshot(firstSnapshot);
  assert.equal(listener.taskManager.events.length, 1);
  assert.equal(listener.taskManager.events[0].type, "BOT_COMMENT");
  assert.equal(listener.taskManager.events[0].details.activities.length, 1);

  await listener._scanSnapshot(makeSnapshot({
    prKey: firstSnapshot.prKey,
    updatedAt: "2026-04-24T00:05:00.000Z",
    issueComments: [
      ...firstSnapshot.issueComments,
      makeActivity({
        id: 401,
        createdAt: "2026-04-24T00:02:00.000Z",
        authorLogin: "review-bot[bot]",
        authorType: "Bot",
        body: "second bot note",
      }),
    ],
  }));

  assert.equal(listener.taskManager.events.length, 1);
  assert.equal(listener.taskManager.events[0].type, "BOT_COMMENT");
  assert.deepStrictEqual(
    listener.taskManager.events[0].details.activities.map((activity) => activity.id),
    ["400", "401"],
  );
  assert.equal(listener.taskManager.events[0].boundary.issueCommentCursor.lastId, "401");
});
