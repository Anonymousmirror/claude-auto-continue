'use strict';

/**
 * Integration test: simulates a Claude Code session hitting rate limit,
 * verifying that the wrapper detects it and sends the continue command.
 *
 * Uses a mock "claude" script (Node.js) that:
 * 1. Outputs some normal text
 * 2. Outputs a rate limit message with a reset time 2 seconds from now
 * 3. Waits for input
 * 4. Prints whatever it receives as confirmation
 */

const pty = require('node-pty');
const path = require('path');
const { RateLimitDetector } = require('../src/detector');

// Generate a reset time 3 seconds from now
const resetDate = new Date(Date.now() + 3000);
let h = resetDate.getHours();
const m = resetDate.getMinutes();
const ampm = h >= 12 ? 'pm' : 'am';
if (h > 12) h -= 12;
if (h === 0) h = 12;
const resetTimeStr = m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;

// Mock claude script
const mockScript = `
  process.stdout.write('Working on your task...\\n');
  setTimeout(() => {
    process.stdout.write("You've hit your limit \\u00b7 resets ${resetTimeStr}\\n");
    // Wait for input
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      process.stdout.write('RECEIVED: ' + d.toString().trim() + '\\n');
      setTimeout(() => process.exit(0), 500);
    });
  }, 500);
`;

console.log('Integration test: rate limit detection in PTY');
console.log(`  Reset time set to: ${resetTimeStr} (3s from now)`);
console.log('  Testing detector only (not full wrapper)...\n');

// Test 1: Detector works with PTY output stream
const detector = new RateLimitDetector();
const mockPty = pty.spawn(process.execPath, ['-e', mockScript], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
});

let detected = false;
let output = '';

mockPty.onData((data) => {
  output += data;
  const result = detector.feed(data);
  if (result && !detected) {
    detected = true;
    console.log('  \u2713 Rate limit detected in PTY output');
    console.log(`    Reset time: ${result.resetTimeStr}`);
    console.log(`    ms until reset: ${result.msUntilReset}`);

    // Simulate what the wrapper would do: wait then send continue
    setTimeout(() => {
      console.log('  \u2713 Sending "continue" to PTY...');
      mockPty.write('continue\r');
    }, 1000);
  }
});

mockPty.onExit(({ exitCode }) => {
  const receivedContinue = output.includes('RECEIVED: continue');
  console.log(`  ${receivedContinue ? '\u2713' : '\u2717'} Mock process received "continue" input`);
  console.log(`  ${detected ? '\u2713' : '\u2717'} Detection worked`);

  const passed = detected && receivedContinue;
  console.log(`\n${passed ? 'PASS' : 'FAIL'}`);
  process.exit(passed ? 0 : 1);
});

// Timeout safety
setTimeout(() => {
  console.log('  \u2717 Timed out after 15s');
  try { mockPty.kill(); } catch {}
  process.exit(1);
}, 15000);
