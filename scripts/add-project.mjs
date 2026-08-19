#!/usr/bin/env node
/**
 * Nimmt ein Projekt aus einem GitHub-Eintrag in data/projects.json auf.
 *
 * Liest den Formularinhalt aus der Umgebungsvariable ISSUE_BODY, prüft die
 * angegebene Seite testweise und bricht ab, bevor etwas geschrieben wird, wenn
 * sich dort keine Angebotstabelle auslesen lässt.
 *
 * Ergebnis geht als Markdown nach $GITHUB_OUTPUT (Schlüssel "message") und
 * als Status ("status" = added | duplicate | failed).
 */

import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { scrapeProject, summarize } from "./scrape.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REGISTRY = path.join(ROOT, "data", "projects.json");

/* Formularabschnitte: "### Feldname\n\nWert" */
function parseIssueForm(body) {
  const fields = {};
  const parts = String(body || "").split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const label = part.slice(0, nl).trim().toLowerCase();
    const value = part.slice(nl + 1).trim();
    fields[label] = /^_no response_$/i.test(value) ? "" : value;
  }
  return fields;
}

function pick(fields, ...needles) {
  for (const [label, value] of Object.entries(fields)) {
    if (needles.some(n => label.includes(n))) return value;
  }
  return "";
}

function slugify(name) {
  return name.toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "projekt";
}

/** Vergleichsform: Protokoll, www und Schlussschrägstrich sind für die Identität egal. */
function normalizeUrl(u) {
  return String(u || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(/#.*$/, "").replace(/\/+$/, "");
}

/** Nur öffentlich erreichbare http(s)-Adressen zulassen. */
function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`„${raw}" ist keine gültige URL.`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Die URL muss mit http:// oder https:// beginnen.");
  const host = u.hostname.toLowerCase();
  const blocked = host === "localhost" || host.endsWith(".local") ||
    /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/.test(host);
  if (blocked) throw new Error("Interne Adressen sind nicht zulässig.");
  return u.toString();
}

async function output(status, message) {
  console.log(message);
  if (process.env.GITHUB_OUTPUT) {
    const delim = "MSG_" + Math.random().toString(36).slice(2);
    await appendFile(process.env.GITHUB_OUTPUT,
      `status=${status}\nmessage<<${delim}\n${message}\n${delim}\n`);
  }
}

async function main() {
  const fields = parseIssueForm(process.env.ISSUE_BODY);
  const name = pick(fields, "projektname", "name");
  const urlRaw = pick(fields, "link", "url", "angebotsseite");
  const art = pick(fields, "art");
  const gruppe = pick(fields, "gruppe", "bezeichnung");

  const registry = JSON.parse(await readFile(REGISTRY, "utf8"));

  try {
    if (!name) throw new Error("Es fehlt ein Projektname.");
    const url = validateUrl(urlRaw);

    if (registry.projects.some(p => normalizeUrl(p.url) === normalizeUrl(url))) {
      await output("duplicate",
        `Dieses Projekt ist bereits erfasst – die Übersicht zeigt es schon an. Es wurde nichts geändert.`);
      return;
    }

    let id = slugify(name);
    if (registry.projects.some(p => p.id === id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;

    const entry = {
      id, name, url,
      type: /haus|häuser|haeuser/i.test(art) ? "house" : "apartment",
      groupLabel: gruppe || "Haus"
    };
    const parking = pick(fields, "parkierung", "parking")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (parking.length) entry.parkingGroups = parking;

    // Testlauf, bevor irgendetwas geschrieben wird
    const { units, layout, grouped } = await scrapeProject(entry);
    const c = summarize(units);

    registry.projects.push(entry);
    await writeFile(REGISTRY, JSON.stringify(registry, null, 2) + "\n");

    await output("added", [
      `**${name}** ist aufgenommen und erscheint nach dem nächsten Seitenaufbau in der Übersicht.`,
      "",
      `| | |`,
      `|---|---|`,
      `| Erkannte Einheiten | ${c.total} |`,
      `| Verfügbar / reserviert / verkauft | ${c.available} / ${c.reserved} / ${c.sold} |`,
      `| Tabellenlayout | \`${layout}\` |`,
      `| Gruppierung nach Gebäude | ${grouped ? "ja" : "nein – flache Liste"} |`,
      `| Quelle | ${url} |`,
      "",
      "Ab jetzt wird das Projekt bei jedem automatischen Lauf (1. und 15. des Monats) mitgelesen."
    ].join("\n"));
  } catch (err) {
    await output("failed", [
      `Das Projekt konnte **nicht** aufgenommen werden.`,
      "",
      `> ${err.message || err}`,
      "",
      "Häufigste Ursache: Der Link zeigt nicht auf die Seite mit der Angebotstabelle.",
      "Bitte die URL prüfen und den Eintrag bearbeiten – der Workflow läuft dann erneut."
    ].join("\n"));
    process.exitCode = 1;
  }
}

await main();
