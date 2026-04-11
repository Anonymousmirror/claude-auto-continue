'use strict';

const {
  RateLimitDetector, parseTimeStr, stripAnsi,
  parseDayOfWeek, parseRelativeTime, parseMonthDate,
} = require('../src/detector');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${msg}`);
  } else {
    failed++;
    console.error(`  \u2717 ${msg}`);
  }
}

/** Generate a time string 2 hours from now, e.g. "3pm" or "11:30pm" */
function futureTimeStr() {
  const d = new Date(Date.now() + 2 * 3600_000);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h}${ampm}` : `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

const FUTURE = futureTimeStr();
console.log(`  (using future time: ${FUTURE})\n`);

// ── stripAnsi ──
console.log('stripAnsi:');
assert(stripAnsi('\x1b[31mhello\x1b[0m') === 'hello', 'strips color codes');
assert(stripAnsi('no ansi') === 'no ansi', 'leaves plain text');

// ── parseTimeStr ──
console.log('\nparseTimeStr:');
assert(JSON.stringify(parseTimeStr('3pm')) === '{"hours":15,"minutes":0}', 'parses "3pm"');
assert(JSON.stringify(parseTimeStr('11:30pm')) === '{"hours":23,"minutes":30}', 'parses "11:30pm"');
assert(JSON.stringify(parseTimeStr('12am')) === '{"hours":0,"minutes":0}', 'parses "12am"');
assert(JSON.stringify(parseTimeStr('12pm')) === '{"hours":12,"minutes":0}', 'parses "12pm"');
assert(JSON.stringify(parseTimeStr('6:15 AM')) === '{"hours":6,"minutes":15}', 'parses "6:15 AM"');

// ── RateLimitDetector ──
console.log('\nRateLimitDetector:');

const d1 = new RateLimitDetector();
const r1 = d1.feed(`You've hit your limit \u00b7 resets ${FUTURE}`);
assert(r1 !== null, 'detects basic rate limit message');
assert(r1 && r1.msUntilReset > 0, 'reset time is in the future');
assert(r1 && typeof r1.resetTimeStr === 'string', 'has display time string');

const d2 = new RateLimitDetector();
const r2 = d2.feed(`You've hit your limit \x1b[33m\u00b7\x1b[0m resets ${FUTURE} (Asia/Shanghai)`);
assert(r2 !== null, 'detects message with ANSI codes and timezone');

const d3 = new RateLimitDetector();
const r3 = d3.feed(`limit reached \u2219 resets ${FUTURE}`);
assert(r3 !== null, 'detects "limit reached" variant');

const d4 = new RateLimitDetector();
const r4 = d4.feed('Hello world, everything is fine');
assert(r4 === null, 'returns null for non-rate-limit output');

// Cooldown test
const d5 = new RateLimitDetector();
d5.feed(`You've hit your limit \u00b7 resets ${FUTURE}`);
const r5 = d5.feed(`You've hit your limit \u00b7 resets ${FUTURE}`);
assert(r5 === null, 'respects cooldown period');

// Chunked input
const d6 = new RateLimitDetector();
assert(d6.feed("You've hit your ") === null, 'partial message returns null');
const r6 = d6.feed(`limit \u00b7 resets ${FUTURE}`);
assert(r6 !== null, 'detects across chunked input');

// ── parseDayOfWeek ──
console.log('\nparseDayOfWeek:');
const nextMon = parseDayOfWeek('Monday');
assert(nextMon !== null, 'returns a date for Monday');
assert(nextMon.getDay() === 1, 'Monday is actually day 1');
assert(nextMon.getTime() > Date.now(), 'Monday is in the future');

const nextSun = parseDayOfWeek('Sunday');
assert(nextSun !== null && nextSun.getDay() === 0, 'Sunday is day 0');

assert(parseDayOfWeek('NotADay') === null, 'returns null for invalid day');

// ── parseRelativeTime ──
console.log('\nparseRelativeTime:');
assert(parseRelativeTime('3', 'day', null, null) === 3 * 86400000, '3 days = 259200000ms');
assert(parseRelativeTime('5', 'hour', null, null) === 5 * 3600000, '5 hours');
assert(
  parseRelativeTime('2', 'hour', '30', 'minute') === 2 * 3600000 + 30 * 60000,
  '2h 30m compound'
);
assert(parseRelativeTime('10', 'min', null, null) === 10 * 60000, '10 min');

// ── parseMonthDate ──
console.log('\nparseMonthDate:');
const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 5);
const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmName = monthNames[futureDate.getMonth()];
const fmDay = futureDate.getDate();
const parsed = parseMonthDate(fmName, fmDay);
assert(parsed !== null, `parses ${fmName} ${fmDay}`);
assert(parsed && parsed.getTime() > Date.now(), 'result is in the future');

