#!/usr/bin/env node
'use strict';

/**
 * StopFailure hook handler for rate_limit events.
 *
 * Called by Claude Code when a rate limit is hit.
 * Reads event JSON from stdin, parses reset time,
 * spawns a detached background process that waits
 * and then sends keystrokes to resume the session.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Read event JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0); // can't parse, ignore
  }

  // Extract useful info
  const sessionId = event.session_id || 'unknown';
  const errorDetails = event.error_details || event.error || '';
  const cwd = event.cwd || process.cwd();

  // Try to parse reset time from error_details
  // API may return retry-after seconds or a time string
  let waitMs = 5 * 60_000; // default: retry in 5 minutes

  // Check for retry-after header (seconds)
  const retryMatch = String(errorDetails).match(/retry.?after[:\s]+(\d+)/i);
  if (retryMatch) {
    waitMs = parseInt(retryMatch[1], 10) * 1000 + 30_000; // + 30s buffer
  }

  // Check for reset time like "resets 3pm" in the error message
  const resetMatch = String(errorDetails).match(
    /resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)/i
  );
  if (resetMatch) {
    const timeStr = resetMatch[1].trim();
    const tm = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
    if (tm) {
      let hours = parseInt(tm[1], 10);
      const minutes = tm[2] ? parseInt(tm[2], 10) : 0;
      const meridiem = tm[3].toLowerCase();
      if (meridiem === 'pm' && hours !== 12) hours += 12;
      if (meridiem === 'am' && hours === 12) hours = 0;

      const now = new Date();
      const target = new Date(now);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      waitMs = target.getTime() - now.getTime() + 30_000; // + 30s buffer
    }
  }

  // Check for day-of-week reset: "resets Monday"
  const dayMatch = String(errorDetails).match(
    /resets?\s+(?:on\s+)?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i
  );
  if (dayMatch) {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const targetDay = days.indexOf(dayMatch[1].toLowerCase());
    const now = new Date();
    let daysUntil = targetDay - now.getDay();
    if (daysUntil <= 0) daysUntil += 7;
    waitMs = daysUntil * 86400_000 + 30_000;
  }

  // Check for relative time: "resets in 3 days"
  const relMatch = String(errorDetails).match(
    /resets?\s+in\s+(\d+)\s*(day|hour|minute|min|hr)s?/i
  );
  if (relMatch) {
    const unitMs = { day: 86400000, hour: 3600000, hr: 3600000, minute: 60000, min: 60000 };
    waitMs = parseInt(relMatch[1], 10) * (unitMs[relMatch[2].toLowerCase()] || 60000) + 30_000;
  }

  // Cap at 7 days (for weekly limits)
  waitMs = Math.min(waitMs, 7 * 24 * 3600_000);
  // Minimum 30 seconds
  waitMs = Math.max(waitMs, 30_000);

  const resumeAt = new Date(Date.now() + waitMs);
  const resumeAtStr = resumeAt.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  // Write pending resume info for status tracking
  const stateDir = path.join(
    process.env.USERPROFILE || process.env.HOME || '/tmp',
    '.claude', 'auto-continue'
  );
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const pending = {
      session_id: sessionId,
      cwd,
      resume_at: resumeAt.toISOString(),
      wait_ms: waitMs,
      created_at: new Date().toISOString(),
      pid: process.ppid, // Claude Code's PID
    };
    fs.writeFileSync(
      path.join(stateDir, `pending-${sessionId}.json`),
      JSON.stringify(pending, null, 2)
    );
  } catch { /* best effort */ }

  // Spawn the detached waiter process
  const waiterScript = path.join(__dirname, 'wait-and-resume.js');
  const child = spawn(process.execPath, [
    waiterScript,
    '--wait-ms', String(waitMs),
    '--ppid', String(process.ppid),
    '--session-id', sessionId,
  ], {
    detached: true,
    stdio: 'ignore',
    cwd,
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();

  // Output to Claude Code: just acknowledge, don't stop the session
  const output = {
    systemMessage: `[Auto-Continue] Rate limit detected. Will auto-resume at ${resumeAtStr}.`,
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
});
