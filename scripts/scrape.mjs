#!/usr/bin/env node
/**
 * Liest die Angebotstabellen aller Projekte aus und schreibt
 *   data/latest.json     – aktueller Bestand
 *   data/history.json    – Zeitreihe je Lauf (für die Verlaufsgrafik)
 *   data/changes.json    – Änderungsprotokoll (Status-/Preiswechsel, Zu-/Abgänge)
 *   data/snapshots/*.json– vollständiger Snapshot je Lauf
 *
 * Ohne externe Abhängigkeiten: node scripts/scrape.mjs [--offline <verzeichnis>]
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "data");
const SNAPS = path.join(DATA, "snapshots");

/** Projektregister – gepflegt in data/projects.json (siehe README). */
export async function loadProjects() {
  const raw = await readJson(path.join(DATA, "projects.json"), null);
  const list = raw && Array.isArray(raw.projects) ? raw.projects : [];
  if (!list.length) throw new Error("data/projects.json enthält keine Projekte");
  return list.map(p => ({
    type: "apartment",
    groupLabel: "Haus",
    ...p,
    id: String(p.id || "").trim(),
    url: String(p.url || "").trim()
  }));
}

/* --------------------------------------------------------------------------
   HTML-Hilfen (bewusst ohne DOM-Bibliothek)
-------------------------------------------------------------------------- */
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  sup2: "²", sup3: "³", deg: "°", auml: "ä", ouml: "ö", uuml: "ü",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è",
  ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", hellip: "…"
};

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+\d*);/gi, (m, name) => (name in ENTITIES ? ENTITIES[name] : m));
}

