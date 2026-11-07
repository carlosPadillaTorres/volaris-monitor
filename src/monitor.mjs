// Punto de entrada: corre los modos activos, registra precios y manda alertas.
// Uso: npm run monitor   (o: MODOS=ida,redondo UMBRAL=99999 npm run monitor)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirNavegador, buscar, vuelosDirectos, cotizarExtras, urlBusqueda, BloqueoError } from './volaris.mjs';
import { agregarFilaCsv, generarMarkdown } from './registro.mjs';
import { enviarTelegram, escaparHtml } from './telegram.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVOS = {
  config: path.join(RAIZ, 'config.json'),
  estado: path.join(RAIZ, 'estado.json'),
  csv: path.join(RAIZ, 'precios.csv'),
  md: path.join(RAIZ, 'precios.md'),
  capturas: path.join(RAIZ, 'capturas'),
};
const MODOS_VALIDOS = ['ida', 'redondo', 'regreso'];
const ESPERA_REINTENTO_MS = 60_000;

// ---------- utilidades ----------
const leerJson = (f, def) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : def);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const mxn = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

function ahoraEn(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, fechaHora: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` };
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const hora = (iso) => iso.slice(11, 16);
const dia = (iso) => `${Number(iso.slice(8, 10))}/${MESES[Number(iso.slice(5, 7)) - 1]}`;
const horario = (v) => `${dia(v.salida)} ${hora(v.salida)}–${hora(v.llegada)}`;

function cargarConfig() {
  const cfg = leerJson(ARCHIVOS.config, null);
  if (!cfg) throw new Error('No existe config.json');
  let modos = MODOS_VALIDOS.filter((m) => cfg.modos?.[m]?.activo);
  if (process.env.MODOS) {
    modos = process.env.MODOS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const malos = modos.filter((m) => !MODOS_VALIDOS.includes(m));
    if (malos.length) throw new Error(`Modo(s) no válido(s): ${malos.join(', ')}. Usa: ${MODOS_VALIDOS.join(', ')}`);
  }
  const forzado = process.env.UMBRAL ? Number(process.env.UMBRAL) : null;
  if (forzado !== null && Number.isNaN(forzado)) throw new Error('UMBRAL debe ser un número');
  return {
    cfg, modos, forzado,
    extras: cfg.cotizar_extras !== false && process.env.SIN_EXTRAS !== '1',
    headless: process.env.HEADLESS !== '0',
  };
}

function tramosDe(modo, cfg) {
  const ida = { origen: cfg.origen, destino: cfg.destino, fecha: cfg.fecha_ida };
  const reg = { origen: cfg.destino, destino: cfg.origen, fecha: cfg.fecha_regreso };
  if (modo === 'ida') return { tramos: [ida], busqueda: { origen: ida.origen, destino: ida.destino, fechaIda: ida.fecha } };
  if (modo === 'regreso') return { tramos: [reg], busqueda: { origen: reg.origen, destino: reg.destino, fechaIda: reg.fecha } };
  return { tramos: [ida, reg], busqueda: { origen: ida.origen, destino: ida.destino, fechaIda: ida.fecha, fechaRegreso: reg.fecha } };
}

// ---------- un modo ----------
async function correrModo(browser, modo, ctx, cacheExtras, estado) {
  const { cfg, forzado } = ctx;
  const adultos = cfg.adultos;
  const maletas = cfg.maletas_documentadas_total ?? 0;
  const { tramos, busqueda } = tramosDe(modo, cfg);

  // 1) Boleto (búsqueda con todos los pasajeros), con 1 reintento si no fue bloqueo
  let res;
  for (let intento = 1; ; intento++) {
    try {
      res = await buscar(browser, { ...busqueda, adultos }, { carpetaCapturas: ARCHIVOS.capturas, etiqueta: modo });
      break;
    } catch (e) {
      if (intento >= 2 || e instanceof BloqueoError) throw e;
      console.log(`  ↻ falló (${e.message}); reintento en ${ESPERA_REINTENTO_MS / 1000} s`);
      await dormir(ESPERA_REINTENTO_MS);
    }
  }

  const elegidos = [];
  for (const t of tramos) {
    const v = vuelosDirectos(res.data, t.origen, t.destino)[0];
    if (!v) return { estado: 'sin vuelo directo', detalle: `No hay vuelo sin escalas disponible ${t.origen}→${t.destino} el ${t.fecha}`, link: res.url };
    elegidos.push({ ...v, fecha: t.fecha });
  }

  const boletoPP = elegidos.reduce((s, v) => s + v.porPersona, 0);
  const tuaPP = elegidos.every((v) => v.tuaPorPersona != null) ? elegidos.reduce((s, v) => s + v.tuaPorPersona, 0) : null;
  const notas = [];
  if (modo === 'redondo') notas.push(`ida ${mxn(elegidos[0].porPersona)} + regreso ${mxn(elegidos[1].porPersona)}`);

  // 2) TUA: registrar y avisar si cambia
  const avisosTua = [];
  estado.tua ??= {};
  for (const v of elegidos) {
    const k = `${v.origen}-${v.destino}-${v.fecha}`;
    const antes = estado.tua[k];
    if (v.tuaPorPersona != null && antes != null && antes !== v.tuaPorPersona) {
      avisosTua.push(`${v.origen}→${v.destino}: TUA pasó de ${mxn(antes)} a ${mxn(v.tuaPorPersona)} por persona`);
    }
    if (v.tuaPorPersona != null) estado.tua[k] = v.tuaPorPersona;
  }
  notas.push(...avisosTua);

  // 3) Extras (equipaje y asientos) por tramo
  let estadoModo = 'ok';
  let extras = [];
  if (ctx.extras) {
    try {
      for (const v of elegidos) {
        const clave = `${v.origen}-${v.destino}-${v.fecha}-${v.vuelo}`;
        if (!cacheExtras.has(clave)) {
          cacheExtras.set(clave, cotizarExtras(browser, v, { carpetaCapturas: ARCHIVOS.capturas, etiqueta: `${modo}_${v.origen}${v.destino}` }));
        }
        extras.push(await cacheExtras.get(clave));
      }
      extras.forEach((x, i) => (x.notas ?? []).forEach((n) => notas.push(`${elegidos[i].origen}→${elegidos[i].destino} ${n}`)));
      if (extras.length > 1 && extras.some((x) => x.mano !== extras[0].mano)) {
        notas.push(`mano por tramo: ${extras.map((x) => mxn(x.mano)).join(' / ')}`);
      }
    } catch (e) {
      estadoModo = 'parcial';
      extras = [];
      notas.push(e.message);
    }
  }
  const sumaExtras = (campo) => (extras.length && extras.every((x) => x[campo] != null) ? extras.reduce((s, x) => s + x[campo], 0) : null);
  const mano = sumaExtras('mano');
  const maleta = sumaExtras('maleta');
  const asMin = sumaExtras('asientoMin');
  const asMax = sumaExtras('asientoMax');

  // 4) Umbrales
  const m = cfg.modos[modo] ?? {};
  const disparos = [];
  const maletaPrecio = maleta != null ? maleta * maletas : null;
  if (modo === 'redondo') {
    const u = forzado ?? m.umbral_suma_por_persona;
    if (u != null && boletoPP < u) disparos.push(`suma ida + regreso ${mxn(boletoPP)} < ${mxn(u)} por persona`);
  } else {
    const u = forzado ?? m.umbral_por_persona;
    if (u != null && boletoPP < u) disparos.push(`${mxn(boletoPP)} < ${mxn(u)} por persona`);
  }
  if (m.umbral_con_tua_por_persona != null && tuaPP != null && boletoPP + tuaPP < m.umbral_con_tua_por_persona) {
    disparos.push(`con TUA ${mxn(boletoPP + tuaPP)} < ${mxn(m.umbral_con_tua_por_persona)} por persona`);
  }
  // umbral_maleta (opcional): además del boleto, la(s) maleta(s) documentada(s) deben costar menos de esto.
  // Si no se pudo cotizar la maleta, se avisa igual por el boleto (mejor un aviso de más que perder el precio).
  if (disparos.length && m.umbral_maleta != null && forzado == null) {
    if (maletaPrecio == null) disparos.push('no se pudo cotizar la maleta; revísala en el sitio');
    else if (maletaPrecio < m.umbral_maleta) disparos.push(`maleta documentada ${mxn(maletaPrecio)} < ${mxn(m.umbral_maleta)}`);
    else disparos.length = 0;
  }

  let alerta = 'no';
  const enviar = disparos.length || (cfg.alertar_cambio_tua !== false && avisosTua.length);
  if (enviar) {
    const lineas = [
      forzado != null ? '🧪 <i>Prueba con umbral forzado</i>' : null,
      disparos.length ? '🔔 <b>Volaris: precio bajo</b>' : 'ℹ️ <b>Volaris: cambió la TUA</b>',
      `<b>Modo:</b> ${modo}`,
      ...elegidos.map((v) => `<b>${v.origen}→${v.destino}</b> ${dia(v.salida)} · ${escaparHtml(v.vuelo)} · ${hora(v.salida)} → ${hora(v.llegada)} · ${mxn(v.porPersona)} pp`),
      `<b>Boleto Zero (sin TUA):</b> ${mxn(boletoPP)} por persona · ${mxn(boletoPP * adultos)} total (${adultos} adultos)`,
      tuaPP != null ? `<b>TUA:</b> ${mxn(tuaPP)} por persona · ${mxn(tuaPP * adultos)} total` : null,
      maletaPrecio != null ? `<b>Maleta documentada (${maletas}):</b> ${mxn(maletaPrecio)}` : null,
      mano != null ? `<b>Equipaje de mano:</b> ${mxn(mano)} por persona` : null,
      ...disparos.map((d) => `✅ ${escaparHtml(d)}`),
      ...avisosTua.map((a) => `⚠️ ${escaparHtml(a)}`),
      `<a href="${escaparHtml(res.url)}">Abrir búsqueda en volaris.com</a>`,
    ].filter(Boolean);
    alerta = (await enviarTelegram(lineas.join('\n'))) ? 'sí' : 'falló envío';
    if (forzado != null) alerta += ' (prueba)';
  }

  return {
    estado: estadoModo,
    vuelo: elegidos.map((v) => v.vuelo).join(' / '),
    horario: elegidos.map(horario).join(' / '),
    boleto_pp: boletoPP,
    boleto_total: boletoPP * adultos,
    tua_pp: tuaPP,
    tua_total: tuaPP != null ? tuaPP * adultos : null,
    boleto_mas_tua_pp: tuaPP != null ? boletoPP + tuaPP : null,
    mano_pp_por_vuelo: extras.length ? extras[0].mano : null,
    mano_total: mano != null ? mano * adultos : null,
    maleta_precio: maletaPrecio,
    maleta_pp_prorrateada: maleta != null ? Math.round((maleta * maletas) / adultos) : null,
    asiento_min_pp: asMin,
    asiento_max_pp: asMax,
    asientos_total_min: asMin != null ? asMin * adultos : null,
    asientos_total_max: asMax != null ? asMax * adultos : null,
    alerta,
    detalle: notas.join(' | '),
    link: res.url,
  };
}

// ---------- principal ----------
async function main() {
  const ctx = cargarConfig();
  const { cfg } = ctx;
  const ahora = ahoraEn(cfg.zona_horaria ?? 'America/Mexico_City');

  if (cfg.fecha_fin && ahora.fecha > cfg.fecha_fin) {
    console.log(`Hoy (${ahora.fecha}) es posterior a fecha_fin (${cfg.fecha_fin}); no se ejecuta nada.`);
    return;
  }
  const modos = ctx.modos.filter((modo) => {
    const ultimaFecha = tramosDe(modo, cfg).tramos[0].fecha;
    if (ultimaFecha < ahora.fecha) { console.log(`Se omite "${modo}": su vuelo (${ultimaFecha}) ya pasó.`); return false; }
    return true;
  });
  if (!modos.length) { console.log('No hay modos activos. Revisa "modos" en config.json o la variable MODOS.'); return; }
  console.log(`[${ahora.fechaHora}] Modos: ${modos.join(', ')}${ctx.forzado != null ? ` · UMBRAL forzado: ${ctx.forzado}` : ''}`);

  const estado = leerJson(ARCHIVOS.estado, {});
  estado.fallos_consecutivos ??= {};
  const limite = cfg.fallos_para_alerta ?? 3;
  const cacheExtras = new Map();

  let browser;
  try {
    browser = await abrirNavegador({ headless: ctx.headless });
    for (const modo of modos) {
      console.log(`▶ ${modo}`);
      let fila;
      try {
        fila = await correrModo(browser, modo, ctx, cacheExtras, estado);
      } catch (e) {
        fila = { estado: e instanceof BloqueoError ? 'bloqueo' : 'error', detalle: String(e.message).split('\n')[0], alerta: 'no', link: urlBusqueda({ ...tramosDe(modo, cfg).busqueda, adultos: cfg.adultos }) };
      }
      fila.fecha_hora = ahora.fechaHora;
      fila.modo = modo;

      // fallos consecutivos ("sin vuelo directo" no es fallo del script)
      const fallo = ['error', 'bloqueo', 'parcial'].includes(fila.estado);
      const n = fallo ? (estado.fallos_consecutivos[modo] ?? 0) + 1 : 0;
      estado.fallos_consecutivos[modo] = n;
      if (fallo && (n === limite || (n > limite && (n - limite) % 24 === 0))) {
        const ok = await enviarTelegram([
          `🚨 <b>volaris-monitor: ${n} fallos seguidos</b> en modo <b>${modo}</b>`,
          `Último estado: ${fila.estado}`,
          `Detalle: ${escaparHtml(fila.detalle ?? '')}`,
          fila.estado === 'bloqueo' ? 'Posible captcha/bloqueo de Volaris. Considera correrlo desde tu máquina.' : 'Puede que Volaris haya cambiado su página.',
        ].join('\n'));
        if (ok) fila.alerta = fila.alerta === 'sí' ? 'sí (+fallos)' : 'fallos';
      }

      agregarFilaCsv(ARCHIVOS.csv, fila);
      const resumen = fila.boleto_pp != null ? `${fila.vuelo} ${mxn(fila.boleto_pp)} pp` : fila.detalle;
      console.log(`  ${fila.estado === 'ok' ? '✅' : '⚠️'} ${fila.estado}: ${resumen} · alerta: ${fila.alerta}${fila.detalle && fila.boleto_pp != null ? ` · ${fila.detalle}` : ''}`);
    }
  } finally {
    await browser?.close();
    estado.ultima_ejecucion = ahora.fechaHora;
    fs.writeFileSync(ARCHIVOS.estado, JSON.stringify(estado, null, 2) + '\n');
    if (fs.existsSync(ARCHIVOS.csv)) generarMarkdown(ARCHIVOS.csv, ARCHIVOS.md, cfg);
  }
}

main().catch(async (e) => {
  console.error('Error inesperado:', e);
  await enviarTelegram(`🚨 <b>volaris-monitor</b> terminó con error inesperado: ${escaparHtml(e.message)}`);
  process.exit(1);
});
