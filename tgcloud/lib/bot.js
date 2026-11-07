import { findImage, isAllowed, queryWords } from './search.js';
async function deliver(db, api, chatId, key, query, offset, messageId = null, search = findImage) {
  let image;
  try { image = await search(db, query, offset); }
  catch (error) {
    if (!String(error.message).startsWith('QUERY_')) throw error;
    await api.sendMessage({ chat_id: chatId, text: error.message === 'QUERY_INDEX_UPDATING' ? 'Индекс обновляется. Попробуй немного позже.' : 'Уточни запрос: нужна фраза длиной от 2 до 300 символов.' }); return;
  }
  if (!image) {
    await api.sendMessage({ chat_id: chatId, text: offset ? 'Больше совпадений нет.' : 'Среди загруженных картинок совпадений нет. Попробуй другие слова или начало слова.' }); return;
  }
  const number = key.slice(key.lastIndexOf(':') + 1);
  const total = Number(image.total ?? 1);
  const buttons = [
    { text: '←', callback_data: offset > 0 ? `page:${number}:${offset - 1}` : 'noop' },
    { text: `${offset + 1} / ${total}`, callback_data: 'noop' },
    { text: '→', callback_data: offset + 1 < total ? `page:${number}:${offset + 1}` : 'noop' },
  ];
  const fields = { chat_id: chatId, photo: image.file_id,
    reply_markup: { inline_keyboard: [buttons] } };
  if (messageId != null) await api.editPhoto({ ...fields, message_id: messageId });
  else await api.sendPhoto(fields);
}
export async function handleMessage(message, { db, api, config, search, now = Date.now() }) {
  if (message.chat?.type !== 'private' || !message.from || message.from.is_bot || message.chat.id !== message.from.id) return;
  const command = (message.text ?? '').split('@')[0].trim();
  if (command === '/id') { await api.sendMessage({ chat_id: message.chat.id, text: `Твой Telegram ID: ${message.from.id}` }); return; }
  if (!isAllowed(message.from.id, config)) {
    await api.sendMessage({ chat_id: message.chat.id, text: 'Доступ к этому каталогу ограничен. Команда /id покажет твой ID.' }); return;
  }
  if (['/start', '/help', '/status'].includes(command)) {
    const row = await db.get('SELECT count(*) AS total, count(file_id) AS ready FROM images');
    await api.sendMessage({ chat_id: message.chat.id, text: `Ищу картинки по смыслу надписей. Опиши, что ищешь; покажу до 20 ближайших результатов. Доступно ${row.ready} из ${row.total} картинок. /id — твой ID.` }); return;
  }
  if (!message.text) return;
  try { if (search) { if(message.text.trim().length<2 || message.text.length>300) throw new Error(); } else queryWords(message.text); }
  catch { await api.sendMessage({ chat_id: message.chat.id, text: 'Нужна фраза длиной от 2 до 300 символов.' }); return; }
  const key = `${message.chat.id}:${message.message_id}`;
  await db.run('DELETE FROM sessions WHERE created<:cutoff', { ':cutoff': now - 3600000 });
  await db.run('INSERT INTO sessions(key,query,created) VALUES(:key,:query,:created) ON CONFLICT(key) DO UPDATE SET query=excluded.query,created=excluded.created',
    { ':key': key, ':query': message.text, ':created': now });
  await deliver(db, api, message.chat.id, key, message.text, 0, null, search);
}
export async function handleCallback(callback, { db, api, config, search, now = Date.now() }) {
  if (!isAllowed(callback.from?.id, config) || callback.message?.chat?.type !== 'private' || callback.message.chat.id !== callback.from.id) {
    await api.answerCallbackQuery({ callback_query_id: callback.id, text: 'Нет доступа.' }); return;
  }
  const match = /^page:(\d+):(\d+)$/.exec(callback.data ?? '');
  if (!match) { await api.answerCallbackQuery({ callback_query_id: callback.id }); return; }
  const key = `${callback.message.chat.id}:${match[1]}`;
  const session = await db.get('SELECT query,created FROM sessions WHERE key=:key', { ':key': key });
  const valid = session && now - session.created <= 3600000;
  await api.answerCallbackQuery({ callback_query_id: callback.id, ...(valid ? {} : { text: 'Запрос устарел. Отправь его заново.' }) });
  if (valid) await deliver(db, api, callback.message.chat.id, key, session.query, Number(match[2]), callback.message.message_id, search);
}