function textOf(htmlFragment) {
  return decodeEntities(
    String(htmlFragment)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tagHtml, name) {
  const m = tagHtml.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

function firstPdf(htmlFragment) {
  const m = String(htmlFragment).match(/<a\b[^>]*href\s*=\s*["']([^"']*\.pdf[^"']*)["']/i);
  return m ? m[1] : null;
}

/* --------------------------------------------------------------------------
   Normalisierung
-------------------------------------------------------------------------- */
export function statusKey(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("verkauft")) return "sold";
  if (t.includes("reserv")) return "reserved";
  if (t.includes("frei") || t.includes("verfügbar") || t.includes("verfugbar")) return "available";
  return "unknown";
}

/** "2'250'000.-" / "1’210’000.–" → 2250000 ; "–" → null */
export function toPrice(text) {
  const digits = (text || "").replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return n >= 1000 ? n : null;
}

/** "156.3 m²" → 156.3 */
export function toNumber(text) {
  const m = (text || "").replace(/'/g, "").match(/(\d+(?:[.,]\d+)?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
}

function cleanPriceText(text, status) {
  const t = (text || "").trim();
  if (!t || /^[-–—]$/.test(t) || !/\d/.test(t)) return "–";
  if (status === "sold" && !/\d/.test(t)) return "–";
  return t;
}

/* --------------------------------------------------------------------------
   Parser 1 – klassische <table>-Layouts (Sonnenberg, Seeluft)
-------------------------------------------------------------------------- */
const SKIP_COLUMNS = /grundriss|anfrage|dokument|download|^$/i;

function columnRole(header) {
  const h = header.toLowerCase();
  // Wohnfläche zuerst ausschliessen, damit sie nicht als "Wohnung" durchgeht
  if (h.includes("wohnfläche") || h.includes("wohnflache")) return "area";
  if (h.includes("objekt") || h.includes("wohnung") || h.includes("haus") || /(^|\W)nr\.?(\W|$)/.test(h)) return "id";
  if (h.includes("zimmer")) return "rooms";
  if (h.includes("wohnfläche") || h.includes("wohnflache")) return "area";
  if (h.includes("verkaufspreis") || h.includes("preis") || h.includes("chf")) return "price";
  if (h.includes("status")) return "status";
  if (h.includes("geschoss")) return "floor";
  return null;
}

export function parseTables(html, project) {
  const units = [];
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];

  for (const table of tables) {
    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    if (!rows.length) continue;

    const cellsOf = row =>
      (row.match(/<t[hd]\b[\s\S]*?<\/t[hd]>/gi) || []).map(c => ({ html: c, text: textOf(c) }));

    const headerIdx = rows.findIndex(r => {
      const t = textOf(r).toLowerCase();
      return t.includes("zimmer") && /(status|preis|chf)/.test(t);
    });
    if (headerIdx < 0) continue;

    const headers = cellsOf(rows[headerIdx]).map(c => c.text);
    const roles = headers.map(columnRole);
    const ix = {};
    roles.forEach((role, i) => { if (role && ix[role] === undefined) ix[role] = i; });
    if (ix.id === undefined || ix.rooms === undefined) continue;

    // Alle übrigen Spalten als Zusatzangaben mitnehmen (Grundstück, Kubatur, Keller …)
    const extraCols = headers
      .map((h, i) => ({ label: h.replace(/\*+$/, "").trim(), i }))
      .filter(({ label, i }) => !roles[i] && label && !SKIP_COLUMNS.test(label));

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const cells = cellsOf(rows[r]);
      if (!cells.length) continue;
      const at = i => (i !== undefined && cells[i] ? cells[i].text : "");

      const id = at(ix.id);
      // Wiederholte Kopfzeilen anhand des exakten Überschriftstextes erkennen –
      // eine Einheit darf durchaus "Wohnung 3" heissen.
      if (!id || headers.some(h => h.toLowerCase() === id.toLowerCase())) continue;
      if (!/\d/.test(id) && !/[a-z]/i.test(id)) continue;

      const status = statusKey(at(ix.status));
      const extra = {};
      for (const { label, i } of extraCols) {
        const v = at(i);
        if (v && !/^[-–—]$/.test(v)) extra[label] = v;
      }

      units.push({
        id: id.trim(),
        group: groupOf(id, project),
        kind: "unit",
        rooms: toNumber(at(ix.rooms)),
        area: toNumber(at(ix.area)),
        areaText: at(ix.area) || "–",
        floor: ix.floor !== undefined ? at(ix.floor) || null : null,
        price: toPrice(at(ix.price)),
        priceText: cleanPriceText(at(ix.price), status),
        status,
        extra,
        pdf: firstPdf(rows[r])
      });
    }
  }
  return units;
}

/* --------------------------------------------------------------------------
   Parser 2 – Div-Grid der Erlenstrasse (.ang_list > .whg_row)
-------------------------------------------------------------------------- */
export function parseAngList(html, project) {
  const listStart = html.search(/<div[^>]*class=["'][^"']*\bang_list\b/i);
  if (listStart < 0) return [];
  const section = html.slice(listStart, listStart + 120000);

  // Zeilen inkl. ihrer col-Divs einsammeln
  const rowRe = /<div\b([^>]*class=["'][^"']*\bwhg_row\b[^"']*["'][^>]*)>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bwhg_row\b|<div\b[^>]*class=["'][^"']*\bsub_list_info\b)/gi;

  let headers = {};          // col-Key -> Beschriftung
  const units = [];
  let match;

  while ((match = rowRe.exec(section)) !== null) {
    const tagAttrs = match[1];
    const body = match[2];
    const cls = attr(`<div ${tagAttrs}>`, "class") || "";

    const cols = {};
    const colRe = /<div\b[^>]*class=["']([^"']*\bcol[\w]*\b[^"']*)["'][^>]*>([\s\S]*?)<\/div>\s*(?=<div\b[^>]*class=["'][^"']*\bcol|$)/gi;
    let c;
    while ((c = colRe.exec(body)) !== null) {
      const key = (c[1].match(/\bcol[\w]*/) || [])[0];
      if (key && cols[key] === undefined) cols[key] = { text: textOf(c[2]), html: c[2] };
    }

    if (/\brow_header\b/.test(cls)) {
      // Kopfzeile: Spaltenbeschriftungen merken (Wohnungen und Parkierung getrennt)
      const scope = /\brow_head_pp\b/.test(cls) ? "pp" : "unit";
      headers[scope] = headers[scope] || {};
      for (const [k, v] of Object.entries(cols)) if (v.text) headers[scope][k] = v.text;
      continue;
    }
    if (!/\brow_item\b/.test(cls)) continue;   // Zwischenüberschriften überspringen

    const art = attr(`<div ${tagAttrs}>`, "data-art") || "whg";
    const isParking = art === "parkplatz";
    const scope = isParking ? "pp" : "unit";
    const label = k => (headers[scope] && headers[scope][k]) || k;
    const at = k => (cols[k] ? cols[k].text : "");

    const status = statusKey(attr(`<div ${tagAttrs}>`, "data-status") || at("col7"));
    const priceRaw = at("col7") || at("col6");

    if (isParking) {
      units.push({
        id: at("col2") || "Parkplatz",
        group: "Parkierung",
        kind: "parking",
        rooms: null, area: null, areaText: "–", floor: null,
        price: toPrice(priceRaw),
        priceText: cleanPriceText(priceRaw, status),
        status, extra: {}, pdf: firstPdf(body)
      });
      continue;
    }

    const id = at("col1");
    if (!id) continue;

    const extra = {};
    for (const key of ["col3", "col5", "col6"]) {
      const v = at(key);
      if (v && !/^[-–—]$/.test(v)) extra[label(key).replace(/\*+$/, "").trim()] = v;
    }

    units.push({
      id,
      group: groupOf(id, project),
      kind: "unit",
      rooms: toNumber(attr(`<div ${tagAttrs}>`, "data-zim") || at("col2")),
      area: toNumber(at("col4")),
      areaText: at("col4") || "–",
      floor: null,
      price: toPrice(priceRaw),
      priceText: cleanPriceText(priceRaw, status),
      status,
      extra,
      pdf: firstPdf(body)
    });
  }
  return units;
}

/* --------------------------------------------------------------------------
   Parser 3 – Beyonity Navigator (eingebettetes JSON `BVR_NAV`)

   Die Vermarktungstools von Beyonity liefern den vollständigen Bestand als
   JSON im Seitenquelltext mit. Statusbezeichnungen und Zusatzfelder stehen
   ebenfalls darin, werden also gelesen statt fest verdrahtet.
-------------------------------------------------------------------------- */
export function extractBvrNav(html) {
  const m = /BVR_NAV\s*=\s*\{/.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const PARKING_CATEGORIES = /^(parking|garage|carport|stellplatz)/i;
const FLOOR_TEXT = /^(EG|UG|DG|OG|Attika|Dachgeschoss|Untergeschoss|Erdgeschoss|\d+\.\s*(OG|UG))$/i;

/** custom_N-Felder tragen je Projekt andere Bedeutungen – hier bestimmt, nicht geraten. */
function detectCustomFields(units, override = {}) {
  const keys = new Set();
  units.forEach(u => Object.keys(u).forEach(k => { if (/^custom_\d+$/.test(k)) keys.add(k); }));
  const score = test => {
    let best = null, bestHits = 0;
    for (const k of keys) {
      const hits = units.filter(u => test(u[k])).length;
      if (hits > bestHits) { best = k; bestHits = hits; }
    }
    return bestHits >= Math.max(3, units.length * 0.3) ? best : null;
  };
  return {
    price: override.price || score(v => typeof v === "number" && v >= 50000),
    floor: override.floor || score(v => typeof v === "string" && FLOOR_TEXT.test(v.trim()))
  };
}

export function parseBeyonity(html, project) {
  const data = extractBvrNav(html);
  const proj = data && data.project;
  if (!proj || !proj.units) return [];

  const statusTable = (proj.settings && proj.settings.statustable) || {};
  const statusText = code => (statusTable[String(code)] || {}).dsc || "";

  // Beschriftete Zusatzfelder laut Projektdefinition (Aussenfläche, Keller, …)
  const extraLabels = {};
  for (const [key, def] of Object.entries(proj.properties || {})) {
    if (/^custom_\d+$/.test(key) && def && def.dsc) {
      extraLabels[key] = { label: def.dsc.trim(), format: def.format || "" };
    }
  }

  const all = Object.values(proj.units);
  const sellable = all.filter(u => {
    const cat = String(u.category || "");
    if (PARKING_CATEGORIES.test(cat)) return true;
    if (cat && cat !== "living") return false;            // infospot & Co. raus
    return u.status !== undefined && u.status !== null && statusText(u.status) !== "";
  });

  const fields = detectCustomFields(sellable, project.fields || {});

  return sellable.map(u => {
    const isParking = PARKING_CATEGORIES.test(String(u.category || ""));
    const id = String(u.name || u.se_id || u.dsc || u.id || "").trim();
    const area = typeof u.area === "number" ? u.area : toNumber(u.area);
    const priceRaw = (u.price !== "" && u.price != null) ? u.price
                   : (fields.price ? u[fields.price] : null);
    const price = typeof priceRaw === "number" ? priceRaw : toPrice(priceRaw);
    const status = statusKey(statusText(u.status));

    const extra = {};
    for (const [key, def] of Object.entries(extraLabels)) {
      const v = u[key];
      if (v === "" || v == null) continue;
      extra[def.label] = /area/.test(def.format) ? `${v} m²`
                       : /price/.test(def.format) ? `CHF ${Number(v).toLocaleString("de-CH")}`
                       : String(v);
    }

    return {
      id,
      group: isParking ? "Parkierung" : groupOf(id, project),
      kind: isParking ? "parking" : "unit",
      rooms: typeof u.rooms === "number" ? u.rooms : toNumber(u.rooms),
      area,
      areaText: area != null ? `${area} m²` : "–",
      floor: fields.floor ? (u[fields.floor] || null) : null,
      price,
      priceText: price != null ? `${price.toLocaleString("de-CH")}.–` : "–",
      status,
      extra,
      pdf: u.document || null
    };
  }).filter(u => u.id);
}

/* --------------------------------------------------------------------------
   Gruppierung (Haus A / Erlenstrasse 12 …)
-------------------------------------------------------------------------- */
export function groupOf(id, project) {
  const raw = String(id || "").trim();
  // Punktnotation (A1.0.1 = Haus A1, Geschoss 0, Wohnung 1)
  const dotted = raw.match(/^([A-Za-z0-9ÄÖÜ]+)\./);
  if (dotted) return `${project.groupLabel} ${dotted[1].toUpperCase()}`;
  const letters = raw.match(/^([A-Za-zÄÖÜ]+)/);
  if (letters) return `${project.groupLabel} ${letters[1].toUpperCase()}`;
  // Ziffernpräfix nur dann als Gebäude werten, wenn danach noch etwas folgt
  // (12a/12b = Haushälften). Reine Nummern sind fortlaufende Wohnungsnummern
  // und bilden keinen Gebäudeblock.
  const prefixed = raw.match(/^(\d+)\s*[.\-]?\s*[A-Za-zÄÖÜ]/);
  if (prefixed) return `${project.groupLabel} ${prefixed[1]}`;
  return project.groupLabel;
}

/* --------------------------------------------------------------------------
   Abruf
-------------------------------------------------------------------------- */
async function loadHtml(project, offlineDir) {
  if (offlineDir) return readFile(path.join(offlineDir, `${project.id}.html`), "utf8");
  const res = await fetch(project.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "de-CH,de;q=0.9"
    },
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Erkennt das Tabellenlayout selbst, damit neue Projekte ohne Konfiguration laufen. */
function detectLayout(html) {
  if (/\bBVR_NAV\s*=/.test(html)) return "beyonity";
  return /class=["'][^"']*\bang_list\b/i.test(html) ? "anglist" : "table";
}

/**
 * Gruppen sind nur sinnvoll, wenn sie echte Gebäudeblöcke sind (Haus A mit 8 Wohnungen).
 * Zerfällt ein Projekt in viele Kleinstgruppen (Erlenstrasse 12a/12b), wird flach gelistet.
 */
function shouldGroup(units) {
  const sizes = {};
  units.filter(u => u.kind === "unit").forEach(u => { sizes[u.group] = (sizes[u.group] || 0) + 1; });
  const groups = Object.values(sizes);
  if (groups.length < 2) return false;
  return !(groups.length > 3 && Math.max(...groups) <= 2);
}

/**
 * Parkierung erkennen. Heisst ein Gebäude "Garage", sind das Abstellplätze und
 * keine Wohnungen – sie dürfen die Wohnungskennzahlen nicht aufblähen.
 * Über `parkingGroups` / `livingGroups` in projects.json korrigierbar.
 */
export const PARKING_NAME =
  /(^|[\s\-_.])(garage[nr]?|tiefgarage|einstellhalle|autoeinstellhalle|parkplatz|parkpl(ä|ae)tze|parking|parkierung|carport|abstellplatz|aussenparkplatz|besucherparkplatz|motorrad|velo)([\s\-_.\d]|$)/i;

export function classifyUnits(units, project = {}) {
  const norm = s => String(s || "").toLowerCase().trim();
  const asParking = (project.parkingGroups || []).map(norm);
  const asLiving  = (project.livingGroups  || []).map(norm);

  return units.map(u => {
    const group = norm(u.group);
    if (asLiving.includes(group)) return u.kind === "unit" ? u : { ...u, kind: "unit" };
    const parking = u.kind === "parking"
      || asParking.includes(group)
      || PARKING_NAME.test(`${u.group || ""} ${u.id || ""} ${u.typeText || ""}`);
    return parking === (u.kind === "parking") ? u : { ...u, kind: parking ? "parking" : "unit" };
  });
}

export async function scrapeProject(project, offlineDir) {
  const html = await loadHtml(project, offlineDir);
  const layout = project.layout || detectLayout(html);
  const units = layout === "beyonity" ? parseBeyonity(html, project)
              : layout === "anglist"  ? parseAngList(html, project)
              :                         parseTables(html, project);
  if (!units.length) throw new Error("Keine Einheiten erkannt – Seitenstruktur hat sich vermutlich geändert");
  const classified = classifyUnits(units, project);
  return {
    units: classified,
    layout,
    grouped: project.grouped !== undefined ? project.grouped : shouldGroup(classified)
  };
}

/* --------------------------------------------------------------------------
   Auswertung
-------------------------------------------------------------------------- */
/** Zimmerzahl als stabiler Schlüssel: 4.5 -> "4.5", ohne Angabe -> "?" */
export function roomKey(rooms) {
  return typeof rooms === "number" && isFinite(rooms) ? rooms.toFixed(1) : "?";
}

export function summarize(units) {
  const live = units.filter(u => u.kind === "unit");
  const c = { total: live.length, available: 0, reserved: 0, sold: 0, unknown: 0 };
  for (const u of live) c[u.status]++;
  c.availableVolume = live
    .filter(u => u.status === "available")
    .reduce((s, u) => s + (u.price || 0), 0);

  // Aufschlüsselung nach Zimmerzahl – trägt den Zimmerfilter auch im Verlauf
  c.byRooms = {};
  for (const u of live) {
    const key = roomKey(u.rooms);
    const b = c.byRooms[key] ||
      (c.byRooms[key] = { total: 0, available: 0, reserved: 0, sold: 0, unknown: 0, availableVolume: 0 });
    b.total++;
    b[u.status]++;
    if (u.status === "available") b.availableVolume += u.price || 0;
  }
  return c;
}

export function diffUnits(prev, next) {
  const changes = [];
  const byId = list => new Map(list.map(u => [u.id, u]));
  const a = byId(prev || []);
  const b = byId(next || []);

  for (const [id, unit] of b) {
    const before = a.get(id);
    if (!before) {
      changes.push({ unit: id, type: "added", to: unit.status, priceTo: unit.price });
      continue;
    }
    if (before.status !== unit.status) {
      changes.push({ unit: id, type: "status", from: before.status, to: unit.status });
    }
    if ((before.price || null) !== (unit.price || null) && unit.status !== "sold" && before.status !== "sold") {
      changes.push({ unit: id, type: "price", priceFrom: before.price, priceTo: unit.price });
    }
  }
  for (const [id, unit] of a) {
    if (!b.has(id)) changes.push({ unit: id, type: "removed", from: unit.status });
  }
  return changes;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/* --------------------------------------------------------------------------
   Hauptlauf
-------------------------------------------------------------------------- */
async function main() {
  const offlineIdx = process.argv.indexOf("--offline");
  const offlineDir = offlineIdx > -1 ? path.resolve(process.argv[offlineIdx + 1]) : null;

  const PROJECTS = await loadProjects();
  const previous = await readJson(path.join(DATA, "latest.json"), null);
  const prevById = new Map((previous?.projects || []).map(p => [p.id, p]));

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const out = { generatedAt: now.toISOString(), projects: [] };
  const changeEntries = [];

  for (const project of PROJECTS) {
    const base = {
      id: project.id,
      name: project.name,
      url: project.link || project.url,
      type: project.type,
      groupLabel: project.groupLabel,
      adresse: project.adresse || null,
      ort: project.ort || null,
      land: project.land || null,
      koordinaten: Array.isArray(project.koordinaten) ? project.koordinaten : null
    };
    try {
      const { units, grouped } = await scrapeProject(project, offlineDir);
      base.grouped = grouped;
      const prev = prevById.get(project.id);
      if (prev?.units?.length) {
        for (const ch of diffUnits(prev.units.filter(u => u.kind === "unit"), units.filter(u => u.kind === "unit"))) {
          changeEntries.push({ date, project: project.id, projectName: project.name, ...ch });
        }
      }
      out.projects.push({ ...base, ok: true, error: null, fetchedAt: now.toISOString(), units, summary: summarize(units) });
      console.log(`✓ ${project.name}: ${units.length} Zeilen`);
    } catch (err) {
      // Fehlgeschlagener Abruf darf den Bestand nicht löschen – letzten Stand behalten
      const prev = prevById.get(project.id);
      out.projects.push({
        ...base,
        grouped: prev?.grouped !== undefined ? prev.grouped : true,
        ok: false,
        error: String(err.message || err),
        fetchedAt: prev?.fetchedAt || null,
        stale: Boolean(prev?.units?.length),
        units: prev?.units || [],
        summary: prev?.summary || summarize([])
      });
      console.error(`✗ ${project.name}: ${err.message || err}`);
    }
  }

  await mkdir(SNAPS, { recursive: true });
  await writeFile(path.join(DATA, "latest.json"), JSON.stringify(out, null, 2) + "\n");
  await writeFile(path.join(SNAPS, `${date}.json`), JSON.stringify(out, null, 2) + "\n");

  // Zeitreihe fortschreiben (ein Eintrag je Datum, letzter Lauf gewinnt)
  const history = await readJson(path.join(DATA, "history.json"), { runs: [] });
  const entry = { date, at: out.generatedAt, projects: {} };
  for (const p of out.projects) if (p.units.length) entry.projects[p.id] = p.summary;
  history.runs = history.runs.filter(r => r.date !== date).concat(entry).sort((a, b) => a.date.localeCompare(b.date));
  await writeFile(path.join(DATA, "history.json"), JSON.stringify(history, null, 2) + "\n");

  // Änderungsprotokoll fortschreiben (neueste zuerst, letzte 300 Einträge)
  const changes = await readJson(path.join(DATA, "changes.json"), { entries: [] });
  if (changeEntries.length) {
    changes.entries = changeEntries.concat(changes.entries).slice(0, 300);
    await writeFile(path.join(DATA, "changes.json"), JSON.stringify(changes, null, 2) + "\n");
  } else if (!existsSync(path.join(DATA, "changes.json"))) {
    await writeFile(path.join(DATA, "changes.json"), JSON.stringify(changes, null, 2) + "\n");
  }

  console.log(`\n${changeEntries.length} Änderung(en) erfasst · Snapshot ${date}`);
  const failed = out.projects.filter(p => !p.ok);
  if (failed.length === PROJECTS.length) process.exitCode = 1;   // alles fehlgeschlagen → Lauf rot
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
