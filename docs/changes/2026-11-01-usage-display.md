# Usage display (2026-11-01)

## Request
Show Codex usage so the user knows when to switch accounts.

## Change
- `extension.js`: `fetchUsage()` calls `GET https://chatgpt.com/backend-api/wham/usage` with `Authorization: Bearer <access_token>` and
  `ChatGPT-Account-Id`, parsing `rate_limit.primary_window` / `secondary_window` (`used_percent`, `limit_window_seconds`, `reset_at`).
  Results are cached in memory (`usageCache`, keyed by saved-account id, or `live` for an unsaved login), polled every
  `usageRefreshMinutes` and refreshed when the switch picker opens if older than 60s.
  Shown in the status bar, tooltip and picker; `maybeWarn()` notifies once per reset window at `warnThreshold` and suggests the least-used account.
- `package.json`: command `refreshUsage`, settings `usageRefreshMinutes`, `warnThreshold`.
- README updated.

## Decisions / risks
- The endpoint is undocumented and reverse-engineered from third-party clients (sources: docs.rs crates `quotas`, `codexusage`, `ai-usagebar`);
  it may change. Parsing is defensive (missing windows are skipped; failures show the error text, never break switching).
- Tokens of non-active accounts are never refreshed by us: refreshing rotates the refresh token and would invalidate the stored snapshot
  unless written back, which risks races with Codex. Expired snapshots show "token expired" until switched to once.
- Not verified against a live account in this session.

## Tests
`node --check extension.js`; vsce package.
