#!/usr/bin/env node

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const STATE_FILE = path.join(__dirname, "event_state.json");
const TASK_FILE = path.join(__dirname, "event_task.json");

const DEFAULTS = {
  cwd: "D:\\Desktop\\pr",
  idleSeconds: 300,
  initialDelaySeconds: 8,
  nudgeCooldownSeconds: 30,
  maxNudges: 0,
  claudeCommand: process.platform === "win32" ? "claude.cmd" : "claude",
  effort: "max",
  prompt:
    '请用json解析工具理解"D:\\Desktop\\pr\\event_state.json"和"D:\\Desktop\\pr\\event_task.json"，了解当前 PR 状态和未完成任务，逐步一个一个解决D:\\Desktop\\pr\\event_task.json的task，再开始寻找新的 PR 项目。请同时维护 D:\\Desktop\\pr 的 git（你不可以创建该项目的分支，但是可以在candidates中管理具体项目的git），并遵守同目录下的 AGENT.md 与 pr_rule.md。',
  logDirName: ".claude_agent_logs",
  showThinking: false,
  showRawEvents: false,
  enableReviewMonitor: false,
  reviewCheckIntervalSeconds: 14400,
  enableEventListener: false,
  eventPollIntervalMs: 3600000,
  eventNotificationEnabled: true,
  eventSubagentEnabled: true,
};

const TASK_RESULT_PREFIX = "__EVENT_RESULT__ ";
const TASK_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  DEAD: "dead",
};
const TASK_EVENT_SEVERITY = {
  CI_FAILURE: "HEAVY",
  REVIEW_CHANGES_REQUESTED: "HEAVY",
  MAINTAINER_COMMENT: "HEAVY",
  BOT_COMMENT: "LIGHT",
  NEW_COMMENT: "LIGHT",
  NEEDS_REBASE: "LIGHT",
  READY_TO_MERGE: "LIGHT",
};
const TASK_EVENT_TYPES = new Set(Object.keys(TASK_EVENT_SEVERITY));
const INFO_ONLY_EVENT_TYPES = new Set(["CI_PASSED", "REVIEW_APPROVED"]);
const COMMENT_TASK_TYPES = new Set(["MAINTAINER_COMMENT", "BOT_COMMENT", "NEW_COMMENT"]);
const MERGE_TASK_TYPES = new Set(["NEEDS_REBASE", "READY_TO_MERGE"]);
const COMMENT_CATEGORIES = ["maintainer", "bot", "user"];
const COMMENT_TASK_TYPE_BY_CATEGORY = Object.freeze({
  maintainer: "MAINTAINER_COMMENT",
  bot: "BOT_COMMENT",
  user: "NEW_COMMENT",
});
const COMMENT_CATEGORY_BY_TASK_TYPE = Object.freeze({
  MAINTAINER_COMMENT: "maintainer",
  BOT_COMMENT: "bot",
  NEW_COMMENT: "user",
});
const MAINTAINER_ASSOCIATIONS = new Set(["COLLABORATOR", "MEMBER", "OWNER"]);
const FAILURE_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "CANCELLED",
]);
const SUCCESSISH_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PER_PAGE = 100;
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const GH_TIMEOUT_MS = 60 * 1000;
const GH_CLEANUP_TIMEOUT_MS = 30 * 1000;
const SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
const SUBAGENT_FORCE_KILL_GRACE_MS = 5 * 1000;
const MAX_PARALLEL_SUBAGENTS = 3;
const SEVERITY_ORDER = {
  HEAVY: 0,
  LIGHT: 1,
  INFO: 2,
};

function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    switch (current) {
      case "--cwd":
        config.cwd = requireValue(argv, ++index, current);
        break;
      case "--idle-seconds":
        config.idleSeconds = requireInt(argv, ++index, current);
        break;
      case "--initial-delay-seconds":
        config.initialDelaySeconds = requireInt(argv, ++index, current);
        break;
      case "--nudge-cooldown-seconds":
        config.nudgeCooldownSeconds = requireInt(argv, ++index, current);
        break;
      case "--max-nudges":
        config.maxNudges = requireInt(argv, ++index, current);
        break;
      case "--prompt":
        config.prompt = requireValue(argv, ++index, current);
        break;
      case "--claude-command":
        config.claudeCommand = requireValue(argv, ++index, current);
        break;
      case "--effort":
        config.effort = requireValue(argv, ++index, current);
        break;
      case "--show-thinking":
        config.showThinking = true;
        break;
      case "--show-raw-events":
        config.showRawEvents = true;
        break;
      case "--enable-review-monitor":
        config.enableReviewMonitor = true;
        break;
      case "--review-check-interval":
        config.reviewCheckIntervalSeconds = requireInt(argv, ++index, current);
        break;
      case "--enable-event-listener":
        config.enableEventListener = true;
        break;
      case "--event-poll-interval":
        config.eventPollIntervalMs = requireInt(argv, ++index, current);
        break;
      case "--event-notification":
        config.eventNotificationEnabled = true;
        break;
      case "--no-event-notification":
        config.eventNotificationEnabled = false;
        break;
      case "--event-subagent":
        config.eventSubagentEnabled = true;
        break;
      case "--no-event-subagent":
        config.eventSubagentEnabled = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${current}`);
    }
  }

  return validateConfig(config);
}

function validateConfig(config) {
  if (config.enableEventListener && !config.eventSubagentEnabled) {
    const error = new Error("Invalid configuration: --enable-event-listener requires subagent mode; remove --no-event-subagent.");
    error.exitCode = 2;
    throw error;
  }
  return config;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} 缺少参数`);
  }
  return value;
}

