import fs from 'node:fs';
import { loadSettings } from './settings.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMessage, handleCallback } from '../tgcloud/lib/bot.js';
import { createSemanticSearch } from './semantic.mjs';
import { config as cloudConfig } from '../tgcloud/lib/config.js';
import { openLocalDatabase, makeApi, abortableDelay, createRateLimiter } from './local-runtime.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const settings = loadSettings();
const source = settings.databasePath;
// Single trusted directory. It cannot be chosen by a chat message, URL or environment override.
const root = settings.imageRoot;
process.umask(0o077);
const stateDir = path.join(base, '.local');
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const lock = path.join(stateDir, 'local-bot.lock');
let lockHeld = false;
let sql;
let semanticSearch;
let stopped = false;
const shutdown = new AbortController();
const stop = () => { stopped = true; shutdown.abort(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  if (!args.includes('--check')) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); lockHeld = true;
    } catch { throw new Error('ANOTHER_INSTANCE_OR_STALE_LOCK'); }
  }
  const local = openLocalDatabase(source, path.join(stateDir, 'local.sqlite3'));
  sql = local.sql;
  const counts = await local.db.get('SELECT count(*) total,count(file_id) ready FROM images');
  const missing = sql.prepare('SELECT canonical_path FROM images').all().filter(row => !fs.existsSync(path.resolve(root, row.canonical_path))).length;
  console.log(`Local catalogue: ${counts.total} images; missing files: ${missing}`);
  if (missing) throw new Error('SOURCE_FILES_MISSING');
  if (!args.includes('--check')) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
    const config = { ...cloudConfig, publicAccess: true };
    semanticSearch = await createSemanticSearch(sql);
    console.log('Semantic search ready: local E5 embeddings, cosine, top 20.');
    const boot = makeApi({ token, botId: 0, sql, root, signal: shutdown.signal });
    const me = await boot.request('getMe');
    const expectedUsername = settings.botUsername;
    if (me.username?.toLowerCase() !== expectedUsername.replace(/^@/, '').toLowerCase()) throw new Error('WRONG_BOT_USERNAME');
    const api = makeApi({ token, botId: me.id, sql, root, signal: shutdown.signal });
    const webhook = await api.request('getWebhookInfo');
    if (webhook.url) {
      if (!args.includes('--remove-webhook')) throw new Error('WEBHOOK_EXISTS_USE_EXPLICIT_REMOVE_WEBHOOK_FLAG');
      await api.request('deleteWebhook', { drop_pending_updates: false });
      if ((await api.request('getWebhookInfo')).url) throw new Error('WEBHOOK_REMOVAL_NOT_CONFIRMED');
    }
    console.log(`Running @${me.username}. Public search in private chats; catalogue images only.`);
    const admit = createRateLimiter();
    let offset = sql.prepare('SELECT next_offset FROM offsets WHERE bot_id=?').get(me.id)?.next_offset ?? 0;
    while (!stopped) {
      let updates;
      try { updates = await api.request('getUpdates', { offset, timeout: 30, allowed_updates: ['message','callback_query'] }); }
      catch (error) {
        if (stopped) break;
        if (['TELEGRAM_API_401','TELEGRAM_API_409'].includes(error.message)) throw error;
        console.error('Polling failed; retrying in 5 seconds.');
        await abortableDelay(5000, shutdown.signal); continue;
      }
      for (const update of updates) {
        if (stopped) break;
        offset = update.update_id + 1;
        // Claim before replying: never automatically duplicate an uncertain send on restart.
        sql.prepare('INSERT OR REPLACE INTO offsets VALUES(?,?)').run(me.id, offset);
        const caller = update.message?.from ?? update.callback_query?.from;
        const chat = update.message?.chat ?? update.callback_query?.message?.chat;
        if (!caller || caller.is_bot || chat?.type !== 'private' || chat.id !== caller.id || !admit(caller.id)) continue;
        try {
          if (update.message) await handleMessage(update.message, { db: local.db, api, config, search: semanticSearch });
          if (update.callback_query) await handleCallback(update.callback_query, { db: local.db, api, config, search: semanticSearch });
        } catch { if (!stopped) console.error('Could not complete one reply; it will not be resent automatically. Repeat the query if needed.'); }
      }
    }
  }
} catch (error) {
  // No exception stack or network URL can leak the token into the terminal.
  if (!stopped) {
    const code = /^[A-Z_0-9]+$/.test(error.message) ? error.message : 'LOCAL_STARTUP_FAILED';
    console.error(`Stopped: ${code}`); process.exitCode = 1;
  }
} finally {
  semanticSearch?.close();
  sql?.close();
  if (lockHeld) fs.unlinkSync(lock);
  if (stopped) console.log('Bot stopped.');
}
