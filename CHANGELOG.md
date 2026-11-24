# Kour Report Changelog

## [2.0.1] - 2026-11-24

### Messaging and notifications
- Fixed outgoing messages disappearing when the client is blocked and corrected auto-scroll when sending near the latest message.
- Improved notification readability and queue behavior, and added settings to place notifications in any screen corner.
- Fixed the floating Messages button remaining enlarged after closing the inbox.

### Settings and diagnostics
- Added a local Error Logs viewer for script-related errors, including captured console and unhandled errors.
- Improved the position selector and settings tooltips, and refined settings controls and interaction feedback.

## [2.0.0] - 2026-11-22

### API V2
- Migrated production reports and test reports to the V2 API.
- Added server-generated, stable client tokens required for reports and all messaging operations.
- Added V2 report metadata: script version and detected room player count.
- Added conditional Turnstile verification for reports and outgoing messages when requested by the API.
- Added the V2 message inbox API: retrieve KBI messages, send replies, and record read receipts.

### Messaging and interface
- Added the in-game KBI inbox with unread count, notifications, sender names, locally saved conversations, and read status.
- Added message settings and a one-time room-entry announcement; periodic chat announcements are not sent.
- Added a companion Messenger launcher and improved the show/hide transitions for the floating launchers.
- Added animated token details in Report History and an important reminder beside the room-entry announcement setting.

### Fixes and improvements
- Improved text-field focus and keyboard handling, including composition input, to keep report and message entry usable while the game is active.
- Improved browser fallbacks for text submission and input event handling.
- Fixed menu and reason-selection interactions, message polling coordination, and related menu presentation issues.
