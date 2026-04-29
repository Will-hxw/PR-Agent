#!/usr/bin/env node

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");

const ROOT_DIR = __dirname;
const STATE_FILE = path.join(ROOT_DIR, "event_state.json");
const TASK_FILE = path.join(ROOT_DIR, "event_task.json");
const CONFIG_FILE = path.join(ROOT_DIR, "agent.config.json");
const CONFIG_EXAMPLE_FILE = path.join(ROOT_DIR, "agent.config.example.json");
const RUNTIME_JSON_SCHEMA_VERSION = 1;
const DEFAULT_READY_TO_MERGE_REVIEW_MODE = "require-approval";
const READY_TO_MERGE_REVIEW_MODES = new Set([
  DEFAULT_READY_TO_MERGE_REVIEW_MODE,
  "allow-no-review-required",
]);
const AGENT_CONFIG = loadAgentConfig();
const CONTRIBUTOR_LOGIN = AGENT_CONFIG.contributorLogin;

const DEFAULTS = {
  cwd: ROOT_DIR,
  idleSeconds: 300,
  initialDelaySeconds: 8,
  nudgeCooldownSeconds: 30,
  maxNudges: 0,
  claudeCommand: process.platform === "win32" ? "claude.cmd" : "claude",
  effort: "max",
  prompt: buildDefaultPrompt(),
  logDirName: ".claude_agent_logs",
  showThinking: true,
  showRawEvents: false,
  showToolResults: false,
  enableEventListener: true,
  eventPollIntervalMs: 3600000,
  readyToMergeReviewMode: AGENT_CONFIG.readyToMergeReviewMode || DEFAULT_READY_TO_MERGE_REVIEW_MODE,
};

const TOOL_RESULT_PREVIEW_MAX = 700;
const TASK_STATUS = {
  PENDING: "pending",
  BLOCKED: "blocked",
};
const TASK_ACTIONABILITY = Object.freeze({
  ACTIONABLE_BY_AGENT: "actionable_by_agent",
  NEEDS_CONTRIBUTOR_ACTION: "needs_contributor_action",
  NEEDS_MAINTAINER_ACTION: "needs_maintainer_action",
  NEEDS_HUMAN_DECISION: "needs_human_decision",
  NEEDS_INFRA_ACTION: "needs_infra_action",
  NOT_ACTIONABLE: "not_actionable",
  UNKNOWN: "unknown",
});
const TERMINAL_TASK_STATUSES = new Set(["success", "succeeded", "completed", "handled", "done"]);
const TASK_EVENT_SEVERITY = {
  CI_FAILURE: "HEAVY",
  REVIEW_CHANGES_REQUESTED: "HEAVY",
  MAINTAINER_COMMENT: "HEAVY",
  BOT_COMMENT: "LIGHT",
  NEW_COMMENT: "LIGHT",
  NEEDS_REBASE: "LIGHT",
};
const TASK_EVENT_TYPES = new Set(Object.keys(TASK_EVENT_SEVERITY));
const INFO_ONLY_EVENT_TYPES = new Set(["CI_PASSED", "REVIEW_APPROVED", "READY_TO_MERGE"]);
const COMMENT_TASK_TYPES = new Set(["MAINTAINER_COMMENT", "BOT_COMMENT", "NEW_COMMENT"]);
const MERGE_TASK_TYPES = new Set(["NEEDS_REBASE"]);
const STATE_BACKED_TASK_TYPES = new Set([
  "CI_FAILURE",
  "REVIEW_CHANGES_REQUESTED",
  ...MERGE_TASK_TYPES,
]);
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
const GH_TIMEOUT_MS = 60 * 1000;
const GH_CLEANUP_TIMEOUT_MS = 30 * 1000;
const GH_TRANSIENT_RETRY_ATTEMPTS = 3;
const GH_TRANSIENT_RETRY_DELAY_MS = 1000;
const CHILD_FORCE_KILL_GRACE_MS = 5 * 1000;
const GRAPHQL_INT_MIN = -2147483648;
const GRAPHQL_INT_MAX = 2147483647;
const EVENT_LISTENER_LOCK_FILE = path.join(ROOT_DIR, DEFAULTS.logDirName, "event-listener.lock");
const BEGIN_UNTRUSTED_PR_CONTENT = "BEGIN_UNTRUSTED_PR_CONTENT";
const END_UNTRUSTED_PR_CONTENT = "END_UNTRUSTED_PR_CONTENT";
const GH_PROXY_MODE_INHERIT = "inherit";
const GH_PROXY_MODE_DIRECT = "direct";
const GH_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];
const SEVERITY_ORDER = {
  HEAVY: 0,
  LIGHT: 1,
  INFO: 2,
};

function buildDefaultPrompt() {
  return [
    "[Agent] You are the single Claude open-source PR Agent. Your goal is to process existing PR tasks, find new contribution opportunities, submit and follow up on GitHub PRs, and keep every contribution small, accurate, and maintainable.",
    "[Highest priority] On startup, read event_task.json and event_state.json first. If event_task.json contains any task, regardless of pending, blocked, or legacy running/dead state, process the task queue before scouting for new PRs.",
    "[Task closure] For every task, follow doc/task-processing.md to investigate, act, reply, or record the result. After handling it, follow doc/event-task-state-maintenance.md to advance the matching event_state.json baseline and delete the corresponding task from event_task.json. Deleting the task alone is not completion.",
    "[Workflow] STARTUP -> TASK_QUEUE -> Scout -> Triage -> Lock Target -> Implement -> Validate -> Submit PR -> Record -> TASK_QUEUE. Return to TASK_QUEUE after every stage.",
    "[PR restriction] Do not create PRs for any MCP-related project, including MCP Server/Client/SDK/Protocol implementations, repositories containing MCP keywords, or projects using @modelcontextprotocol/* or @anthropic-ai/mcp-sdk dependencies.",
    "Reply in Chinese except for proper nouns, code, commands, and technical identifiers.",
    `Read runtime state with JSON-aware tooling from: ${STATE_FILE} and ${TASK_FILE}.`,
    "Maintain this launcher repository's git cleanliness. Do not create contribution branches in this launcher repository; use candidates/ for target repositories, cloning your own fork there when needed.",
    "Follow AGENT.md, doc/pr_rule.md, doc/task-processing.md, and doc/event-task-state-maintenance.md.",
    "Only scout for new PR opportunities when the task queue is empty. After handling or creating any PR, return to event_task.json and continue the queue.",
  ].join("\n");
}
function normalizeConfiguredLogin(value) {
  const login = String(value || "").trim();
  if (!login || login === "YOUR_GITHUB_LOGIN" || /^<.*>$/.test(login)) {
    return "";
  }
  return login;
}

function normalizeReadyToMergeReviewMode(value, source = "readyToMergeReviewMode") {
  const mode = String(value || "").trim();
  if (!mode) {
    return "";
  }
  if (!READY_TO_MERGE_REVIEW_MODES.has(mode)) {
    throw new Error(
      `Invalid ${source}: ${mode}. Expected one of: ${[...READY_TO_MERGE_REVIEW_MODES].join(", ")}`,
    );
  }
  return mode;
}

function loadAgentConfig() {
  const config = {
    contributorLogin: normalizeConfiguredLogin(process.env.PR_AGENT_CONTRIBUTOR_LOGIN),
    readyToMergeReviewMode: normalizeReadyToMergeReviewMode(
      process.env.PR_AGENT_READY_TO_MERGE_REVIEW_MODE,
      "PR_AGENT_READY_TO_MERGE_REVIEW_MODE",
    ),
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const localConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      if (!config.contributorLogin) {
        config.contributorLogin = normalizeConfiguredLogin(localConfig.contributorLogin);
      }
      if (!config.readyToMergeReviewMode) {
        config.readyToMergeReviewMode = normalizeReadyToMergeReviewMode(localConfig.readyToMergeReviewMode);
      }
    } catch (error) {
      throw new Error(`无法读取 ${path.basename(CONFIG_FILE)}: ${error.message}`);
    }
  }

  return config;
}

function requireContributorLogin() {
  if (CONTRIBUTOR_LOGIN) {
    return CONTRIBUTOR_LOGIN;
  }
  throw new Error(
    `缺少 contributorLogin。请复制 ${path.basename(CONFIG_EXAMPLE_FILE)} 为 ${path.basename(CONFIG_FILE)} 并填写 GitHub 登录名，或设置 PR_AGENT_CONTRIBUTOR_LOGIN。`,
  );
}

function parseOwnerRepoFromRepositoryUrl(repositoryUrl) {
  const prefix = "https://api.github.com/repos/";
  const value = String(repositoryUrl || "");
  return value.startsWith(prefix) ? value.slice(prefix.length) : "";
}

function isOwnRepository(ownerRepo) {
  if (!CONTRIBUTOR_LOGIN) {
    return false;
  }
  const owner = String(ownerRepo || "").split("/")[0];
  return owner.toLowerCase() === CONTRIBUTOR_LOGIN.toLowerCase();
}

