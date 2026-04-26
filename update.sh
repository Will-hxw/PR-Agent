#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

node - <<'NODE'
"use strict";

const { refreshEventJsonOnce } = require("./run-claude-agent.js");

const logger = {
  writeLine(line) {
    process.stderr.write(`${line}\n`);
  },
};

refreshEventJsonOnce({
  cwd: process.cwd(),
  eventNotificationEnabled: false,
  strict: true,
}, logger)
  .then((result) => {
    if (result.updated) {
      process.stdout.write("event JSON updated\n");
      return;
    }
    process.stderr.write(`event JSON skipped: ${result.skippedReason || "unknown"}\n`);
    process.exitCode = 2;
  })
  .catch((error) => {
    process.stderr.write(`event JSON update failed: ${error.message || error}\n`);
    process.exitCode = 1;
  });
NODE
