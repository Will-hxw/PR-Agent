const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const agent = require(path.join(__dirname, "..", "run-claude-agent.js"));

function createLogger() {
  return {
    lines: [],
    writeLine(line) {
      this.lines.push(line);
    },
  };
}

function createListener() {
  return new agent.EventListener({
    cwd: process.cwd(),
    claudeCommand: "claude.cmd",
    enableTaskDispatch: false,
    eventNotificationEnabled: false,
    eventPollIntervalMs: 1000,
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
} = {}) {
  return {
    stream,
    id: String(id),
    createdAt,
    authorLogin,
    authorType,
    authorAssociation,
    body,
    state,
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

test("stale pending and dead tasks are removed when trigger disappears", async () => {
  const listener = createListener();
  const failedSnapshot = makeSnapshot({
    statusCheckState: "FAILED",
    failingChecks: [{ name: "ci", conclusion: "FAILURE" }],
  });

  await listener._scanSnapshot(failedSnapshot);
  assert.deepStrictEqual(listener.taskManager.events.map((event) => event.type), ["CI_FAILURE"]);

  await listener._scanSnapshot(makeSnapshot({
    prKey: failedSnapshot.prKey,
    statusCheckState: "SUCCESS",
    updatedAt: "2026-04-24T00:05:00.000Z",
  }));
  assert.equal(listener.taskManager.events.length, 0);

  const staleDeadTask = listener.taskManager.add(
    failedSnapshot.prKey,
    "NEEDS_REBASE",
    agent.TASK_EVENT_SEVERITY.NEEDS_REBASE,
    { snapshotSummary: "stale" },
    agent.buildBoundaryFromSnapshot(failedSnapshot),
  );
  staleDeadTask.status = agent.TASK_STATUS.DEAD;
  staleDeadTask.nextRetryAt = null;

  await listener._scanSnapshot(makeSnapshot({
    prKey: failedSnapshot.prKey,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    updatedAt: "2026-04-24T00:06:00.000Z",
  }));
  assert.equal(listener.taskManager.events.length, 0);
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

test("open PR search filter ignores PRs in own repositories", () => {
  assert.equal(
    agent.shouldTrackOpenPrSearchItem({
      repository_url: "https://api.github.com/repos/Will-hxw/servers",
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
  const snapshot = makeSnapshot({ prKey: "Will-hxw/servers#1" });

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

test("running tasks are not auto-removed when snapshot no longer matches", async () => {
  const listener = createListener();
  const snapshot = makeSnapshot({
    prKey: "demo/repo#5",
    statusCheckState: "FAILED",
    failingChecks: [{ name: "ci", conclusion: "FAILURE" }],
  });

  const task = listener.taskManager.add(
    snapshot.prKey,
    "CI_FAILURE",
    agent.TASK_EVENT_SEVERITY.CI_FAILURE,
    { snapshotSummary: "old-summary" },
    agent.buildBoundaryFromSnapshot(snapshot),
  );
  listener.taskManager.claim(task.id, 12345);

  await listener._scanSnapshot(makeSnapshot({
    prKey: snapshot.prKey,
    statusCheckState: "SUCCESS",
    updatedAt: "2026-04-24T00:05:00.000Z",
  }));

  assert.equal(listener.taskManager.events.length, 1);
  assert.equal(listener.taskManager.events[0].status, agent.TASK_STATUS.RUNNING);
  assert.equal(listener.taskManager.events[0].details.snapshotSummary, "old-summary");
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
