const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const STALE_MS = 60 * 1000;
/** id (or 'live' for an unsaved login) -> { windows, plan, error, fetchedAt } */
const usageCache = new Map();
const warned = new Set();
let usageTimer;

const INDEX_KEY = 'codexAccounts.index';
const SECRET_PREFIX = 'codexAccounts.auth.';
const LOGIN_POLL_MS = 1500;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** @type {vscode.ExtensionContext} */
let ctx;
let statusItem;
let loginPoll;

function cfg() {
  return vscode.workspace.getConfiguration('codexAccounts');
}

function codexHome() {
  return cfg().get('codexHome') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function authPath() {
  return path.join(codexHome(), 'auth.json');
}

function readAuth() {
  try {
    return fs.readFileSync(authPath(), 'utf8');
  } catch {
    return null;
  }
}

// Write via temp file + rename so Codex never reads a half-written auth.json.
function writeAuth(raw) {
  const target = authPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Extract a stable identity + display info from an auth.json body. */
function describe(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = json.tokens || {};
  if (tokens.id_token || tokens.access_token) {
    const claims = jwtPayload(tokens.id_token || '');
    const email = claims.email || '';
    const accountId = tokens.account_id || '';
    const plan = (claims['https://api.openai.com/auth'] || {}).chatgpt_plan_type || '';
    return { identity: `chatgpt:${email}|${accountId}`, label: email || accountId || 'ChatGPT account', plan };
  }
  if (json.OPENAI_API_KEY) {
    const key = String(json.OPENAI_API_KEY);
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
    return { identity: `apikey:${hash}`, label: `API key …${key.slice(-4)}`, plan: 'api key' };
  }
  return null;
}

function getIndex() {
  return ctx.globalState.get(INDEX_KEY, []);
}

async function setIndex(list) {
  await ctx.globalState.update(INDEX_KEY, list);
}

function secretKey(id) {
  return SECRET_PREFIX + id;
}

function currentEntry() {
  const raw = readAuth();
  const info = raw && describe(raw);
  if (!info) return undefined;
  return getIndex().find((a) => a.identity === info.identity);
}

/**
 * Codex rotates refresh tokens, so the live auth.json can be newer than the
 * snapshot we stored. Copy it back before switching away or the old account
 * would come back with a dead refresh token.
 */
async function syncCurrentBack() {
  const raw = readAuth();
  const info = raw && describe(raw);
  if (!info) return;
  const entry = getIndex().find((a) => a.identity === info.identity);
  if (!entry) return;
  const stored = await ctx.secrets.get(secretKey(entry.id));
  if (stored !== raw) await ctx.secrets.store(secretKey(entry.id), raw);
}

async function saveCurrent({ silent = false } = {}) {
  const raw = readAuth();
  if (!raw) {
    if (!silent) vscode.window.showWarningMessage(`No Codex login found at ${authPath()}. Log in to Codex first.`);
    return undefined;
  }
  const info = describe(raw);
  if (!info) {
    if (!silent) vscode.window.showErrorMessage('auth.json has no usable login (no tokens or API key).');
    return undefined;
  }
  const list = getIndex();
  const existing = list.find((a) => a.identity === info.identity);
  if (existing) {
    await ctx.secrets.store(secretKey(existing.id), raw);
    if (!silent) vscode.window.showInformationMessage(`Updated saved login "${existing.name}".`);
    return existing;
  }
  let name = info.label;
  if (!silent) {
    name = await vscode.window.showInputBox({
      prompt: 'Name for this account',
      value: info.label,
      validateInput: (v) => (v.trim() ? undefined : 'Name is required'),
    });
    if (!name) return undefined;
  }
  const entry = { id: crypto.randomUUID(), name: name.trim(), identity: info.identity, label: info.label, plan: info.plan };
  await ctx.secrets.store(secretKey(entry.id), raw);
  await setIndex([...list, entry]);
  if (!silent) vscode.window.showInformationMessage(`Saved "${entry.name}".`);
  return entry;
}

// ---- usage -------------------------------------------------------------

function httpGetJson(url, headers, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(Object.assign(new Error('token expired'), { code: 'AUTH' }));
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function windowLabel(seconds) {
  if (!seconds) return '?';
  if (seconds >= 6 * 86400) return 'wk';
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`;
  return `${Math.round(seconds / 3600)}h`;
}

/**
 * Uses the same (undocumented) endpoint the Codex clients use for /status.
 * We never refresh tokens here: refreshing would rotate the refresh token and
 * invalidate the stored copy, so an expired snapshot just shows "expired".
 */
async function fetchUsage(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { windows: [], error: 'bad auth.json', fetchedAt: Date.now() };
  }
  const tokens = json.tokens || {};
  if (!tokens.access_token) return { windows: [], error: 'no usage for API key', fetchedAt: Date.now() };
  const headers = { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'codex-account-switcher', Accept: 'application/json' };
  if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  try {
    const j = await httpGetJson(USAGE_URL, headers);
    const rl = j.rate_limit || {};
    const windows = [];
    for (const w of [rl.primary_window, rl.secondary_window]) {
      if (!w || w.used_percent == null) continue;
      const resetAt = w.reset_at ? w.reset_at * 1000 : w.reset_after_seconds != null ? Date.now() + w.reset_after_seconds * 1000 : undefined;
      windows.push({ label: windowLabel(w.limit_window_seconds), pct: Math.round(Number(w.used_percent)), resetAt });
    }
    return { windows, plan: j.plan_type, fetchedAt: Date.now() };
  } catch (e) {
    return { windows: [], error: e.code === 'AUTH' ? 'token expired – switch to it to refresh' : e.message, fetchedAt: Date.now() };
  }
}

async function refreshUsage() {
  const live = readAuth();
  const liveInfo = live && describe(live);
  const list = getIndex();
  const jobs = [];
  for (const a of list) {
    const isLive = liveInfo && liveInfo.identity === a.identity;
    jobs.push(
      (async () => {
        const raw = isLive ? live : await ctx.secrets.get(secretKey(a.id));
        if (raw) usageCache.set(a.id, await fetchUsage(raw));
      })()
    );
  }
  if (live && liveInfo && !list.some((a) => a.identity === liveInfo.identity)) {
    jobs.push(fetchUsage(live).then((u) => usageCache.set('live', u)));
  }
  await Promise.all(jobs);
  refreshStatus();
  maybeWarn();
}

function maxPct(u) {
  return u && u.windows.length ? Math.max(...u.windows.map((w) => w.pct)) : undefined;
}

function fmtUsage(u) {
  if (!u) return '';
  if (u.error) return u.error;
  return u.windows.map((w) => `${w.label} ${w.pct}%`).join(' · ');
}

function fmtReset(ms) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function fmtResets(u) {
  if (!u || u.error) return '';
  return u.windows.filter((w) => w.resetAt).map((w) => `${w.label} resets in ${fmtReset(w.resetAt)}`).join(', ');
}

function maybeWarn() {
  const active = currentEntry();
  if (!active) return;
  const u = usageCache.get(active.id);
  const pct = maxPct(u);
  const threshold = cfg().get('warnThreshold');
  if (pct == null || !threshold || pct < threshold) return;
  const key = `${active.id}:${u.windows.map((w) => w.resetAt || '').join(',')}`;
  if (warned.has(key)) return;
  warned.add(key);
  const best = getIndex()
    .filter((a) => a.id !== active.id)
    .map((a) => ({ a, p: maxPct(usageCache.get(a.id)) }))
    .filter((x) => x.p != null && x.p < pct)
    .sort((x, y) => x.p - y.p)[0];
  const hint = best ? ` "${best.a.name}" is at ${best.p}%.` : '';
  const btn = best ? `Switch to ${best.a.name}` : 'Switch Account';
  vscode.window.showWarningMessage(`Codex usage for ${active.name} is ${fmtUsage(u)}.${hint}`, btn).then((c) => {
    if (!c) return;
    if (best) applyAccount(best.a);
    else cmdSwitch();
  });
}

function describeItem(a, activeId) {
  const u = usageCache.get(a.id);
  const usage = fmtUsage(u);
  const resets = fmtResets(u);
  return {
    label: `${a.id === activeId ? '$(check) ' : '$(account) '}${a.name}`,
    description: [usage, a.label !== a.name ? a.label : ''].filter(Boolean).join('   '),
    detail: [a.plan ? `Plan: ${a.plan}` : '', resets].filter(Boolean).join(' — ') || undefined,
    account: a,
  };
}

async function pickAccount(placeHolder, { includeAdd = false } = {}) {
  const list = getIndex();
  const oldest = Math.min(...list.map((a) => (usageCache.get(a.id) || { fetchedAt: 0 }).fetchedAt));
  if (list.length && Date.now() - oldest > STALE_MS) {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Fetching Codex usage…' }, refreshUsage);
  }
  const active = currentEntry();
  const items = list.map((a) => describeItem(a, active && active.id));
  if (includeAdd) {
    items.push({ label: '$(add) Add another account…', action: 'add' });
  }
  if (!items.length) {
    const choice = await vscode.window.showInformationMessage('No saved Codex accounts yet.', 'Save Current Login', 'Add Account');
    if (choice === 'Save Current Login') await cmdSaveCurrent();
    if (choice === 'Add Account') await cmdAdd();
    return undefined;
  }
  return vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
}

async function applyAccount(entry) {
  const stored = await ctx.secrets.get(secretKey(entry.id));
  if (!stored) {
    vscode.window.showErrorMessage(`Saved login for "${entry.name}" is missing. Remove it and log in again.`);
    return;
  }
  await syncCurrentBack();
  writeAuth(stored);
  refreshStatus();
  if (!cfg().get('reloadAfterSwitch')) {
    vscode.window.showInformationMessage(`Switched to ${entry.name}.`);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    `Switched to ${entry.name}. Reload the window so Codex picks up the new login.`,
    'Reload Window'
  );
  if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function cmdSwitch() {
  const picked = await pickAccount('Switch Codex account', { includeAdd: true });
  if (!picked) return;
  if (picked.action === 'add') return cmdAdd();
  const active = currentEntry();
  if (active && active.id === picked.account.id) {
    vscode.window.showInformationMessage(`${picked.account.name} is already active.`);
    return;
  }
  await applyAccount(picked.account);
}

async function cmdSaveCurrent() {
  await saveCurrent();
  refreshStatus();
}

async function cmdAdd() {
  const ok = await vscode.window.showWarningMessage(
    'This saves your current login, signs Codex out, and opens a terminal to log in with another account.',
    { modal: true },
    'Continue'
  );
  if (ok !== 'Continue') return;

  // Make sure the account we're leaving can be restored later.
  if (readAuth()) {
    const saved = await saveCurrent({ silent: true });
    if (!saved) {
      vscode.window.showErrorMessage('Could not save the current login, aborting so nothing is lost.');
      return;
    }
    await syncCurrentBack();
  }
  try {
    fs.rmSync(authPath(), { force: true });
  } catch (e) {
    vscode.window.showErrorMessage(`Could not remove auth.json: ${e.message}`);
    return;
  }
  refreshStatus();

  const term = vscode.window.createTerminal({ name: 'Codex login', env: cfg().get('codexHome') ? { CODEX_HOME: codexHome() } : undefined });
  term.show();
  term.sendText(cfg().get('loginCommand') || 'codex login');
  vscode.window.showInformationMessage('Complete the login in the terminal (or via the Codex sidebar). The account is saved automatically.');
  waitForLogin();
}

function waitForLogin() {
  if (loginPoll) clearInterval(loginPoll);
  const started = Date.now();
  loginPoll = setInterval(async () => {
    if (Date.now() - started > LOGIN_TIMEOUT_MS) {
      clearInterval(loginPoll);
      loginPoll = undefined;
      return;
    }
    const raw = readAuth();
    if (!raw || !describe(raw)) return;
    clearInterval(loginPoll);
    loginPoll = undefined;
    const entry = await saveCurrent({ silent: true });
    refreshStatus();
    if (entry) {
      const choice = await vscode.window.showInformationMessage(`Logged in and saved as "${entry.name}".`, 'Reload Window');
      if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }, LOGIN_POLL_MS);
}

async function cmdRename() {
  const picked = await pickAccount('Rename which account?');
  if (!picked) return;
  const name = await vscode.window.showInputBox({
    prompt: 'New name',
    value: picked.account.name,
    validateInput: (v) => (v.trim() ? undefined : 'Name is required'),
  });
  if (!name) return;
  await setIndex(getIndex().map((a) => (a.id === picked.account.id ? { ...a, name: name.trim() } : a)));
  refreshStatus();
}

async function cmdRemove() {
  const picked = await pickAccount('Remove which saved account?');
  if (!picked) return;
  const ok = await vscode.window.showWarningMessage(
    `Remove saved login "${picked.account.name}"? (Does not log it out of OpenAI.)`,
    { modal: true },
    'Remove'
  );
  if (ok !== 'Remove') return;
  await ctx.secrets.delete(secretKey(picked.account.id));
  await setIndex(getIndex().filter((a) => a.id !== picked.account.id));
  refreshStatus();
}

function refreshStatus() {
  const raw = readAuth();
  const info = raw && describe(raw);
  const entry = currentEntry();
  const u = info && usageCache.get(entry ? entry.id : 'live');
  const short = u && !u.error && u.windows.length ? ' · ' + u.windows.map((w) => `${w.label} ${w.pct}%`).join(' ') : '';
  const threshold = cfg().get('warnThreshold');
  const hot = threshold && maxPct(u) != null && maxPct(u) >= threshold;
  statusItem.backgroundColor = hot ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const usageTip = u ? `\nUsage: ${fmtUsage(u)}${fmtResets(u) ? `\n${fmtResets(u)}` : ''}` : '';
  if (!info) {
    statusItem.text = '$(account) Codex: signed out';
    statusItem.tooltip = 'No Codex login found. Click to switch or add an account.';
  } else if (entry) {
    statusItem.text = `$(account) Codex: ${entry.name}${short}`;
    statusItem.tooltip = `${entry.label}${entry.plan ? ` (${entry.plan})` : ''}${usageTip}\nClick to switch account`;
  } else {
    statusItem.text = `$(account) Codex: ${info.label} (unsaved)${short}`;
    statusItem.tooltip = `This login is not saved yet. Run "Codex Accounts: Save Current Login".${usageTip}`;
  }
  statusItem.show();
}

function activate(context) {
  ctx = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusItem.command = 'codexAccounts.switch';

  const watched = authPath();
  fs.watchFile(watched, { interval: 3000 }, refreshStatus);

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('codexAccounts.switch', cmdSwitch),
    vscode.commands.registerCommand('codexAccounts.add', cmdAdd),
    vscode.commands.registerCommand('codexAccounts.saveCurrent', cmdSaveCurrent),
    vscode.commands.registerCommand('codexAccounts.rename', cmdRename),
    vscode.commands.registerCommand('codexAccounts.remove', cmdRemove),
    vscode.commands.registerCommand('codexAccounts.refreshUsage', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Fetching Codex usage…' }, refreshUsage);
    }),
    { dispose: () => fs.unwatchFile(watched, refreshStatus) },
    { dispose: () => loginPoll && clearInterval(loginPoll) },
    { dispose: () => usageTimer && clearInterval(usageTimer) }
  );
  refreshStatus();
  refreshUsage();
  const mins = Math.max(1, cfg().get('usageRefreshMinutes') || 5);
  usageTimer = setInterval(refreshUsage, mins * 60 * 1000);
}

function deactivate() {}

module.exports = { activate, deactivate };
