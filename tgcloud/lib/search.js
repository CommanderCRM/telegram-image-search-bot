export function normalize(text) {
  return String(text).normalize('NFKC').toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}
export function queryWords(text) {
  if (String(text).length > 300) throw new Error('QUERY_LENGTH');
  const words = [...new Set(normalize(text).split(' ').filter(x => x.length >= 2))];
  if (!words.length || words.length > 6) throw new Error('QUERY_WORDS');
  return words;
}
export async function findImage(db, text, offset = 0) {
  const words = queryWords(text);
  if (!Number.isInteger(offset) || offset < 0 || offset > 4999) throw new Error('QUERY_OFFSET');
  const estimates = [];
  for (const word of words) {
    const row = await db.get('SELECT coalesce(sum(df),0) AS n FROM term_stats WHERE term>=:lo AND term<:hi',
      { ':lo': word, ':hi': word + '\uffff' });
    estimates.push({ word, n: Number(row.n) });
  }
  estimates.sort((a, b) => a.n - b.n);
  if (!estimates[0].n) return null;
  if (estimates[0].n > 5000) throw new Error('QUERY_BROAD');
  const params = { ':lo': estimates[0].word, ':hi': estimates[0].word + '\uffff', ':offset': offset };
  const clauses = estimates.slice(1).map(({ word }, i) => {
    params[':lo' + i] = word; params[':hi' + i] = word + '\uffff';
    return `EXISTS (SELECT 1 FROM terms x${i} WHERE x${i}.sha256=i.sha256 AND x${i}.term>=:lo${i} AND x${i}.term<:hi${i})`;
  });
  return await db.get(`SELECT matches.*,count(*) OVER() AS total FROM (SELECT DISTINCT i.sha256,i.text,i.file_id FROM terms t JOIN images i ON i.sha256=t.sha256
    WHERE t.term>=:lo AND t.term<:hi AND i.file_id IS NOT NULL
    ${clauses.length ? 'AND ' + clauses.join(' AND ') : ''}
     ) matches ORDER BY sha256 LIMIT 1 OFFSET :offset`, params) ?? null;
}
export function isAllowed(id, config) {
  return Number.isSafeInteger(id) && id > 0 && (config.publicAccess === true || config.allowedUserIds?.includes(id));
}
export function caption(text) { return String(text).slice(0, 900).replace(/[\uD800-\uDBFF]$/, ''); }
