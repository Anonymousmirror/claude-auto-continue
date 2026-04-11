'use strict';

const pty = require('node-pty');
const { execSync } = require('child_process');
const { RateLimitDetector } = require('./detector');
const { notify, writeStatus, clearStatus, printStatusLine } = require('./notifier');

// Default message to send when auto-resuming
const DEFAULT_CONTINUE_MSG = 'continue';

// Extra delay (ms) after reset time before sending continue,
// to ensure the rate limit has fully reset.
const RESUME_BUFFER_MS = 30_000; // 30 seconds

/**
 * Resolve the full path to the `claude` executable.
 * node-pty on Windows requires a resolvable path (not just a bare command name).
 */
function resolveClaudeCmd() {
  if (process.platform === 'win32') {
    // Try common names; `where` returns the full path on Windows.
    for (const name of ['claude.exe', 'claude.cmd', 'claude']) {
      try {
        const full = execSync(`where ${name}`, { encoding: 'utf8', timeout: 5000 })
          .split(/\r?\n/)[0]
          .trim();
        if (full) return full;
      } catch { /* not found, try next */ }
    }
    // Fallback
    return 'claude.cmd';
  }
  return 'claude';
}

/**
 * Create a transparent PTY wrapper around Claude Code.
 *
 * IMPORTANT: Claude Code uses a fullscreen Ink-based TUI with alternate
 * screen buffer. We must NEVER write to stdout or stderr ourselves —
 * it would corrupt the display. All user feedback goes through:
 *   1. Desktop notifications (toast/osascript/notify-send)
 *   2. Status file on disk (~/.claude/auto-continue/status.json)
 *
 * @param {string[]} claudeArgs - Arguments to pass to `claude`
 * @param {object}   opts
 * @param {string}   opts.continueMessage - Text to send on auto-resume
 * @param {boolean}  opts.noNotify - Suppress desktop notifications
 */
