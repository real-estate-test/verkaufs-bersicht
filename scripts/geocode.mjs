#!/usr/bin/env node
/**
 * Ergänzt fehlende Koordinaten im Projektregister.
 *
 * Aufgelöst wird über Nominatim (OpenStreetMap), weil es Schweiz und
 * Deutschland gleichermassen abdeckt. Jede Adresse wird genau einmal
 * nachgeschlagen – das Ergebnis steht danach dauerhaft in
 * data/projects.json und wird nie erneut abgefragt.
 *
 *   node scripts/geocode.mjs [--force <projekt-id>]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REGISTRY = path.join(ROOT, "data", "projects.json");

/* Nominatim verlangt eine erkennbare Kennung und höchstens eine Abfrage je Sekunde. */
const UA = "verkaufs-uebersicht/1.0 (github.com/real-estate-test/verkaufs-bersicht)";
const PAUSE_MS = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function geocode(query) {
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "1",
    addressdetails: "1",
    countrycodes: "ch,de"          // Portfolio liegt in der Schweiz und in Deutschland
  });
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "de" },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Nominatim antwortete mit HTTP ${res.status}`);
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) return null;
  const h = hits[0];
  const a = h.address || {};
  return {
    koordinaten: [Number(h.lat), Number(h.lon)],
    ort: a.city || a.town || a.village || a.municipality || a.hamlet || null,
    land: (a.country_code || "").toUpperCase() || null,
    gefundenAls: h.display_name
  };
}

async function main() {
  const forceIdx = process.argv.indexOf("--force");
  const forceId = forceIdx > -1 ? process.argv[forceIdx + 1] : null;

  const registry = JSON.parse(await readFile(REGISTRY, "utf8"));
  let changed = false;
  let first = true;

  for (const p of registry.projects) {
    const hasCoords = Array.isArray(p.koordinaten) && p.koordinaten.length === 2;
    if (hasCoords && p.id !== forceId) continue;

    const query = p.adresse || p.ort;
    if (!query) {
      console.log(`– ${p.name}: keine Adresse hinterlegt, übersprungen`);
      continue;
    }

    if (!first) await sleep(PAUSE_MS);
    first = false;

    try {
      const hit = await geocode(query);
      if (!hit) {
        console.log(`✗ ${p.name}: „${query}" nicht gefunden`);
        continue;
      }
      p.koordinaten = [
        Number(hit.koordinaten[0].toFixed(6)),
        Number(hit.koordinaten[1].toFixed(6))
      ];
      if (hit.ort && !p.ort) p.ort = hit.ort;
      if (hit.land) p.land = hit.land;
      changed = true;
      console.log(`✓ ${p.name}: ${p.koordinaten.join(", ")}  (${hit.gefundenAls})`);
    } catch (err) {
      console.error(`✗ ${p.name}: ${err.message || err}`);
    }
  }

  if (changed) {
    await writeFile(REGISTRY, JSON.stringify(registry, null, 2) + "\n");
    console.log("\nRegister ergänzt.");
  } else {
    console.log("\nNichts zu ergänzen.");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
