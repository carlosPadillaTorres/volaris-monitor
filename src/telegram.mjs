// Envío de mensajes por Telegram. El token y el chat_id vienen SOLO de variables de entorno.

export const telegramConfigurado = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('  ⚠️ Telegram no configurado (faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID); no se envió el mensaje.');
    return false;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) {
      const cuerpo = await r.json().catch(() => ({}));
      console.error(`  ⚠️ Telegram respondió HTTP ${r.status}: ${cuerpo.description ?? ''}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`  ⚠️ No se pudo contactar a Telegram: ${e.message}`);
    return false;
  }
}

export const escaparHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
