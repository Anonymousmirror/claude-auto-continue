'use strict';

/**
 * End-to-end demo: simulates the FULL auto-continue wrapper experience.
 *
 * A mock "claude" process:
 *   1. Pretends to work for 2s
 *   2. Outputs rate-limit message (reset in 5s)
 *   3. Waits for input
 *   4. When it receives "continue", resumes "working"
 *   5. Exits successfully
 *
 * The wrapper (src/wrapper.js logic, replicated here for demo)
 * detects the limit, waits, and auto-sends "continue".
 */

const pty = require('node-pty');
const path = require('path');
const { RateLimitDetector } = require('../src/detector');
const { notify, writeStatus, clearStatus, printStatusLine } = require('../src/notifier');

// Reset time = 2 minutes from now (a compressed simulation)
const resetDate = new Date(Date.now() + 2 * 60_000);
let h = resetDate.getHours();
const m = resetDate.getMinutes();
const ampm = h >= 12 ? 'pm' : 'am';
if (h > 12) h -= 12;
if (h === 0) h = 12;
const resetTimeStr = `${h}:${String(m).padStart(2, '0')}${ampm}`;

const RESUME_BUFFER_S = 3; // shorter buffer for demo (real: 30s)

const mockClaudeScript = `
  const readline = require('readline');

  // Phase 1: working
  process.stdout.write('\\n');
  process.stdout.write('\\x1b[1m  Claude Code\\x1b[0m v2.3.0\\n');
  process.stdout.write('\\n');

  let dots = 0;
  const work = setInterval(() => {
    dots++;
    process.stdout.write('\\x1b[36m  > Working on your task' + '.'.repeat(dots) + '\\x1b[0m\\n');
  }, 600);

  setTimeout(() => {
    clearInterval(work);
    process.stdout.write('\\n');
    process.stdout.write('\\x1b[33m  \\u26a0 You\\u2019ve hit your limit \\u00b7 resets ${resetTimeStr}\\x1b[0m\\n');
    process.stdout.write('\\n');

    // Wait for user/wrapper input
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed) {
        process.stdout.write('\\n');
        process.stdout.write('\\x1b[32m  \\u2713 Resumed! Received: "' + trimmed + '"\\x1b[0m\\n');
        process.stdout.write('\\x1b[32m  \\u2713 Continuing your task...\\x1b[0m\\n');
        process.stdout.write('\\x1b[32m  \\u2713 Task completed successfully!\\x1b[0m\\n');
        process.stdout.write('\\n');
        setTimeout(() => process.exit(0), 800);
        rl.close();
      }
    });
  }, 2000);
`;

// ── Run the demo ──

console.log('\n\x1b[1m=== Auto-Continue End-to-End Demo ===\x1b[0m');
console.log(`  Simulated reset time: ${resetTimeStr} (~2 min from now)`);
console.log(`  Buffer after reset: ${RESUME_BUFFER_S}s`);
console.log('  \x1b[90mFeedback: desktop notifications + status file only (zero terminal output)\x1b[0m\n');

const detector = new RateLimitDetector();

const mockPty = pty.spawn(process.execPath, ['-e', mockClaudeScript], {
  name: 'xterm-256color',
  cols: 70,
  rows: 24,
  cwd: process.cwd(),
});

let resumeTimer = null;
let detected = false;

mockPty.onData((data) => {
  // Pass through output (like the real wrapper does)
  process.stdout.write(data);

  const result = detector.feed(data);
  if (result && !detected) {
    detected = true;

    // Use a short buffer for demo instead of 30s
    const waitMs = Math.max(result.msUntilReset, 0) + RESUME_BUFFER_S * 1000;
    const resumeAt = new Date(Date.now() + waitMs);
    const resumeAtStr = resumeAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Single line inline status
    printStatusLine(`Rate limit detected. Will resume at ${resumeAtStr}`, '33');
    notify('Auto-Continue: Rate Limited', `Will resume at ${resumeAtStr}`);
    writeStatus({
      state: 'waiting',
      resume_at: resumeAt.toISOString(),
      resume_at_display: resumeAtStr,
    });

    // Countdown — inline + status file
    const countdownInterval = setInterval(() => {
      const remaining = (resumeAt.getTime() - Date.now()) / 1000;
      if (remaining > 0) {
        printStatusLine(`~${Math.ceil(remaining)}s until resume`);
        writeStatus({
          state: 'waiting',
          resume_at: resumeAt.toISOString(),
          remaining: `~${Math.ceil(remaining)}s`,
        });
      } else {
        clearInterval(countdownInterval);
      }
    }, 15000);

    resumeTimer = setTimeout(() => {
      clearInterval(countdownInterval);
      printStatusLine('Resuming session now!', '32');
      notify('Auto-Continue: Resuming', 'Sending continue now.');
      clearStatus();

      // ESC to dismiss menu, then send continue
      mockPty.write('\x1b');
      setTimeout(() => {
        mockPty.write('continue\r');
      }, 300);
    }, waitMs);
  }
});

mockPty.onExit(({ exitCode }) => {
  if (resumeTimer) clearTimeout(resumeTimer);
  clearStatus();
  console.log(`\x1b[1m=== Demo Complete (exit code: ${exitCode}) ===\x1b[0m\n`);
  process.exit(exitCode);
});

// Safety timeout
setTimeout(() => {
  console.error('\n  Timed out!');
  clearStatus();
  try { mockPty.kill(); } catch {}
  process.exit(1);
}, 180000);