function requireInt(argv, index, flag) {
  const value = Number.parseInt(requireValue(argv, index, flag), 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} 需要非负整数`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node run-claude-agent.js [options]",
      "",
      "Options:",
      "  --cwd <path>                  Claude 工作目录，默认 D:\\Desktop\\pr",
      "  --idle-seconds <n>            连续无输出多少秒后补发提示，默认 300",
      "  --initial-delay-seconds <n>   启动后等待多久再发送首条提示，默认 8",
      "  --nudge-cooldown-seconds <n>  两次补发之间至少间隔多少秒，默认 30",
      "  --max-nudges <n>              最多补发次数，0 表示不限制，默认 0",
      "  --prompt <text>               首条提示和补发提示内容",
      "  --claude-command <cmd>        Claude 可执行命令，默认 claude.cmd / claude",
      "  --effort <mode>               思考深度：low/middle/high/xhigh/max，默认 max",
      "  --show-thinking               在终端显示 thinking 事件",
      "  --show-raw-events             直接打印原始 JSON 事件",
      "  --enable-review-monitor       启用 PR review 监控功能",
      "  --review-check-interval <n>   review 检查间隔（秒），默认 14400（4小时）",
      "  --enable-event-listener       启用 GitHub 事件监听（默认轮询间隔 3600000ms）",
      "  --event-poll-interval <n>     事件检测间隔（毫秒），默认 3600000（1小时）",
      "  --event-notification          启用系统通知（默认开启）",
      "  --no-event-notification       禁用系统通知",
      "  --event-subagent              task-backed 事件使用 subagent（默认开启）",
      "  --no-event-subagent           禁用 subagent；与 --enable-event-listener 冲突",
      "  --help, -h                    显示帮助",
      "",
    ].join("\n"),
  );
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} 不存在: ${filePath}`);
  }
}

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function timestampForFile() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "_",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function shellQuote(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function nowIso() {
  return new Date().toISOString();
}

function nowStamp() {
  return nowIso().replace("T", " ").replace("Z", "Z");
}

function parseTimestampMs(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(text, maxLength = 180) {
  const input = String(text);
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength - 3)}...`;
}

function color(text, code) {
  return `\u001b[${code}m${text}\u001b[0m`;
}

function printInfo(message) {
  process.stdout.write(`${color("[info]", "36")} ${message}\n`);
}

function printWarn(message) {
  process.stdout.write(`${color("[warn]", "33")} ${message}\n`);
}

function printError(message) {
  process.stderr.write(`${color("[error]", "31")} ${message}\n`);
}

function createJsonUserEvent(text) {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
  });
}

function createLogger(logFilePath) {
  ensureDirectoryExists(path.dirname(logFilePath));
  const stream = fs.createWriteStream(logFilePath, { flags: "a", encoding: "utf8" });

  return {
    write(text) {
      stream.write(text);
    },
    writeLine(text) {
      stream.write(`${text}\n`);
    },
    close() {
      stream.end();
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function emptyCursor() {
  return {
    count: 0,
    lastId: null,
    lastCreatedAt: null,
  };
}

function normalizeCursor(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyCursor();
  }
  const count = Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : 0;
  return {
    count,
    lastId: raw.lastId != null ? String(raw.lastId) : null,
    lastCreatedAt: raw.lastCreatedAt || null,
  };
}

function cloneCursor(cursor) {
  return normalizeCursor(cursor);
}

function buildCursor(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return emptyCursor();
  }
  const last = items[items.length - 1];
  return {
    count: items.length,
    lastId: last && last.id != null ? String(last.id) : null,
    lastCreatedAt: last && last.createdAt ? last.createdAt : null,
  };
}

function emptyCommentCursorSet() {
  return {
    issueCommentCursor: emptyCursor(),
    reviewCommentCursor: emptyCursor(),
    reviewCursor: emptyCursor(),
  };
}

function normalizeCommentCursorSet(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyCommentCursorSet();
  }
  return {
    issueCommentCursor: normalizeCursor(raw.issueCommentCursor),
    reviewCommentCursor: normalizeCursor(raw.reviewCommentCursor),
    reviewCursor: normalizeCursor(raw.reviewCursor),
  };
}

function cloneCommentCursorSet(raw) {
  return normalizeCommentCursorSet(cloneJson(raw));
}

function emptyCommentBaselines() {
  return Object.fromEntries(COMMENT_CATEGORIES.map((category) => [category, emptyCommentCursorSet()]));
}

function normalizeCommentBaselines(raw, legacyRaw = null) {
  if (raw && typeof raw === "object") {
    return Object.fromEntries(
      COMMENT_CATEGORIES.map((category) => [category, normalizeCommentCursorSet(raw[category])]),
    );
  }

  const legacy = normalizeCommentCursorSet(legacyRaw || {});
  return Object.fromEntries(
    COMMENT_CATEGORIES.map((category) => [category, cloneCommentCursorSet(legacy)]),
  );
}

function cloneCommentBaselines(raw) {
  return normalizeCommentBaselines(cloneJson(raw));
}

function buildCommentCursorSet(issueComments, reviewComments, reviews) {
  return {
    issueCommentCursor: buildCursor(issueComments),
    reviewCommentCursor: buildCursor(reviewComments),
    reviewCursor: buildCursor(reviews),
  };
}

function emptyBaseline() {
  return {
    commentBaselines: emptyCommentBaselines(),
    statusCheckState: null,
    reviewDecision: null,
    mergeStateStatus: null,
    mergeable: null,
    isDraft: null,
    unresolvedReviewThreadCount: 0,
    headSha: null,
    updatedAt: null,
  };
}

function normalizeBaseline(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyBaseline();
  }

  const normalized = emptyBaseline();
  normalized.commentBaselines = normalizeCommentBaselines(raw.commentBaselines, raw);

  normalized.statusCheckState = raw.statusCheckState || normalizeLegacyStatus(raw.statusCheckRollup);
  normalized.reviewDecision = raw.reviewDecision || null;
  normalized.mergeStateStatus = raw.mergeStateStatus || null;
  normalized.mergeable = raw.mergeable || null;
  normalized.isDraft = raw.isDraft ?? null;
  normalized.unresolvedReviewThreadCount = Number.isInteger(raw.unresolvedReviewThreadCount)
    ? raw.unresolvedReviewThreadCount
    : 0;
  normalized.headSha = raw.headSha || null;
  normalized.updatedAt = raw.updatedAt || null;
  return normalized;
}

function cloneBaseline(baseline) {
  return normalizeBaseline(cloneJson(baseline));
}

function buildCommentBaselinesFromSnapshot(snapshot) {
  return Object.fromEntries(
    COMMENT_CATEGORIES.map((category) => {
      const issueComments = snapshot.issueComments.filter((activity) => classifyActivityCategory(activity) === category);
      const reviewComments = snapshot.reviewComments.filter((activity) => classifyActivityCategory(activity) === category);
      const reviews = snapshot.reviews.filter((activity) => classifyActivityCategory(activity) === category);
      return [category, buildCommentCursorSet(issueComments, reviewComments, reviews)];
    }),
  );
}

function baselineFromSnapshot(snapshot) {
  return {
    commentBaselines: buildCommentBaselinesFromSnapshot(snapshot),
    statusCheckState: snapshot.statusCheckState,
    reviewDecision: snapshot.reviewDecision,
    mergeStateStatus: snapshot.mergeStateStatus,
    mergeable: snapshot.mergeable,
    isDraft: snapshot.isDraft,
    unresolvedReviewThreadCount: snapshot.unresolvedReviewThreadCount,
    headSha: snapshot.headSha,
    updatedAt: snapshot.updatedAt || nowIso(),
  };
}

function zeroStateEntry(prKey) {
  return {
    baseline: emptyBaseline(),
    observed: emptyBaseline(),
    prKey,
    updatedAt: nowIso(),
  };
}

function normalizeStateEntry(prKey, raw) {
  const entry = zeroStateEntry(prKey);
  if (!raw || typeof raw !== "object") {
    return entry;
  }
  entry.baseline = normalizeBaseline(raw.baseline);
  entry.observed = raw.observed ? normalizeBaseline(raw.observed) : cloneBaseline(entry.baseline);
  entry.updatedAt = raw.updatedAt || nowIso();
  entry.prKey = raw.prKey || prKey;
  return entry;
}

function buildBoundaryFromSnapshot(snapshot) {
  return {
    ...buildCommentCursorSet(snapshot.issueComments, snapshot.reviewComments, snapshot.reviews),
    snapshotUpdatedAt: snapshot.updatedAt || null,
  };
}

function buildBoundaryFromCategorySnapshot(snapshot, category) {
  return {
    ...buildCommentCursorSet(
      snapshot.issueComments.filter((activity) => classifyActivityCategory(activity) === category),
      snapshot.reviewComments.filter((activity) => classifyActivityCategory(activity) === category),
      snapshot.reviews.filter((activity) => classifyActivityCategory(activity) === category),
    ),
    snapshotUpdatedAt: snapshot.updatedAt || null,
  };
}

function normalizeBoundary(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      issueCommentCursor: emptyCursor(),
      reviewCommentCursor: emptyCursor(),
      reviewCursor: emptyCursor(),
      snapshotUpdatedAt: null,
    };
  }
  return {
    issueCommentCursor: normalizeCursor(raw.issueCommentCursor),
    reviewCommentCursor: normalizeCursor(raw.reviewCommentCursor),
    reviewCursor: normalizeCursor(raw.reviewCursor),
    snapshotUpdatedAt: raw.snapshotUpdatedAt || null,
  };
}

function normalizeLegacyStatus(value) {
  if (!value) return null;
  const upper = String(value).toUpperCase();
  if (upper === "FAILURE" || upper === "ERROR") return "FAILED";
  if (upper === "SUCCESS") return "SUCCESS";
  if (upper === "PENDING") return "PENDING";
  if (upper === "NONE") return "NONE";
  return upper;
}

function normalizeTaskRecord(raw) {
  if (!raw || typeof raw !== "object" || !raw.prKey || !raw.type) {
    return null;
  }

  if (raw.handledAt != null) {
    return null;
  }

  const now = nowIso();
  let status = raw.status;
  if (status !== TASK_STATUS.PENDING && status !== TASK_STATUS.RUNNING && status !== TASK_STATUS.DEAD) {
    status = TASK_STATUS.PENDING;
  }
  if (status === TASK_STATUS.RUNNING) {
    status = TASK_STATUS.PENDING;
  }

  return {
    id: raw.id || randomUUID(),
    prKey: raw.prKey,
    type: raw.type,
    severity: raw.severity || TASK_EVENT_SEVERITY[raw.type] || "LIGHT",
    createdAt: raw.createdAt || now,
    status,
    attemptCount: Number.isInteger(raw.attemptCount) && raw.attemptCount >= 0 ? raw.attemptCount : 0,
    lastAttemptAt: raw.lastAttemptAt || null,
    nextRetryAt: status === TASK_STATUS.DEAD ? null : (raw.nextRetryAt || now),
    lastError: raw.lastError || null,
    claimedAt: null,
    runningPid: null,
    boundary: normalizeBoundary(raw.boundary),
    details: raw.details && typeof raw.details === "object" ? cloneJson(raw.details) : {},
  };
}

function computeBackoffMs(attemptCount) {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(BASE_BACKOFF_MS * (2 ** exponent), MAX_BACKOFF_MS);
}

function nextRetryAtForAttempt(attemptCount) {
  return new Date(Date.now() + computeBackoffMs(attemptCount)).toISOString();
}

function compareTasksForDispatch(left, right) {
  const severityDelta = (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const createdDelta = parseTimestampMs(left.createdAt) - parseTimestampMs(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return left.id.localeCompare(right.id);
}

function normalizeEventDetailValue(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return cloneJson(value);
}

function isBotLogin(login) {
  if (!login) return false;
  const normalized = String(login).toLowerCase();
  return normalized.endsWith("[bot]") || normalized.includes("bot");
}

function isBotActor(activity) {
  return String(activity.authorType || "").toLowerCase() === "bot" || isBotLogin(activity.authorLogin);
}

function isMaintainerActivity(activity) {
  return MAINTAINER_ASSOCIATIONS.has(activity.authorAssociation || "NONE");
}

function classifyActivityCategory(activity) {
  if (isBotActor(activity)) {
    return "bot";
  }
  if (isMaintainerActivity(activity)) {
    return "maintainer";
  }
  return "user";
}

function commentCategoryForTaskType(type) {
  return COMMENT_CATEGORY_BY_TASK_TYPE[type] || null;
}

function compareActivityChronologically(left, right) {
  const createdDelta = parseTimestampMs(left.createdAt) - parseTimestampMs(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return String(left.id).localeCompare(String(right.id));
}

function trimMultiline(text) {
  return String(text).split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
}

function buildSnapshotSummary(snapshot) {
  return [
    `PR URL: ${snapshot.url || "unknown"}`,
    `Head SHA: ${snapshot.headSha || "unknown"}`,
    `CI: ${snapshot.statusCheckState}`,
    `Review decision: ${snapshot.reviewDecision || "NONE"}`,
    `Merge state: ${snapshot.mergeStateStatus || "NONE"}`,
    `Mergeable: ${snapshot.mergeable || "UNKNOWN"}`,
    `Draft: ${snapshot.isDraft ? "yes" : "no"}`,
    `Unresolved review threads: ${snapshot.unresolvedReviewThreadCount}`,
    `Issue comments: ${snapshot.issueCommentCursor.count}`,
    `Review comments: ${snapshot.reviewCommentCursor.count}`,
    `Reviews: ${snapshot.reviewCursor.count}`,
  ].join("\n");
}

function buildTaskDetails(type, snapshot, extraDetails = {}) {
  return {
    prUrl: snapshot.url || null,
    snapshotSummary: buildSnapshotSummary(snapshot),
    snapshotUpdatedAt: snapshot.updatedAt || null,
    headSha: snapshot.headSha || null,
    ...Object.fromEntries(
      Object.entries(extraDetails).map(([key, value]) => [key, normalizeEventDetailValue(value)]),
    ),
  };
}

function parsePrKey(prKey) {
  const match = String(prKey).match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) {
    throw new Error(`非法 prKey: ${prKey}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    prNumber: Number.parseInt(match[3], 10),
  };
}

function buildAckRecord(task) {
  return {
    version: 1,
    eventId: task.id,
    prKey: task.prKey,
    type: task.type,
    status: "success",
  };
}

function buildSubagentPrompt(task) {
  const { owner, repo, prNumber } = parsePrKey(task.prKey);
  const ackLine = `${TASK_RESULT_PREFIX}${JSON.stringify(buildAckRecord(task))}`;
  return [
    `请处理 PR 事件：${task.prKey}`,
    `事件类型：${task.type}`,
    "",
    "当前快照摘要：",
    task.details.snapshotSummary || "无",
    "",
    "事件细节：",
    JSON.stringify(task.details, null, 2),
    "",
    "处理要求：",
    "1. 按 AGENT.md 和 pr_rule.md 的 Review / CI 跟进流程处理。",
    "2. 先重新检查该 PR 的最新状态，再决定是否修改、回复或记录。",
    "3. 如需查看 CI，使用 gh pr checks <number> --repo <owner>/<repo>。",
    `4. 如需回复 inline review comment，必须回复原线程，例如：gh api repos/${owner}/${repo}/pulls/${prNumber}/comments/<comment_id>/replies -X POST -f body='<reply>'`,
    "5. 如需更新记录，只更新与该 PR 直接相关的 records 内容。",
    "",
    "成功确认协议：",
    "只有在你确认该事件已经处理完成时，最后单独输出下面这一行，不要放进代码块，不要改写字段：",
    ackLine,
    "",
    "如果没有完成处理，不要输出这一行。",
  ].join("\n");
}

function createActivitySummary(activity) {
  return {
    stream: activity.stream,
    id: activity.id,
    createdAt: activity.createdAt,
    authorLogin: activity.authorLogin,
    authorType: activity.authorType,
    authorAssociation: activity.authorAssociation,
    state: activity.state || null,
    url: activity.url || null,
    excerpt: activity.body ? truncate(trimMultiline(activity.body), 200) : "",
  };
}

function compareActivityToCursor(activity, cursor) {
  const activityCreatedAt = parseTimestampMs(activity.createdAt);
  const cursorCreatedAt = parseTimestampMs(cursor.lastCreatedAt);
  if (activityCreatedAt !== cursorCreatedAt) {
    return activityCreatedAt - cursorCreatedAt;
  }
  const activityId = activity && activity.id != null ? String(activity.id) : "";
  const cursorId = cursor && cursor.lastId != null ? String(cursor.lastId) : "";
  return activityId.localeCompare(cursorId);
}

function collectItemsAfterCursor(items, rawCursor) {
  const cursor = normalizeCursor(rawCursor);
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  if (cursor.lastId != null) {
    const cursorIndex = items.findIndex((item) => String(item.id) === cursor.lastId);
    if (cursorIndex >= 0) {
      return items.slice(cursorIndex + 1);
    }
  }
  if (cursor.lastCreatedAt || cursor.lastId != null) {
    return items.filter((item) => compareActivityToCursor(item, cursor) > 0);
  }
  const start = Math.min(cursor.count, items.length);
  return items.slice(start);
}

function collectNewActivities(snapshot, baseline, category = null) {
  const issueComments = category
    ? snapshot.issueComments.filter((activity) => classifyActivityCategory(activity) === category)
    : snapshot.issueComments;
  const reviewComments = category
    ? snapshot.reviewComments.filter((activity) => classifyActivityCategory(activity) === category)
    : snapshot.reviewComments;
  const reviews = category
    ? snapshot.reviews.filter((activity) => classifyActivityCategory(activity) === category)
    : snapshot.reviews;

  const cursorSet = normalizeCommentCursorSet(baseline);
  const newIssueComments = collectItemsAfterCursor(issueComments, cursorSet.issueCommentCursor);
  const newReviewComments = collectItemsAfterCursor(reviewComments, cursorSet.reviewCommentCursor);
  const newReviews = collectItemsAfterCursor(reviews, cursorSet.reviewCursor);
  const items = [
    ...newIssueComments,
    ...newReviewComments,
    ...newReviews,
  ].sort(compareActivityChronologically);
  return {
    category,
    items,
    counts: {
      issueComments: newIssueComments.length,
      reviewComments: newReviewComments.length,
      reviews: newReviews.length,
    },
    cursors: buildCommentCursorSet(issueComments, reviewComments, reviews),
  };
}

function baselineNeedsRebase(baseline) {
  if (!baseline) return false;
  return isNeedsRebaseFromRaw({
    mergeStateStatus: baseline.mergeStateStatus,
    mergeable: baseline.mergeable,
  });
}

function baselineReadyToMerge(baseline) {
  if (!baseline) return false;
  return isReadyToMergeFromRaw({
    isDraft: baseline.isDraft,
    reviewDecision: baseline.reviewDecision,
    statusCheckState: baseline.statusCheckState,
    mergeable: baseline.mergeable,
    unresolvedReviewThreadCount: baseline.unresolvedReviewThreadCount,
  });
}

function isNeedsRebaseFromRaw(raw) {
  const mergeStateStatus = raw.mergeStateStatus || null;
  const mergeable = raw.mergeable || null;
  return mergeStateStatus === "BEHIND" || mergeStateStatus === "DIRTY" || mergeable === "CONFLICTING";
}

function isReadyToMergeFromRaw(raw) {
  return !raw.isDraft
    && raw.reviewDecision === "APPROVED"
    && raw.statusCheckState === "SUCCESS"
    && raw.mergeable === "MERGEABLE"
    && Number(raw.unresolvedReviewThreadCount || 0) === 0;
}

function extractAckFromTextBuffer(bufferHolder, task) {
  let parsed = null;
  let newlineIndex = bufferHolder.buffer.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = bufferHolder.buffer.slice(0, newlineIndex).replace(/\r$/, "");
    bufferHolder.buffer = bufferHolder.buffer.slice(newlineIndex + 1);
    const maybe = parseAckLine(line, task);
    if (maybe) {
      parsed = maybe;
    }
    newlineIndex = bufferHolder.buffer.indexOf("\n");
  }
  return parsed;
}

