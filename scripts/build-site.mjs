#!/usr/bin/env node
/**
 * Baut die auszuliefernde Seite nach dist/.
 *
 * Zwei Ausgaben aus einer index.html – der Unterschied liegt allein darin,
 * welche Datendateien danebenliegen:
 *
 *   dist/            öffentlich: Bestand, Karte, Tabellen
 *   dist/intern/     zusätzlich Verlauf und Änderungsprotokoll
 *
 * Der Verlaufsbereich blendet sich aus, wenn er seine Daten nicht erreicht.
 * Den Schutz leistet nicht dieser Build, sondern die Zugriffsregel auf
 * /intern/* – siehe README. Dieses Skript stellt nur sicher, dass die
 * vertraulichen Dateien ausschliesslich unterhalb von /intern/ landen.
 */

import { readFile, writeFile, mkdir, cp, rm, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(ROOT, "dist");

/** Was jeder der beiden Bereiche an Daten bekommt. */
const OEFFENTLICH = ["latest.json", "projects.json"];
const INTERN = [...OEFFENTLICH, "history.json", "changes.json"];

async function kopiereDaten(ziel, dateien) {
  await mkdir(path.join(ziel, "data"), { recursive: true });
  for (const name of dateien) {
    await cp(path.join(ROOT, "data", name), path.join(ziel, "data", name));
  }
}

async function baueBereich(ziel, dateien) {
  await mkdir(ziel, { recursive: true });
  await cp(path.join(ROOT, "index.html"), path.join(ziel, "index.html"));
  await cp(path.join(ROOT, "vendor"), path.join(ziel, "vendor"), { recursive: true });
  await kopiereDaten(ziel, dateien);
}

/** Sicherheitsnetz: nichts Vertrauliches darf im öffentlichen Teil liegen. */
async function pruefe() {
  const verboten = ["history.json", "changes.json", "snapshots"];
  const oeffentlich = await readdir(path.join(DIST, "data"));
  const treffer = oeffentlich.filter(n => verboten.includes(n));
  if (treffer.length) {
    throw new Error(`Vertrauliche Dateien im öffentlichen Teil: ${treffer.join(", ")}`);
  }
  for (const name of ["history.json", "changes.json"]) {
    const intern = await readdir(path.join(DIST, "intern", "data"));
    if (!intern.includes(name)) throw new Error(`${name} fehlt im internen Bereich`);
  }
}

await rm(DIST, { recursive: true, force: true });
await baueBereich(DIST, OEFFENTLICH);
await baueBereich(path.join(DIST, "intern"), INTERN);
await writeFile(path.join(DIST, ".nojekyll"), "");
await pruefe();

console.log("dist/           öffentlich :", OEFFENTLICH.join(", "));
console.log("dist/intern/    geschützt  :", INTERN.join(", "));
console.log("\nSnapshots werden bewusst nicht ausgeliefert – sie bleiben im Repository.");