function createWrapper(claudeArgs, opts = {}) {
  const continueMsg = opts.continueMessage || DEFAULT_CONTINUE_MSG;
  const shouldNotify = !opts.noNotify;

  const claudeCmd = resolveClaudeCmd();

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  const ptyProcess = pty.spawn(claudeCmd, claudeArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const detector = new RateLimitDetector();
  let resumeTimer = null;
  let waitingForResume = false;
  let countdownInterval = null;
  let inputLineBuffer = '';

  function clearScheduledResume() {
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    waitingForResume = false;
    inputLineBuffer = '';
  }

  function scheduleResume(detection) {
    clearScheduledResume();
    waitingForResume = true;

    const waitMs = detection.msUntilReset + RESUME_BUFFER_MS;
    const resumeAt = new Date(Date.now() + waitMs);

    // For long waits (> 24h), show date; otherwise just time
    let resumeTimeStr;
    if (waitMs > 24 * 3600_000) {
      resumeTimeStr = resumeAt.toLocaleString([], {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } else {
      resumeTimeStr = resumeAt.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    // Inline status — single line, user can see it in terminal
    printStatusLine(`Rate limit detected. Will auto-resume at ${resumeTimeStr}`, '33');

    // Desktop notification
    if (shouldNotify) {
      notify(
        'Auto-Continue: Rate Limited',
        `Will auto-resume at ${resumeTimeStr}`,
      );
    }

    // Status file — persistent, checkable at any time
    writeStatus({
      state: 'waiting',
      resume_at: resumeAt.toISOString(),
      resume_at_display: resumeTimeStr,
      wait_ms: waitMs,
      detected_at: new Date().toISOString(),
    });

    // Countdown: update status file + periodic desktop notification reminders
    const countdownFreq = waitMs > 3600_000 ? 600_000 : 60_000;
    let lastNotifyRemaining = Infinity;
    countdownInterval = setInterval(() => {
      if (!waitingForResume) {
        clearInterval(countdownInterval);
        return;
      }
      const remaining = resumeAt.getTime() - Date.now();
      if (remaining > 0) {
        let timeLeft;
        if (remaining > 3600_000) {
          const hours = Math.floor(remaining / 3600_000);
          const mins = Math.ceil((remaining % 3600_000) / 60_000);
          timeLeft = `~${hours}h ${mins}m`;
        } else {
          const mins = Math.ceil(remaining / 60_000);
          timeLeft = `~${mins} min`;
        }

        // Inline countdown
        printStatusLine(`${timeLeft} until resume (${resumeTimeStr})`);

        // Update status file
        writeStatus({
          state: 'waiting',
          resume_at: resumeAt.toISOString(),
          resume_at_display: resumeTimeStr,
          remaining: timeLeft,
        });
      }
    }, countdownFreq);

    resumeTimer = setTimeout(() => {
      if (!waitingForResume) return;

      // Inline + notification
      printStatusLine('Resuming session now!', '32');
      if (shouldNotify) {
        notify('Auto-Continue: Resuming', 'Sending continue command now.');
      }
      writeStatus({ state: 'resuming' });

      // Dismiss any active menu/dialog
      ptyProcess.write('\x1b'); // ESC
      setTimeout(() => {
        ptyProcess.write('\x1b'); // ESC again (safety)
        setTimeout(() => {
          // Send the continue message
          ptyProcess.write(continueMsg + '\r');
          waitingForResume = false;
          if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
          }
          detector.reset();
          clearStatus();
        }, 300);
      }, 500);
    }, waitMs);
  }

  // ── PTY output → stdout + detection ──
  ptyProcess.onData((data) => {
    process.stdout.write(data);

    // Already handling a limit — don't re-enter detection. Prevents HUD
    // status-line re-renders from disturbing the scheduled resume.
    if (waitingForResume) return;

    const detection = detector.feed(data);
    if (detection) {
      scheduleResume(detection);
    }
  });

  // ── stdin → PTY ──
  // All input passes through unconditionally. Only "auto-continue stop" + Enter cancels.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    // Always forward input to PTY first
    ptyProcess.write(data);

    // Only track for cancel command when waiting
    if (!waitingForResume) return;

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      if (byte === 0x0d || byte === 0x0a) {
        // Enter — check if line is the cancel command
        const trimmed = inputLineBuffer.trim().toLowerCase();
        if (trimmed === 'auto-continue stop') {
          clearScheduledResume();
          clearStatus();
          printStatusLine('Auto-resume cancelled.', '36');
          if (shouldNotify) {
            notify('Auto-Continue', 'Auto-resume cancelled by user.');
          }
        }
        inputLineBuffer = '';
      } else if (byte === 0x7f || byte === 0x08) {
        // Backspace — remove last char
        inputLineBuffer = inputLineBuffer.slice(0, -1);
      } else if (byte === 0x15) {
        // Ctrl-U — clear line
        inputLineBuffer = '';
      } else if (byte === 0x17) {
        // Ctrl-W — delete last word
        inputLineBuffer = inputLineBuffer.replace(/\S+\s*$/, '');
      } else if (byte === 0x1b) {
        // ESC — skip escape sequences to avoid buffer pollution
        if (i + 1 < data.length && data[i + 1] === 0x5b) {
          i += 2; // skip ESC [
          while (i < data.length && (data[i] < 0x40 || data[i] > 0x7e)) {
            i++;
          }
        } else if (i + 1 < data.length) {
          i++; // skip ESC + next byte
        }
      } else if (byte >= 0x20 && byte < 0x7f) {
        // Printable ASCII — accumulate
        inputLineBuffer += String.fromCharCode(byte);
      }
    }
  });

  // ── Terminal resize ──
  process.stdout.on('resize', () => {
    ptyProcess.resize(
      process.stdout.columns || 80,
      process.stdout.rows || 24,
    );
  });

  // ── Process exit ──
  ptyProcess.onExit(({ exitCode, signal }) => {
    clearScheduledResume();
    clearStatus();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(exitCode ?? (signal ? 128 + signal : 0));
  });

  // ── Graceful shutdown ──
  function cleanup() {
    clearScheduledResume();
    clearStatus();
    try { ptyProcess.kill(); } catch {}
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
}

module.exports = { createWrapper };