assert(parseMonthDate('InvalidMonth', 1) === null, 'returns null for invalid month');

// ── Weekly/date-based detector patterns ──
console.log('\nWeekly/date-based detection:');

// Day of week
const d7 = new RateLimitDetector();
const r7 = d7.feed("You've hit your limit \u00b7 resets Monday");
assert(r7 !== null, 'detects day-of-week reset (Monday)');
assert(r7 && r7.msUntilReset > 0, 'day-of-week reset is in the future');
assert(r7 && r7.msUntilReset <= 7 * 24 * 3600_000, 'day-of-week within 7 days');

const d8 = new RateLimitDetector();
const r8 = d8.feed("You've hit your limit \u00b7 resets on Wednesday");
assert(r8 !== null, 'detects "resets on <day>" variant');

// Relative time
const d9 = new RateLimitDetector();
const r9 = d9.feed("You've hit your limit \u00b7 resets in 3 days");
assert(r9 !== null, 'detects relative time (days)');
assert(r9 && Math.abs(r9.msUntilReset - 3 * 86400_000) < 5000, 'relative days correct');

const d10 = new RateLimitDetector();
const r10 = d10.feed("usage limit reached \u00b7 resets in 5 hours");
assert(r10 !== null, 'detects relative time (hours)');

const d11 = new RateLimitDetector();
const r11 = d11.feed("You've hit your 5-hour limit \u00b7 resets in 2 hours and 30 minutes");
assert(r11 !== null, 'detects compound relative time');
assert(
  r11 && Math.abs(r11.msUntilReset - (2 * 3600_000 + 30 * 60_000)) < 5000,
  'compound relative time correct'
);

// Calendar date
const d12 = new RateLimitDetector();
const futureDateStr = `${fmName} ${fmDay}`;
const r12 = d12.feed(`You've hit your limit \u00b7 resets ${futureDateStr}`);
assert(r12 !== null, `detects calendar date (${futureDateStr})`);

// Slash date
const d13 = new RateLimitDetector();
const slashDate = `${futureDate.getMonth() + 1}/${fmDay}`;
const r13 = d13.feed(`You've hit your weekly limit \u00b7 resets ${slashDate}`);
assert(r13 !== null, `detects slash date (${slashDate})`);

// Weekly limit phrasing with clock time
const d14 = new RateLimitDetector();
const r14 = d14.feed(`You've hit your weekly limit \u00b7 resets ${FUTURE}`);
assert(r14 !== null, '"hit your weekly limit" with clock time');

// Fallback: rate limit without parseable time
const d15 = new RateLimitDetector();
const r15 = d15.feed("You've hit your limit");
assert(r15 !== null, 'fallback: detects limit without reset time');
assert(
  r15 && r15.msUntilReset > 0 && r15.msUntilReset <= 6 * 60_000,
  'fallback: default wait ~5 min'
);

// Sanity: reject > 7 days
const d16 = new RateLimitDetector();
const r16 = d16.feed("hit your limit \u00b7 resets in 10 days");
assert(r16 === null, 'rejects reset times beyond 7 days');

// ── claude-hud false positive guards ──
console.log('\nclaude-hud false positive guards:');

const dH1 = new RateLimitDetector();
assert(
  dH1.feed("5h: 35% \u00b7 resets 14:00 | weekly: 20%") === null,
  'ignores HUD line: percentage + resets without "hit your" / "limit reached"'
);

const dH2 = new RateLimitDetector();
assert(
  dH2.feed("rate limit: 40% remaining \u00b7 resets 3pm") === null,
  'ignores HUD line: "rate limit: X%"'
);

const dH3 = new RateLimitDetector();
assert(
  dH3.feed("usage limit 20% \u00b7 resets Monday") === null,
  'ignores HUD line: "usage limit X%"'
);

const dH4 = new RateLimitDetector();
assert(
  dH4.feed("weekly limit: 15% \u00b7 resets in 3 days") === null,
  'ignores HUD line: "weekly limit X%"'
);

// Proximity guard: trigger phrase and a far-away resets must NOT bind together.
// Far-away resets outside the 120-char forward window should be ignored, and
// the detector should fall back to the ~5-minute default instead of using the
// unrelated resets.
const dH5 = new RateLimitDetector();
const far = "You've hit your limit" + " ".repeat(300) + `resets ${FUTURE}`;
const rH5 = dH5.feed(far);
assert(rH5 !== null, 'proximity: far-away resets still produces a fallback detection');
assert(
  rH5 && rH5.msUntilReset > 0 && rH5.msUntilReset <= 6 * 60_000,
  'proximity: far-away resets is ignored, fallback is ~5 min'
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
