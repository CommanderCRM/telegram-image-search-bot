import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {cosine,rankVectors,chunks,createSemanticSearch,MODEL,REVISION} from '../scripts/semantic.mjs';
import {handleMessage,handleCallback} from '../tgcloud/lib/bot.js';

test('cosine measures direction independent of vector magnitude',()=>{
  assert.equal(cosine([1,0],[10,0]),1);assert.equal(cosine([1,0],[0,1]),0);
  assert.equal(cosine([1,0],[-2,0]),-1);assert.equal(cosine([0,0],[1,0]),0);
});
test('chunks preserve the end of long texts and rankings deduplicate images by best cosine',()=>{
  const text=Array.from({length:1000},(_,i)=>'word'+i).join(' ');
  assert.ok(chunks(text).at(-1).endsWith('word999'));
  const ranked=rankVectors([{sha256:'a',vector:[1,0]},{sha256:'a',vector:[.9,.1]},
    {sha256:'b',vector:[0,1]}],[1,0]);
  assert.deepEqual(ranked.map(r=>r.sha256),['a','b']);
});
test('semantic search uses query prefix, stable cache and rejects stale corpus',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-'));
  const file=path.join(dir,'index.sqlite3');const index=new DatabaseSync(file);
  index.exec('CREATE TABLE meta(key TEXT,value TEXT);CREATE TABLE embeddings(sha256 TEXT,vector BLOB)');
  for(const [key,value] of Object.entries({source_hash:'source',model:MODEL+'@'+REVISION,version:'1'}))
    index.prepare('INSERT INTO meta VALUES(?,?)').run(key,value);
  index.prepare('INSERT INTO embeddings VALUES(?,?)').run('a',Buffer.from(new Float32Array([1,0]).buffer));
  index.prepare('INSERT INTO embeddings VALUES(?,?)').run('b',Buffer.from(new Float32Array([0,1]).buffer));
  const local=new DatabaseSync(':memory:');
  local.exec("CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES('source_hash','source');CREATE TABLE images(sha256 TEXT,file_id TEXT);INSERT INTO images VALUES('a','local:a'),('b','local:b')");
  let calls=0;
  const search=await createSemanticSearch(local,{filename:file,embed:async(texts,prefix)=>{
    assert.equal(prefix,'query: ');calls++;return [[1,0]];
  }});
  try{
    const first=await search(null,'совсем другие слова',0);
    assert.equal(first.sha256,'a');assert.equal(first.total,2);
    assert.equal((await search(null,'совсем другие слова',1)).sha256,'b');assert.equal(calls,1);
    local.exec("UPDATE meta SET value='changed'");
    await assert.rejects(search(null,'запрос'),/QUERY_INDEX_UPDATING/);
  }finally{search.close();local.close();index.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('bot accepts longer semantic sentences and paginates the same semantic ranking without captions',async()=>{
  const sessions=new Map(),calls=[];
  const db={run:async(q,p)=>{if(q.startsWith('INSERT'))sessions.set(p[':key'],{query:p[':query'],created:p[':created']});},
    get:async(q,p)=>sessions.get(p[':key'])};
  const api=Object.fromEntries(['sendPhoto','editPhoto','answerCallbackQuery','sendMessage'].map(name=>[name,async fields=>calls.push({name,fields})]));
  const search=async(db,query,offset)=>({file_id:'image'+offset,total:20});
  const deps={db,api,config:{publicAccess:true},search,now:100};
  await handleMessage({chat:{id:42,type:'private'},from:{id:42},message_id:1,text:'я хочу найти картинку о том как тяжело работать в понедельник'},deps);
  assert.equal(calls[0].name,'sendPhoto');assert.equal(calls[0].fields.caption,undefined);
  assert.equal(calls[0].fields.reply_markup.inline_keyboard[0][1].text,'1 / 20');
  await handleCallback({id:'cb',from:{id:42},message:{chat:{id:42,type:'private'},message_id:9},data:'page:1:1'},deps);
  assert.equal(calls.at(-1).name,'editPhoto');assert.equal(calls.at(-1).fields.photo,'image1');
});
