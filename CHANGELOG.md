# Changelog

## [1.0.0] - 2026-04-09

### Added

- Transparent PTY wrapper for Claude Code CLI
- Rate limit detection with multiple time format support:
  - Clock time (`resets 3pm`, `resets 11:30pm`)
  - Timezone-aware (`resets 11pm (Asia/Shanghai)`)
  - Day of week (`resets Monday`)
  - Relative time (`resets in 3 days`, `resets in 5 hours and 30 minutes`)
  - Calendar date (`resets Apr 14`, `resets 4/14`)
  - Fallback (5-minute retry when time cannot be parsed)
- Automatic "continue" command after rate limit resets (+ 30s buffer)
- Cross-platform desktop notifications (Windows Toast, macOS osascript, Linux notify-send)
- Single-line status messages (no intrusive banners)
- Status file at `~/.claude/auto-continue/status.json`
- Cancel command: type `auto-continue stop` + Enter
- Custom resume message via `-m` flag
- CLI aliases: `auto-continue` and `ac`
- Full test suite: unit tests (43 cases), integration test, end-to-end demo
- Windows, macOS, Linux support
