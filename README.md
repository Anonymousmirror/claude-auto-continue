# claude-auto-continue

[![CI](https://github.com/YaoZeyuan/claude-auto-continue/actions/workflows/test.yml/badge.svg)](https://github.com/YaoZeyuan/claude-auto-continue/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/claude-auto-continue.svg)](https://www.npmjs.com/package/claude-auto-continue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

[中文文档](./README_CN.md)

> Automatically resume Claude Code sessions when rate limits reset. A transparent PTY wrapper that keeps your window open.

## The Problem

Heavy Claude Code users (especially on Max plans) frequently hit the 5-hour rate limit. When the limit resets, the session just sits there waiting for you to manually type "continue". If you're AFK, running multiple sessions, or simply didn't notice -- your work stalls.

## The Solution

`claude-auto-continue` wraps Claude Code in a transparent PTY proxy. It watches for rate limit messages, parses the reset time, and automatically sends "continue" when the limit lifts. **Your window stays open the entire time.**

```
You're working...
  ⚠ You've hit your limit · resets 3pm          ← Claude Code shows this
  [Auto-Continue] Rate limit detected.           ← auto-continue detects it
      Will auto-resume at 15:00:30
  [Auto-Continue] ~45 min until resume           ← countdown updates
  [Auto-Continue] ~30 min until resume
  [Auto-Continue] ~15 min until resume
  [Auto-Continue] Resuming session now!           ← sends "continue" automatically
  ✓ Back to work!
```

## Features

- **Transparent wrapper** -- all input/output passes through unchanged. Colors, shortcuts, UI all work normally
- **Smart detection** -- handles daily limits (`resets 3pm`), weekly limits (`resets Monday`, `resets in 3 days`, `resets Apr 14`), and timezone-aware formats (`resets 11pm (Asia/Shanghai)`)
- **Desktop notifications** -- toast/notification when rate limit is hit, periodic reminders, and when resuming (Windows, macOS, Linux)
- **Non-intrusive** -- no banners or boxes that break Claude Code's fullscreen TUI. Just single-line status messages
- **Won't cancel on keystrokes** -- you can keep typing, selecting options, or interacting with Claude Code's menus. Only typing `auto-continue stop` + Enter cancels the scheduled resume
- **Status file** -- writes state to `~/.claude/auto-continue/status.json` for programmatic access
- **Cross-platform** -- Windows, macOS, Linux

## Installation

```bash
npm install -g claude-auto-continue
```

**Prerequisites:** [Node.js](https://nodejs.org/) >= 18 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed.

## Usage

Use `auto-continue` (or `ac`) as a drop-in replacement for `claude`:

```bash
# Start a new session
auto-continue

# Continue last session
auto-continue -c

# Resume a named session
auto-continue --resume my-project

# Custom resume message
auto-continue -m "please continue the previous task"

# Pass any Claude Code flags after --
auto-continue -- --model opus

# Suppress desktop notifications
auto-continue --no-notify
```

### Cancel auto-resume

If you want to cancel the scheduled resume while waiting, type this in the Claude Code prompt and press Enter:

```
auto-continue stop
```

Normal typing and interaction will **not** cancel the auto-resume.

## How It Works

```
┌─────────────────────────────────────────────┐
│  Your Terminal                               │
│  ┌─────────────────────────────────────────┐ │
│  │  auto-continue (PTY wrapper)            │ │
│  │  ┌───────────────────────────────────┐  │ │
│  │  │  claude (Claude Code CLI)         │  │ │
│  │  │                                   │  │ │
│  │  │  stdin ◄──── passes through ◄──── │◄─│─│── your keyboard
│  │  │  stdout ───► passes through ────► │──│─│──► your screen
│  │  │              + rate limit detect  │  │ │
│  │  └───────────────────────────────────┘  │ │
│  │                                         │ │
│  │  On rate limit:                         │ │
│  │    1. Parse reset time from output      │ │
│  │    2. Wait until reset + 30s buffer     │ │
│  │    3. Send "continue" to Claude Code    │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Rate Limit Detection

The detector recognizes multiple message formats:

| Format | Example |
|--------|---------|
| Clock time | `resets 3pm`, `resets 11:30pm` |
| With timezone | `resets 11pm (Asia/Shanghai)` |
| Day of week | `resets Monday`, `resets on Wednesday` |
| Relative time | `resets in 3 days`, `resets in 5 hours` |
| Calendar date | `resets Apr 14`, `resets 4/14` |
| Fallback | Any "hit your limit" message without parseable time (retries in 5 min) |

Keywords detected: `hit your limit`, `limit reached`, `rate limit`, `usage limit`, `weekly limit`

## Options

| Flag | Description |
|------|-------------|
| `-h, --help` | Show help |
| `-m, --message <text>` | Custom message to send on resume (default: `"continue"`) |
| `--no-notify` | Suppress desktop notifications |

All other flags are passed directly to Claude Code.

## FAQ

**Q: Does this interfere with Claude Code's UI?**
A: No. All input and output passes through unchanged. The wrapper only adds minimal single-line status messages to stderr.

**Q: What if I want to manually resume instead?**
A: Type `auto-continue stop` + Enter to cancel the scheduled auto-resume, then interact normally.

**Q: Does it work with multiple concurrent sessions?**
A: Yes. Each `auto-continue` instance wraps its own Claude Code process independently.

**Q: What's the 30-second buffer?**
A: After the rate limit reset time, the tool waits an extra 30 seconds before sending "continue" to ensure the limit has fully cleared.

## Development

```bash
git clone https://github.com/YaoZeyuan/claude-auto-continue.git
cd claude-auto-continue
npm install

# Run tests
npm test

# Run the end-to-end demo (simulated, no real Claude Code needed)
node test/demo.js
```

## License

[MIT](./LICENSE)
