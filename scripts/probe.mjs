#!/usr/bin/env node
/** Temporär: holt BVR_NAV als Testvorlage und zeigt, wo die Statusdefinitionen liegen. */
import { writeFile, mkdir } from "node:fs/promises";
const URL_ = process.argv[2];
const res = await fetch(URL_, { headers:{ "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }, redirect:"follow" });
const html = await res.text();
const m = /BVR_NAV\s*=\s*\{/.exec(html);
let i = m.index + m[0].length - 1, depth = 0, instr = false, esc = false;
const start = i;
for (; i < html.length; i++) {
  const c = html[i];
  if (instr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') instr = false; }
  else if (c === '"') instr = true;
  else if (c === "{") depth++;
  else if (c === "}" && --depth === 0) break;
}
const data = JSON.parse(html.slice(start, i + 1));
await mkdir("_probe", { recursive: true });
await writeFile("_probe/bvr_nav.json", JSON.stringify(data));
console.log("BVR_NAV gespeichert:", html.slice(start, i + 1).length, "Zeichen");

/* Pfad der Statusdefinitionen suchen */
(function find(o, path) {
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && typeof v.dsc === "string" &&
        /^(verfügbar|nicht verfügbar|reserviert|verkauft)$/i.test(v.dsc)) {
      console.log(`STATUSPFAD  ${path}  ->  ${k} = "${v.dsc}"`);
    }
    if (v && typeof v === "object") find(v, path + "/" + k);
  }
})(data, "");
