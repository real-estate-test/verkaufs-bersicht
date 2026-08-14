#!/usr/bin/env node
/**
 * Nimmt ein Projekt aus data/projects.json.
 *
 * Liest den Formularinhalt aus ISSUE_BODY, findet das Projekt über Kennung,
 * Name oder URL und meldet das Ergebnis nach $GITHUB_OUTPUT
 * ("status" = removed | notfound | failed).
 *
 * Historie und Änderungsprotokoll bleiben unangetastet – sie sind das Archiv.
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

function normalizeUrl(u) {
  return String(u || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(/#.*$/, "").replace(/\/+$/, "");
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
  const needle = Object.entries(fields)
    .find(([label]) => label.includes("projekt"))?.[1]?.trim() || "";

  const registry = JSON.parse(await readFile(REGISTRY, "utf8"));

  try {
    if (!needle) throw new Error("Es wurde kein Projekt angegeben.");

    const key = needle.toLowerCase();
    const match = registry.projects.find(p =>
      p.id.toLowerCase() === key ||
      p.name.toLowerCase() === key ||
      normalizeUrl(p.url) === normalizeUrl(needle));

    if (!match) {
      const liste = registry.projects.map(p => `- ${p.name} (\`${p.id}\`)`).join("\n");
      await output("notfound", [
        `Kein Projekt gefunden, das zu „${needle}" passt. Es wurde nichts geändert.`,
        "", "Aktuell erfasst:", liste
      ].join("\n"));
      return;
    }

    if (registry.projects.length === 1) {
      throw new Error("Das ist das einzige erfasste Projekt – die Liste darf nicht leer werden.");
    }

    registry.projects = registry.projects.filter(p => p.id !== match.id);
    await writeFile(REGISTRY, JSON.stringify(registry, null, 2) + "\n");

    await output("removed", [
      `**${match.name}** ist aus der Übersicht genommen.`,
      "",
      `| | |`,
      `|---|---|`,
      `| Kennung | \`${match.id}\` |`,
      `| Quelle | ${match.url} |`,
      `| Verbleibende Projekte | ${registry.projects.length} |`,
      "",
      "Die aufgezeichnete Historie bleibt erhalten. Der automatische Lauf ruft die",
      "Seite ab sofort nicht mehr ab."
    ].join("\n"));
  } catch (err) {
    await output("failed", `Das Projekt konnte **nicht** entfernt werden.\n\n> ${err.message || err}`);
    process.exitCode = 1;
  }
}

await main();
