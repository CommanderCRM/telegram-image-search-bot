import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalize } from '../tgcloud/lib/search.js';

export function openLocalDatabase(sourcePath, statePath) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const sql = new DatabaseSync(statePath);
  sql.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS images(sha256 TEXT PRIMARY KEY,text TEXT,normalized TEXT,file_id TEXT,canonical_path TEXT);
    CREATE TABLE IF NOT EXISTS terms(term TEXT,sha256 TEXT,PRIMARY KEY(term,sha256));
    CREATE INDEX IF NOT EXISTS terms_image ON terms(sha256,term);
    CREATE TABLE IF NOT EXISTS term_stats(term TEXT PRIMARY KEY,df INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY,query TEXT,created INTEGER);
    CREATE TABLE IF NOT EXISTS media_cache(bot_id INTEGER,sha256 TEXT,file_id TEXT,PRIMARY KEY(bot_id,sha256));
    CREATE TABLE IF NOT EXISTS photo_cache(bot_id INTEGER,sha256 TEXT,file_id TEXT,PRIMARY KEY(bot_id,sha256));
    CREATE TABLE IF NOT EXISTS offsets(bot_id INTEGER PRIMARY KEY,next_offset INTEGER);`);
  const fingerprint = createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  if (sql.prepare("SELECT value FROM meta WHERE key='source_hash'").get()?.value !== fingerprint) {
    sql.exec('BEGIN IMMEDIATE; DELETE FROM images; DELETE FROM terms; DELETE FROM term_stats; DELETE FROM sessions;');
    try {
      const image = sql.prepare('INSERT INTO images VALUES(?,?,?,?,?)');
      const term = sql.prepare('INSERT INTO terms VALUES(?,?)');
      for (const row of source.prepare('SELECT sha256,text,canonical_path FROM images').iterate()) {
        const normalized = normalize(row.text);
        if (!normalized) continue;
        image.run(row.sha256, row.text, normalized, 'local:' + row.sha256, row.canonical_path);
        for (const word of new Set(normalized.split(' '))) term.run(word, row.sha256);
      }
      sql.exec('INSERT INTO term_stats SELECT term,count(*) FROM terms GROUP BY term');
      sql.prepare("INSERT OR REPLACE INTO meta VALUES('source_hash',?)").run(fingerprint);
      sql.exec('COMMIT');
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  }
  source.close();
  return { sql,
    db: { get: async (text, args = {}) => sql.prepare(text).get(args),
          run: async (text, args = {}) => sql.prepare(text).run(args) } };
}

export function pinImageRoot(root) {
  const absolute = path.resolve(root);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute)
    throw new Error('INVALID_IMAGE_ROOT');
  return Object.freeze({ path: absolute, dev: stat.dev, ino: stat.ino });
}

function imageType(bytes, extension) {
  if (['.jpg', '.jpeg'].includes(extension) && bytes.length > 16
      && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  if (extension === '.png' && bytes.length >= 33
      && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      && bytes.subarray(12,16).toString('ascii') === 'IHDR') return 'image/png';
  if (extension === '.webp' && bytes.length >= 20 && bytes.subarray(0,4).toString('ascii') === 'RIFF'
      && bytes.subarray(8,12).toString('ascii') === 'WEBP'
      && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp';
  throw new Error('IMAGE_TYPE_NOT_ALLOWED');
}

export function resolveImage(root, relative, sha256) {
  const pinned = typeof root === 'string' ? pinImageRoot(root) : root;
  if (!pinned || typeof relative !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)
      || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('INVALID_IMAGE_PATH');
  const pieces = relative.split('/');
  if (pieces.some(piece => !piece || piece === '.' || piece === '..')) throw new Error('INVALID_IMAGE_PATH');
  const extension = path.extname(relative).toLowerCase();
  if (!['.jpg','.jpeg','.png','.webp'].includes(extension)) throw new Error('IMAGE_TYPE_NOT_ALLOWED');
  const paths = [pinned.path];
  for (const part of pieces) paths.push(path.join(paths.at(-1), part));
  const before = paths.map((name, index) => {
    const stat = fs.lstatSync(name);
    if (stat.isSymbolicLink() || (index < paths.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('IMAGE_LINK_OR_SPECIAL_FILE');
    return stat;
  });
  if (before[0].ino !== pinned.ino || before[0].dev !== pinned.dev) throw new Error('IMAGE_ROOT_CHANGED');
  const file = paths.at(-1);
  if (!fs.realpathSync(file).startsWith(pinned.path + path.sep)) throw new Error('IMAGE_OUTSIDE_ROOT');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size <= 0 || opened.size > 20 * 1024 * 1024)
      throw new Error('IMAGE_LINK_OR_SIZE_NOT_ALLOWED');
    if (opened.ino !== before.at(-1).ino || opened.dev !== before.at(-1).dev) throw new Error('IMAGE_CHANGED');
    // Recheck path identities after opening. Read this descriptor, never reopen the pathname.
    paths.forEach((name, index) => {
      const after = fs.lstatSync(name);
      if (after.isSymbolicLink() || after.ino !== before[index].ino || after.dev !== before[index].dev)
        throw new Error('IMAGE_CHANGED');
    });
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== opened.size || createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new Error('IMAGE_HASH_MISMATCH');
    const type = imageType(bytes, extension);
    return { file, bytes, type, filename: 'image-' + sha256.slice(0,12) + extension };
  } finally { fs.closeSync(fd); }
}

export function createRateLimiter({ interval = 2000, perMinute = 20, maxUsers = 10000 } = {}) {
  const users = new Map();
  return (id, now = Date.now()) => {
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const previous = users.get(id);
    if (previous && now - previous.last < interval) return false;
    if (users.size >= maxUsers) for (const [key, value] of users) if (now - value.start >= 60000) users.delete(key);
    if (!previous && users.size >= maxUsers) return false;
    const entry = !previous || now - previous.start >= 60000 ? {start: now, count: 0, last: 0} : previous;
    if (entry.count >= perMinute) return false;
    entry.last = now; entry.count++;
    users.set(id, entry);
    return true;
  };
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('STOPPED')); return; }
    const abort = () => { clearTimeout(timer); reject(new Error('STOPPED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function preparePhoto(bytes) {
  const helper = fileURLToPath(new URL('../.local/prepare-photo', import.meta.url));
  try {
    const jpeg = execFileSync(helper, [], { input: bytes, maxBuffer: 11 * 1024 * 1024,
      timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'] });
    if (jpeg.length > 10 * 1024 * 1024 || jpeg[0] !== 255 || jpeg[1] !== 216) throw new Error();
    return jpeg;
  } catch { throw new Error('PHOTO_PREPARATION_FAILED'); }
}

export function makeApi({ token, botId, sql, root, fetchImpl = fetch, signal,
  delay = ms => abortableDelay(ms, signal) }) {
  const pinnedRoot = root ? pinImageRoot(root) : null;
  const methods = new Set(['getMe','getWebhookInfo','deleteWebhook','getUpdates','sendMessage','sendPhoto','editMessageMedia','answerCallbackQuery']);
  let lastMessage = 0;
  async function request(method, fields = {}, bytes = null, filename = '', mime = 'application/octet-stream') {
    if (!methods.has(method)) throw new Error('TELEGRAM_METHOD_NOT_ALLOWED');
    if (['sendMessage','sendPhoto','editMessageMedia'].includes(method)) {
      await delay(Math.max(0, lastMessage + 1100 - Date.now()));
      lastMessage = Date.now();
    }
    let body, headers;
    if (bytes) {
      body = new FormData();
      for (const [key, value] of Object.entries(fields)) if (value != null)
        body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      body.set('photo', new Blob([bytes], { type: mime }), filename);
    } else { body = JSON.stringify(fields); headers = { 'Content-Type': 'application/json' }; }
    for (let attempt = 0; attempt < 4; attempt++) {
      let answer;
      try {
        const timeout = AbortSignal.timeout(method === 'getUpdates' ? 45000 : 120000);
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`,
          { method: 'POST', body, headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        answer = await response.json();
      } catch { throw new Error('TELEGRAM_NETWORK_UNKNOWN_OUTCOME'); }
      if (answer.ok) return answer.result;
      if (answer.error_code === 429 && answer.parameters?.retry_after && attempt < 3) {
        await delay((answer.parameters.retry_after + 1) * 1000); continue;
      }
      throw new Error(`TELEGRAM_API_${Number(answer.error_code) || 'UNKNOWN'}`);
    }
  }
  return {
    request,
    sendPhoto(fields) { return this.sendLocalPhoto(fields); },
    editPhoto(fields) { return this.sendLocalPhoto(fields, true); },
    sendMessage: fields => request('sendMessage', fields),
    answerCallbackQuery: fields => request('answerCallbackQuery', fields),
    async sendLocalPhoto(fields, editing = false) {
      if (typeof fields.photo !== 'string' || !/^local:[a-f0-9]{64}$/.test(fields.photo)) throw new Error('EXPECTED_LOCAL_PHOTO');
      const sha = fields.photo.slice(6);
      const image = sql.prepare('SELECT canonical_path,text FROM images WHERE sha256=?').get(sha);
      if (!image) throw new Error('IMAGE_NOT_FOUND');
      // Check even a cached file against today's directory and catalogue before any send.
      const { bytes } = resolveImage(pinnedRoot, image.canonical_path, sha);
      const params = { chat_id: fields.chat_id, reply_markup: fields.reply_markup, ...(editing ? {message_id: fields.message_id} : {}) };
      const method = editing ? 'editMessageMedia' : 'sendPhoto';
      const mediaFields = id => editing ? { ...params, media: { type: 'photo', media: id } } : { ...params, photo: id };
      const cached = sql.prepare('SELECT file_id FROM photo_cache WHERE bot_id=? AND sha256=?').get(botId, sha);
      if (cached) {
        try { return await request(method, mediaFields(cached.file_id)); }
        catch (error) {
          if (error.message !== 'TELEGRAM_API_400') throw error;
          sql.prepare('DELETE FROM photo_cache WHERE bot_id=? AND sha256=?').run(botId, sha);
        }
      }
      const jpeg = preparePhoto(bytes);
      const sent = await request(method, editing ? mediaFields('attach://photo') : params, jpeg, 'image-' + sha.slice(0,12) + '.jpg', 'image/jpeg');
      const fileId = sent.photo?.at(-1)?.file_id;
      if (!fileId) throw new Error('UPLOAD_RESPONSE_MISSING_PHOTO_ID');
      sql.prepare('INSERT OR REPLACE INTO photo_cache VALUES(?,?,?)').run(botId, sha, fileId);
      return sent;
    },
  };
}
