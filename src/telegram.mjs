// Envío de mensajes por Telegram. El token y el chat_id vienen SOLO de variables de entorno.

export const telegramConfigurado = () => Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

export async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('  ⚠️ Telegram no configurado (faltan TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID); no se envió el mensaje.');
    return false;
  }
  // hasta 3 intentos (esperas de 5 s y 15 s) si falla la red o Telegram responde 5xx/429
  const esperas = [5000, 15000];
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      if (r.ok) return true;
      const cuerpo = await r.json().catch(() => ({}));
      console.error(`  ⚠️ Telegram respondió HTTP ${r.status}: ${cuerpo.description ?? ''}`);
      if (r.status < 500 && r.status !== 429) return false;
    } catch (e) {
      console.error(`  ⚠️ No se pudo contactar a Telegram: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
    }
    if (intento <= esperas.length) await new Promise((res) => setTimeout(res, esperas[intento - 1]));
  }
  return false;
}

export const escaparHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
