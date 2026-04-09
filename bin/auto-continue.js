#!/usr/bin/env node
'use strict';

const { createWrapper } = require('../src/wrapper');

// ── Parse our own flags (before --) vs Claude flags (after --) ──
const argv = process.argv.slice(2);

const ownFlags = {
  continueMessage: 'continue',
  noNotify: false,
  help: false,
};

const claudeArgs = [];
let pastSeparator = false;

for (let i = 0; i < argv.length; i++) {
  if (pastSeparator) {
    claudeArgs.push(argv[i]);
    continue;
  }

  if (argv[i] === '--') {
    pastSeparator = true;
    continue;
  }

  if (argv[i] === '--help' || argv[i] === '-h') {
    ownFlags.help = true;
  } else if (argv[i] === '--no-notify') {
    ownFlags.noNotify = true;
  } else if (argv[i] === '--message' || argv[i] === '-m') {
    ownFlags.continueMessage = argv[++i] || 'continue';
  } else {
    // Everything else goes to claude
    claudeArgs.push(argv[i]);
  }
}

if (ownFlags.help) {
  console.log(`
  claude-auto-continue - Auto-resume Claude Code on rate limit reset

  Usage:
    auto-continue [options] [-- claude-args...]
    ac [options] [-- claude-args...]

  Options:
    -h, --help        Show this help
    -m, --message     Custom message to send on resume (default: "continue")
    --no-notify       Suppress desktop notifications

  Examples:
    auto-continue                     # Start claude normally
    auto-continue -c                  # Continue last session
    auto-continue --resume my-task    # Resume a named session
    auto-continue -m "请继续之前的任务"  # Custom resume message
    ac                                # Short alias

  How it works:
    Wraps Claude Code in a transparent PTY proxy. All input/output passes
    through unchanged. When a rate-limit message is detected, it parses the
    reset time and automatically sends "continue" when the limit resets.

    - Window stays open, zero interference with Claude Code's display
    - All keyboard shortcuts, colors, and UI work normally
    - Type "auto-continue stop" + Enter to cancel auto-resume
    - Desktop notifications when rate limit is hit and when resuming
    - Status file: ~/.claude/auto-continue/status.json
`);
  process.exit(0);
}

// ── Launch ──
if (!process.stdout.isTTY) {
  console.error('Error: auto-continue requires an interactive terminal (TTY).');
  console.error('For non-interactive usage, use `claude -p` directly.');
  process.exit(1);
}

createWrapper(claudeArgs, {
  continueMessage: ownFlags.continueMessage,
  noNotify: ownFlags.noNotify,
});
