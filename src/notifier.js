'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Status file path: ~/.claude/auto-continue/status.json
 * This is the ONLY reliable way to show state to the user,
 * because Claude Code's fullscreen TUI owns both the screen
 * content and the window title bar.
 */
const STATUS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || '/tmp',
  '.claude', 'auto-continue'
);
const STATUS_FILE = path.join(STATUS_DIR, 'status.json');

/**
 * Send a cross-platform desktop notification.
 * Falls back silently if the notification system is unavailable.
 */
function notify(title, message) {
  try {
    if (process.platform === 'win32') {
      // Use PowerShell toast notification on Windows
      const script = `
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

        $template = @"
        <toast>
          <visual>
            <binding template="ToastGeneric">
              <text>${title.replace(/"/g, '&quot;')}</text>
              <text>${message.replace(/"/g, '&quot;')}</text>
            </binding>
          </visual>
          <audio silent="true" />
        </toast>
"@

        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($template)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Auto-Continue").Show($toast)
      `;
      execFile('powershell', ['-NoProfile', '-Command', script], { timeout: 10000 }, () => {});
    } else if (process.platform === 'darwin') {
      // macOS: osascript
      const escaped = message.replace(/"/g, '\\"');
      const titleEsc = title.replace(/"/g, '\\"');
      execFile('osascript', ['-e', `display notification "${escaped}" with title "${titleEsc}"`], { timeout: 5000 }, () => {});
    } else {
      // Linux: notify-send
      execFile('notify-send', [title, message], { timeout: 5000 }, () => {});
    }
  } catch {
    // Notification is best-effort, never crash
  }
}

/**
 * Write auto-continue status to a file on disk.
 * User can check with: type ~/.claude/auto-continue/status.json
 */
function writeStatus(status) {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      ...status,
      updated_at: new Date().toISOString(),
    }, null, 2));
  } catch { /* best effort */ }
}

/**
 * Clear the status file (on resume/cancel/exit).
 */
function clearStatus() {
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch { /* ignore */ }
}

/**
 * Print a single dim line to stderr.
 * May be overwritten by Claude Code's TUI redraws, but at least
 * the user has a chance to see it when the screen is relatively static
 * (e.g. during rate limit wait).
 */
function printStatusLine(text, color = '90') {
  process.stderr.write(`\x1b[${color}m[Auto-Continue] ${text}\x1b[0m\n`);
}

module.exports = { notify, writeStatus, clearStatus, printStatusLine };
