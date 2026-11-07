import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { resolveImage, pinImageRoot, makeApi, createRateLimiter } from '../scripts/local-runtime.mjs';
import { handleMessage, handleCallback } from '../tgcloud/lib/bot.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC3sAAAAASUVORK5CYII=','base64');
const hash=data=>createHash('sha256').update(data).digest('hex');
function fixture() {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'image-boundary-')));
  const root=path.join(temp,'images'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'image.png'),png);
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE images(sha256 TEXT PRIMARY KEY,text TEXT,canonical_path TEXT);
    CREATE TABLE photo_cache(bot_id INTEGER,sha256 TEXT,file_id TEXT,PRIMARY KEY(bot_id,sha256));`);
  sql.prepare('INSERT INTO images VALUES(?,?,?)').run(hash(png),'Текст картинки','image.png');
  return {root,temp,sql,sha:hash(png),close(){sql.close();fs.rmSync(temp,{recursive:true,force:true});}};
}
test('absolute paths, traversal, forbidden extensions and disguised non-images fail closed',()=>{
  const f=fixture();
  try {
    fs.writeFileSync(path.join(f.temp,'outside.png'),png);
    for(const relative of ['../outside.png',path.join(f.temp,'outside.png'),'folder/../../outside.png','image.png\0','..\\outside.png'])
      assert.throws(()=>resolveImage(f.root,relative,f.sha));
    fs.writeFileSync(path.join(f.root,'private.txt'),'confidential text');
    assert.throws(()=>resolveImage(f.root,'private.txt',hash('confidential text')),/IMAGE_TYPE_NOT_ALLOWED/);
    fs.writeFileSync(path.join(f.root,'private.png'),'confidential text');
    assert.throws(()=>resolveImage(f.root,'private.png',hash('confidential text')),/IMAGE_TYPE_NOT_ALLOWED/);
  } finally {f.close();}
});
test('file symlinks, directory symlinks and hard links are rejected',()=>{
  const f=fixture();
  try {
    fs.symlinkSync(path.join(f.root,'image.png'),path.join(f.root,'link.png'));
    assert.throws(()=>resolveImage(f.root,'link.png',f.sha),/IMAGE_LINK_OR_SPECIAL_FILE/);
    fs.mkdirSync(path.join(f.temp,'outside'));
    fs.writeFileSync(path.join(f.temp,'outside/image.png'),png);
    fs.symlinkSync(path.join(f.temp,'outside'),path.join(f.root,'alias'));
    assert.throws(()=>resolveImage(f.root,'alias/image.png',f.sha),/IMAGE_LINK_OR_SPECIAL_FILE/);
    fs.linkSync(path.join(f.temp,'outside/image.png'),path.join(f.root,'hard.png'));
    assert.throws(()=>resolveImage(f.root,'hard.png',f.sha),/IMAGE_LINK_OR_SIZE_NOT_ALLOWED/);
  } finally {f.close();}
});
test('replacing the allowed root is detected using its pinned identity',()=>{
  const f=fixture();
  try {
    const root=pinImageRoot(f.root);
    fs.renameSync(f.root,f.root+'-old'); fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root,'image.png'),png);
    assert.throws(()=>resolveImage(root,'image.png',f.sha),/IMAGE_ROOT_CHANGED/);
  } finally {f.close();}
});
test('cached file_id cannot bypass a missing or substituted image check',async()=>{
  const f=fixture(); let calls=0;
  const api=makeApi({token:'fixture-token',botId:1,sql:f.sql,root:f.root,delay:async()=>{},
    fetchImpl:async()=>{calls++;return {json:async()=>({ok:true,result:{photo:[{file_id:'id'}]}})};}});
  try {
    f.sql.prepare('INSERT INTO photo_cache VALUES(?,?,?)').run(1,f.sha,'cached');
    fs.writeFileSync(path.join(f.root,'image.png'),'changed');
    await assert.rejects(api.sendPhoto({chat_id:42,photo:'local:'+f.sha}),/IMAGE_HASH_MISMATCH/);
    fs.unlinkSync(path.join(f.root,'image.png'));
    await assert.rejects(api.sendPhoto({chat_id:42,photo:'local:'+f.sha}));
    assert.equal(calls,0);
  } finally {f.close();}
});
test('arbitrary URLs/file IDs, uncatalogued images and unsupported API methods cannot be sent',async()=>{
  const f=fixture(); let calls=0;
  const api=makeApi({token:'fixture-token',botId:1,sql:f.sql,root:f.root,delay:async()=>{},fetchImpl:async()=>{calls++;}});
  try {
    for(const document of ['file:///etc/passwd','https://localhost/secret','any-file-id','local:../../private.png'])
      await assert.rejects(api.sendPhoto({chat_id:42,photo:document}),/EXPECTED_LOCAL_PHOTO/);
    await assert.rejects(api.sendPhoto({chat_id:42,photo:'local:'+'0'.repeat(64)}),/IMAGE_NOT_FOUND/);
    await assert.rejects(api.request('getFile'),/TELEGRAM_METHOD_NOT_ALLOWED/);
    assert.equal(calls,0);
  } finally {f.close();}
});
test('only catalogue OCR caption and generic image filename are sent over fixed HTTPS',async()=>{
  const f=fixture(); let sent;
  const api=makeApi({token:'fixture-token',botId:1,sql:f.sql,root:f.root,delay:async()=>{},
    fetchImpl:async(url,options)=>{sent={url,...options}; return {json:async()=>({ok:true,result:{photo:[{file_id:'id'}]}})};}});
  try {
    await api.sendPhoto({chat_id:42,photo:'local:'+f.sha,caption:'not from catalogue',parse_mode:'HTML'});
    assert.equal(new URL(sent.url).hostname,'api.telegram.org');
    assert.equal(sent.redirect,'error');
    assert.equal(sent.body.get('caption'),null);
    assert.equal(sent.body.get('parse_mode'),null);
    assert.equal(sent.body.get('photo').name,'image-'+f.sha.slice(0,12)+'.jpg');
    assert.equal(sent.body.get('photo').type,'image/jpeg');
    assert.equal(Buffer.from(await sent.body.get('photo').arrayBuffer()).subarray(0,3).toString('hex'),'ffd8ff');
  } finally {f.close();}
});
test('public search accepts different users, while foreign callbacks cannot reuse another chat session',async()=>{
  const calls=[];
  const api=Object.fromEntries(['sendPhoto','sendMessage','answerCallbackQuery'].map(name=>[name,async args=>calls.push({name,args})]));
  const db={get:async(query)=>query.includes('term_stats') ? {n:1} : query.includes('FROM terms t') ? {file_id:'image-id',text:'OCR'} : null,
    run:async()=>{}};
  for(const id of [42,99]) await handleMessage({chat:{type:'private',id},from:{id},message_id:1,text:'картинка'},
    {db,api,config:{publicAccess:true}});
  assert.deepEqual(calls.filter(c=>c.name==='sendPhoto').map(c=>c.args.chat_id),[42,99]);
  calls.length=0;
  await handleCallback({id:'cb',from:{id:99},message:{chat:{type:'private',id:42}},data:'page:1:0'},
    {db,api,config:{publicAccess:true}});
  assert.equal(calls.length,1); assert.equal(calls[0].name,'answerCallbackQuery');
});
test('user paths, SQL and shell strings stay search data; attachments are never downloaded',async()=>{
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE images(sha256 TEXT,text TEXT,file_id TEXT);
    CREATE TABLE terms(term TEXT,sha256 TEXT); CREATE TABLE term_stats(term TEXT,df INTEGER);
    CREATE TABLE sessions(key TEXT PRIMARY KEY,query TEXT,created INTEGER);`);
  const db={get:async(q,p={})=>sql.prepare(q).get(p),run:async(q,p={})=>sql.prepare(q).run(p)};
  const calls=[];
  const api=Object.fromEntries(['sendPhoto','sendMessage'].map(name=>[name,async args=>calls.push({name,args})]));
  try {
    for(const [index,text] of ['/etc/passwd','file:///private/outside/key','$(cat ~/.zshrc)',"'; DROP TABLE images; --"].entries())
      await handleMessage({chat:{type:'private',id:42},from:{id:42},message_id:index+1,text},
        {db,api,config:{publicAccess:true}});
    await handleMessage({chat:{type:'private',id:42},from:{id:42},message_id:10,photo:{file_id:'foreign'}},
      {db,api,config:{publicAccess:true}});
    assert.equal(calls.filter(c=>c.name==='sendPhoto').length,0);
    assert.equal(sql.prepare('SELECT count(*) n FROM images').get().n,0);
  } finally {sql.close();}
});
test('public per-user throttling is bounded and does not use a private allowlist',()=>{
  const admit=createRateLimiter({interval:2000,perMinute:2,maxUsers:2});
  assert.equal(admit(1,10000),true); assert.equal(admit(1,10001),false);
  assert.equal(admit(2,10001),true); assert.equal(admit(3,10002),false);
  assert.equal(admit(1,12000),true); assert.equal(admit(1,15000),false);
  assert.equal(admit(3,75000),true);
});