function parseAckLine(line, task) {
  const trimmed = line.trim();
  if (!trimmed.startsWith(TASK_RESULT_PREFIX)) {
    return null;
  }
  const rawJson = trimmed.slice(TASK_RESULT_PREFIX.length);
  let payload;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return { valid: false, reason: "ack_json_parse_failed" };
  }
  const expected = buildAckRecord(task);
  if (
    payload
    && payload.version === expected.version
    && payload.eventId === expected.eventId
    && payload.prKey === expected.prKey
    && payload.type === expected.type
    && payload.status === expected.status
  ) {
    return { valid: true, payload };
  }
  return { valid: false, reason: "ack_payload_mismatch", payload };
}

function extractRecordField(content, fieldName) {
  const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(fieldName)}\\s*[：:]\\s*(.+)$`, "im");
  const match = String(content).match(pattern);
  return match ? match[1].trim() : "";
}

function normalizeResultValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "已提交" || normalized === "submitted") return "submitted";
  if (normalized === "waiting review" || normalized === "waiting-review") return "waiting-review";
  if (normalized === "skipped") return "skipped";
  if (normalized === "abandoned") return "abandoned";
  if (normalized === "merged") return "merged";
  if (normalized === "closed") return "closed";
  return normalized;
}

function normalizeReviewState(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || "";
}

function appendQuery(base, params) {
  const query = Object.entries(params)
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  if (!query) {
    return base;
  }
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

async function terminateChildProcess(child, options = {}) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  const pid = child.pid;
  if (process.platform === "win32") {
    if (pid) {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill();
    }
    return;
  }

  child.kill(options.signal || "SIGTERM");
  const graceMs = options.graceMs ?? SUBAGENT_FORCE_KILL_GRACE_MS;
  if (graceMs > 0) {
    await sleep(graceMs);
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGKILL");
    }
  }
}

async function runCommandWithTimeout(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let killTimer = null;

    const finalize = (fn) => {
      if (finished) {
        return;
      }
      finished = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      fn();
    };

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (error) => {
      finalize(() => reject(error));
    });

    proc.on("close", (code, signal) => {
      finalize(() => {
        if (timedOut) {
          const error = new Error(`command timed out after ${options.timeoutMs}ms: ${command} ${args.join(" ")}`);
          error.code = "ETIMEDOUT";
          error.stdout = stdout;
          error.stderr = stderr;
          error.exitCode = code;
          error.signal = signal;
          error.timedOut = true;
          reject(error);
          return;
        }
        if (code !== 0) {
          const error = new Error(`command failed (code ${code}): ${command} ${args.join(" ")}${stderr ? ` :: ${stderr.trim()}` : ""}`);
          error.code = "ECOMMAND";
          error.stdout = stdout;
          error.stderr = stderr;
          error.exitCode = code;
          error.signal = signal;
          error.timedOut = false;
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          code,
          signal,
          timedOut: false,
        });
      });
    });

    if (options.timeoutMs > 0) {
      killTimer = setTimeout(async () => {
        timedOut = true;
        await terminateChildProcess(proc, {
          signal: "SIGTERM",
          graceMs: SUBAGENT_FORCE_KILL_GRACE_MS,
        });
      }, options.timeoutMs);
    }
  });
}

async function ghApiJson(endpoint, options = {}) {
  const { stdout } = await runCommandWithTimeout("gh", ["api", endpoint], {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
  });
  return JSON.parse(stdout);
}

async function ghPrViewJson(owner, repo, prNumber, fields, options = {}) {
  const { stdout } = await runCommandWithTimeout("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    `${owner}/${repo}`,
    "--json",
    fields.join(","),
  ], {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
  });
  return JSON.parse(stdout);
}

async function ghGraphQLJson(query, variables, options = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables || {})) {
    if (typeof value === "number") {
      args.push("-F", `${key}=${value}`);
    } else if (value == null) {
      continue;
    } else {
      args.push("-f", `${key}=${value}`);
    }
  }
  const { stdout } = await runCommandWithTimeout("gh", args, {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
  });
  return JSON.parse(stdout);
}

async function fetchPaginatedArray(endpointBase, options = {}) {
  const items = [];
  for (let page = 1; page < 1000; page += 1) {
    const endpoint = appendQuery(endpointBase, {
      per_page: PER_PAGE,
      page,
    });
    const pageItems = await ghApiJson(endpoint, options);
    if (!Array.isArray(pageItems)) {
      throw new Error(`expected array from GitHub API: ${endpoint}`);
    }
    items.push(...pageItems);
    if (pageItems.length < PER_PAGE) {
      break;
    }
  }
  return items;
}

function normalizeIssueComment(raw) {
  return {
    stream: "issue_comment",
    id: raw.id != null ? String(raw.id) : raw.node_id || raw.url || randomUUID(),
    createdAt: raw.created_at || raw.createdAt || null,
    authorAssociation: raw.author_association || raw.authorAssociation || "NONE",
    authorLogin: raw.user?.login || null,
    authorType: raw.user?.type || null,
    state: null,
    body: raw.body || "",
    url: raw.html_url || raw.url || null,
  };
}

function normalizeReviewComment(raw) {
  return {
    stream: "review_comment",
    id: raw.id != null ? String(raw.id) : raw.node_id || raw.url || randomUUID(),
    createdAt: raw.created_at || raw.createdAt || null,
    authorAssociation: raw.author_association || raw.authorAssociation || "NONE",
    authorLogin: raw.user?.login || null,
    authorType: raw.user?.type || null,
    state: null,
    body: raw.body || "",
    url: raw.html_url || raw.url || null,
  };
}

function normalizeReview(raw) {
  return {
    stream: "review",
    id: raw.id != null ? String(raw.id) : raw.node_id || raw.url || randomUUID(),
    createdAt: raw.submitted_at || raw.submittedAt || raw.created_at || raw.createdAt || null,
    authorAssociation: raw.author_association || raw.authorAssociation || "NONE",
    authorLogin: raw.user?.login || null,
    authorType: raw.user?.type || null,
    state: raw.state || null,
    body: raw.body || "",
    url: raw.html_url || raw.url || null,
  };
}

function statusContextLabel(item) {
  return item.context || item.name || item.__typename || "unknown";
}

function classifyStatusChecks(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup) || statusCheckRollup.length === 0) {
    return {
      state: "NONE",
      failingChecks: [],
      pendingChecks: [],
      checkCount: 0,
    };
  }

  const failingChecks = [];
  const pendingChecks = [];

  for (const item of statusCheckRollup) {
    const rawState = String(item.state || "").toUpperCase();
    const status = String(
      item.status
      || (rawState === "PENDING" || rawState === "EXPECTED" ? "PENDING" : (rawState ? "COMPLETED" : "")),
    ).toUpperCase();
    const conclusion = String(item.conclusion || rawState || "").toUpperCase();
    const label = statusContextLabel(item);
    if (status !== "COMPLETED") {
      pendingChecks.push({ label, status, conclusion });
      continue;
    }
    if (FAILURE_CONCLUSIONS.has(conclusion) || (conclusion && !SUCCESSISH_CONCLUSIONS.has(conclusion))) {
      failingChecks.push({ label, status, conclusion });
    }
  }

  if (failingChecks.length > 0) {
    return {
      state: "FAILED",
      failingChecks,
      pendingChecks,
      checkCount: statusCheckRollup.length,
    };
  }
  if (pendingChecks.length > 0) {
    return {
      state: "PENDING",
      failingChecks,
      pendingChecks,
      checkCount: statusCheckRollup.length,
    };
  }
  return {
    state: "SUCCESS",
    failingChecks,
    pendingChecks,
    checkCount: statusCheckRollup.length,
  };
}

async function fetchReviewThreads(owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              isResolved
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  let unresolvedCount = 0;
  let after = null;
  do {
    const result = await ghGraphQLJson(query, {
      owner,
      repo,
      prNumber,
      after,
    });
    const connection = result?.data?.repository?.pullRequest?.reviewThreads;
    if (!connection) {
      return { unresolvedCount };
    }
    for (const thread of connection.nodes || []) {
      if (!thread.isResolved) {
        unresolvedCount += 1;
      }
    }
    after = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after);

  return { unresolvedCount };
}

async function fetchPrSnapshot(prKey, options = {}) {
  const { owner, repo, prNumber } = parsePrKey(prKey);
  const prView = await ghPrViewJson(owner, repo, prNumber, [
    "statusCheckRollup",
    "reviewDecision",
    "mergeStateStatus",
    "mergeable",
    "isDraft",
    "latestReviews",
    "headRefOid",
    "headRefName",
    "baseRefName",
    "state",
    "mergedAt",
    "url",
    "updatedAt",
  ], {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
  });

  const [issueCommentsRaw, reviewCommentsRaw, reviewsRaw, reviewThreads] = await Promise.all([
    fetchPaginatedArray(`repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    }),
    fetchPaginatedArray(`repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
      timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    }),
    fetchPaginatedArray(`repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    }),
    fetchReviewThreads(owner, repo, prNumber),
  ]);

  const issueComments = issueCommentsRaw.map(normalizeIssueComment).sort(compareActivityChronologically);
  const reviewComments = reviewCommentsRaw.map(normalizeReviewComment).sort(compareActivityChronologically);
  const reviews = reviewsRaw
    .map(normalizeReview)
    .filter((review) => review.state && review.state !== "PENDING")
    .sort(compareActivityChronologically);
  const checkSummary = classifyStatusChecks(prView.statusCheckRollup || []);

  return {
    prKey,
    owner,
    repo,
    prNumber,
    url: prView.url || null,
    state: prView.state || null,
    mergedAt: prView.mergedAt || null,
    updatedAt: prView.updatedAt || nowIso(),
    reviewDecision: prView.reviewDecision || null,
    mergeStateStatus: prView.mergeStateStatus || null,
    mergeable: prView.mergeable || null,
    isDraft: prView.isDraft === true,
    headSha: prView.headRefOid || null,
    headRefName: prView.headRefName || null,
    baseRefName: prView.baseRefName || null,
    unresolvedReviewThreadCount: reviewThreads.unresolvedCount,
    statusCheckState: checkSummary.state,
    failingChecks: checkSummary.failingChecks,
    pendingChecks: checkSummary.pendingChecks,
    issueComments,
    reviewComments,
    reviews,
    issueCommentCursor: buildCursor(issueComments),
    reviewCommentCursor: buildCursor(reviewComments),
    reviewCursor: buildCursor(reviews),
  };
}

