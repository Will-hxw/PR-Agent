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
}, logger)
  .then(() => {
    process.stdout.write("event JSON updated\n");
  })
  .catch((error) => {
    process.stderr.write(`event JSON update failed: ${error.message || error}\n`);
    process.exitCode = 1;
  });
NODE
