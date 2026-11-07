import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { findImage, normalize, caption } from '../tgcloud/lib/search.js';
import { handleMessage, handleCallback } from '../tgcloud/lib/bot.js';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE images(sha256 TEXT PRIMARY KEY,text TEXT,normalized TEXT,file_id TEXT);
    CREATE TABLE terms(term TEXT,sha256 TEXT); CREATE INDEX word ON terms(term,sha256);
    CREATE INDEX image ON terms(sha256,term); CREATE TABLE term_stats(term TEXT PRIMARY KEY,df INTEGER);
    CREATE TABLE sessions(key TEXT PRIMARY KEY,query TEXT,created INTEGER);`);
  for (const [sha, text, file] of [['a','Ёжик идёт домой','file-a'], ['b','Ёжик работает','file-b'], ['c','Ёжик спит',null]]) {
    const normalized = normalize(text);
    sql.prepare('INSERT INTO images VALUES(?,?,?,?)').run(sha, text, normalized, file);
    for (const word of new Set(normalized.split(' '))) sql.prepare('INSERT INTO terms VALUES(?,?)').run(word, sha);
  }
  sql.exec('INSERT INTO term_stats SELECT term,count(*) FROM terms GROUP BY term');
  const db = { get: async (text, args = {}) => sql.prepare(text).get(args),
    run: async (text, args = {}) => sql.prepare(text).run(args) };
  const calls = [];
  const api = Object.fromEntries(['sendMessage','sendPhoto','editPhoto','answerCallbackQuery'].map(name =>
    [name, async args => { calls.push({ name, args }); return { message_id: 1 }; }]));
  return { sql, db, api, calls, config: { ownerId: 42, allowedUserIds: [42] }, now: 100000 };
}
const message = text => ({ chat: { id: 42, type: 'private' }, from: { id: 42 }, message_id: 7, text });

test('prefix AND query, ё normalization, unloaded images excluded', async () => {
  const f = fixture();
  assert.equal((await findImage(f.db,'ЕЖИК РАБОТ')).sha256, 'b');
  assert.equal(await findImage(f.db,'ежик спит'), null);
  assert.equal(await findImage(f.db,'ежик " OR 1=1'), null);
  f.sql.close();
});
test('pagination returns different images and terminates', async () => {
  const f = fixture();
  assert.equal((await findImage(f.db, 'ежик', 0)).sha256, 'a');
  assert.equal((await findImage(f.db, 'ежик', 1)).sha256, 'b');
  assert.equal(await findImage(f.db, 'ежик', 2), null);
  f.sql.close();
});
test('counter counts unique images even when multiple words match a prefix',async()=>{
  const f=fixture();
  f.sql.exec("INSERT INTO terms VALUES('ежики','a'); INSERT INTO term_stats VALUES('ежики',1)");
  assert.equal((await findImage(f.db,'ежик')).total,2);
  f.sql.close();
});
test('broad/invalid queries rejected before unbounded scan', async () => {
  const f = fixture();
  f.sql.exec("UPDATE term_stats SET df=6000 WHERE term='ежик'");
  await assert.rejects(findImage(f.db,'ежик'), /QUERY_BROAD/);
  await assert.rejects(findImage(f.db,'!'), /QUERY_WORDS/);
  await assert.rejects(findImage(f.db,'ежик', -1), /QUERY_OFFSET/);
  f.sql.close();
});
test('authorized search sends original by file_id with next button', async () => {
  const f = fixture();
  await handleMessage(message('ежик'), f);
  assert.equal(f.calls[0].name, 'sendPhoto');
  assert.equal(f.calls[0].args.photo, 'file-a');
  assert.equal(f.calls[0].args.caption,undefined);
  assert.equal(f.calls[0].args.reply_markup.inline_keyboard[0][1].text,'1 / 2');
  assert.equal(f.calls[0].args.reply_markup.inline_keyboard[0][2].callback_data, 'page:7:1');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM sessions').get().n, 1);
  f.sql.close();
});
test('unauthorized user and group cannot retrieve catalogue', async () => {
  const f = fixture();
  const input = message('ежик'); input.from.id = 99;
  await handleMessage(input, f);
  input.from.id = 42; input.chat.type='group';
  await handleMessage(input, f);
  assert.equal(f.calls.filter(c => c.name === 'sendPhoto').length, 0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  f.sql.close();
});
test('next callback is bound to private owner chat and expires', async () => {
  const f = fixture();
  await handleMessage(message('ежик'), f); f.calls.length=0;
  const callback = { id:'cb', from:{id:42}, message:{message_id:99,chat:{id:42,type:'private'}}, data:'page:7:1' };
  await handleCallback(callback, f);
  assert.equal(f.calls[1].name,'editPhoto');
  assert.equal(f.calls[1].args.message_id,99);
  assert.equal(f.calls[1].args.photo,'file-b');
  assert.equal(f.calls[1].args.reply_markup.inline_keyboard[0][1].text,'2 / 2');
  f.calls.length=0;
  await handleCallback(callback,{...f,now:f.now+3600001});
  assert.equal(f.calls.length,1);
  f.calls.length=0; callback.from.id=99;
  await handleCallback(callback,f);
  assert.equal(f.calls.length,1);
  f.sql.close();
});
test('caption is bounded, no broken surrogate at boundary', () => {
  assert.ok(caption('а'.repeat(1000)).length<=900);
  assert.ok(!/[\uD800-\uDBFF]$/.test(caption('а'.repeat(899)+'😀')));
});

test('production SQL retrieves 100 synthetic prefix-unique records',async()=>{
 const sql=new DatabaseSync(':memory:');
 sql.exec('CREATE TABLE images(sha256 TEXT PRIMARY KEY,text TEXT,normalized TEXT,file_id TEXT);CREATE TABLE terms(term TEXT,sha256 TEXT);CREATE INDEX word ON terms(term,sha256);CREATE TABLE term_stats(term TEXT PRIMARY KEY,df INTEGER)');
 for(let i=0;i<100;i++){
  const word='synthetic'+String(i).padStart(4,'0');const sha=String(i).padStart(64,'0');
  sql.prepare('INSERT INTO images VALUES(?,?,?,?)').run(sha,word,word,'fixture');
  sql.prepare('INSERT INTO terms VALUES(?,?)').run(word,sha);sql.prepare('INSERT INTO term_stats VALUES(?,1)').run(word);
 }
 const db={get:async(q,p={})=>sql.prepare(q).get(p)};
 for(let i=0;i<100;i++)assert.equal((await findImage(db,'synthetic'+String(i).padStart(4,'0'))).sha256,String(i).padStart(64,'0'));
 sql.close();
});
