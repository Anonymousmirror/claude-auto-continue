'use strict';

/**
 * Rate limit detection and reset time parsing for Claude Code output.
 *
 * Known message patterns (with ANSI stripped):
 *   "You've hit your limit · resets 11pm (Asia/Shanghai)"
 *   "You've hit your limit · resets 3:30pm"
 *   "limit reached ∙ resets 2pm"
 *   "resets 11pm (Asia/Shanghai)"
 */

// Matches "resets <time>" where time is like "3pm", "11:30pm", "3:30 PM", etc.
// Optionally followed by a timezone in parentheses.
const RESET_PATTERN =
  /resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)(?:\s*\(([^)]+)\))?/i;

// Matches "resets Monday", "resets on Wednesday", etc.
const RESET_DAY_PATTERN =
  /resets?\s+(?:on\s+)?(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;

// Matches "resets in 3 days", "resets in 5 hours", "resets in 2 hours and 30 minutes", etc.
const RESET_RELATIVE_PATTERN =
  /resets?\s+in\s+(\d+)\s*(day|hour|minute|min|hr)s?(?:\s*(?:and\s*)?(\d+)\s*(hour|minute|min|hr)s?)?/i;

// Matches "resets Apr 14", "resets April 14", etc.
const RESET_DATE_PATTERN =
  /resets?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})/i;

// Matches "resets 4/14" (month/day)
const RESET_SLASH_DATE_PATTERN =
  /resets?\s+(\d{1,2})\/(\d{1,2})/i;

// Active rate-limit event phrases only. Deliberately strict so that passive
// status displays (e.g. claude-hud "weekly limit: 20% · resets Mon") do not
// match. Real Claude Code messages always include "hit your ... limit" or
// "limit reached".
const RATE_LIMIT_PATTERN =
  /hit your(?:\s+[\w-]+){0,3}\s+limit|limit reached/i;

/**
 * Strip ANSI escape sequences so regex can match against plain text.
 */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][AB012]/g, '')
            .replace(/\x1b\[[\?]?[0-9;]*[hlm]/g, '');
}

/**
 * Parse a time string like "3pm", "11:30pm", "3:30 PM" into { hours, minutes }.
 */
function parseTimeStr(timeStr) {
  const match = timeStr.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3].toLowerCase();

  if (meridiem === 'pm' && hours !== 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  return { hours, minutes };
}

/**
 * Given {hours, minutes} and an optional IANA timezone string,
 * return the next future Date when that wall-clock time occurs.
 */
function nextOccurrence(hm, tzName) {
  const now = new Date();

  // Build a "today at hm" date in the target timezone.
  // Strategy: use Intl to find the current time in that timezone,
  // then compute the delta.
  if (tzName) {
    try {
      // Get current hours/minutes in target tz
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const tzHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
      const tzMin = parseInt(parts.find(p => p.type === 'minute').value, 10);

      // Minutes from now (in tz) until target time
      const nowMins = tzHour * 60 + tzMin;
      const targetMins = hm.hours * 60 + hm.minutes;
      let deltaMins = targetMins - nowMins;
      if (deltaMins <= 0) deltaMins += 24 * 60; // next day

      return new Date(now.getTime() + deltaMins * 60_000);
    } catch {
      // Fall through to local-time logic
    }
  }

  // Fallback: use local time
  const target = new Date(now);
  target.setHours(hm.hours, hm.minutes, 0, 0);
  if (target.getTime() <= now.getTime()) {
    // Already past → assume next day
    target.setDate(target.getDate() + 1);
  }
  return target;
}

/**
 * Given a day-of-week name, return the next future Date for that weekday (midnight).
 */
function parseDayOfWeek(dayName) {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const targetDay = days.indexOf(dayName.toLowerCase());
  if (targetDay === -1) return null;

  const now = new Date();
  const currentDay = now.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil <= 0) daysUntil += 7;

  const target = new Date(now);
  target.setDate(target.getDate() + daysUntil);
  target.setHours(0, 0, 0, 0);
  return target;
}

/**
 * Convert relative time amounts + units into milliseconds.
 */
function parseRelativeTime(amount1, unit1, amount2, unit2) {
  const unitMs = { day: 86400000, hour: 3600000, hr: 3600000, minute: 60000, min: 60000 };
  let ms = parseInt(amount1, 10) * (unitMs[unit1.toLowerCase()] || 0);
  if (amount2 && unit2) {
    ms += parseInt(amount2, 10) * (unitMs[unit2.toLowerCase()] || 0);
  }
  return ms;
}

/**
 * Given a month name string and day number, return the next future Date for that calendar date.
 */