async function fetchPrTerminalStatus(prKey) {
  const { owner, repo, prNumber } = parsePrKey(prKey);
  try {
    const pr = await ghPrViewJson(owner, repo, prNumber, ["state", "mergedAt"], {
      timeoutMs: GH_CLEANUP_TIMEOUT_MS,
    });
    if (pr.mergedAt) {
      return { terminal: true, reason: "merged" };
    }
    if (String(pr.state || "").toUpperCase() === "CLOSED") {
      return { terminal: true, reason: "closed" };
    }
    return { terminal: false, reason: "open" };
  } catch (error) {
    const body = `${error.message || ""} ${error.stderr || ""}`;
    if (error.code === "ECOMMAND" && /404|410|not found|could not resolve/i.test(body)) {
      return { terminal: true, reason: "missing" };
    }
    throw error;
  }
}

class EventState {
  constructor() {
    this.prs = new Map();
    this.lastSyncAt = null;
  }

  async load() {
    try {
      const raw = await fsPromises.readFile(STATE_FILE, "utf8");
      const obj = JSON.parse(raw);
      this.prs = new Map(
        Object.entries(obj.prs || {}).map(([prKey, entry]) => [prKey, normalizeStateEntry(prKey, entry)]),
      );
      this.lastSyncAt = obj.lastSyncAt || null;
    } catch {
      this.prs = new Map();
      this.lastSyncAt = null;
    }
  }

