// Interacción con volaris.com mediante Playwright.
// Los precios se leen de las respuestas JSON que la propia página pide (vistas desde el navegador),
// no de selectores CSS. Los clics usan roles y textos visibles.
// Reglas: sin login, sin datos de pasajeros, nunca se llega a la pantalla de pago.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://www.volaris.com/flight/select';
const TEXTO_BLOQUEO = /captcha|access denied|acceso denegado|unusual traffic|verify you are (a )?human|are you a robot|request blocked|bot detection/i;

export class BloqueoError extends Error {
  constructor(msg) { super(msg); this.name = 'BloqueoError'; }
}

// Tipos de cargo de Navitaire: 0 tarifa, 4 cargo de viaje, 5 impuesto, 6 servicio (suman); 1 y 7 descuentos (restan).
const SUMA = new Set([0, 4, 5, 6]);
const RESTA = new Set([1, 7]);
export const totalCargos = (cargos = []) =>
  cargos.reduce((s, c) => s + (SUMA.has(c.type) ? c.amount : RESTA.has(c.type) ? -c.amount : 0), 0);

const mdy = (iso) => { const [y, m, d] = iso.split('-'); return `${m}-${d}-${y}`; };

export function urlBusqueda({ origen, destino, fechaIda, fechaRegreso, adultos }) {
  const p = new URLSearchParams({ adt: String(adultos), chd: '0', in1: '0', rr: String(Boolean(fechaRegreso)), cc: 'MXN', dd1: mdy(fechaIda) });
  if (fechaRegreso) p.set('dd2', mdy(fechaRegreso));
  p.set('culture', 'es-MX');
  p.set('o1', origen);
  p.set('d1', destino);
  return `${BASE}?${p}`;
}

export async function abrirNavegador({ headless = true } = {}) {
  return chromium.launch({ headless });
}

const nuevoContexto = (browser) => browser.newContext({
  locale: 'es-MX',
  timezoneId: 'America/Mexico_City',
  viewport: { width: 1366, height: 900 },
});

async function captura(page, carpeta, etiqueta) {
  try {
    fs.mkdirSync(carpeta, { recursive: true });
    const archivo = path.join(carpeta, `${new Date().toISOString().replace(/[:.]/g, '-')}_${etiqueta}.png`);
    await page.screenshot({ path: archivo, fullPage: true });
    console.log(`  📸 captura: ${archivo}`);
  } catch { /* la página pudo haberse cerrado */ }
}

async function revisarBloqueo(page) {
  const texto = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const titulo = await page.title().catch(() => '');
  if (TEXTO_BLOQUEO.test(texto) || TEXTO_BLOQUEO.test(titulo)) throw new BloqueoError('La página mostró un captcha o un aviso de bloqueo');
  if (texto.trim().length < 50) throw new BloqueoError('La página llegó vacía (posible bloqueo)');
}

const esRespuesta = (fragmento, metodo = 'POST') => (r) => r.url().includes(fragmento) && r.request().method() === metodo;

async function abrirBusqueda(page, url, extraEspera = []) {
  const disponibilidad = page.waitForResponse(esRespuesta('/api/v3/availability/search'), { timeout: 75000 });
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (resp && resp.status() >= 400) throw new BloqueoError(`HTTP ${resp.status()} al abrir la búsqueda`);
  let r;
  try { r = await disponibilidad; } catch {
    await revisarBloqueo(page);
    throw new Error('No llegó la respuesta de disponibilidad (availability/search); ¿cambió la página?');
  }
  if (r.status() === 403 || r.status() === 429) throw new BloqueoError(`availability/search respondió HTTP ${r.status()}`);
  if (!r.ok()) throw new Error(`availability/search respondió HTTP ${r.status()}`);
  return r.json();
}

// ---------- Búsqueda (boleto) ----------

export async function buscar(browser, params, { carpetaCapturas, etiqueta }) {
  const ctx = await nuevoContexto(browser);
  const page = await ctx.newPage();
  const url = urlBusqueda(params);
  try {
    const data = await abrirBusqueda(page, url);
    if (data.currencyCode && data.currencyCode !== 'MXN') throw new Error(`Moneda inesperada: ${data.currencyCode}`);
    return { url, data };
  } catch (e) {
    await captura(page, carpetaCapturas, `${etiqueta}_busqueda`);
    throw e;
  } finally {
    await ctx.close();
  }
}

