// Envía un mensaje de prueba. Uso: npm run probar-telegram
import { enviarTelegram } from './telegram.mjs';

const ok = await enviarTelegram('✅ <b>volaris-monitor</b>: mensaje de prueba. Si lees esto, el bot y el chat_id están bien configurados.');
console.log(ok ? 'Mensaje enviado. Revisa Telegram.' : 'No se pudo enviar (ver mensaje arriba).');
process.exit(ok ? 0 : 1);