  async save() {
    await fsPromises.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const obj = {
      prs: Object.fromEntries(this.prs),
      lastSyncAt: nowIso(),
    };
    await fsPromises.writeFile(STATE_FILE, JSON.stringify(obj, null, 2), "utf8");
  }

  getOrInit(prKey) {
    if (!this.prs.has(prKey)) {
      this.prs.set(prKey, zeroStateEntry(prKey));
    }
    return this.prs.get(prKey);
  }

  setObservedSnapshot(prKey, snapshot) {
    const entry = this.getOrInit(prKey);
    entry.observed = baselineFromSnapshot(snapshot);
    entry.updatedAt = nowIso();
  }

  applyTaskSuccess(task, snapshot) {
    const entry = this.getOrInit(task.prKey);
    const boundary = normalizeBoundary(task.boundary);

    if (COMMENT_TASK_TYPES.has(task.type)) {
      const category = commentCategoryForTaskType(task.type);
      if (category) {
        entry.baseline.commentBaselines[category] = normalizeCommentCursorSet(boundary);
      }
    }

    if (task.type === "CI_FAILURE") {
      entry.baseline.statusCheckState = snapshot.statusCheckState;
    }

    if (task.type === "REVIEW_CHANGES_REQUESTED") {
      entry.baseline.reviewDecision = snapshot.reviewDecision;
    }

    if (MERGE_TASK_TYPES.has(task.type)) {
      entry.baseline.statusCheckState = snapshot.statusCheckState;
      entry.baseline.reviewDecision = snapshot.reviewDecision;
      entry.baseline.mergeStateStatus = snapshot.mergeStateStatus;
      entry.baseline.mergeable = snapshot.mergeable;
      entry.baseline.isDraft = snapshot.isDraft;
      entry.baseline.unresolvedReviewThreadCount = snapshot.unresolvedReviewThreadCount;
      entry.baseline.headSha = snapshot.headSha;
    }

    entry.baseline.updatedAt = snapshot.updatedAt || nowIso();
    entry.observed = baselineFromSnapshot(snapshot);
    entry.updatedAt = nowIso();
  }

  remove(prKey) {
    this.prs.delete(prKey);
  }

  keys() {
    return [...this.prs.keys()];
  }
}

class EventTaskManager {
  constructor() {
    this.events = [];
  }

  async load() {
    try {
      const raw = await fsPromises.readFile(TASK_FILE, "utf8");
      const obj = JSON.parse(raw);
      this.events = Array.isArray(obj.events)
        ? obj.events.map(normalizeTaskRecord).filter(Boolean)
        : [];
    } catch {
      this.events = [];
    }
  }

  async save() {
    await fsPromises.mkdir(path.dirname(TASK_FILE), { recursive: true });
    await fsPromises.writeFile(TASK_FILE, JSON.stringify({ events: this.events }, null, 2), "utf8");
  }

  resetRunningTasks() {
    let resetCount = 0;
    for (const event of this.events) {
      if (event.status === TASK_STATUS.RUNNING) {
        event.status = TASK_STATUS.PENDING;
        event.nextRetryAt = nowIso();
        event.claimedAt = null;
        event.runningPid = null;
        resetCount += 1;
      }
    }
    return resetCount;
  }

  hasBlocking(prKey, type) {
    return this.events.some((event) => event.prKey === prKey && event.type === type);
  }

  add(prKey, type, severity, details, boundary) {
    const event = {
      id: randomUUID(),
      prKey,
      type,
      severity,
      createdAt: nowIso(),
      status: TASK_STATUS.PENDING,
      attemptCount: 0,
      lastAttemptAt: null,
      nextRetryAt: nowIso(),
      lastError: null,
      claimedAt: null,
      runningPid: null,
      boundary: normalizeBoundary(boundary),
      details: cloneJson(details || {}),
    };
    this.events.push(event);
    return event;
  }

  getById(id) {
    return this.events.find((event) => event.id === id) || null;
  }

  listByPrKey(prKey) {
    return this.events.filter((event) => event.prKey === prKey);
  }

  getRunnable(nowMs = Date.now()) {
    return this.events
      .filter((event) => event.status === TASK_STATUS.PENDING && (!event.nextRetryAt || parseTimestampMs(event.nextRetryAt) <= nowMs))
      .sort(compareTasksForDispatch);
  }

  claim(id, pid) {
    const event = this.getById(id);
    if (!event || event.status !== TASK_STATUS.PENDING) {
      return null;
    }
    event.status = TASK_STATUS.RUNNING;
    event.attemptCount += 1;
    event.lastAttemptAt = nowIso();
    event.nextRetryAt = null;
    event.claimedAt = nowIso();
    event.runningPid = pid || null;
    return event;
  }

  fail(id, errorMessage) {
    const event = this.getById(id);
    if (!event) {
      return null;
    }
    event.lastError = truncate(errorMessage || "unknown failure", 400);
    event.claimedAt = null;
    event.runningPid = null;
    if (event.attemptCount >= MAX_ATTEMPTS) {
      event.status = TASK_STATUS.DEAD;
      event.nextRetryAt = null;
    } else {
      event.status = TASK_STATUS.PENDING;
      event.nextRetryAt = nextRetryAtForAttempt(event.attemptCount);
    }
    return event;
  }

  remove(id) {
    const before = this.events.length;
    this.events = this.events.filter((event) => event.id !== id);
    return before !== this.events.length;
  }

  removeByPrKey(prKey) {
    const before = this.events.length;
    this.events = this.events.filter((event) => event.prKey !== prKey);
    return before - this.events.length;
  }

  getAllPrKeys() {
    return [...new Set(this.events.map((event) => event.prKey))];
  }
}

class EventListener {
  constructor(config, actionLogger) {
    this.config = config;
    this.actionLogger = actionLogger;
    this.state = new EventState();
    this.taskManager = new EventTaskManager();
    this.intervalMs = config.eventPollIntervalMs || DEFAULTS.eventPollIntervalMs;
    this.enabled = false;
    this.loaded = false;
    this._timer = null;
    this._processing = new Set();
    this.activeSubagents = new Map();
    this.terminalPrs = new Set();
  }

  async load() {
    if (this.loaded) {
      return;
    }
    await this.state.load();
    await this.taskManager.load();
    const resetCount = this.taskManager.resetRunningTasks();
    if (resetCount > 0) {
      this.actionLogger.writeLine(`[${nowStamp()}] event_listener_recovered_running_tasks count=${resetCount}`);
      await this.taskManager.save();
    }
    this.loaded = true;
  }

  async saveAll() {
    await this.state.save();
    await this.taskManager.save();
  }

  async bootstrapRefresh() {
    await this.load();
    await this._refresh(false);
  }

  async start() {
    await this.load();
    this.enabled = true;
    await this._dispatchRunnableTasks();
    this._scheduleNext();
    this.actionLogger.writeLine(`[${nowStamp()}] event_listener_start interval=${this.intervalMs}ms`);
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.enabled = false;
    this.actionLogger.writeLine(`[${nowStamp()}] event_listener_stop`);
  }

