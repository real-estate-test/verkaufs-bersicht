#!/usr/bin/env node
/**
 * Legt für ein erfasstes Projekt fest, welche Gruppen Abstellplätze sind
 * (`parkingGroups`) und welche trotz ihres Namens Wohnungen (`livingGroups`).
 *
 * Liest den Formularinhalt aus ISSUE_BODY und meldet das Ergebnis nach
 * $GITHUB_OUTPUT ("status" = updated | unchanged | notfound | failed).
 */

import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REGISTRY = path.join(ROOT, "data", "projects.json");

function parseIssueForm(body) {
  const fields = {};
  for (const part of String(body || "").split(/^###\s+/m).slice(1)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const value = part.slice(nl + 1).trim();
    fields[part.slice(0, nl).trim().toLowerCase()] = /^_no response_$/i.test(value) ? "" : value;
  }
  return fields;
}

const pick = (fields, ...needles) =>
  Object.entries(fields).find(([label]) => needles.some(n => label.includes(n)))?.[1]?.trim() || "";

const list = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);

async function output(status, message) {
  console.log(message);
  if (process.env.GITHUB_OUTPUT) {
    const delim = "MSG_" + Math.random().toString(36).slice(2);
    await appendFile(process.env.GITHUB_OUTPUT,
      `status=${status}\nmessage<<${delim}\n${message}\n${delim}\n`);
  }
}

/** Vereinigung ohne Duplikate, Vergleich unabhängig von Gross-/Kleinschreibung. */
function mergeGroups(existing = [], add = [], remove = []) {
  const drop = new Set(remove.map(s => s.toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const g of [...existing, ...add]) {
    const k = g.toLowerCase();
    if (drop.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return out;
}

async function main() {
  const fields = parseIssueForm(process.env.ISSUE_BODY);
  const needle = pick(fields, "projekt");
  const asParking = list(pick(fields, "parkierung", "parking"));
  const asLiving = list(pick(fields, "wohnung"));

  const registry = JSON.parse(await readFile(REGISTRY, "utf8"));

  try {
    if (!needle) throw new Error("Es wurde kein Projekt angegeben.");
    if (!asParking.length && !asLiving.length) {
      throw new Error("Es wurde keine Gruppe angegeben – beide Felder waren leer.");
    }

    const key = needle.toLowerCase();
    const project = registry.projects.find(p =>
      p.id.toLowerCase() === key || p.name.toLowerCase() === key);

    if (!project) {
      await output("notfound", [
        `Kein Projekt gefunden, das zu „${needle}" passt. Es wurde nichts geändert.`,
        "", "Aktuell erfasst:",
        registry.projects.map(p => `- ${p.name} (\`${p.id}\`)`).join("\n")
      ].join("\n"));
      return;
    }

    const before = JSON.stringify([project.parkingGroups || [], project.livingGroups || []]);
    // Eine Gruppe kann nur eines von beidem sein – die neue Angabe gewinnt
    const parking = mergeGroups(project.parkingGroups, asParking, asLiving);
    const living = mergeGroups(project.livingGroups, asLiving, asParking);

    if (parking.length) project.parkingGroups = parking; else delete project.parkingGroups;
    if (living.length) project.livingGroups = living; else delete project.livingGroups;

    if (JSON.stringify([project.parkingGroups || [], project.livingGroups || []]) === before) {
      await output("unchanged", `Für **${project.name}** war diese Zuordnung bereits hinterlegt. Es wurde nichts geändert.`);
      return;
    }

    await writeFile(REGISTRY, JSON.stringify(registry, null, 2) + "\n");

    await output("updated", [
      `Zuordnung für **${project.name}** ist übernommen und gilt ab sofort auf allen Geräten.`,
      "",
      `| | |`,
      `|---|---|`,
      `| Als Parkierung | ${parking.length ? parking.join(", ") : "–"} |`,
      `| Als Wohnungen | ${living.length ? living.join(", ") : "–"} |`,
      "",
      "Die Kennzahlen der Übersicht rechnen diese Gruppen entsprechend mit oder heraus."
    ].join("\n"));
  } catch (err) {
    await output("failed", `Die Zuordnung konnte **nicht** übernommen werden.\n\n> ${err.message || err}`);
    process.exitCode = 1;
  }
}

await main();