function parseOwnerRepoFromPrKey(prKey) {
  const match = String(prKey || "").match(/^([^#]+)#\d+$/);
  return match ? match[1] : "";
}

function isOwnRepositoryPrKey(prKey) {
  const ownerRepo = parseOwnerRepoFromPrKey(prKey);
  return Boolean(ownerRepo) && isOwnRepository(ownerRepo);
}

function shouldTrackOpenPrSearchItem(item) {
  if (!item || !item.repository_url || item.number == null) {
    return false;
  }
  const ownerRepo = parseOwnerRepoFromRepositoryUrl(item.repository_url);
  return Boolean(ownerRepo) && !isOwnRepository(ownerRepo);
}

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
      case "--no-show-thinking":
        config.showThinking = false;
        break;
      case "--show-raw-events":
        config.showRawEvents = true;
        break;
      case "--show-tool-results":
        config.showToolResults = true;
        break;
      case "--no-show-tool-results":
        config.showToolResults = false;
        break;
      case "--enable-event-listener":
        config.enableEventListener = true;
        break;
      case "--no-event-listener":
        config.enableEventListener = false;
        break;
      case "--event-poll-interval":
        config.eventPollIntervalMs = requireInt(argv, ++index, current);
        break;
      case "--ready-to-merge-review-mode":
        config.readyToMergeReviewMode = normalizeReadyToMergeReviewMode(requireValue(argv, ++index, current), current);
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
  config.readyToMergeReviewMode = normalizeReadyToMergeReviewMode(config.readyToMergeReviewMode)
    || DEFAULT_READY_TO_MERGE_REVIEW_MODE;
  if (config.enableEventListener) {
    requireContributorLogin();
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
      "  --cwd <path>                  Claude 工作目录；event_state.json / event_task.json 固定写入 launcher 根目录",
      "  --idle-seconds <n>            连续无输出多少秒后补发提示，默认 300",
      "  --initial-delay-seconds <n>   启动后等待多久再发送首条提示，默认 8",
      "  --nudge-cooldown-seconds <n>  两次补发之间至少间隔多少秒，默认 30",
      "  --max-nudges <n>              最多补发次数，0 表示不限制，默认 0",
      "  --prompt <text>               首条提示和补发提示内容",
      "  --claude-command <cmd>        Claude 可执行命令，默认 claude.cmd / claude",
      "  --effort <mode>               思考深度：low/middle/high/xhigh/max，默认 max",
      "  --show-thinking               在终端显示主 Claude thinking 事件（默认开启）",
      "  --no-show-thinking            隐藏主 Claude thinking 事件",
      "  --show-raw-events             直接打印原始 JSON 事件",
      "  --show-tool-results           在终端显示 tool 结果（默认关闭）",
      "  --no-show-tool-results        隐藏 tool 结果",
      "  --enable-event-listener       启用 GitHub 事件监听（默认开启，轮询间隔 3600000ms）",
      "  --no-event-listener           禁用 GitHub 事件监听，只启动主 Claude 会话",
      "  --event-poll-interval <n>     事件检测间隔（毫秒），默认 3600000（1小时）",
      "  --ready-to-merge-review-mode <mode> READY_TO_MERGE review mode: require-approval / allow-no-review-required",
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

function normalizeTaskMetadataString(value, maxLength = 200) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, maxLength) : null;
}

function normalizeTaskActionability(value) {
  const normalized = normalizeTaskMetadataString(value, 80);
  if (!normalized) {
    return null;
  }
  return Object.values(TASK_ACTIONABILITY).includes(normalized) ? normalized : null;
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

function writePrefixedLines(prefix, text, stream = process.stdout) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) {
    return;
  }
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  for (const line of withoutTrailingNewline.split("\n")) {
    stream.write(`${prefix} ${line}\n`);
  }
}

function formatResultSummary(event) {
  const cost = typeof event.total_cost_usd === "number" ? event.total_cost_usd.toFixed(6) : "n/a";
  return `${event.subtype || "done"} turns=${event.num_turns ?? "?"} cost=$${cost}`;
}

function compactPreview(value, maxLength = TOOL_RESULT_PREVIEW_MAX) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else if (value == null) {
    text = "";
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return truncate(text.replace(/\r/g, "\\r").replace(/\n/g, "\\n"), maxLength);
}

function renderUserEvent(event, prefix = "", showToolResults = false) {
  const { message } = event;
  if (!message || !Array.isArray(message.content)) {
    return;
  }
  for (const item of message.content) {
    if (item.type === "text" && item.text) {
      writePrefixedLines(`${prefix}${color("[user]", "36")}`, item.text);
      continue;
    }
    if (item.type === "tool_result" && showToolResults) {
      const id = item.tool_use_id ? ` ${item.tool_use_id}` : "";
      const status = item.is_error ? " error" : "";
      const preview = compactPreview(item.content);
      process.stdout.write(`${prefix}${color("[tool-result]", "36")}${id}${status}${preview ? ` ${preview}` : ""}\n`);
    }
  }
}

function renderSystemEvent(event, prefix = "") {
  const subtype = event.subtype || "event";
  const session = event.session_id ? ` session=${event.session_id}` : "";
  process.stdout.write(`${prefix}${color("[system]", "90")} ${subtype}${session}\n`);
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

async function writeJsonFileAtomic(filePath, value) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpName = `${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const tmpPath = path.join(path.dirname(filePath), tmpName);
  try {
    await fsPromises.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsPromises.rename(tmpPath, filePath);
  } catch (error) {
    try {
      await fsPromises.unlink(tmpPath);
    } catch {
      // Best effort cleanup; preserve the original write failure.
    }
    throw error;
  }
}

async function readJsonFileIfExists(filePath) {
  try {
    return JSON.parse(await fsPromises.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readFileHashIfExists(filePath) {
  try {
    const raw = await fsPromises.readFile(filePath, "utf8");
    return createHash("sha256").update(raw).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function runtimeSignaturesEqual(left, right) {
  return Boolean(left && right && left.state === right.state && left.task === right.task);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeActivityId(value) {
  return value == null ? null : String(value);
}

function buildActivityFingerprint(activity) {
  return createHash("sha256").update(JSON.stringify({
    stream: activity?.stream || null,
    id: activity?.id != null ? String(activity.id) : null,
    createdAt: activity?.createdAt || null,
    updatedAt: activity?.updatedAt || null,
    state: activity?.state || null,
    body: activity?.body || "",
  })).digest("hex");
}

function normalizeRuntimeRevision(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

async function fileStatSummary(filePath) {
  try {
    const stat = await fsPromises.stat(filePath);
    return `path=${filePath} mtime=${stat.mtime.toISOString()} size=${stat.size}`;
  } catch (error) {
    if (error.code === "ENOENT") {
      return `path=${filePath} missing`;
    }
    return `path=${filePath} stat_error=${error.message}`;
  }
}

function buildRuntimeRevisionMismatchMessage(stateRevision, taskRevision, stateFile, taskFile, stateStat, taskStat) {
  const normalizedStateRevision = normalizeRuntimeRevision(stateRevision);
  const normalizedTaskRevision = normalizeRuntimeRevision(taskRevision);
  if (!normalizedStateRevision || !normalizedTaskRevision || normalizedStateRevision === normalizedTaskRevision) {
    return null;
  }
  return [
    `Runtime JSON revision mismatch: state=${normalizedStateRevision} task=${normalizedTaskRevision}`,
    `stateFile=${stateFile}`,
    `taskFile=${taskFile}`,
    `stateStat=${stateStat || "unknown"}`,
    `taskStat=${taskStat || "unknown"}`,
    "Stop the listener before editing runtime JSON, inspect both files, keep the newer consistent state/task pair or restore both files from backup, then make runtimeRevision match before restarting.",
  ].join(" | ");
}

function assertRuntimeRevisionCompatible(stateRevision, taskRevision) {
  const message = buildRuntimeRevisionMismatchMessage(stateRevision, taskRevision, STATE_FILE, TASK_FILE);
  if (message) {
    throw new Error(message);
  }
}

function isValidPid(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizePid(value) {
  const numberValue = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return isValidPid(numberValue) ? numberValue : null;
}

function isProcessAlive(pid) {
  const normalizedPid = normalizePid(pid);
  if (!normalizedPid) {
    return false;
  }
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function emptyCursor() {
  return {
    count: 0,
    lastId: null,
    lastCreatedAt: null,
    lastUpdatedAt: null,
    itemFingerprints: {},
  };
}

function normalizeCursor(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyCursor();
  }
  const count = Number.isInteger(raw.count) && raw.count >= 0 ? raw.count : 0;
  const itemFingerprints = raw.itemFingerprints && typeof raw.itemFingerprints === "object"
    ? Object.fromEntries(
      Object.entries(raw.itemFingerprints)
        .filter(([key, value]) => key && typeof value === "string")
        .map(([key, value]) => [String(key), value]),
    )
    : {};
  return {
    count,
    lastId: raw.lastId != null ? String(raw.lastId) : null,
    lastCreatedAt: raw.lastCreatedAt || null,
    lastUpdatedAt: raw.lastUpdatedAt || null,
    itemFingerprints,
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
    lastUpdatedAt: last && last.updatedAt ? last.updatedAt : null,
    itemFingerprints: Object.fromEntries(
      items
        .filter((item) => item && item.id != null)
        .map((item) => [String(item.id), buildActivityFingerprint(item)]),
    ),
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
    failingChecks: [],
    pendingChecks: [],
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
  normalized.failingChecks = Array.isArray(raw.failingChecks) ? cloneJson(raw.failingChecks) : [];
  normalized.pendingChecks = Array.isArray(raw.pendingChecks) ? cloneJson(raw.pendingChecks) : [];
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
    failingChecks: Array.isArray(snapshot.failingChecks) ? cloneJson(snapshot.failingChecks) : [],
    pendingChecks: Array.isArray(snapshot.pendingChecks) ? cloneJson(snapshot.pendingChecks) : [],
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

function normalizeBoundaryTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !Number.isFinite(Date.parse(trimmed))) {
    return null;
  }
  return trimmed;
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
    snapshotUpdatedAt: normalizeBoundaryTimestamp(raw.snapshotUpdatedAt),
  };
}

function boundaryRefreshRegresses(currentBoundary, nextBoundary) {
  const current = normalizeBoundary(currentBoundary);
  const next = normalizeBoundary(nextBoundary);
  const currentMs = parseTimestampMs(current.snapshotUpdatedAt);
  const nextMs = parseTimestampMs(next.snapshotUpdatedAt);
  if (!Number.isFinite(currentMs)) {
    return false;
  }
  if (!Number.isFinite(nextMs)) {
    return true;
  }
  return nextMs < currentMs;
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
  let status = String(raw.status || "").toLowerCase();
  if (TERMINAL_TASK_STATUSES.has(status)) {
    return null;
  }
  if (status !== TASK_STATUS.BLOCKED) {
    // Legacy non-blocked tasks now return to the single-Claude queue.
    status = TASK_STATUS.PENDING;
  }

  return {
    id: raw.id || randomUUID(),
    prKey: raw.prKey,
    type: raw.type,
    severity: raw.severity || TASK_EVENT_SEVERITY[raw.type] || "LIGHT",
    createdAt: raw.createdAt || now,
    status,
    blockedAt: raw.blockedAt || null,
    blockReason: raw.blockReason || null,
    blockOwner: normalizeTaskMetadataString(raw.blockOwner, 80),
    blockCategory: normalizeTaskMetadataString(raw.blockCategory, 80),
    unblockHint: normalizeTaskMetadataString(raw.unblockHint, 400),
    blockedSnapshot: raw.blockedSnapshot && typeof raw.blockedSnapshot === "object" ? cloneJson(raw.blockedSnapshot) : null,
    boundary: normalizeBoundary(raw.boundary),
    details: raw.details && typeof raw.details === "object" ? cloneJson(raw.details) : {},
  };
}

function compareStableId(left, right) {
  const leftText = left == null ? "" : String(left);
  const rightText = right == null ? "" : String(right);
  if (leftText === rightText) {
    return 0;
  }
  return leftText < rightText ? -1 : 1;
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
  return compareStableId(left.id, right.id);
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
  return normalized.endsWith("[bot]");
}

function isBotActor(activity) {
  return String(activity.authorType || "").toLowerCase() === "bot" || isBotLogin(activity.authorLogin);
}

function isMaintainerActivity(activity) {
  return MAINTAINER_ASSOCIATIONS.has(activity.authorAssociation || "NONE");
}

function isContributorActivity(activity) {
  if (!CONTRIBUTOR_LOGIN) {
    return false;
  }
  return String(activity.authorLogin || "").toLowerCase() === CONTRIBUTOR_LOGIN.toLowerCase();
}

function classifyActivityCategory(activity) {
  if (isContributorActivity(activity)) {
    return null;
  }
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

function uniqueNormalizedIds(values) {
  const ids = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = normalizeActivityId(value);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function extractBotReviewCommentIds(activities) {
  return uniqueNormalizedIds(
    (activities || [])
      .filter((activity) => activity?.stream === "review_comment" && !activity.inReplyTo && isBotActor(activity))
      .map((activity) => activity.id),
  );
}

function extractAwaitingReplyReviewCommentIds(details) {
  if (Array.isArray(details?.awaitingReplyReviewCommentIds)) {
    return uniqueNormalizedIds(details.awaitingReplyReviewCommentIds);
  }
  return extractBotReviewCommentIds(details?.activities || []);
}

function buildReviewCommentReplyResolution(snapshot, awaitingIds) {
  const awaitedIds = uniqueNormalizedIds(awaitingIds);
  const awaited = new Set(awaitedIds);
  const replied = new Set();
  for (const comment of snapshot?.reviewComments || []) {
    const parentId = normalizeActivityId(comment?.inReplyTo);
    if (parentId && awaited.has(parentId) && !isBotActor(comment)) {
      replied.add(parentId);
    }
  }
  const repliedIds = awaitedIds.filter((id) => replied.has(id));
  const unresolvedIds = awaitedIds.filter((id) => !replied.has(id));
  return {
    awaitedIds,
    repliedIds,
    unresolvedIds,
  };
}

function compareActivityChronologically(left, right) {
  const createdDelta = parseTimestampMs(left.createdAt) - parseTimestampMs(right.createdAt);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return compareStableId(left.id, right.id);
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

function createActivitySummary(activity) {
  return {
    stream: activity.stream,
    id: activity.id,
    createdAt: activity.createdAt,
    updatedAt: activity.updatedAt || null,
    authorLogin: activity.authorLogin,
    authorType: activity.authorType,
    authorAssociation: activity.authorAssociation,
    state: activity.state || null,
    inReplyTo: activity.inReplyTo || null,
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
  return compareStableId(activityId, cursorId);
}

function collectItemsAfterCursor(items, rawCursor) {
  const cursor = normalizeCursor(rawCursor);
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const combineActivities = (...groups) => {
    const seen = new Set();
    const combined = [];
    for (const group of groups) {
      for (const item of group) {
        const key = item && item.id != null ? `${item.stream || ""}:${String(item.id)}` : null;
        if (key && seen.has(key)) {
          continue;
        }
        if (key) {
          seen.add(key);
        }
        combined.push(item);
      }
    }
    return combined.sort(compareActivityChronologically);
  };
  const changedItems = [];
  for (const item of items) {
    if (!item || item.id == null) {
      continue;
    }
    const id = String(item.id);
    const previousFingerprint = cursor.itemFingerprints[id];
    if (previousFingerprint && previousFingerprint !== buildActivityFingerprint(item)) {
      changedItems.push(item);
    }
  }
  if (cursor.lastId != null) {
    const cursorIndex = items.findIndex((item) => String(item.id) === cursor.lastId);
    if (cursorIndex >= 0) {
      return combineActivities(
        changedItems.filter((item) => items.indexOf(item) <= cursorIndex),
        items.slice(cursorIndex + 1),
      );
    }
  }
  if (cursor.lastCreatedAt || cursor.lastId != null) {
    return combineActivities(
      changedItems,
      items.filter((item) => compareActivityToCursor(item, cursor) > 0),
    );
  }
  const start = Math.min(cursor.count, items.length);
  return combineActivities(
    changedItems.filter((item) => items.indexOf(item) < start),
    items.slice(start),
  );
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

function isNeedsRebaseFromRaw(raw) {
  const mergeStateStatus = raw.mergeStateStatus || null;
  const mergeable = raw.mergeable || null;
  return mergeStateStatus === "BEHIND" || mergeStateStatus === "DIRTY" || mergeable === "CONFLICTING";
}

function isReviewSatisfiedForReadyToMerge(raw, reviewMode = DEFAULT_READY_TO_MERGE_REVIEW_MODE) {
  if (raw.reviewDecision === "APPROVED") {
    return true;
  }
  return reviewMode === "allow-no-review-required" && raw.reviewDecision === null;
}

function isReadyToMergeFromRaw(raw, options = {}) {
  const reviewMode = normalizeReadyToMergeReviewMode(options.readyToMergeReviewMode)
    || DEFAULT_READY_TO_MERGE_REVIEW_MODE;
  return !raw.isDraft
    && isReviewSatisfiedForReadyToMerge(raw, reviewMode)
    && raw.statusCheckState === "SUCCESS"
    && raw.mergeable === "MERGEABLE"
    && Number(raw.unresolvedReviewThreadCount || 0) === 0;
}

function parseValidTimestampMs(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasNoOutstandingPrIssues(raw) {
  return !raw.isDraft
    && raw.statusCheckState !== "FAILED"
    && raw.statusCheckState !== "PENDING"
    && raw.reviewDecision !== "CHANGES_REQUESTED"
    && !isNeedsRebaseFromRaw(raw)
    && raw.mergeable !== "CONFLICTING"
    && Number(raw.unresolvedReviewThreadCount || 0) === 0;
}

function hasObservedPrSnapshot(observed) {
  return parseValidTimestampMs(observed?.updatedAt) != null;
}

function isTaskTriggerActive(type, snapshot) {
  if (!snapshot) {
    return false;
  }
  if (type === "CI_FAILURE") {
    return snapshot.statusCheckState === "FAILED";
  }
  if (type === "REVIEW_CHANGES_REQUESTED") {
    return snapshot.reviewDecision === "CHANGES_REQUESTED";
  }
  if (type === "NEEDS_REBASE") {
    return isNeedsRebaseFromRaw(snapshot);
  }
  return false;
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function stateBackedTriggerAlreadyHandled(type, snapshot, baseline) {
  if (!isTaskTriggerActive(type, snapshot) || !baseline) {
    return false;
  }
  const baselineUpdatedAtMs = parseValidTimestampMs(baseline.updatedAt);
  if (!baselineUpdatedAtMs) {
    return false;
  }
  if (baseline.headSha && snapshot.headSha && baseline.headSha !== snapshot.headSha) {
    return false;
  }
  if (type === "CI_FAILURE") {
    return baseline.statusCheckState === snapshot.statusCheckState
      && stableJson(baseline.failingChecks) === stableJson(snapshot.failingChecks || [])
      && stableJson(baseline.pendingChecks) === stableJson(snapshot.pendingChecks || []);
  }
  if (type === "REVIEW_CHANGES_REQUESTED") {
    return baseline.reviewDecision === snapshot.reviewDecision;
  }
  if (type === "NEEDS_REBASE") {
    return baseline.mergeStateStatus === snapshot.mergeStateStatus
      && baseline.mergeable === snapshot.mergeable
      && baseline.isDraft === snapshot.isDraft
      && Number(baseline.unresolvedReviewThreadCount || 0) === Number(snapshot.unresolvedReviewThreadCount || 0);
  }
  return false;
}

function describeActiveTaskTrigger(type, snapshot) {
  const parts = [`post_success_trigger_still_active:${type}`];
  if (snapshot?.headSha) {
    parts.push(`head=${snapshot.headSha}`);
  }
  if (type === "CI_FAILURE") {
    const checks = (snapshot.failingChecks || [])
      .map((check) => check.label || check.name || "unknown")
      .join(",");
    parts.push(`statusCheckState=${snapshot.statusCheckState || "unknown"}`);
    if (checks) {
      parts.push(`failingChecks=${checks}`);
    }
  } else if (type === "REVIEW_CHANGES_REQUESTED") {
    parts.push(`reviewDecision=${snapshot.reviewDecision || "unknown"}`);
  } else if (type === "NEEDS_REBASE") {
    parts.push(`mergeStateStatus=${snapshot.mergeStateStatus || "unknown"}`);
    parts.push(`mergeable=${snapshot.mergeable || "unknown"}`);
  }
  return parts.join(" ");
}

function buildStateBackedTaskDetails(type, snapshot) {
  if (type === "CI_FAILURE") {
    return buildTaskDetails(type, snapshot, {
      failingChecks: snapshot.failingChecks,
    });
  }
  if (type === "REVIEW_CHANGES_REQUESTED") {
    return buildTaskDetails(type, snapshot, {
      reviewDecision: snapshot.reviewDecision,
    });
  }
  if (type === "NEEDS_REBASE") {
    return buildTaskDetails(type, snapshot, {
      mergeStateStatus: snapshot.mergeStateStatus,
      mergeable: snapshot.mergeable,
    });
  }
  return buildTaskDetails(type, snapshot);
}

function flattenClassificationText(value) {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(flattenClassificationText).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value).map(flattenClassificationText).join(" ");
  }
  return String(value);
}

function textIncludesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function stateBackedBlockCategory(type) {
  if (type === "CI_FAILURE") {
    return "ci";
  }
  if (type === "REVIEW_CHANGES_REQUESTED") {
    return "review";
  }
  if (type === "NEEDS_REBASE") {
    return "merge";
  }
  return "state";
}

function buildBlockedSnapshot(type, snapshot) {
  const blockedSnapshot = {
    snapshotUpdatedAt: snapshot?.updatedAt || null,
    headSha: snapshot?.headSha || null,
  };
  if (type === "CI_FAILURE") {
    blockedSnapshot.statusCheckState = snapshot?.statusCheckState || null;
    blockedSnapshot.failingChecks = summarizeCheckLabels(snapshot?.failingChecks || []);
  } else if (type === "REVIEW_CHANGES_REQUESTED") {
    blockedSnapshot.reviewDecision = snapshot?.reviewDecision || null;
    blockedSnapshot.reviewCursor = cloneJson(snapshot?.reviewCursor || emptyCursor());
    blockedSnapshot.reviewCommentCursor = cloneJson(snapshot?.reviewCommentCursor || emptyCursor());
  } else if (type === "NEEDS_REBASE") {
    blockedSnapshot.mergeStateStatus = snapshot?.mergeStateStatus || null;
    blockedSnapshot.mergeable = snapshot?.mergeable || null;
  }
  return blockedSnapshot;
}

function buildActionabilityResult(type, actionability, {
  shouldBlock = false,
  blockReason = null,
  blockOwner = null,
  blockCategory = stateBackedBlockCategory(type),
  unblockHint = null,
} = {}) {
  return {
    type,
    actionability,
    shouldBlock,
    blockReason: blockReason || "state-trigger-still-active",
    blockOwner,
    blockCategory,
    unblockHint,
  };
}

function buildBlockMetadataFromActionability(actionability, snapshot) {
  return {
    actionability: actionability.actionability,
    blockOwner: actionability.blockOwner,
    blockCategory: actionability.blockCategory,
    unblockHint: actionability.unblockHint,
    blockedSnapshot: buildBlockedSnapshot(actionability.type, snapshot),
  };
}

function hasActionableMaintainerReviewActivity(snapshot) {
  const reviewComments = Array.isArray(snapshot?.reviewComments) ? snapshot.reviewComments : [];
  const reviews = Array.isArray(snapshot?.reviews) ? snapshot.reviews : [];
  if (reviewComments.some((activity) => classifyActivityCategory(activity) === "maintainer")) {
    return true;
  }
  return reviews.some((activity) => (
    classifyActivityCategory(activity) === "maintainer"
    && String(activity.state || "").toUpperCase() === "CHANGES_REQUESTED"
  ));
}

function classifyCiFailureActionability(snapshot) {
  const failingChecks = Array.isArray(snapshot?.failingChecks) ? snapshot.failingChecks : [];
  const text = flattenClassificationText(failingChecks).toLowerCase();
  const contributorPatterns = [
    "dco",
    "developer certificate",
    "contributor statement",
    "signed-off-by",
    "signoff",
    "sign-off",
    "signature",
    "contributor license agreement",
    "license agreement",
  ];
  const maintainerPatterns = [
    "label pr",
    "required label",
    "label required",
    "permission",
    "resource not accessible by integration",
    "forbidden",
    "not authorized",
    "github token",
    "token permission",
    "missing secret",
    "repository secret",
    "secrets not available",
    "secret unavailable",
    "workflow permission",
  ];
  const infraPatterns = [
    "service unavailable",
    "external service",
    "infrastructure",
    "runner unavailable",
    "capacity",
    "rate limit",
  ];
  const agentPatterns = [
    "lint",
    "eslint",
    "prettier",
    "format",
    "test",
    "unit",
    "integration",
    "build",
    "typecheck",
    "type check",
    "typescript",
    "tsc",
    "compile",
    "pytest",
    "mypy",
    "ruff",
    "cargo",
    "go test",
    "npm",
    "pnpm",
    "yarn",
  ];

  if (textIncludesAny(text, contributorPatterns)) {
    return buildActionabilityResult("CI_FAILURE", TASK_ACTIONABILITY.NEEDS_CONTRIBUTOR_ACTION, {
      shouldBlock: true,
      blockReason: "needs-contributor-action",
      blockOwner: "contributor",
      unblockHint: "Contributor must update commits, PR metadata, or required attestations and push a new head SHA.",
    });
  }
  if (textIncludesAny(text, maintainerPatterns)) {
    return buildActionabilityResult("CI_FAILURE", TASK_ACTIONABILITY.NEEDS_MAINTAINER_ACTION, {
      shouldBlock: true,
      blockReason: "needs-maintainer-action",
      blockOwner: "maintainer",
      unblockHint: "Maintainer must adjust labels, permissions, repository settings, secrets, or workflow access.",
    });
  }
  if (textIncludesAny(text, infraPatterns)) {
    return buildActionabilityResult("CI_FAILURE", TASK_ACTIONABILITY.NEEDS_INFRA_ACTION, {
      shouldBlock: true,
      blockReason: "needs-infrastructure-action",
      blockOwner: "infra",
      unblockHint: "Infrastructure or external service state must recover before automation can continue.",
    });
  }
  if (text && textIncludesAny(text, agentPatterns)) {
    return buildActionabilityResult("CI_FAILURE", TASK_ACTIONABILITY.ACTIONABLE_BY_AGENT, {
      blockOwner: "automation",
    });
  }
  return buildActionabilityResult("CI_FAILURE", TASK_ACTIONABILITY.UNKNOWN, {
    blockOwner: "automation",
    unblockHint: "Automation may inspect the latest CI logs once; if still active after handling, keep the task blocked.",
  });
}

function classifyStateBackedActionability(type, snapshot) {
  if (!isTaskTriggerActive(type, snapshot)) {
    return buildActionabilityResult(type, TASK_ACTIONABILITY.NOT_ACTIONABLE, {
      blockReason: "state-trigger-cleared",
      blockOwner: "automation",
    });
  }
  if (type === "CI_FAILURE") {
    return classifyCiFailureActionability(snapshot);
  }
  if (type === "REVIEW_CHANGES_REQUESTED") {
    if (hasActionableMaintainerReviewActivity(snapshot)) {
      return buildActionabilityResult(type, TASK_ACTIONABILITY.ACTIONABLE_BY_AGENT, {
        blockOwner: "automation",
      });
    }
    return buildActionabilityResult(type, TASK_ACTIONABILITY.NEEDS_MAINTAINER_ACTION, {
      shouldBlock: true,
      blockReason: "needs-maintainer-review-decision-change",
      blockOwner: "maintainer",
      unblockHint: "Maintainer must update the review decision or leave actionable review comments.",
    });
  }
  if (type === "NEEDS_REBASE") {
    return buildActionabilityResult(type, TASK_ACTIONABILITY.NEEDS_CONTRIBUTOR_ACTION, {
      shouldBlock: true,
      blockReason: "needs-contributor-rebase",
      blockOwner: "contributor",
      unblockHint: "Contributor must rebase, merge the base branch, or push a refreshed head commit.",
    });
  }
  return buildActionabilityResult(type, TASK_ACTIONABILITY.UNKNOWN, {
    blockOwner: "automation",
  });
}

function classifyBlockedTaskReason(type, snapshot) {
  return classifyStateBackedActionability(type, snapshot).blockReason;
}

function checkLabelForSummary(check) {
  return check?.label || check?.name || check?.workflowName || "unknown";
}

function summarizeCheckLabels(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    return "";
  }
  return checks.map(checkLabelForSummary).join(",");
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

function normalizeGhProxyMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (!mode) {
    return GH_PROXY_MODE_INHERIT;
  }
  if (mode === GH_PROXY_MODE_INHERIT || mode === GH_PROXY_MODE_DIRECT) {
    return mode;
  }
  throw new Error(`Invalid PR_AGENT_GH_PROXY_MODE: ${value}. Expected one of: ${GH_PROXY_MODE_INHERIT}, ${GH_PROXY_MODE_DIRECT}`);
}

function buildGhCommandEnv(baseEnv = process.env) {
  const sourceEnv = baseEnv || process.env;
  const mode = normalizeGhProxyMode(sourceEnv.PR_AGENT_GH_PROXY_MODE || process.env.PR_AGENT_GH_PROXY_MODE);
  if (mode === GH_PROXY_MODE_INHERIT) {
    return baseEnv && baseEnv !== process.env ? { ...sourceEnv } : undefined;
  }
  const env = { ...sourceEnv, PR_AGENT_GH_PROXY_MODE: GH_PROXY_MODE_DIRECT };
  for (const key of GH_PROXY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function isNonRetryableGhCommandError(error) {
  const body = `${error?.message || ""} ${error?.stderr || ""}`;
  return error?.code === "ECOMMAND" && /404|410|not found|could not resolve/i.test(body);
}

function isTransientGhCommandError(error) {
  if (!error || isNonRetryableGhCommandError(error)) {
    return false;
  }
  if (error.code === "ETIMEDOUT" || error.timedOut === true) {
    return true;
  }
  const body = `${error.message || ""} ${error.stderr || ""}`;
  return /\bEOF\b|TLS handshake|SSL\/TLS|schannel|connection reset|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|temporarily unavailable|socket hang up/i.test(body);
}

function classifyGhCommand(args) {
  if (args[0] === "pr" && args[1] === "view") {
    return "pr_view";
  }
  if (args[0] === "api" && args[1] === "graphql") {
    return "graphql";
  }
  if (args[0] === "api") {
    return "rest";
  }
  return "gh";
}

class GhCommandRunner {
  constructor(runCommand = runCommandWithTimeout, options = {}) {
    this.runCommand = runCommand;
    this.maxAttempts = options.maxAttempts || GH_TRANSIENT_RETRY_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? GH_TRANSIENT_RETRY_DELAY_MS;
    this._queue = Promise.resolve();
  }

  run(args, options = {}) {
    const commandKind = options.commandKind || classifyGhCommand(args);
    const task = this._queue.then(() => this._runWithRetries(args, {
      ...options,
      commandKind,
    }));
    this._queue = task.catch(() => {});
    return task;
  }

  async _runWithRetries(args, options) {
    const maxAttempts = options.maxAttempts || this.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runCommand("gh", args, {
          timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
          cwd: options.cwd,
          env: buildGhCommandEnv(options.env || process.env),
        });
      } catch (error) {
        error.ghAttempt = attempt;
        error.ghCommandKind = options.commandKind;
        if (attempt >= maxAttempts || !isTransientGhCommandError(error)) {
          throw error;
        }
        if (this.retryDelayMs > 0) {
          await sleep(this.retryDelayMs);
        }
      }
    }
    throw new Error("unreachable gh retry state");
  }
}

const defaultGhCommandRunner = new GhCommandRunner();

function runGhCommand(args, options = {}) {
  return (options.ghRunner || defaultGhCommandRunner).run(args, options);
}

async function ghApiJson(endpoint, options = {}) {
  const { stdout } = await runGhCommand(["api", endpoint], {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
    env: options.env,
    ghRunner: options.ghRunner,
    commandKind: "rest",
  });
  return JSON.parse(stdout);
}

async function ghPrViewJson(owner, repo, prNumber, fields, options = {}) {
  const { stdout } = await runGhCommand([
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
    env: options.env,
    ghRunner: options.ghRunner,
    commandKind: "pr_view",
  });
  return JSON.parse(stdout);
}

async function ghGraphQLJson(query, variables, options = {}) {
  const args = buildGhGraphQLArgs(query, variables);
  const { stdout } = await runGhCommand(args, {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
    env: options.env,
    ghRunner: options.ghRunner,
    commandKind: "graphql",
  });
  return JSON.parse(stdout);
}

function validateGraphQLIntVariable(key, value) {
  if (!Number.isSafeInteger(value) || value < GRAPHQL_INT_MIN || value > GRAPHQL_INT_MAX) {
    throw new Error(`GraphQL numeric variable ${key} is outside Int range`);
  }
}

function buildGhGraphQLArgs(query, variables = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables || {})) {
    if (typeof value === "number") {
      validateGraphQLIntVariable(key, value);
      args.push("-F", `${key}=${value}`);
    } else if (value == null) {
      continue;
    } else {
      args.push("-f", `${key}=${value}`);
    }
  }
  return args;
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
    updatedAt: raw.updated_at || raw.updatedAt || raw.created_at || raw.createdAt || null,
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
    updatedAt: raw.updated_at || raw.updatedAt || raw.created_at || raw.createdAt || null,
    authorAssociation: raw.author_association || raw.authorAssociation || "NONE",
    authorLogin: raw.user?.login || null,
    authorType: raw.user?.type || null,
    state: null,
    inReplyTo: raw.in_reply_to_id != null ? String(raw.in_reply_to_id) : raw.inReplyTo != null ? String(raw.inReplyTo) : null,
    body: raw.body || "",
    url: raw.html_url || raw.url || null,
  };
}

function normalizeReview(raw) {
  return {
    stream: "review",
    id: raw.id != null ? String(raw.id) : raw.node_id || raw.url || randomUUID(),
    createdAt: raw.submitted_at || raw.submittedAt || raw.created_at || raw.createdAt || null,
    updatedAt: raw.submitted_at || raw.submittedAt || raw.updated_at || raw.updatedAt || raw.created_at || raw.createdAt || null,
    authorAssociation: raw.author_association || raw.authorAssociation || "NONE",
    authorLogin: raw.user?.login || null,
    authorType: raw.user?.type || null,
    state: raw.state || null,
    body: raw.body || "",
    url: raw.html_url || raw.url || null,
  };
}

function statusContextLabel(item) {
  if (item.context) {
    return item.context;
  }
  if (item.workflowName && item.name) {
    return `${item.workflowName} / ${item.name}`;
  }
  return item.name || item.__typename || "unknown";
}

function statusCheckTimestampMs(item) {
  return parseTimestampMs(item.completedAt || item.startedAt || item.updatedAt || item.createdAt);
}

function latestStatusChecks(statusCheckRollup) {
  const latestByLabel = new Map();
  for (const [index, item] of statusCheckRollup.entries()) {
    const label = statusContextLabel(item);
    const timestamp = statusCheckTimestampMs(item);
    const existing = latestByLabel.get(label);
    if (!existing || timestamp > existing.timestamp || (timestamp === existing.timestamp && index > existing.index)) {
      latestByLabel.set(label, { item, timestamp, index });
    }
  }
  return [...latestByLabel.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.item);
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
  const currentChecks = latestStatusChecks(statusCheckRollup);

  for (const item of currentChecks) {
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
    if (FAILURE_CONCLUSIONS.has(conclusion)) {
      failingChecks.push({ label, status, conclusion });
    } else if (conclusion && !SUCCESSISH_CONCLUSIONS.has(conclusion)) {
      pendingChecks.push({ label, status: "UNKNOWN", conclusion });
    }
  }

  if (failingChecks.length > 0) {
    return {
      state: "FAILED",
      failingChecks,
      pendingChecks,
      checkCount: currentChecks.length,
    };
  }
  if (pendingChecks.length > 0) {
    return {
      state: "PENDING",
      failingChecks,
      pendingChecks,
      checkCount: currentChecks.length,
    };
  }
  return {
    state: "SUCCESS",
    failingChecks,
    pendingChecks,
    checkCount: currentChecks.length,
  };
}

async function fetchReviewThreads(owner, repo, prNumber, options = {}) {
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
    }, {
      timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
      cwd: options.cwd,
      env: options.env,
      ghRunner: options.ghRunner,
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
    "reviewRequests",
    "headRefOid",
    "headRefName",
    "baseRefName",
    "state",
    "mergedAt",
    "url",
    "updatedAt",
  ], {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
    env: options.env,
    ghRunner: options.ghRunner,
  });

  const requestOptions = {
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
    cwd: options.cwd,
    env: options.env,
    ghRunner: options.ghRunner,
  };
  const issueCommentsRaw = await fetchPaginatedArray(`repos/${owner}/${repo}/issues/${prNumber}/comments`, requestOptions);
  const reviewCommentsRaw = await fetchPaginatedArray(`repos/${owner}/${repo}/pulls/${prNumber}/comments`, requestOptions);
  const reviewsRaw = await fetchPaginatedArray(`repos/${owner}/${repo}/pulls/${prNumber}/reviews`, requestOptions);
  const reviewThreads = await fetchReviewThreads(owner, repo, prNumber, requestOptions);

  const issueComments = issueCommentsRaw.map(normalizeIssueComment).sort(compareActivityChronologically);
  const reviewComments = reviewCommentsRaw.map(normalizeReviewComment).sort(compareActivityChronologically);
  const reviews = reviewsRaw
    .map(normalizeReview)
    // Pending reviews are draft review sessions, not submitted review activity.
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
    reviewers: prView.reviewRequests || [],
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
  constructor(options = {}) {
    this.filePath = options.filePath || STATE_FILE;
    this.prs = new Map();
    this.lastSyncAt = null;
    this.revision = null;
  }

  async load() {
    try {
      const raw = await fsPromises.readFile(this.filePath, "utf8");
      const obj = JSON.parse(raw);
      this.prs = new Map(
        Object.entries(obj.prs || {}).map(([prKey, entry]) => [prKey, normalizeStateEntry(prKey, entry)]),
      );
      this.lastSyncAt = obj.lastSyncAt || null;
      this.revision = normalizeRuntimeRevision(obj.runtimeRevision);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Failed to load ${this.filePath}: ${error.message}`);
      }
      this.prs = new Map();
      this.lastSyncAt = null;
      this.revision = null;
    }
  }

  async save(runtimeRevision = null) {
    this.revision = normalizeRuntimeRevision(runtimeRevision) || this.revision || randomUUID();
    const obj = {
      schemaVersion: RUNTIME_JSON_SCHEMA_VERSION,
      runtimeRevision: this.revision,
      prs: Object.fromEntries(this.prs),
      lastSyncAt: nowIso(),
    };
    await writeJsonFileAtomic(this.filePath, obj);
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
      entry.baseline.failingChecks = Array.isArray(snapshot.failingChecks) ? cloneJson(snapshot.failingChecks) : [];
      entry.baseline.pendingChecks = Array.isArray(snapshot.pendingChecks) ? cloneJson(snapshot.pendingChecks) : [];
      entry.baseline.headSha = snapshot.headSha;
    }

    if (task.type === "REVIEW_CHANGES_REQUESTED") {
      entry.baseline.reviewDecision = snapshot.reviewDecision;
      entry.baseline.headSha = snapshot.headSha;
      entry.baseline.commentBaselines.maintainer = normalizeCommentCursorSet(boundary);
    }

    if (MERGE_TASK_TYPES.has(task.type)) {
      entry.baseline.statusCheckState = snapshot.statusCheckState;
      entry.baseline.failingChecks = Array.isArray(snapshot.failingChecks) ? cloneJson(snapshot.failingChecks) : [];
      entry.baseline.pendingChecks = Array.isArray(snapshot.pendingChecks) ? cloneJson(snapshot.pendingChecks) : [];
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
  constructor(options = {}) {
    this.filePath = options.filePath || TASK_FILE;
    this.events = [];
    this.revision = null;
  }

  async load() {
    try {
      const raw = await fsPromises.readFile(this.filePath, "utf8");
      const obj = JSON.parse(raw);
      const rawEvents = Array.isArray(obj.events) ? obj.events : [];
      this.events = Array.isArray(obj.events)
        ? rawEvents.map(normalizeTaskRecord).filter(Boolean)
        : [];
      this.revision = normalizeRuntimeRevision(obj.runtimeRevision);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Failed to load ${this.filePath}: ${error.message}`);
      }
      this.events = [];
      this.revision = null;
    }
  }

  async save(runtimeRevision = null) {
    this.revision = normalizeRuntimeRevision(runtimeRevision) || this.revision || randomUUID();
    await writeJsonFileAtomic(this.filePath, {
      schemaVersion: RUNTIME_JSON_SCHEMA_VERSION,
      runtimeRevision: this.revision,
      events: this.events,
    });
  }

  hasTaskForPrAndType(prKey, type) {
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
      blockedAt: null,
      blockReason: null,
      blockOwner: null,
      blockCategory: null,
      unblockHint: null,
      blockedSnapshot: null,
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

  unblock(id, details, boundary) {
    const event = this.getById(id);
    if (!event) {
      return null;
    }
    event.status = TASK_STATUS.PENDING;
    event.blockedAt = null;
    event.blockReason = null;
    event.blockOwner = null;
    event.blockCategory = null;
    event.unblockHint = null;
    event.blockedSnapshot = null;
    if (details && typeof details === "object") {
      event.details = cloneJson(details);
    }
    if (boundary) {
      event.boundary = normalizeBoundary(boundary);
    }
    return event;
  }

  block(id, blockReason, details, boundary, metadata = {}) {
    const event = this.getById(id);
    if (!event) {
      return null;
    }
    const wasBlocked = event.status === TASK_STATUS.BLOCKED;
    event.status = TASK_STATUS.BLOCKED;
    event.blockReason = truncate(blockReason || "state-trigger-still-active", 400);
    event.blockedAt = wasBlocked && event.blockedAt ? event.blockedAt : nowIso();
    event.blockOwner = normalizeTaskMetadataString(metadata.blockOwner, 80);
    event.blockCategory = normalizeTaskMetadataString(metadata.blockCategory, 80);
    event.unblockHint = normalizeTaskMetadataString(metadata.unblockHint, 400);
    event.blockedSnapshot = metadata.blockedSnapshot && typeof metadata.blockedSnapshot === "object"
      ? cloneJson(metadata.blockedSnapshot)
      : null;
    if (details && typeof details === "object") {
      event.details = cloneJson(details);
    }
    if (boundary) {
      event.boundary = normalizeBoundary(boundary);
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
    config = { ...config };
    this.config = config;
    this.actionLogger = actionLogger;
    this.state = new EventState({ filePath: config.stateFile || STATE_FILE });
    this.taskManager = new EventTaskManager({ filePath: config.taskFile || TASK_FILE });
    this.intervalMs = config.eventPollIntervalMs || DEFAULTS.eventPollIntervalMs;
    this.enabled = false;
    this.loaded = false;
    this._timer = null;
    this._lockHeld = false;
    this.lockFile = config.eventListenerLockFile || EVENT_LISTENER_LOCK_FILE;
    this.fetchPrSnapshot = config.fetchPrSnapshot || fetchPrSnapshot;
    this.fetchPrTerminalStatus = config.fetchPrTerminalStatus || fetchPrTerminalStatus;
    this.snapshotRetryDelayMs = config.snapshotRetryDelayMs ?? 1000;
    this._runtimeMutationQueue = Promise.resolve();
    this.lastRefreshResult = null;
  }

  async load(options = {}) {
    if (this.loaded && !options.force) {
      return;
    }
    await this._loadRuntimeFromDisk();
  }

  async _readRuntimeSignature() {
    const [state, task] = await Promise.all([
      readFileHashIfExists(this.state.filePath),
      readFileHashIfExists(this.taskManager.filePath),
    ]);
    return { state, task };
  }

  async _loadRuntimeFromDisk(options = {}) {
    await this.state.load();
    await this.taskManager.load();
    const revisionMismatch = buildRuntimeRevisionMismatchMessage(
      this.state.revision,
      this.taskManager.revision,
      this.state.filePath,
      this.taskManager.filePath,
      await fileStatSummary(this.state.filePath),
      await fileStatSummary(this.taskManager.filePath),
    );
    if (revisionMismatch) {
      throw new Error(revisionMismatch);
    }
    this.loaded = true;
    return {};
  }

  async _saveRuntimeIfUnchanged(reason, beforeSignature) {
    const currentSignature = await this._readRuntimeSignature();
    if (!runtimeSignaturesEqual(beforeSignature, currentSignature)) {
      this.actionLogger.writeLine(
        `[${nowStamp()}] runtime_save_conflict reason=${reason} action=skip`,
      );
      return false;
    }
    await this.saveAll();
    return true;
  }

  async _withRuntimeMutation(reason, mutator, options = {}) {
    const run = async () => this._runRuntimeMutation(reason, mutator, options);
    const result = this._runtimeMutationQueue.then(run, run);
    this._runtimeMutationQueue = result.catch(() => {});
    return result;
  }

  async _runRuntimeMutation(reason, mutator, options = {}) {
    const attempts = options.attempts || 2;
    const save = options.save !== false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const beforeSignature = await this._readRuntimeSignature();
      const shouldReload = options.reload !== false
        && (this.loaded || beforeSignature.state !== "missing" || beforeSignature.task !== "missing");
      if (shouldReload) {
        await this._loadRuntimeFromDisk({ recoverRunning: false });
      }
      const result = await mutator({ attempt });
      if (!save) {
        return result;
      }
      if (result === null && options.saveOnNull !== true) {
        return result;
      }
      const currentSignature = await this._readRuntimeSignature();
      if (runtimeSignaturesEqual(beforeSignature, currentSignature)) {
        await this.saveAll();
        return result;
      }
      this.actionLogger.writeLine(
        `[${nowStamp()}] runtime_save_conflict reason=${reason} attempt=${attempt} action=${attempt < attempts ? "retry" : "skip"}`,
      );
    }
    return null;
  }

  async saveAll() {
    const runtimeRevision = randomUUID();
    try {
      await this.state.save(runtimeRevision);
    } catch (error) {
      this.actionLogger.writeLine(
        `[${nowStamp()}] runtime_save_failed file=state revision=${runtimeRevision} err=${truncate(error.message || error, 300)}`,
      );
      throw error;
    }
    try {
      await this.taskManager.save(runtimeRevision);
    } catch (error) {
      this.actionLogger.writeLine(
        `[${nowStamp()}] runtime_save_failed file=task revision=${runtimeRevision} err=${truncate(error.message || error, 300)} repair="stop listener, inspect event_state.json and event_task.json revisions, restore a consistent pair or rerun strict refresh"`,
      );
      throw error;
    }
  }

  async generateEventJson() {
    const lockAcquired = await this._acquireEventListenerLock();
    if (!lockAcquired) {
      this.lastRefreshResult = {
        ok: false,
        searchFailed: false,
        failedPrKeys: [],
        scannedPrKeys: [],
        skippedReason: "active_listener_lock",
      };
      return false;
    }
    await this.load({ force: this.loaded });
    const refreshResult = await this._refreshJsonState();
    this.lastRefreshResult = refreshResult;
    return refreshResult.ok;
  }

  async bootstrapRefresh() {
    return this.generateEventJson();
  }

  async start() {
    await this.load();
    this.enabled = true;
    this._scheduleNext();
    this.actionLogger.writeLine(`[${nowStamp()}] event_listener_start interval=${this.intervalMs}ms`);
  }

  stop() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.enabled = false;
    this._releaseEventListenerLockSync();
    this.actionLogger.writeLine(`[${nowStamp()}] event_listener_stop`);
  }

  async _acquireEventListenerLock() {
    if (this._lockHeld) {
      return true;
    }

    const metadata = {
      pid: process.pid,
      createdAt: nowIso(),
      cwd: this.config.cwd,
      command: process.argv.join(" "),
    };

    await fsPromises.mkdir(path.dirname(this.lockFile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fsPromises.open(this.lockFile, "wx");
        try {
          await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        this._lockHeld = true;
        this.actionLogger.writeLine(`[${nowStamp()}] event_listener_lock_acquired pid=${metadata.pid} file=${this.lockFile}`);
        return true;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }
      }

      let existing = null;
      let staleReason = "invalid_lock";
      try {
        existing = await readJsonFileIfExists(this.lockFile);
      } catch {
        existing = null;
      }
      const existingPid = normalizePid(existing?.pid);
      if (existingPid && isProcessAlive(existingPid)) {
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_listener_lock_active pid=${existingPid} file=${this.lockFile}`,
        );
        return false;
      }
      if (existingPid) {
        staleReason = "dead_pid";
      }
      try {
        await fsPromises.unlink(this.lockFile);
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_listener_lock_reclaimed reason=${staleReason} previous_pid=${existingPid || "unknown"} file=${this.lockFile}`,
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    this.actionLogger.writeLine(`[${nowStamp()}] event_listener_lock_retry_exhausted file=${this.lockFile}`);
    return false;
  }

  _releaseEventListenerLockSync() {
    if (!this._lockHeld) {
      return;
    }
    try {
      const existing = JSON.parse(fs.readFileSync(this.lockFile, "utf8"));
      if (normalizePid(existing?.pid) === process.pid) {
        fs.unlinkSync(this.lockFile);
        this.actionLogger.writeLine(`[${nowStamp()}] event_listener_lock_released pid=${process.pid} file=${this.lockFile}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_listener_lock_release_failed pid=${process.pid} file=${this.lockFile} err=${truncate(error.message || error, 300)}`,
        );
      }
    } finally {
      this._lockHeld = false;
    }
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
    this._runPollCycle()
      .catch((error) => {
        this.actionLogger.writeLine(`[${nowStamp()}] event_tick_error=${truncate(error.message || error, 300)}`);
      })
      .finally(() => {
        this._scheduleNext();
      });
  }

  async _runPollCycle() {
    await this.generateEventJson();
  }

  async _refreshJsonState() {
    const logPrefix = `[${nowStamp()}] event_tick`;
    let prList;
    try {
      prList = await this._fetchOpenPrList();
    } catch (error) {
      this.actionLogger.writeLine(`${logPrefix} search_failed=${truncate(error.message || error, 300)}`);
      return {
        ok: false,
        searchFailed: true,
        failedPrKeys: [],
        scannedPrKeys: [],
        skippedReason: "search_failed",
      };
    }

    const failedPrKeys = [];
    const scannedPrKeys = [];
    await this._withRuntimeMutation("refresh_json_state", async () => {
      const openPrKeys = new Set(prList.map((pr) => pr.prKey));
      await this._cleanupTerminalPrs(openPrKeys);

      for (const pr of prList) {
        let snapshot = null;
        let scanError = null;
        let scanAttempt = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          scanAttempt = attempt + 1;
          try {
            snapshot = await this.fetchPrSnapshot(pr.prKey, {
              timeoutMs: GH_TIMEOUT_MS,
            });
            break;
          } catch (error) {
            scanError = error;
            if (attempt < 2 && this.snapshotRetryDelayMs > 0) {
              await new Promise((r) => setTimeout(r, this.snapshotRetryDelayMs));
            }
          }
        }
        if (snapshot) {
          await this._scanSnapshot(snapshot);
          scannedPrKeys.push(pr.prKey);
        } else {
          failedPrKeys.push(pr.prKey);
          this.actionLogger.writeLine(
            `[${nowStamp()}] event_tick pr_scan_failed pr=${pr.prKey} attempt=${scanAttempt || "unknown"} commandKind=${scanError?.ghCommandKind || "unknown"} ghAttempt=${scanError?.ghAttempt || "unknown"} err=${truncate(scanError?.message || scanError, 300)}`,
          );
        }
      }
    });
    return {
      ok: true,
      searchFailed: false,
      failedPrKeys,
      scannedPrKeys,
      skippedReason: null,
    };
  }

  async _fetchOpenPrList() {
    const contributorLogin = requireContributorLogin();
    const items = [];
    for (let page = 1; page <= 10; page += 1) {
      const raw = await ghApiJson(appendQuery("search/issues", {
        q: `author:${contributorLogin} is:pr state:open`,
        per_page: PER_PAGE,
        page,
        sort: "updated",
      }), {
        timeoutMs: GH_TIMEOUT_MS,
      });
      const pageItems = Array.isArray(raw.items) ? raw.items : [];
      items.push(...pageItems);
      if (pageItems.length < PER_PAGE) {
        break;
      }
    }
    return items
      .filter(shouldTrackOpenPrSearchItem)
      .map((item) => {
        const ownerRepo = parseOwnerRepoFromRepositoryUrl(item.repository_url);
        return {
          ownerRepo,
          prKey: `${ownerRepo}#${item.number}`,
          number: item.number,
        };
      });
  }

  _removeTrackedPr(prKey, reason, logEvent = "tracked_pr_removed") {
    const removedTaskCount = this.taskManager.removeByPrKey(prKey);
    this.state.remove(prKey);
    this.actionLogger.writeLine(
      `[${nowStamp()}] ${logEvent} pr=${prKey} reason=${reason} tasks=${removedTaskCount}`,
    );
  }

  async _cleanupTerminalPrs(openPrKeys) {
    const trackedPrKeys = new Set([
      ...this.state.keys(),
      ...this.taskManager.getAllPrKeys(),
    ]);

    for (const prKey of trackedPrKeys) {
      if (openPrKeys.has(prKey)) {
        continue;
      }
      try {
        if (isOwnRepositoryPrKey(prKey)) {
          this._removeTrackedPr(prKey, "ignored_own_repository");
          continue;
        }
        const terminalStatus = await this.fetchPrTerminalStatus(prKey);
        if (!terminalStatus.terminal) {
          continue;
        }
        this._removeTrackedPr(prKey, terminalStatus.reason, "terminal_pr_removed");
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

    if (
      isTaskTriggerActive("CI_FAILURE", snapshot)
      && !stateBackedTriggerAlreadyHandled("CI_FAILURE", snapshot, baseline)
    ) {
      candidateTasks.set("CI_FAILURE", {
        type: "CI_FAILURE",
        severity: TASK_EVENT_SEVERITY.CI_FAILURE,
        boundary: fullBoundary,
        details: buildStateBackedTaskDetails("CI_FAILURE", snapshot),
        actionability: classifyStateBackedActionability("CI_FAILURE", snapshot),
      });
    }

    if (
      isTaskTriggerActive("REVIEW_CHANGES_REQUESTED", snapshot)
      && !stateBackedTriggerAlreadyHandled("REVIEW_CHANGES_REQUESTED", snapshot, baseline)
    ) {
      candidateTasks.set("REVIEW_CHANGES_REQUESTED", {
        type: "REVIEW_CHANGES_REQUESTED",
        severity: TASK_EVENT_SEVERITY.REVIEW_CHANGES_REQUESTED,
        boundary: buildBoundaryFromCategorySnapshot(snapshot, "maintainer"),
        details: buildStateBackedTaskDetails("REVIEW_CHANGES_REQUESTED", snapshot),
        actionability: classifyStateBackedActionability("REVIEW_CHANGES_REQUESTED", snapshot),
      });
    }

    for (const category of COMMENT_CATEGORIES) {
      const activities = collectNewActivities(snapshot, baseline.commentBaselines[category], category);
      if (activities.items.length === 0) {
        continue;
      }
      const type = COMMENT_TASK_TYPE_BY_CATEGORY[category];
      const activitySummaries = activities.items.map(createActivitySummary);
      const latestActivity = createActivitySummary(activities.items[activities.items.length - 1]);
      const extraDetails = {
        activities: activitySummaries,
        activityCount: activities.items.length,
        streamCounts: activities.counts,
        latestActivity,
      };
      if (type === "BOT_COMMENT") {
        const awaitingReplyReviewCommentIds = extractBotReviewCommentIds(activities.items);
        extraDetails.awaitingReplyReviewCommentIds = awaitingReplyReviewCommentIds;
        extraDetails.replyResolution = buildReviewCommentReplyResolution(snapshot, awaitingReplyReviewCommentIds);
      }
      candidateTasks.set(type, {
        type,
        severity: TASK_EVENT_SEVERITY[type],
        boundary: buildBoundaryFromCategorySnapshot(snapshot, category),
        details: buildTaskDetails(type, snapshot, extraDetails),
      });
    }

    const currentNeedsRebase = isNeedsRebaseFromRaw(snapshot);
    if (currentNeedsRebase && !stateBackedTriggerAlreadyHandled("NEEDS_REBASE", snapshot, baseline)) {
      candidateTasks.set("NEEDS_REBASE", {
        type: "NEEDS_REBASE",
        severity: TASK_EVENT_SEVERITY.NEEDS_REBASE,
        boundary: fullBoundary,
        details: buildStateBackedTaskDetails("NEEDS_REBASE", snapshot),
        actionability: classifyStateBackedActionability("NEEDS_REBASE", snapshot),
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
      if (boundaryRefreshRegresses(primary.boundary, candidate.boundary)) {
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_boundary_regressed pr=${snapshot.prKey} type=${primary.type} task=${primary.id} current=${primary.boundary?.snapshotUpdatedAt || "none"} candidate=${candidate.boundary?.snapshotUpdatedAt || "none"}`,
        );
        candidateTasks.delete(type);
        continue;
      }
      const previousTaskResult = primary.status === TASK_STATUS.BLOCKED ? primary.details?.taskResult : null;
      const previousDetails = primary.details;
      const boundaryAdvanced = parseTimestampMs(candidate.boundary?.snapshotUpdatedAt) > parseTimestampMs(primary.boundary?.snapshotUpdatedAt);
      primary.details = cloneJson(candidate.details);
      if (previousTaskResult) {
        primary.details.taskResult = cloneJson(previousTaskResult);
      }
      primary.boundary = normalizeBoundary(candidate.boundary);
      if (primary.type === "BOT_COMMENT") {
        const awaitingReplyReviewCommentIds = extractAwaitingReplyReviewCommentIds(primary.details);
        const fallbackAwaitingIds = extractAwaitingReplyReviewCommentIds(previousDetails);
        const replyResolution = buildReviewCommentReplyResolution(
          snapshot,
          awaitingReplyReviewCommentIds.length > 0 ? awaitingReplyReviewCommentIds : fallbackAwaitingIds,
        );
        primary.details.awaitingReplyReviewCommentIds = replyResolution.awaitedIds;
        primary.details.replyResolution = replyResolution;
        if (replyResolution.awaitedIds.length > 0 && replyResolution.unresolvedIds.length === 0) {
          this.state.applyTaskSuccess(primary, snapshot);
          this.taskManager.remove(primary.id);
          this.actionLogger.writeLine(
            `[${nowStamp()}] event_reconciled_resolved pr=${snapshot.prKey} type=${primary.type} task=${primary.id} reason=bot_review_comments_replied replied=${replyResolution.repliedIds.length}`,
          );
          candidateTasks.delete(type);
          continue;
        }
      }
      if (candidate.actionability?.shouldBlock) {
        const wasBlocked = primary.status === TASK_STATUS.BLOCKED;
        this.taskManager.block(
          primary.id,
          candidate.actionability.blockReason,
          primary.details,
          primary.boundary,
          buildBlockMetadataFromActionability(candidate.actionability, snapshot),
        );
        this.actionLogger.writeLine(
          `[${nowStamp()}] ${wasBlocked ? "event_blocked_task_refreshed" : "event_task_blocked"} pr=${snapshot.prKey} type=${primary.type} task=${primary.id} blockReason=${candidate.actionability.blockReason} blockOwner=${candidate.actionability.blockOwner || "unknown"}`,
        );
        candidateTasks.delete(type);
        continue;
      }
      if (primary.status === TASK_STATUS.BLOCKED && STATE_BACKED_TASK_TYPES.has(primary.type)) {
        if (previousTaskResult && !boundaryAdvanced) {
          this.actionLogger.writeLine(
            `[${nowStamp()}] event_blocked_task_refreshed pr=${snapshot.prKey} type=${primary.type} task=${primary.id} blockReason=${primary.blockReason || "state-trigger-still-active"}`,
          );
          candidateTasks.delete(type);
          continue;
        }
        this.taskManager.unblock(primary.id, candidate.details, candidate.boundary);
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_task_unblocked pr=${snapshot.prKey} type=${primary.type} task=${primary.id} actionability=${candidate.actionability?.actionability || TASK_ACTIONABILITY.UNKNOWN}`,
        );
        candidateTasks.delete(type);
        continue;
      }
      this.actionLogger.writeLine(
        `[${nowStamp()}] event_reconciled_refreshed pr=${snapshot.prKey} type=${primary.type} task=${primary.id} status=${primary.status}`,
      );
      candidateTasks.delete(type);
    }

    for (const event of candidateTasks.values()) {
      if (event.type === "BOT_COMMENT") {
        const replyResolution = buildReviewCommentReplyResolution(
          snapshot,
          extractAwaitingReplyReviewCommentIds(event.details),
        );
        if (replyResolution.awaitedIds.length > 0 && replyResolution.unresolvedIds.length === 0) {
          this.state.applyTaskSuccess({
            prKey: snapshot.prKey,
            type: event.type,
            boundary: event.boundary,
          }, snapshot);
          this.actionLogger.writeLine(
            `[${nowStamp()}] event_reconciled_resolved pr=${snapshot.prKey} type=${event.type} task=none reason=bot_review_comments_replied replied=${replyResolution.repliedIds.length}`,
          );
          continue;
        }
      }
      if (this.taskManager.hasTaskForPrAndType(snapshot.prKey, event.type)) {
        this.actionLogger.writeLine(`[${nowStamp()}] event_deduped pr=${snapshot.prKey} type=${event.type}`);
        continue;
      }
      const task = this.taskManager.add(snapshot.prKey, event.type, event.severity, event.details, event.boundary);
      if (event.actionability?.shouldBlock) {
        this.taskManager.block(
          task.id,
          event.actionability.blockReason,
          event.details,
          event.boundary,
          buildBlockMetadataFromActionability(event.actionability, snapshot),
        );
        this.actionLogger.writeLine(
          `[${nowStamp()}] event_task_blocked pr=${snapshot.prKey} type=${task.type} task=${task.id} blockReason=${event.actionability.blockReason} blockOwner=${event.actionability.blockOwner || "unknown"}`,
        );
        continue;
      }
      this.actionLogger.writeLine(`[${nowStamp()}] event_added pr=${snapshot.prKey} type=${task.type} severity=${task.severity}`);
    }

    if (
      snapshot.statusCheckState === "SUCCESS"
      && observed.statusCheckState
      && observed.statusCheckState !== "SUCCESS"
    ) {
      this.actionLogger.writeLine(`[${nowStamp()}] event_info pr=${snapshot.prKey} type=CI_PASSED`);
    }

    if (
      snapshot.reviewDecision === "APPROVED"
      && observed.reviewDecision
      && observed.reviewDecision !== "APPROVED"
    ) {
      this.actionLogger.writeLine(`[${nowStamp()}] event_info pr=${snapshot.prKey} type=REVIEW_APPROVED`);
    }

    if (isReadyToMergeFromRaw(snapshot, this.config) && !isReadyToMergeFromRaw(observed, this.config)) {
      this.actionLogger.writeLine(`[${nowStamp()}] event_info pr=${snapshot.prKey} type=READY_TO_MERGE`);
    }

    this.state.setObservedSnapshot(snapshot.prKey, snapshot);
  }

}

async function refreshEventJsonOnce(options = {}, actionLogger = { writeLine() {} }) {
  const ownsListener = !options.listener;
  const listener = options.listener || new EventListener({
    cwd: path.resolve(options.cwd || DEFAULTS.cwd),
    eventPollIntervalMs: options.eventPollIntervalMs || DEFAULTS.eventPollIntervalMs,
    stateFile: options.stateFile,
    taskFile: options.taskFile,
    eventListenerLockFile: options.eventListenerLockFile,
    readyToMergeReviewMode: options.readyToMergeReviewMode || DEFAULTS.readyToMergeReviewMode,
  }, actionLogger);

  let updated = false;
  try {
    updated = await listener.bootstrapRefresh();
    const refreshResult = listener.lastRefreshResult || {};
    if (options.strict === true && refreshResult.searchFailed) {
      throw new Error("refresh failed: open PR search failed");
    }
  } finally {
    if (ownsListener) {
      listener.stop();
    }
  }
  const refreshResult = listener.lastRefreshResult || {};
  return {
    listener,
    updated,
    skippedReason: updated ? null : (refreshResult.skippedReason || "active_listener_lock"),
    searchFailed: refreshResult.searchFailed === true,
    failedPrKeys: Array.isArray(refreshResult.failedPrKeys) ? [...refreshResult.failedPrKeys] : [],
    scannedPrKeys: Array.isArray(refreshResult.scannedPrKeys) ? [...refreshResult.scannedPrKeys] : [],
  };
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
      writePrefixedLines(color("[thinking]", "90"), item.thinking);
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
  const ruleFile = path.join(cwd, "doc/pr_rule.md");

  ensureFileExists(agentFile, "AGENT.md");
  ensureFileExists(ruleFile, "doc/pr_rule.md");

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
  printInfo(`主 Claude thinking 输出: ${config.showThinking ? "开启" : "关闭"}`);

  actionLogger.writeLine(`===== bootstrap ${nowStamp()} =====`);
  actionLogger.writeLine(`cwd=${cwd}`);
  actionLogger.writeLine(`claude_command=${config.claudeCommand}`);
  actionLogger.writeLine(`effort=${config.effort}`);
  actionLogger.writeLine(`enableEventListener=${config.enableEventListener}`);
  actionLogger.writeLine(`eventPollIntervalMs=${config.eventPollIntervalMs}`);
  actionLogger.writeLine(`showThinking=${config.showThinking}`);
  actionLogger.writeLine(`readyToMergeReviewMode=${config.readyToMergeReviewMode}`);
  actionLogger.writeLine(`git_status=${gitStatus}`);
  actionLogger.writeLine(`prompt=${config.prompt}`);

  const eventListener = new EventListener({
    cwd,
    eventPollIntervalMs: config.eventPollIntervalMs,
    readyToMergeReviewMode: config.readyToMergeReviewMode,
  }, actionLogger);
  if (config.enableEventListener) {
    const refreshResult = await refreshEventJsonOnce({ listener: eventListener }, actionLogger);
    if (!refreshResult.updated) {
      throw new Error(`Event listener bootstrap skipped: ${refreshResult.skippedReason || "unknown"}`);
    }
    actionLogger.writeLine(`[${nowStamp()}] bootstrap_done`);
  } else {
    actionLogger.writeLine(`[${nowStamp()}] bootstrap_skipped reason=event_listener_disabled`);
  }

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

  if (config.enableEventListener) {
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

  const sendPrompt = (reason) => {
    if (childExited) {
      return;
    }

    const payload = createJsonUserEvent(config.prompt);
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
      } else {
        writePrefixedLines(color("[stdout]", "90"), line);
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
      process.stdout.write(`${color("[result]", "32")} ${formatResultSummary(event)}\n`);
      return;
    }

    if (event.type === "user") {
      renderUserEvent(event, "", config.showToolResults);
      return;
    }

    if (event.type === "system") {
      if (event.subtype === "init") {
        actionLogger.writeLine(`[${nowStamp()}] session_init session_id=${event.session_id || ""}`);
      }
      renderSystemEvent(event);
      return;
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
    if (config.enableEventListener) eventListener.stop();
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
    if (config.enableEventListener) eventListener.stop();
    child.kill("SIGINT");
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise((resolve, reject) => {
    child.on("close", (code) => {
      childExited = true;
      clearTimeout(initialTimer);
      clearInterval(idleTimer);
      if (config.enableEventListener) eventListener.stop();

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
    GhCommandRunner,
    TASK_ACTIONABILITY,
    TASK_EVENT_SEVERITY,
    TASK_FILE,
    TASK_STATUS,
    STATE_FILE,
    assertRuntimeRevisionCompatible,
    baselineFromSnapshot,
    buildBoundaryFromCategorySnapshot,
    buildBoundaryFromSnapshot,
    buildCommentBaselinesFromSnapshot,
    buildCommentCursorSet,
    buildCursor,
    buildDefaultPrompt,
    buildGhCommandEnv,
    buildGhGraphQLArgs,
    classifyBlockedTaskReason,
    classifyStateBackedActionability,
    classifyActivityCategory,
    classifyStatusChecks,
    compareStableId,
    collectNewActivities,
    commentCategoryForTaskType,
    compareActivityChronologically,
    createActivitySummary,
    emptyBaseline,
    emptyCommentBaselines,
    emptyCommentCursorSet,
    emptyCursor,
    hasNoOutstandingPrIssues,
    hasObservedPrSnapshot,
    isTransientGhCommandError,
    isTaskTriggerActive,
    isNeedsRebaseFromRaw,
    isReadyToMergeFromRaw,
    isOwnRepositoryPrKey,
    normalizeBaseline,
    normalizeBoundary,
    normalizeBoundaryTimestamp,
    normalizeTaskRecord,
    normalizeReviewComment,
    normalizeCommentBaselines,
    normalizeCommentCursorSet,
    parseOwnerRepoFromRepositoryUrl,
    refreshEventJsonOnce,
    shouldTrackOpenPrSearchItem,
    writeJsonFileAtomic,
  };
}
