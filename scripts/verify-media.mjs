import { DatabaseSync } from 'node:sqlite';
import { loadSettings } from './settings.mjs';
import { resolveImage, pinImageRoot } from './local-runtime.mjs';
const settings = loadSettings();
const source = new DatabaseSync(settings.databasePath, {readOnly:true});
const root = pinImageRoot(settings.imageRoot);
const errors = {};
let checked = 0;
for (const image of source.prepare('SELECT sha256,canonical_path FROM images').iterate()) {
  try { resolveImage(root, image.canonical_path, image.sha256); checked++; }
  catch(error) { errors[error.code ?? error.message] = (errors[error.code ?? error.message] ?? 0) + 1; }
}
source.close();
console.log(JSON.stringify({ checked, errors }));
if (Object.keys(errors).length) process.exitCode=1;
