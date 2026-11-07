import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openLocalDatabase, makeApi, resolveImage } from '../scripts/local-runtime.mjs';
import { handleMessage } from '../tgcloud/lib/bot.js';

function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'local-image-bot-')));
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC3sAAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(root,'a.png'),bytes);
  const sha=createHash('sha256').update(bytes).digest('hex');
  const source=path.join(root,'source.sqlite3');
  const input=new DatabaseSync(source);
  input.exec('CREATE TABLE images(sha256 TEXT,text TEXT,canonical_path TEXT)');
  input.prepare('INSERT INTO images VALUES(?,?,?)').run(sha,'Ёжик работает','a.png'); input.close();
  const state=path.join(root,'state.sqlite3');
  const local=openLocalDatabase(source,state);
  return {root,sha,bytes,source,state,...local,close(){local.sql.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('real local search uploads selected bytes then reuses a bot-scoped file_id',async()=>{
  const f=fixture(),calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push(options.body);
    return {json:async()=>({ok:true,result:{photo:[{file_id:'cached-file'}]}})};
  };
  const api=makeApi({token:'test-token',botId:7,sql:f.sql,root:f.root,fetchImpl,delay:async()=>{}});
  const config={allowedUserIds:[42]};
  const message={chat:{id:42,type:'private'},from:{id:42},message_id:1,text:'ежик работ'};
  await handleMessage(message,{db:f.db,api,config});
  assert.ok(calls[0] instanceof FormData);
  assert.equal(Buffer.from(await calls[0].get('photo').arrayBuffer()).subarray(0,3).toString('hex'),'ffd8ff');
  assert.equal(calls[0].get('chat_id'),'42');
  assert.equal(calls[0].get('caption'),null);
  await handleMessage({...message,message_id:2},{db:f.db,api,config});
  assert.equal(JSON.parse(calls[1]).photo,'cached-file');
  const other=makeApi({token:'other-test-token',botId:8,sql:f.sql,root:f.root,fetchImpl,delay:async()=>{}});
  await other.sendPhoto({chat_id:42,photo:'local:'+f.sha});
  assert.ok(calls[2] instanceof FormData);
  f.close();
});
test('unknown network outcome is not retried as another send',async()=>{
  const f=fixture(); let calls=0;
  const api=makeApi({token:'test-token',botId:7,sql:f.sql,root:f.root,
    fetchImpl:async()=>{calls++;throw new Error('sensitive transport URL');},delay:async()=>{}});
  await assert.rejects(api.sendPhoto({chat_id:42,photo:'local:'+f.sha}),/TELEGRAM_NETWORK_UNKNOWN_OUTCOME/);
  assert.equal(calls,1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM photo_cache').get().n,0);
  f.close();
});
test('pagination edits the existing photo using multipart media without a caption',async()=>{
  const f=fixture();let sent;
  const api=makeApi({token:'test-token',botId:7,sql:f.sql,root:f.root,delay:async()=>{},
    fetchImpl:async(url,options)=>{sent={url,...options};return {json:async()=>({ok:true,result:{photo:[{file_id:'edited'}]}})};}});
  try {
    await api.editPhoto({chat_id:42,message_id:99,photo:'local:'+f.sha,caption:'must not escape'});
    assert.ok(sent.url.endsWith('/editMessageMedia'));
    assert.equal(sent.body.get('message_id'),'99');
    assert.deepEqual(JSON.parse(sent.body.get('media')),{type:'photo',media:'attach://photo'});
    assert.equal(sent.body.get('caption'),null);
    assert.ok(sent.body.get('photo') instanceof Blob);
    await api.editPhoto({chat_id:42,message_id:99,photo:'local:'+f.sha});
    assert.deepEqual(JSON.parse(sent.body).media,{type:'photo',media:'edited'});
  }finally{f.close();}
});
test('old document IDs are never reused as photo IDs',async()=>{
  const f=fixture(); let body;
  f.sql.prepare('INSERT INTO media_cache VALUES(?,?,?)').run(7,f.sha,'old-document-id');
  const api=makeApi({token:'test-token',botId:7,sql:f.sql,root:f.root,delay:async()=>{},
    fetchImpl:async(url,options)=>{body=options.body;assert.ok(url.endsWith('/sendPhoto'));
      return {json:async()=>({ok:true,result:{photo:[{file_id:'small-photo'},{file_id:'large-photo'}]}})};}});
  try {
    await api.sendPhoto({chat_id:42,photo:'local:'+f.sha});
    assert.ok(body instanceof FormData);
    assert.equal(f.sql.prepare('SELECT file_id FROM photo_cache').get().file_id,'large-photo');
    assert.equal(f.sql.prepare('SELECT file_id FROM media_cache').get().file_id,'old-document-id');
  } finally {f.close();}
});
test('corrupted local file is not sent',()=>{
  const f=fixture();
  fs.writeFileSync(path.join(f.root,'a.png'),'bad');
  assert.throws(()=>resolveImage(f.root,'a.png',f.sha),/IMAGE_HASH_MISMATCH/);
  f.close();
});
test('429 delay is respected and only a successful upload is cached',async()=>{
  const f=fixture(); let calls=0; const waits=[];
  const api=makeApi({token:'test-token',botId:7,sql:f.sql,root:f.root,delay:async ms=>waits.push(ms),
    fetchImpl:async()=>({json:async()=> ++calls===1 ? {ok:false,error_code:429,parameters:{retry_after:2}}
      : {ok:true,result:{photo:[{file_id:'retried-file'}]}}})});
  await api.sendPhoto({chat_id:42,photo:'local:'+f.sha});
  assert.equal(calls,2); assert.ok(waits.includes(3000));
  assert.equal(f.sql.prepare('SELECT file_id FROM photo_cache').get().file_id,'retried-file');
  f.close();
});

test('SIGINT interrupts a pending long poll and exits without waiting for timeout', { timeout: 5000 }, async()=>{
  const module = new URL('../scripts/local-runtime.mjs', import.meta.url).href;
  const code = `
    import {makeApi} from ${JSON.stringify(module)};
    const keepAlive=setInterval(()=>{},1000);
    const stop=new AbortController();
    process.on('SIGINT',()=>stop.abort());
    const api=makeApi({token:'test-token',signal:stop.signal,
      fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
        console.log('ready');
      })});
    try {await api.request('getUpdates');process.exitCode=1;}
    catch {process.exitCode=stop.signal.aborted ? 0 : 1;}
    finally {clearInterval(keepAlive);}
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
  try {
    await once(child.stdout,'data');
    const finished=once(child,'exit');
    child.kill('SIGINT');
    const [status]=await finished;
    assert.equal(status,0);
  } finally {if(child.exitCode===null)child.kill('SIGKILL');}
});