  _scheduleNext() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this.enabled) {
      return;
    }
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
    this.actionLogger.writeLine(`[${nowStamp()}] event_listener_scheduled next=${this.intervalMs}ms`);
  }

  _tick() {
    if (!this.enabled) {
      return;
    }
    this._refresh(true)
      .catch((error) => {
        this.actionLogger.writeLine(`[${nowStamp()}] event_tick_error=${truncate(error.message || error, 300)}`);
      })
      .finally(() => {
        this._scheduleNext();
      });
  }

  async _refresh(dispatchNewTasks) {
    const logPrefix = `[${nowStamp()}] event_tick`;
    let prList;
    try {
      prList = await this._fetchOpenPrList();
    } catch (error) {
      this.actionLogger.writeLine(`${logPrefix} search_failed=${truncate(error.message || error, 300)}`);
      return;
    }

    const openPrKeys = new Set(prList.map((pr) => pr.prKey));
    await this._cleanupTerminalPrs(openPrKeys);

    for (const pr of prList) {
      try {
        const snapshot = await fetchPrSnapshot(pr.prKey);
        await this._scanSnapshot(snapshot);
      } catch (error) {
        this.actionLogger.writeLine(`${logPrefix} pr_scan_failed pr=${pr.prKey} err=${truncate(error.message || error, 300)}`);
      }
    }

    if (dispatchNewTasks) {
      await this._dispatchRunnableTasks();
    }
    await this.saveAll();
  }

  async _fetchOpenPrList() {
    const raw = await ghApiJson("search/issues?q=author:Will-hxw+is:pr+state:open&per_page=100&sort=updated", {
      timeoutMs: GH_TIMEOUT_MS,
    });
    const items = Array.isArray(raw.items) ? raw.items : [];
    return items
      .filter((item) => item.repository_url && item.number)
      .map((item) => {
        const ownerRepo = item.repository_url.replace("https://api.github.com/repos/", "");
        return {
          ownerRepo,
          prKey: `${ownerRepo}#${item.number}`,
          number: item.number,
        };
      });
  }

  async _cleanupTerminalPrs(openPrKeys) {
    const trackedPrKeys = new Set([
      ...this.state.keys(),
      ...this.taskManager.getAllPrKeys(),
      ...this.activeSubagents.keys(),
    ]);

    for (const prKey of trackedPrKeys) {
      if (openPrKeys.has(prKey)) {
        continue;
      }
      try {
        const terminalStatus = await fetchPrTerminalStatus(prKey);
        if (!terminalStatus.terminal) {
          continue;
        }
        const removedTaskCount = this.taskManager.removeByPrKey(prKey);
        this.state.remove(prKey);
        this._processing.delete(prKey);
        if (this.activeSubagents.has(prKey)) {
          this.terminalPrs.add(prKey);
        } else {
          this.terminalPrs.delete(prKey);
        }
        this.actionLogger.writeLine(
          `[${nowStamp()}] terminal_pr_removed pr=${prKey} reason=${terminalStatus.reason} tasks=${removedTaskCount}`,
        );
      } catch (error) {
        this.actionLogger.writeLine(
          `[${nowStamp()}] terminal_pr_check_failed pr=${prKey} err=${truncate(error.message || error, 300)}`,
        );
      }
    }
  }

  async _scanSnapshot(snapshot) {
    const entry = this.state.getOrInit(snapshot.prKey);
    const baseline = entry.baseline;
    const observed = entry.observed;
    const fullBoundary = buildBoundaryFromSnapshot(snapshot);
    const candidateTasks = new Map();

    if (snapshot.statusCheckState === "FAILED" && baseline.statusCheckState !== "FAILED") {
      candidateTasks.set("CI_FAILURE", {
        type: "CI_FAILURE",
        severity: TASK_EVENT_SEVERITY.CI_FAILURE,
        boundary: fullBoundary,
        details: buildTaskDetails("CI_FAILURE", snapshot, {
          failingChecks: snapshot.failingChecks,
        }),
      });
    }

    if (snapshot.reviewDecision === "CHANGES_REQUESTED" && baseline.reviewDecision !== "CHANGES_REQUESTED") {
      candidateTasks.set("REVIEW_CHANGES_REQUESTED", {
        type: "REVIEW_CHANGES_REQUESTED",
        severity: TASK_EVENT_SEVERITY.REVIEW_CHANGES_REQUESTED,
        boundary: fullBoundary,
        details: buildTaskDetails("REVIEW_CHANGES_REQUESTED", snapshot, {
          reviewDecision: snapshot.reviewDecision,
        }),
      });
    }

    for (const category of COMMENT_CATEGORIES) {
      const activities = collectNewActivities(snapshot, baseline.commentBaselines[category], category);
      if (activities.items.length === 0) {
        continue;
      }
      const type = COMMENT_TASK_TYPE_BY_CATEGORY[category];
      const latestActivity = createActivitySummary(activities.items[activities.items.length - 1]);
      candidateTasks.set(type, {
        type,
        severity: TASK_EVENT_SEVERITY[type],
        boundary: buildBoundaryFromCategorySnapshot(snapshot, category),
        details: buildTaskDetails(type, snapshot, {
          activities: activities.items.map(createActivitySummary),
          activityCount: activities.items.length,
          streamCounts: activities.counts,
          latestActivity,
        }),
      });
    }

    const currentNeedsRebase = isNeedsRebaseFromRaw(snapshot);
    if (currentNeedsRebase && !baselineNeedsRebase(baseline)) {
      candidateTasks.set("NEEDS_REBASE", {
        type: "NEEDS_REBASE",
        severity: TASK_EVENT_SEVERITY.NEEDS_REBASE,
        boundary: fullBoundary,
        details: buildTaskDetails("NEEDS_REBASE", snapshot, {
          mergeStateStatus: snapshot.mergeStateStatus,
          mergeable: snapshot.mergeable,
        }),
      });
    }

    const currentReadyToMerge = isReadyToMergeFromRaw(snapshot);
    if (currentReadyToMerge && !baselineReadyToMerge(baseline)) {
      candidateTasks.set("READY_TO_MERGE", {
        type: "READY_TO_MERGE",
        severity: TASK_EVENT_SEVERITY.READY_TO_MERGE,
        boundary: fullBoundary,
        details: buildTaskDetails("READY_TO_MERGE", snapshot, {
          reviewDecision: snapshot.reviewDecision,
          mergeStateStatus: snapshot.mergeStateStatus,
          mergeable: snapshot.mergeable,
          unresolvedReviewThreadCount: snapshot.unresolvedReviewThreadCount,
        }),
      });
    }

    const existingByType = new Map();
    for (const task of this.taskManager.listByPrKey(snapshot.prKey)) {
      if (!TASK_EVENT_TYPES.has(task.type)) {
        continue;
      }
      if (!existingByType.has(task.type)) {
        existingByType.set(task.type, []);
      }
      existingByType.get(task.type).push(task);
    }

    for (const [type, tasks] of existingByType) {
      const runningTasks = tasks.filter((task) => task.status === TASK_STATUS.RUNNING);
      if (runningTasks.length > 0) {
        candidateTasks.delete(type);
        for (const task of tasks) {
          if (task.status === TASK_STATUS.RUNNING) {
            continue;
          }
          this.taskManager.remove(task.id);
          this.actionLogger.writeLine(
            `[${nowStamp()}] event_reconciled_removed pr=${snapshot.prKey} type=${task.type} task=${task.id} status=${task.status} reason=duplicate_while_running`,
          );
        }
        continue;
      }

      const [primary, ...duplicates] = [...tasks].sort(compareTasksForDispatch);
      for (const duplicate of duplicates) {
        this.taskManager.remove(duplicate.id);
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_reconciled_removed pr=${snapshot.prKey} type=${duplicate.type} task=${duplicate.id} status=${duplicate.status} reason=duplicate`,
        );
      }

      const candidate = candidateTasks.get(type);
      if (!candidate) {
        this.taskManager.remove(primary.id);
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_reconciled_removed pr=${snapshot.prKey} type=${primary.type} task=${primary.id} status=${primary.status} reason=trigger_cleared`,
        );
        continue;
      }

      primary.severity = candidate.severity;
      primary.details = cloneJson(candidate.details);
      primary.boundary = normalizeBoundary(candidate.boundary);
      this.actionLogger.writeLine(
        `[${nowStamp()}] event_reconciled_refreshed pr=${snapshot.prKey} type=${primary.type} task=${primary.id} status=${primary.status}`,
      );
      candidateTasks.delete(type);
    }

    for (const event of candidateTasks.values()) {
      if (this.taskManager.hasBlocking(snapshot.prKey, event.type)) {
        this.actionLogger.writeLine(`[${nowStamp()}] event_deduped pr=${snapshot.prKey} type=${event.type}`);
        continue;
      }
      const task = this.taskManager.add(snapshot.prKey, event.type, event.severity, event.details, event.boundary);
      if (this.config.eventNotificationEnabled) {
        notifyEvent(task.type, task.prKey, task.severity, this.actionLogger);
      }
      this.actionLogger.writeLine(`[${nowStamp()}] event_added pr=${snapshot.prKey} type=${task.type} severity=${task.severity}`);
    }

    if (
      snapshot.statusCheckState === "SUCCESS"
      && observed.statusCheckState
      && observed.statusCheckState !== "SUCCESS"
    ) {
      if (this.config.eventNotificationEnabled) {
        notifyEvent("CI_PASSED", snapshot.prKey, "INFO", this.actionLogger);
      }
      this.actionLogger.writeLine(`[${nowStamp()}] event_info pr=${snapshot.prKey} type=CI_PASSED`);
    }

    if (
      snapshot.reviewDecision === "APPROVED"
      && observed.reviewDecision
      && observed.reviewDecision !== "APPROVED"
    ) {
      if (this.config.eventNotificationEnabled) {
        notifyEvent("REVIEW_APPROVED", snapshot.prKey, "INFO", this.actionLogger);
      }
      this.actionLogger.writeLine(`[${nowStamp()}] event_info pr=${snapshot.prKey} type=REVIEW_APPROVED`);
    }

    this.state.setObservedSnapshot(snapshot.prKey, snapshot);
  }

  async _dispatchRunnableTasks() {
    if (!this.config.enableTaskDispatch) {
      return;
    }

    const runnable = this.taskManager.getRunnable();
    for (const task of runnable) {
      if (this.activeSubagents.size >= MAX_PARALLEL_SUBAGENTS) {
        break;
      }
      if (this._processing.has(task.prKey) || this.terminalPrs.has(task.prKey)) {
        continue;
      }
      await this._startTask(task);
    }
  }

  async _startTask(task) {
    const commandString = [
      shellQuote(this.config.claudeCommand),
      "-p",
      "--verbose",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--effort",
      "max",
    ].join(" ");

    const child = spawn(commandString, {
      cwd: this.config.cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const claimed = this.taskManager.claim(task.id, child.pid || null);
    if (!claimed) {
      return;
    }
    await this.taskManager.save();

    this._processing.add(task.prKey);
    this.activeSubagents.set(task.prKey, {
      taskId: task.id,
      pid: child.pid || null,
      startedAt: Date.now(),
    });
    this.actionLogger.writeLine(`[${nowStamp()}] subagent_spawn pr=${task.prKey} task=${task.id} pid=${child.pid || "unknown"}`);

    let stdoutBuffer = "";
    const ackTextBuffer = { buffer: "" };
    let ackRecord = null;
    let invalidAckReason = null;
    let spawnError = null;
    let attemptTimedOut = false;
    let killRequested = false;
    let closeHandled = false;

    const handleStdoutLine = (line) => {
      if (!line.trim()) {
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        this.actionLogger.writeLine(`[${nowStamp()}] subagent_stdout_parse_failed pr=${task.prKey} line=${truncate(line, 200)}`);
        return;
      }
      if (event.type !== "assistant" || !event.message || !Array.isArray(event.message.content)) {
        return;
      }
      for (const item of event.message.content) {
        if (item.type === "text" && item.text) {
          ackTextBuffer.buffer += item.text;
          const parsed = extractAckFromTextBuffer(ackTextBuffer, task);
          if (parsed) {
            if (parsed.valid) {
              ackRecord = parsed.payload;
            } else {
              invalidAckReason = parsed.reason;
            }
          }
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleStdoutLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) {
          this.actionLogger.writeLine(`[${nowStamp()}] subagent_stderr pr=${task.prKey} task=${task.id} ${truncate(line.trim(), 200)}`);
        }
      }
    });

    child.on("error", (error) => {
      spawnError = error;
      this.actionLogger.writeLine(`[${nowStamp()}] subagent_spawn_error pr=${task.prKey} task=${task.id} err=${truncate(error.message || error, 300)}`);
    });

    const timeoutTimer = setTimeout(async () => {
      attemptTimedOut = true;
      killRequested = true;
      this.actionLogger.writeLine(`[${nowStamp()}] subagent_timeout pr=${task.prKey} task=${task.id} timeout_ms=${SUBAGENT_TIMEOUT_MS}`);
      await terminateChildProcess(child, {
        signal: "SIGTERM",
        graceMs: SUBAGENT_FORCE_KILL_GRACE_MS,
      });
    }, SUBAGENT_TIMEOUT_MS);

    const finalize = async (code, signal) => {
      if (closeHandled) {
        return;
      }
      closeHandled = true;
      clearTimeout(timeoutTimer);

      if (stdoutBuffer.trim()) {
        handleStdoutLine(stdoutBuffer.trim());
      }
      if (ackTextBuffer.buffer.trim()) {
        const parsed = parseAckLine(ackTextBuffer.buffer.trim(), task);
        if (parsed) {
          if (parsed.valid) {
            ackRecord = parsed.payload;
          } else {
            invalidAckReason = parsed.reason;
          }
        }
      }

      this.activeSubagents.delete(task.prKey);
      this._processing.delete(task.prKey);

      if (this.terminalPrs.has(task.prKey)) {
        this.terminalPrs.delete(task.prKey);
        this.actionLogger.writeLine(`[${nowStamp()}] subagent_ignored_terminal pr=${task.prKey} task=${task.id} code=${code} signal=${signal || "none"}`);
        await this._dispatchRunnableTasks();
        return;
      }

      const taskStillExists = this.taskManager.getById(task.id);
      if (!taskStillExists) {
        await this._dispatchRunnableTasks();
        return;
      }

      const success = !attemptTimedOut
        && !killRequested
        && code === 0
        && ackRecord
        && !invalidAckReason;

      if (success) {
        await this._handleTaskSuccess(task);
      } else {
        const reason = spawnError
          ? `spawn_error: ${spawnError.message}`
          : attemptTimedOut
            ? "subagent_timeout"
            : invalidAckReason
              ? invalidAckReason
              : !ackRecord
                ? "missing_success_ack"
                : `subagent_exit_${code ?? "null"}_${signal || "nosignal"}`;
        await this._handleTaskFailure(task, reason);
      }

      await this._dispatchRunnableTasks();
    };

    child.on("close", (code, signal) => {
      finalize(code, signal).catch((error) => {
        this.actionLogger.writeLine(`[${nowStamp()}] subagent_finalize_failed pr=${task.prKey} task=${task.id} err=${truncate(error.message || error, 300)}`);
      });
    });

    try {
      child.stdin.write(`${createJsonUserEvent(buildSubagentPrompt(task))}\n`, "utf8");
      child.stdin.end();
    } catch (error) {
      spawnError = error;
      killRequested = true;
      await terminateChildProcess(child, {
        signal: "SIGTERM",
        graceMs: SUBAGENT_FORCE_KILL_GRACE_MS,
      });
    }
  }

  async _handleTaskSuccess(task) {
    let refreshedSnapshot;
    try {
      refreshedSnapshot = await fetchPrSnapshot(task.prKey, {
        timeoutMs: GH_TIMEOUT_MS,
      });
    } catch (error) {
      await this._handleTaskFailure(task, `post_success_refresh_failed: ${error.message}`);
      return;
    }

    this.state.applyTaskSuccess(task, refreshedSnapshot);
    this.taskManager.remove(task.id);
    this.actionLogger.writeLine(`[${nowStamp()}] event_task_success pr=${task.prKey} task=${task.id} type=${task.type}`);
    await this.saveAll();

    try {
      await this._scanSnapshot(refreshedSnapshot);
      await this.saveAll();
    } catch (error) {
      this.actionLogger.writeLine(`[${nowStamp()}] post_success_rescan_failed pr=${task.prKey} task=${task.id} err=${truncate(error.message || error, 300)}`);
    }
  }

  async _handleTaskFailure(task, reason) {
    const updated = this.taskManager.fail(task.id, reason);
    if (!updated) {
      return;
    }
    this.actionLogger.writeLine(
      `[${nowStamp()}] event_task_failed pr=${task.prKey} task=${task.id} type=${task.type} status=${updated.status} attempts=${updated.attemptCount} next_retry=${updated.nextRetryAt || "none"} reason=${truncate(reason, 300)}`,
    );
    await this.taskManager.save();
  }
}

