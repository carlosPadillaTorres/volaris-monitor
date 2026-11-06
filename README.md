# volaris-monitor

Monitor de precios de **Volaris** (volaris.com, sitio México, MXN) hecho con **Playwright**.
Cada hora busca el vuelo **sin escalas más barato** en tarifa **Zero** para tu ruta y fechas, registra los precios en `precios.md` y `precios.csv`, y te avisa por **Telegram** cuando el boleto baja de tu umbral.

Corre gratis en **GitHub Actions** (en un repo público los minutos son ilimitados) o en tu propia computadora.

> Proyecto personal, no oficial ni afiliado a Volaris. Úsalo con baja frecuencia y bajo tu responsabilidad.

## Qué cotiza en cada ejecución

| Dato | De dónde sale | Se guarda |
|---|---|---|
| **Boleto** tarifa Zero, vuelo directo más barato (sin TUA) | JSON `availability/search` de la búsqueda | por persona y total |
| **TUA** (tarifa de aeropuerto) | mismo JSON | por persona y total; aviso si cambia |
| **Equipaje de mano** | JSON `booking/quote` + validación con la pantalla | por pasajero/vuelo y total |
| **Maleta documentada** | ídem | precio de la(s) maleta(s) y prorrateo por persona |
| **Asientos** | JSON del mapa de asientos | mínimo–máximo por persona y total |
| Vuelo y horarios | JSON de la búsqueda | — |

Los precios se leen de las respuestas JSON que la propia página de Volaris pide **dentro del navegador de Playwright**, que es más estable que leer el HTML.
Para los extras se recorre el flujo con 1 adulto hasta la pantalla de asientos y luego se vacía el carrito. **Nunca** inicia sesión, **nunca** captura datos de pasajeros y **nunca** llega a la pantalla de pago.

## Modos

| Modo | Qué busca | Umbral |
|---|---|---|
| `ida` | origen → destino en `fecha_ida` | boleto por persona **≤** `umbral_por_persona` |
| `redondo` | ida + regreso en una sola búsqueda | suma ida + regreso por persona **<** `umbral_suma_por_persona` |
| `regreso` | destino → origen en `fecha_regreso` | boleto por persona **≤** `umbral_por_persona` |

En cada modo puedes poner, opcionalmente, `umbral_con_tua_por_persona` (boleto + TUA). Con `null` queda apagado.

## Configuración (`config.json`)

```json
{
  "origen": "BJX", "destino": "PVR",
  "fecha_ida": "2026-11-25", "fecha_regreso": "2026-11-29",
  "adultos": 3,
  "maletas_documentadas_total": 1,
  "fecha_fin": "2026-11-29",
  "cotizar_extras": true,
  "alertar_cambio_tua": true,
  "fallos_para_alerta": 3,
  "modos": {
    "ida":     { "activo": true,  "umbral_por_persona": 600,       "umbral_con_tua_por_persona": null },
    "redondo": { "activo": true,  "umbral_suma_por_persona": 3400, "umbral_con_tua_por_persona": null },
    "regreso": { "activo": false, "umbral_por_persona": 600,       "umbral_con_tua_por_persona": null }
  }
}
```

- **Ruta y fechas:** usa códigos IATA (`MEX`, `GDL`, `CUN`…) y fechas `AAAA-MM-DD`.
- **Prender o apagar un modo:** cambia `"activo"` a `true` o `false`, guarda y haz commit. La siguiente ejecución ya lo toma en cuenta.
- **Cambiar un umbral:** edita el número del modo correspondiente.
- **Dejar de ejecutar:** después de `fecha_fin` el script ya no hace nada y el workflow **se desactiva solo**. Un modo cuyo vuelo ya pasó se omite automáticamente.
- **Alerta por fallos:** si un modo falla `fallos_para_alerta` veces seguidas (captcha, bloqueo, cambio de página), te llega un aviso. Si sigue fallando, se repite cada 24 ejecuciones.

## 1. Correr en local

