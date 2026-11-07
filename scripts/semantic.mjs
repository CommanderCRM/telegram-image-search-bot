import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
export const BASE=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MODEL='Xenova/multilingual-e5-small';
export const REVISION='761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const MODEL_DIR=path.join(BASE,'.local/models/e5');
export const INDEX=path.join(BASE,'.local/semantic.sqlite3');
export const hash=text=>createHash('sha256').update(text).digest('hex');

export async function downloadModel() {
  const files=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'];
  const metadata=await fetch(`https://huggingface.co/api/models/${MODEL}/revision/${REVISION}?blobs=true`);
  if(!metadata.ok)throw new Error('MODEL_METADATA_FAILED');
  const info=await metadata.json();
  for(const name of files){
    const entry=info.siblings.find(row=>row.rfilename===name);
    if(!entry)throw new Error('MODEL_MANIFEST_INCOMPLETE');
    const target=path.join(MODEL_DIR,name);
    const verify=bytes=>entry.lfs ? hash(bytes)===entry.lfs.sha256
      : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')===entry.blobId;
    if(fs.existsSync(target)&&verify(fs.readFileSync(target)))continue;
    console.log('Downloading fixed model artifact:',name);
    const response=await fetch(`https://huggingface.co/${MODEL}/resolve/${REVISION}/${name}`);
    if(!response.ok)throw new Error('MODEL_DOWNLOAD_FAILED');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(!verify(bytes))throw new Error('MODEL_CHECKSUM_MISMATCH');
    fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    fs.writeFileSync(target+'.tmp',bytes,{mode:0o600});fs.renameSync(target+'.tmp',target);
  }
}
export async function loadEmbedder(){
  const {pipeline,env}=await import('@huggingface/transformers');
  env.allowRemoteModels=false;
  env.allowLocalModels=true;
  const model=await pipeline('feature-extraction',MODEL_DIR,{dtype:'q8',local_files_only:true,
    session_options:{intraOpNumThreads:4,interOpNumThreads:1}});
  return async(texts,prefix)=>{
    const output=await model(texts.map(text=>prefix+text),{pooling:'mean',normalize:true,truncation:true,max_length:512});
    return output.tolist().map(row=>Float32Array.from(row));
  };
}
export function chunks(text){
  const words=String(text).trim().split(/\s+/);const result=[];
  for(let start=0;start<words.length;){
    let end=start,length=0;
    while(end<words.length && end-start<120 && (length+words[end].length<=900 || end===start))length+=words[end++].length+1;
    result.push(words.slice(start,end).join(' '));
    if(end===words.length)break;
    start=Math.max(start+1,end-15);
  }
  return result;
}
export function cosine(a,b){
  if(a.length!==b.length)throw new Error('EMBEDDING_DIMENSION_MISMATCH');
  let dot=0,aa=0,bb=0;
  for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
  return aa&&bb?dot/Math.sqrt(aa*bb):0;
}
export function rankVectors(vectors,query,limit=20){
  const best=new Map();
  for(const row of vectors){const score=cosine(row.vector,query);if(score>(best.get(row.sha256)??-Infinity))best.set(row.sha256,score);}
  return [...best].map(([sha256,score])=>({sha256,score})).sort((a,b)=>b.score-a.score||a.sha256.localeCompare(b.sha256)).slice(0,limit);
}
export async function createSemanticSearch(localSql,{embed,filename=INDEX}={}){
  const encoder=embed??await loadEmbedder();
  const index=new DatabaseSync(filename,{readOnly:true});
  let version='',vectors=[];const cache=new Map();
  const search=async(db,text,offset=0)=>{
    if(typeof text!=='string'||text.trim().length<2||text.length>300||!Number.isInteger(offset)||offset<0||offset>=20)
      throw new Error('QUERY_SEMANTIC_INPUT');
    const meta=Object.fromEntries(index.prepare('SELECT key,value FROM meta').all().map(r=>[r.key,r.value]));
    const source=localSql.prepare("SELECT value FROM meta WHERE key='source_hash'").get()?.value;
    if(meta.source_hash!==source||meta.model!==MODEL+'@'+REVISION)throw new Error('QUERY_INDEX_UPDATING');
    if(version!==meta.version){
      vectors=index.prepare('SELECT sha256,vector FROM embeddings').all().map(row=>({sha256:row.sha256,
        vector:Float32Array.from(new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength)))}));
      version=meta.version;cache.clear();
    }
    const key=text.trim().toLowerCase();let results=cache.get(key);
    if(!results){
      const [query]=await encoder([text],'query: ');results=rankVectors(vectors,query);
      if(cache.size>=100)cache.delete(cache.keys().next().value);
      cache.set(key,results);
    }
    const result=results[offset];if(!result)return null;
    const image=localSql.prepare('SELECT sha256,file_id FROM images WHERE sha256=?').get(result.sha256);
    return image?{...image,total:results.length,score:result.score}:null;
  };
  search.close=()=>index.close();return search;
}
