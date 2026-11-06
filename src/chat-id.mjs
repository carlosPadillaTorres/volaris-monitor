// Muestra los chat_id de quienes le han escrito a tu bot. Uso: npm run chat-id
// Antes: abre tu bot en Telegram y mándale cualquier mensaje.
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Falta TELEGRAM_BOT_TOKEN. Ponlo en el archivo .env (copia .env.example como .env).');
  process.exit(1);
}
const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await r.json();
if (!data.ok) {
  console.error(`Telegram respondió: ${data.description}. Revisa que el token esté bien copiado.`);
  process.exit(1);
}
const chats = new Map();
for (const u of data.result) {
  const c = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
  if (c) chats.set(c.id, c.username ? `@${c.username}` : (c.title ?? c.first_name ?? ''));
}
if (!chats.size) {
  console.log('No hay mensajes todavía. Abre tu bot en Telegram, mándale "hola" y vuelve a correr: npm run chat-id');
} else {
  console.log('chat_id encontrados (copia el tuyo a TELEGRAM_CHAT_ID en .env):');
  for (const [id, nombre] of chats) console.log(`  ${id}  ${nombre}`);
}
