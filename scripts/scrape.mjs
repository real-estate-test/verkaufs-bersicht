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
  if (h.includes("objekt") || h === "haus" || h.includes("haus-nr") || h.includes("nr.")) return "id";
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
      if (!id || columnRole(id) === "id" || /^(haus|objekt)/i.test(id) && cells.length < 3) continue;
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
   Gruppierung (Haus A / Erlenstrasse 12 …)
-------------------------------------------------------------------------- */
export function groupOf(id, project) {
  const raw = String(id || "").trim();
  const letters = raw.match(/^([A-Za-zÄÖÜ]+)/);
  if (letters) return `${project.groupLabel} ${letters[1].toUpperCase()}`;
  const digits = raw.match(/^(\d+)/);
  if (digits) return `${project.groupLabel} ${digits[1]}`;
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

export async function scrapeProject(project, offlineDir) {
  const html = await loadHtml(project, offlineDir);
  const layout = project.layout || detectLayout(html);
  const units = layout === "anglist" ? parseAngList(html, project) : parseTables(html, project);
  if (!units.length) throw new Error("Keine Einheiten erkannt – Seitenstruktur hat sich vermutlich geändert");
  return { units, layout, grouped: project.grouped !== undefined ? project.grouped : shouldGroup(units) };
}

/* --------------------------------------------------------------------------
   Auswertung
-------------------------------------------------------------------------- */
export function summarize(units) {
  const live = units.filter(u => u.kind === "unit");
  const c = { total: live.length, available: 0, reserved: 0, sold: 0, unknown: 0 };
  for (const u of live) c[u.status]++;
  c.availableVolume = live
    .filter(u => u.status === "available")
    .reduce((s, u) => s + (u.price || 0), 0);
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
      groupLabel: project.groupLabel
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
