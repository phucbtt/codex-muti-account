# Codex Account Switcher

Save several Codex (ChatGPT / API key) logins and switch between them from VS Code without logging in again.

## How it works

Codex (CLI and the VS Code extension) keeps its login in `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`).
This extension stores a copy of that file per account in VS Code's encrypted `SecretStorage`, and switching
means writing the chosen copy back to `auth.json`.

- Before leaving an account, the live `auth.json` is copied back into that account's saved entry, because Codex
  rotates refresh tokens and an old snapshot would otherwise be dead.
- Accounts are identified by the email + account id inside the `id_token` (or a hash of the API key).

## Usage

Click the **Codex: …** status-bar item, or use the Command Palette (`Codex Accounts: …`):

| Command | What it does |
|---|---|
| Switch Account | Pick a saved account and apply it (then reload the window) |
| Add Account | Saves the current login, signs out, opens a terminal running `codex login`; the new login is saved automatically |
| Save Current Login | Saves/updates whatever is in `auth.json` right now |
| Refresh Usage | Re-fetch usage for all saved accounts now |
| Rename / Remove Account | Manage the saved list |

First-time setup: while logged in as account A, run **Save Current Login**; then **Add Account** for B, etc.

## Usage display

The status bar shows the active account's rate-limit usage (e.g. `Codex: work · 5h 23% wk 45%`). The switch
list shows every account's usage and reset time, so you can pick the one with headroom. When usage reaches
`codexAccounts.warnThreshold` (default 90%) the status bar turns warning-colored and a notification suggests
the least-used other account.

Data comes from `chatgpt.com/backend-api/wham/usage`, the undocumented endpoint Codex clients use for `/status`;
it may change without notice. Saved accounts whose access token has expired show "token expired" until you switch
to them once (Codex refreshes the token). API-key logins have no usage data.

## Settings

- `codexAccounts.usageRefreshMinutes` – polling interval (default 5)
- `codexAccounts.warnThreshold` – warn percent, 0 disables (default 90)

- `codexAccounts.codexHome` – override the folder containing `auth.json`
- `codexAccounts.loginCommand` – default `codex login`
- `codexAccounts.reloadAfterSwitch` – offer a window reload after switching (default on)

## Install

```
npx @vscode/vsce package
code --install-extension codex-account-switcher-0.1.0.vsix
```

## Limitations

- The Codex extension reads `auth.json` at startup, so a window reload is needed after switching.
- Two VS Code windows share one `auth.json`; switching affects all of them.
- If Codex is configured to store credentials in the OS keyring instead of `auth.json`
  (`cli_auth_credentials_store` in `config.toml`), set it to `file`.
