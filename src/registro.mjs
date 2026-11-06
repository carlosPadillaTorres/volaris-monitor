// Registro en precios.csv (fuente de verdad) y precios.md (se regenera desde el CSV).
import fs from 'node:fs';

export const COLUMNAS = [
  'fecha_hora', 'modo', 'estado', 'vuelo', 'horario',
  'boleto_pp', 'boleto_total', 'tua_pp', 'tua_total', 'boleto_mas_tua_pp',
  'mano_pp_por_vuelo', 'mano_total', 'maleta_precio', 'maleta_pp_prorrateada',
  'asiento_min_pp', 'asiento_max_pp', 'asientos_total_min', 'asientos_total_max',
  'alerta', 'detalle', 'link',
];

const BOM = '﻿'; // para que Excel lea bien los acentos

const csvCampo = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function leerCsv(archivo) {
  if (!fs.existsSync(archivo)) return [];
  const texto = fs.readFileSync(archivo, 'utf8').replace(/^﻿/, '');
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas;
  return resto.filter((f) => f.length > 1).map((f) => Object.fromEntries(cab.map((k, i) => [k, f[i] ?? ''])));
}

export function agregarFilaCsv(archivo, fila) {
  const nuevo = !fs.existsSync(archivo);
  const linea = COLUMNAS.map((k) => csvCampo(fila[k])).join(',') + '\n';
  if (nuevo) fs.writeFileSync(archivo, BOM + COLUMNAS.join(',') + '\n' + linea);
  else fs.appendFileSync(archivo, linea);
}

const mxn = (v) => (v === '' || v === null || v === undefined ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);

const SECCIONES = {
  ida: 'Ida',
  redondo: 'Redondo (ida + regreso)',
  regreso: 'Regreso',
};

export function generarMarkdown(archivoCsv, archivoMd, cfg) {
  const filas = leerCsv(archivoCsv);
  const cab = '| Fecha/hora (CDMX) | Modo | Vuelo | Boleto por persona | Boleto total | TUA por persona | Equipaje de mano | Maleta documentada | Asientos | ¿Alerta enviada? |\n|---|---|---|---|---|---|---|---|---|---|';
  let md = `# Precios Volaris ${cfg.origen} ↔ ${cfg.destino}\n\n`;
  md += `Tarifa Zero, vuelo sin escalas más barato, ${cfg.adultos} adulto(s), ${cfg.maletas_documentadas_total} maleta(s) documentada(s) en total. Precios en MXN; el boleto **no incluye TUA** (va en su propia columna).\n`;
  md += `Equipaje de mano: precio por pasajero y por vuelo · total. Maleta: precio de la maleta (total del grupo por vuelo) · prorrateado por persona. Asientos: rango por persona · rango total.\n\n`;
  md += '_Archivo generado automáticamente desde `precios.csv`; no lo edites a mano._\n';
  for (const [modo, titulo] of Object.entries(SECCIONES)) {
    const del = filas.filter((f) => f.modo === modo);
    if (!del.length) continue;
    md += `\n## ${titulo}\n\n${cab}\n`;
    for (const f of del) {
      const ok = f.estado === 'ok' || f.estado === 'parcial';
      const vuelo = ok ? `${f.vuelo} · ${f.horario}` : `❌ ${f.estado}: ${f.detalle}`.replace(/\|/g, '/');
      const boleto = !ok ? '—' : (modo === 'redondo' && f.detalle ? `${mxn(f.boleto_pp)} (${f.detalle})` : mxn(f.boleto_pp));
      const mano = f.mano_pp_por_vuelo ? `${mxn(f.mano_pp_por_vuelo)} pp/vuelo · ${mxn(f.mano_total)} total` : '—';
      const maleta = f.maleta_precio ? `${mxn(f.maleta_precio)} · ${mxn(f.maleta_pp_prorrateada)} pp` : '—';
      const asientos = f.asiento_min_pp ? `${mxn(f.asiento_min_pp)}–${mxn(f.asiento_max_pp)} pp · ${mxn(f.asientos_total_min)}–${mxn(f.asientos_total_max)} total` : '—';
      md += `| ${f.fecha_hora} | ${modo} | ${vuelo} | ${boleto} | ${ok ? mxn(f.boleto_total) : '—'} | ${ok ? mxn(f.tua_pp) : '—'} | ${mano} | ${maleta} | ${asientos} | ${f.alerta || 'no'} |\n`;
    }
  }
  fs.writeFileSync(archivoMd, md);
}