// Vuelos sin escalas de un mercado, ordenados del más barato al más caro (tarifa Zero = tarifa base).
export function vuelosDirectos(data, origen, destino) {
  const out = [];
  for (const res of data.results ?? []) {
    for (const trip of res.trips ?? []) {
      for (const j of trip.journeysAvailableByMarket?.[`${origen}|${destino}`] ?? []) {
        if (j.stops !== 0 || j.isSoldOutFlight) continue;
        for (const f of j.fares ?? []) {
          const fa = data.faresAvailable?.[f.fareAvailabilityKey];
          const pf = fa?.fares?.[0]?.passengerFares?.find((p) => p.passengerType === 'ADT');
          if (!pf) continue;
          out.push({
            origen, destino,
            vuelo: j.segments.map((s) => `${s.identifier.carrierCode} ${s.identifier.identifier}`).join(' + '),
            salida: j.designator.departure,
            llegada: j.designator.arrival,
            porPersona: pf.fareAmount,
            tuaPorPersona: f.tuaAmount ?? null,
            disponibles: f.details?.[0]?.availableCount ?? null,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.porPersona - b.porPersona);
}

// ---------- Extras (equipaje y asientos) ----------
// Se recorre el flujo con 1 adulto (los precios de extras son por pasajero) para no apartar
// lugares de más; al terminar se vuelve a la búsqueda, lo que hace que el sitio vacíe el carrito.

function preciosEquipaje(quote) {
  const pax = Object.values(quote?.passengers ?? {})[0];
  const fee = (codigo) => {
    const f = pax?.fees?.find((x) => x.code === codigo || x.ssrCode === codigo);
    return f ? totalCargos(f.serviceCharges) : null;
  };
  return { mano: fee('CRB1'), maleta: fee('BGB1') };
}

export function preciosAsientos(seatmaps, origen, destino) {
  const sm = (seatmaps ?? []).find((s) => s.seatMap?.departureStation === origen && s.seatMap?.arrivalStation === destino) ?? seatmaps?.[0];
  if (!sm) return null;
  const grupos = Object.values(sm.fees ?? {})[0]?.groups ?? {};
  const precios = [];
  for (const deck of Object.values(sm.seatMap.decks ?? {})) {
    for (const comp of Object.values(deck.compartments ?? {})) {
      for (const u of comp.units ?? []) {
        // availability 5 = libre; 4 = apartado por esta misma sesión (el sitio pre-asigna uno)
        if (!u.assignable || ![4, 5].includes(u.availability)) continue;
        const g = grupos[u.group];
        if (!g) continue;
        precios.push(totalCargos(g.fees?.[0]?.serviceCharges));
      }
    }
  }
  if (!precios.length) return null;
  return { min: Math.min(...precios), max: Math.max(...precios), disponibles: precios.length };
}

const montoUI = (texto, etiqueta) => {
  const m = texto.match(new RegExp(`${etiqueta}[\\s\\S]{0,60}?\\$([\\d,]+) MXN`));
  return m ? Number(m[1].replace(/,/g, '')) : null;
};

export async function cotizarExtras(browser, { origen, destino, fecha, vuelo }, { carpetaCapturas, etiqueta }) {
  const ctx = await nuevoContexto(browser);
  const page = await ctx.newPage();
  const url = urlBusqueda({ origen, destino, fechaIda: fecha, adultos: 1 });
  const primerVuelo = vuelo.split(' + ')[0];
  let paso = 'abrir búsqueda';
  try {
    await abrirBusqueda(page, url);

    paso = `abrir tarifas del vuelo ${primerVuelo}`;
    await page.getByText(primerVuelo).first().waitFor({ timeout: 30000 });
    const tarjeta = page.locator('div').filter({ hasText: primerVuelo }).filter({ hasText: /\$[\d,]+ MXN/ }).last();
    // el primer monto de la tarjeta es la tarifa (el segundo es la TUA)
    await tarjeta.getByText(/\$[\d,]+\s*MXN/).first().click();

    paso = 'elegir tarifa Zero';
    const quoteP = page.waitForResponse(esRespuesta('/api/booking/quote'), { timeout: 45000 });
    const columnaZero = page.locator('div')
      .filter({ has: page.getByText('Zero', { exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Seleccionar', exact: true }) })
      .last();
    await columnaZero.getByRole('button', { name: 'Seleccionar', exact: true }).first().click();
    await page.getByRole('button', { name: /Mantener Zero/i }).click({ timeout: 15000 }).catch(() => {});
    const quote = await (await quoteP).json();
    const equipaje = preciosEquipaje(quote);

    // cerrar el aviso "Agrega equipaje de mano" sin agregar nada
    await page.waitForTimeout(2500);
    await page.keyboard.press('Escape').catch(() => {});
    await page.locator('[role=dialog], mat-dialog-container, .modal').getByText('close', { exact: true }).first().click({ timeout: 3000 }).catch(() => {});

    // validación cruzada con lo que muestra la pantalla ("Maleta de mano · Desde $X MXN");
    // si difieren, gana la pantalla (es lo que pagarías) y se deja nota
    const texto = await page.locator('body').innerText();
    const ui = { mano: montoUI(texto, 'Maleta de mano'), maleta: montoUI(texto, 'Maleta documentada') };
    const notas = [];
    for (const k of ['mano', 'maleta']) {
      if (ui[k] != null && equipaje[k] != null && ui[k] !== equipaje[k]) notas.push(`${k}: JSON ${equipaje[k]} vs pantalla ${ui[k]}`);
      equipaje[k] = ui[k] ?? equipaje[k];
    }

    paso = 'continuar a asientos';
    // "Paga después" la TUA: es solo una opción de la reserva, no se paga nada
    // el aviso de equipaje o un spinner pueden tapar la página unos segundos: reintentar el cierre y el clic
    for (let i = 1; ; i++) {
      try {
        await page.getByText('Paga después', { exact: true }).first().click({ timeout: 10000 });
        break;
      } catch (e) {
        if (i >= 3) throw e;
        await page.keyboard.press('Escape').catch(() => {});
        await page.locator('[role=dialog], mat-dialog-container, .modal').getByText('close', { exact: true }).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
    const seatP = page.waitForResponse(esRespuesta('/api/seatmap/getallseatmaps', 'GET'), { timeout: 60000 });
    await page.getByRole('button', { name: /Continuar a asientos/i }).last().click();
    const asientos = preciosAsientos(await (await seatP).json(), origen, destino);
    if (!asientos) throw new Error('No se encontraron asientos con precio en el mapa');

    paso = 'vaciar carrito';
    const reset = page.waitForResponse(esRespuesta('/api/booking/reset', 'DELETE'), { timeout: 45000 }).catch(() => null);
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await reset;

    return { mano: equipaje.mano, maleta: equipaje.maleta, asientoMin: asientos.min, asientoMax: asientos.max, notas };
  } catch (e) {
    await captura(page, carpetaCapturas, `${etiqueta}_extras`);
    e.message = `Extras (${origen}→${destino}, paso "${paso}"): ${String(e.message).split('\n')[0]}`;
    throw e;
  } finally {
    await ctx.close();
  }
}