Requisitos: Node.js 22.9 o superior.

```bash
git clone https://github.com/<tu-usuario>/volaris-monitor.git
cd volaris-monitor
npm install
npx playwright install chromium
cp .env.example .env        # luego llena el token y el chat_id (ver sección Telegram)
npm run monitor             # headless
npm run monitor:visible     # con el navegador visible, para ver el flujo
```

Variables opcionales para una sola ejecución:

```bash
MODOS=ida,redondo npm run monitor     # ignora "activo" del config
UMBRAL=99999 npm run monitor          # fuerza la alerta (para probar Telegram)
SIN_EXTRAS=1 npm run monitor          # solo el boleto, más rápido
```

## 2. Telegram

1. En Telegram abre **@BotFather**, manda `/newbot` y sigue los pasos. Al final te da un **token** (`123456789:AA...`).
2. Pega el token en `.env` como `TELEGRAM_BOT_TOKEN=...`.
3. Abre tu bot en Telegram y mándale cualquier mensaje (por ejemplo "hola").
4. Corre `npm run chat-id`. Copia el número que aparece a `.env` como `TELEGRAM_CHAT_ID=...`.
5. Corre `npm run probar-telegram`. Te debe llegar un mensaje.

El `.env` está en `.gitignore`. **Nunca** pongas el token en el código ni en `config.json`.

## 3. GitHub Actions (cada hora, gratis)

1. Haz un fork o sube tu copia como **repo público**. Los minutos son gratis en repos públicos, y los Secrets no se ven aunque el repo lo sea.
2. Sube tus secretos desde tu `.env` (no se imprimen):
   ```bash
   gh secret set -f .env
   ```
   También puedes darlos de alta a mano en *Settings → Secrets and variables → Actions*: `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.
3. En la pestaña **Actions**, habilita los workflows si GitHub lo pide.
4. Prueba manual con alerta forzada:
   ```bash
   gh workflow run monitor.yml -f modos=ida,redondo,regreso -f umbral=99999
   ```

El workflow (`.github/workflows/monitor.yml`) corre al minuto 17 de cada hora (UTC) y hace commit de `precios.md`, `precios.csv` y `estado.json`. Si algo falla, sube capturas de pantalla como *artifact* por 7 días.

Para pausarlo sin tocar código: `gh workflow disable monitor.yml`. Para reanudarlo: `gh workflow enable monitor.yml`.

> ⚠️ En un repo público, cualquiera puede ver tu ruta, fechas e historial de precios (no tus secretos).

## 4. Alternativa: tu computadora (si Volaris bloquea a GitHub)

Si en Actions ves estados `bloqueo` (captcha, 403, página vacía), corre el monitor desde tu máquina. `scripts/correr-local.sh` ejecuta el monitor y sube el registro.

Linux o macOS con `cron` (`crontab -e`):

```cron
17 * * * * /ruta/a/volaris-monitor/scripts/correr-local.sh >> /ruta/a/volaris-monitor/monitor.log 2>&1
```

Y apaga el de Actions con `gh workflow disable monitor.yml`.

## Qué NO hace (a propósito)

- No usa proxies, no rota IPs y no intenta resolver ni evadir captchas o sistemas anti-bot. Si aparece un captcha, registra `bloqueo` y lo vuelve a intentar en la siguiente hora.
- Hace como máximo 1 reintento, tras 60 s, y solo si el fallo no fue un bloqueo.
- No inicia sesión, no llena datos de pasajeros y no llega al pago.

## Notas

- Las tarifas, el equipaje y los asientos de Volaris son **dinámicos** y pueden cambiar de una hora a otra.
- El precio "Zero" es el que muestra el sitio como *tarifa preferencial*, por pasajero y **sin** TUA.
- Si Volaris cambia su página, el monitor dejará de encontrar los datos y te avisará tras los fallos seguidos. Las capturas de error ayudan a ajustar los selectores en `src/volaris.mjs`.

Licencia MIT.