function getNotifier() {
  try {
    return require("node-notifier");
  } catch (_) {
    if (process.platform === "win32") {
      return {
        notify(options, callback) {
          const title = options.title.replace(/"/g, '\\"').replace(/[&|;$<>()]/g, "");
          const message = options.message.replace(/"/g, '\\"').replace(/[&|;$<>()]/g, "");
          const command = `powershell -Command "[System.Windows.Forms.MessageBox]::Show('${message}', '${title}')"`;
          spawn(command, { shell: true, stdio: "ignore", windowsHide: true });
          if (callback) {
            callback();
          }
        },
      };
    }
    return null;
  }
}

function notifyEvent(type, prKey, severity, logger) {
  const notifier = getNotifier();
  if (!notifier) {
    return;
  }
  const title = severity === "HEAVY" ? `⚠️ PR 事件 [${type}]` : `ℹ️ PR 事件 [${type}]`;
  notifier.notify({
    title,
    message: prKey,
    sound: true,
  }, (error) => {
    if (error) {
      logger.writeLine(`[${nowStamp()}] notify_error=${truncate(error.message || error, 200)}`);
    }
  });
}

function renderAssistantEvent(event, config, seenToolUses) {
  const { message } = event;
  if (!message || !Array.isArray(message.content)) {
    return;
  }

  for (const item of message.content) {
    if (item.type === "text" && item.text) {
      process.stdout.write(item.text);
      if (!item.text.endsWith("\n")) {
        process.stdout.write("\n");
      }
      continue;
    }

    if (item.type === "thinking" && config.showThinking && item.thinking) {
      process.stdout.write(`${color("[thinking]", "90")} ${item.thinking}\n`);
      continue;
    }

    if (item.type === "tool_use" && item.id && !seenToolUses.has(item.id)) {
      seenToolUses.add(item.id);
      const inputPreview = item.input ? truncate(JSON.stringify(item.input)) : "";
      process.stdout.write(`${color("[tool]", "35")} ${item.name}${inputPreview ? ` ${inputPreview}` : ""}\n`);
    }
  }
}

function runGitStatus(cwd) {
  return new Promise((resolve) => {
    const git = spawn("git", ["status", "--short", "--branch"], {
      cwd,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    git.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    git.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    git.on("error", (error) => {
      resolve(`git status failed: ${error.message}`);
    });
    git.on("close", (code) => {
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join(" | ");
      if (!combined) {
        resolve(`git status exited with code ${code}`);
        return;
      }
      resolve(combined);
    });
  });
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(config.cwd);
  const agentFile = path.join(cwd, "AGENT.md");
  const ruleFile = path.join(cwd, "pr_rule.md");

  ensureFileExists(agentFile, "AGENT.md");
  ensureFileExists(ruleFile, "pr_rule.md");

  const logDir = path.join(cwd, config.logDirName);
  ensureDirectoryExists(logDir);

  const stamp = timestampForFile();
  const transcriptLogger = createLogger(path.join(logDir, `claude_stream_${stamp}.jsonl`));
  const actionLogger = createLogger(path.join(logDir, `claude_actions_${stamp}.log`));
  const gitStatus = await runGitStatus(cwd);

  printInfo(`工作目录: ${cwd}`);
  printInfo(`Claude 命令: ${config.claudeCommand}`);
  printInfo(`思考深度: ${config.effort}`);
  printInfo(`日志目录: ${logDir}`);
  printInfo(`空闲阈值: ${config.idleSeconds}s`);
  printInfo(`首次提示延迟: ${config.initialDelaySeconds}s`);
  printInfo(`补发冷却: ${config.nudgeCooldownSeconds}s`);

  actionLogger.writeLine(`===== bootstrap ${nowStamp()} =====`);
  actionLogger.writeLine(`cwd=${cwd}`);
  actionLogger.writeLine(`claude_command=${config.claudeCommand}`);
  actionLogger.writeLine(`effort=${config.effort}`);
  actionLogger.writeLine(`enableEventListener=${config.enableEventListener}`);
  actionLogger.writeLine(`eventPollIntervalMs=${config.eventPollIntervalMs}`);
  actionLogger.writeLine(`git_status=${gitStatus}`);
  actionLogger.writeLine(`prompt=${config.prompt}`);

  const bootstrapListener = new EventListener({
    cwd,
    claudeCommand: config.claudeCommand,
    eventPollIntervalMs: config.eventPollIntervalMs,
    eventNotificationEnabled: config.eventNotificationEnabled,
    enableTaskDispatch: false,
  }, actionLogger);
  await bootstrapListener.bootstrapRefresh();
  actionLogger.writeLine(`[${nowStamp()}] bootstrap_done`);

  const eventListener = config.enableEventListener
    ? new EventListener({
      cwd,
      claudeCommand: config.claudeCommand,
      eventPollIntervalMs: config.eventPollIntervalMs,
      eventNotificationEnabled: config.eventNotificationEnabled,
      enableTaskDispatch: true,
    }, actionLogger)
    : null;

  const commandString = [
    shellQuote(config.claudeCommand),
    "-p",
    "--verbose",
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--effort",
    config.effort,
  ].join(" ");

  const child = spawn(commandString, {
    cwd,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });

  if (eventListener) {
    await eventListener.start();
    printInfo(`事件监听已启用，轮询间隔 ${config.eventPollIntervalMs}ms`);
  }

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let promptSent = false;
  let childExited = false;
  let nudgeCount = 0;
  let lastOutputAt = Date.now();
  let lastNudgeAt = 0;
  const seenToolUses = new Set();
  let pendingReviewPRs = [];
  let lastReviewCheckAt = 0;

  const scanPendingReviews = (force = false) => {
    if (!config.enableReviewMonitor) {
      return [];
    }
    const recordsDir = path.join(cwd, "records");
    if (!fs.existsSync(recordsDir)) {
      return [];
    }
    const now = Date.now();
    const checkIntervalMs = config.reviewCheckIntervalSeconds * 1000;
    if (!force && now - lastReviewCheckAt < checkIntervalMs) {
      return pendingReviewPRs;
    }
    lastReviewCheckAt = now;

    const files = fs.readdirSync(recordsDir).filter((file) => file.endsWith(".md"));
    const nextPending = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(recordsDir, file), "utf8");
      const result = normalizeResultValue(extractRecordField(content, "Result"));
      const reviewState = normalizeReviewState(extractRecordField(content, "Current state"));
      if (!["submitted", "waiting-review"].includes(result)) {
        continue;
      }
      if (reviewState === "FINISHED") {
        continue;
      }
      const prMatch = content.match(/(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/i);
      if (prMatch) {
        nextPending.push({ file, url: prMatch[1] });
      }
    }
    pendingReviewPRs = nextPending;
    if (nextPending.length > 0) {
      printInfo(`发现 ${nextPending.length} 个待检查的 PR review 状态`);
      actionLogger.writeLine(
        `[${nowStamp()}] review_pending count=${nextPending.length} files=${nextPending.map((item) => item.file).join(",")}`,
      );
    }
    return nextPending;
  };

  const reviewCheckTimer = config.enableReviewMonitor
    ? setInterval(() => {
      scanPendingReviews(true);
    }, Math.max(config.reviewCheckIntervalSeconds, 300) * 1000)
    : null;

  pendingReviewPRs = scanPendingReviews(true);

  const sendPrompt = (reason) => {
    if (childExited) {
      return;
    }

    let fullPrompt = config.prompt;
    if (config.enableReviewMonitor && pendingReviewPRs.length > 0) {
      const prList = pendingReviewPRs.map((item) => `- ${item.file}: ${item.url}`).join("\n");
      fullPrompt += `\n\n## 重要：PR Review 监控\n当前有 ${pendingReviewPRs.length} 个已提交的 PR 需要检查 review 状态：\n${prList}\n\n请先处理这些 review 相关任务，再继续寻找新的 PR 项目。`;
    }

    const payload = createJsonUserEvent(fullPrompt);
    child.stdin.write(`${payload}\n`, "utf8");
    promptSent = true;
    lastNudgeAt = Date.now();
    lastOutputAt = Date.now();
    actionLogger.writeLine(`[${nowStamp()}] prompt_sent reason=${reason}`);
    printWarn(`已发送提示，reason=${reason}`);
  };

  const initialTimer = setTimeout(() => {
    sendPrompt("initial");
  }, config.initialDelaySeconds * 1000);

  const idleTimer = setInterval(() => {
    if (childExited || !promptSent) {
      return;
    }
    const now = Date.now();
    const idleSeconds = Math.floor((now - lastOutputAt) / 1000);
    const cooldownSeconds = Math.floor((now - lastNudgeAt) / 1000);

    if (idleSeconds < config.idleSeconds || cooldownSeconds < config.nudgeCooldownSeconds) {
      return;
    }

    if (config.maxNudges > 0 && nudgeCount >= config.maxNudges) {
      printWarn(`达到最大补发次数 ${config.maxNudges}，停止自动补发。`);
      actionLogger.writeLine(`[${nowStamp()}] max_nudges_reached count=${nudgeCount}`);
      clearInterval(idleTimer);
      return;
    }

    nudgeCount += 1;
    sendPrompt(`idle-${nudgeCount}`);
  }, 1000);

  const handleStdoutLine = (line) => {
    if (!line.trim()) {
      return;
    }

    transcriptLogger.writeLine(line);
    lastOutputAt = Date.now();

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      actionLogger.writeLine(`[${nowStamp()}] stdout_parse_failed=${truncate(line, 400)}`);
      if (config.showRawEvents) {
        process.stdout.write(`${line}\n`);
      }
      return;
    }

    if (config.showRawEvents) {
      process.stdout.write(`${line}\n`);
    }

    if (event.type === "assistant") {
      renderAssistantEvent(event, config, seenToolUses);
      return;
    }

    if (event.type === "result") {
      const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd.toFixed(6) : "n/a";
      process.stdout.write(`${color("[result]", "32")} ${event.subtype || "done"} turns=${event.num_turns ?? "?"} cost=$${cost}\n`);
      return;
    }

    if (event.type === "system" && event.subtype === "init") {
      actionLogger.writeLine(`[${nowStamp()}] session_init session_id=${event.session_id || ""}`);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleStdoutLine(line);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString("utf8");
    lastOutputAt = Date.now();

    let newlineIndex = stderrBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      if (line) {
        actionLogger.writeLine(`[${nowStamp()}] stderr=${line}`);
        printError(line);
      }
      newlineIndex = stderrBuffer.indexOf("\n");
    }
  });

  child.on("error", (error) => {
    childExited = true;
    clearTimeout(initialTimer);
    clearInterval(idleTimer);
    if (reviewCheckTimer) clearInterval(reviewCheckTimer);
    if (eventListener) eventListener.stop();
    actionLogger.writeLine(`[${nowStamp()}] child_error=${error.message}`);
    transcriptLogger.close();
    actionLogger.close();
    throw error;
  });

  const shutdown = (signal) => {
    if (childExited) {
      return;
    }
    printWarn(`收到 ${signal}，准备停止 Claude 子进程。`);
    actionLogger.writeLine(`[${nowStamp()}] received_signal=${signal}`);
    childExited = true;
    clearTimeout(initialTimer);
    clearInterval(idleTimer);
    if (reviewCheckTimer) clearInterval(reviewCheckTimer);
    if (eventListener) eventListener.stop();
    child.kill("SIGINT");
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise((resolve, reject) => {
    child.on("close", (code) => {
      childExited = true;
      clearTimeout(initialTimer);
      clearInterval(idleTimer);
      if (reviewCheckTimer) clearInterval(reviewCheckTimer);
      if (eventListener) eventListener.stop();

      if (stdoutBuffer.trim()) {
        handleStdoutLine(stdoutBuffer.trim());
      }
      if (stderrBuffer.trim()) {
        actionLogger.writeLine(`[${nowStamp()}] stderr_tail=${stderrBuffer.trim()}`);
        printError(stderrBuffer.trim());
      }

      actionLogger.writeLine(`[${nowStamp()}] child_exit=${code}`);
      transcriptLogger.close();
      actionLogger.close();

      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Claude 退出码非 0: ${code}`));
    });
  });
}

if (require.main === module) {
  main().catch((error) => {
    printError(error.message || String(error));
    process.exit(error.exitCode || 1);
  });
} else {
  module.exports = {
    COMMENT_CATEGORIES,
    COMMENT_TASK_TYPES,
    EventListener,
    EventState,
    EventTaskManager,
    TASK_EVENT_SEVERITY,
    TASK_STATUS,
    baselineFromSnapshot,
    buildBoundaryFromCategorySnapshot,
    buildBoundaryFromSnapshot,
    buildCommentBaselinesFromSnapshot,
    buildCommentCursorSet,
    buildCursor,
    classifyActivityCategory,
    collectNewActivities,
    commentCategoryForTaskType,
    compareActivityChronologically,
    createActivitySummary,
    emptyBaseline,
    emptyCommentBaselines,
    emptyCommentCursorSet,
    emptyCursor,
    isNeedsRebaseFromRaw,
    isReadyToMergeFromRaw,
    normalizeBaseline,
    normalizeBoundary,
    normalizeCommentBaselines,
    normalizeCommentCursorSet,
  };
}