function parseMonthDate(monthStr, dayNum) {
  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };
  const month = months[monthStr.toLowerCase()];
  if (month === undefined) return null;

  const now = new Date();
  const target = new Date(now.getFullYear(), month, dayNum, 0, 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setFullYear(target.getFullYear() + 1);
  }
  return target;
}

/**
 * Accumulates output chunks and detects rate-limit events.
 * Returns null or { resetTime: Date, resetTimeStr: string, msUntilReset: number }.
 */
class RateLimitDetector {
  constructor() {
    this._buffer = '';
    this._lastDetection = 0;
    // Minimum interval between detections (ms) to avoid duplicate triggers
    this._cooldown = 30_000;
  }

  /**
   * Feed a chunk of PTY output. Returns detection result or null.
   */
  feed(chunk) {
    const plain = stripAnsi(chunk);
    this._buffer += plain;

    // Small buffer — real messages are < 100 bytes; a smaller window limits
    // contamination from HUD re-renders accumulating in the buffer.
    if (this._buffer.length > 512) {
      this._buffer = this._buffer.slice(-512);
    }

    // Check cooldown
    const now = Date.now();
    if (now - this._lastDetection < this._cooldown) return null;

    // Locate the active rate-limit trigger phrase. Only passive status
    // displays without this phrase reach here as false matches in rare cases.
    const triggerMatch = this._buffer.match(RATE_LIMIT_PATTERN);
    if (!triggerMatch) return null;

    // Proximity window: the reset-time must appear near the trigger phrase,
    // not somewhere else in the rolling buffer. 40 chars back, 120 forward
    // comfortably covers real messages like
    //   "You've hit your limit · resets 11pm (Asia/Shanghai)"
    const triggerStart = triggerMatch.index;
    const triggerEnd = triggerStart + triggerMatch[0].length;
    const winStart = Math.max(0, triggerStart - 40);
    const winEnd = Math.min(this._buffer.length, triggerEnd + 120);
    const window = this._buffer.slice(winStart, winEnd);

    let resetTime = null;
    let rawMatch = '';

    // Strategy 1: Clock time (existing) — "resets 3pm"
    const m1 = window.match(RESET_PATTERN);
    if (m1) {
      const hm = parseTimeStr(m1[1]);
      if (hm) {
        resetTime = nextOccurrence(hm, m1[2] || null);
        rawMatch = m1[0];
      }
    }

    // Strategy 2: Day of week — "resets Monday"
    if (!resetTime) {
      const m2 = window.match(RESET_DAY_PATTERN);
      if (m2) {
        resetTime = parseDayOfWeek(m2[1]);
        rawMatch = m2[0];
      }
    }

    // Strategy 3: Relative time — "resets in 3 days"
    if (!resetTime) {
      const m3 = window.match(RESET_RELATIVE_PATTERN);
      if (m3) {
        const ms = parseRelativeTime(m3[1], m3[2], m3[3], m3[4]);
        if (ms > 0) {
          resetTime = new Date(Date.now() + ms);
          rawMatch = m3[0];
        }
      }
    }

    // Strategy 4: Calendar date — "resets Apr 14"
    if (!resetTime) {
      const m4 = window.match(RESET_DATE_PATTERN);
      if (m4) {
        resetTime = parseMonthDate(m4[1], parseInt(m4[2], 10));
        rawMatch = m4[0];
      }
    }

    // Strategy 5: Slash date — "resets 4/14"
    if (!resetTime) {
      const m5 = window.match(RESET_SLASH_DATE_PATTERN);
      if (m5) {
        const month = parseInt(m5[1], 10) - 1;
        const day = parseInt(m5[2], 10);
        const now2 = new Date();
        const target = new Date(now2.getFullYear(), month, day, 0, 0, 0, 0);
        if (target.getTime() <= now2.getTime()) {
          target.setFullYear(target.getFullYear() + 1);
        }
        resetTime = target;
        rawMatch = m5[0];
      }
    }

    // Strategy 6: Fallback — rate limit detected but no parseable time
    if (!resetTime) {
      resetTime = new Date(Date.now() + 5 * 60_000);
      rawMatch = 'rate limit (no reset time parsed)';
    }

    const msUntilReset = resetTime.getTime() - Date.now();

    // Sanity check: allow up to 7 days for weekly limits.
    if (msUntilReset > 7 * 24 * 3600_000 || msUntilReset < 0) return null;

    this._lastDetection = now;
    this._buffer = ''; // Clear after detection

    const displayTime = resetTime.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    return {
      resetTime,
      resetTimeStr: displayTime,
      msUntilReset,
      rawMatch,
    };
  }

  reset() {
    this._buffer = '';
    this._lastDetection = 0;
  }
}

module.exports = {
  RateLimitDetector, stripAnsi, parseTimeStr, nextOccurrence,
  parseDayOfWeek, parseRelativeTime, parseMonthDate,
};
