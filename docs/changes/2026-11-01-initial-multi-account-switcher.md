# Initial multi-account switcher (2026-11-01)

## Request
Log in to several Codex accounts in VS Code and switch between them without re-authenticating each time.

## Root cause / constraint
Codex keeps a single login in `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`); there is no built-in multi-account
support. Switching therefore = swapping that file.

## Change
- `extension.js`: commands switch/add/saveCurrent/rename/remove, status-bar item, login watcher.
  - Snapshots stored in `context.secrets` (key `codexAccounts.auth.<id>`); metadata (name, identity, label, plan) in `globalState`.
  - `syncCurrentBack()` copies the live `auth.json` into its saved entry before any switch/add, since Codex rotates refresh tokens.
  - `auth.json` written via temp file + rename, mode 0600.
  - "Add Account" saves current login, deletes `auth.json`, runs `codex login` in a terminal, polls for the new file and auto-saves.
- `package.json`: contributions and settings (`codexHome`, `loginCommand`, `reloadAfterSwitch`).

## Known risks / limitations
- Window reload required after switching (Codex reads auth at startup). Multiple windows share one `auth.json`.
- Not supported when Codex stores credentials in the OS keyring rather than `auth.json`.
- Not tested inside a live VS Code instance in this session (syntax-checked only); `auth.json` schema assumed from current Codex CLI
  (`tokens.id_token`, `tokens.account_id`, `OPENAI_API_KEY`).

## Tests
`node --check extension.js`; packaging with `vsce` (see below in session notes if run).
