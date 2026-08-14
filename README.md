# Verkaufsübersicht

Übersicht über den Verkaufsstand der Wohn- und Hausprojekte, veröffentlicht unter
<https://real-estate-test.github.io/verkaufs-bersicht/>.

## Wie die Daten entstehen

Die Projektseiten werden **nicht** mehr im Browser der Besucher geladen, sondern
serverseitig durch einen GitHub-Actions-Workflow ausgelesen und als JSON im
Repository abgelegt. Das macht die Anzeige unabhängig von öffentlichen CORS-Proxys
und liefert nebenbei die Datengrundlage für den Verlauf.

```
Projektseiten ──► scripts/scrape.mjs ──► data/*.json ──► index.html
   (Actions, 1. & 15. des Monats)                        (GitHub Pages)
```

### Erfasste Projekte

| Projekt | Quelle | Layout der Angebotstabelle |
|---|---|---|
| Sonnenberg Reinach | `sonnenberg-reinach.ch/angebot/` | klassische `<table>` |
| Seeluft Boniswil | `seeluft-boniswil.ch/angebot/` | klassische `<table>` |
| Erlenstrasse Oetwil | `erlenstrasse-oetwil.ch` (Abschnitt „Angebot") | Div-Grid `.ang_list > .whg_row` |

Der Scraper erkennt beide Layouts automatisch.

## Projekte ergänzen

Erfasste Projekte stehen in `data/projects.json` – **nicht** im Browser. Damit sind
sie auf jedem Gerät sichtbar und werden vom Zwei-Wochen-Lauf mitgelesen.

Der bequeme Weg führt über die Seite: „**+ Projekt**" trägt das Projekt zunächst
nur lokal ein (Kennzeichnung „Nur dieses Gerät") und bietet danach den Knopf
„**dauerhaft übernehmen**" an. Der öffnet einen vorausgefüllten GitHub-Eintrag;
nach dem Absenden prüft der Workflow `add-project.yml` die Seite, nimmt das Projekt
auf und meldet das Ergebnis im Eintrag zurück. Schlägt die Prüfung fehl, wird
nichts geschrieben – Link korrigieren und der Workflow läuft erneut.

Weil das Repository öffentlich ist, akzeptiert der Workflow nur Einträge von
Eigentümer:innen und Mitarbeitenden des Repositories; interne Adressen
(`localhost`, private Netze) sind gesperrt.

Alternativ lässt sich `data/projects.json` direkt bearbeiten:

| Feld | Bedeutung |
|---|---|
| `id` | eindeutiger Schlüssel, taucht in Historie und Änderungsprotokoll auf |
| `name` | Anzeigename in der Übersicht |
| `url` | Seite mit der Angebotstabelle |
| `link` | optional, falls die Übersicht auf einen Anker verlinken soll (`…/#angebot`) |
| `type` | `"house"` oder `"apartment"` – steuert die Beschriftung („Häuser" / „Wohnungen") |
| `groupLabel` | Präfix der Gruppenüberschrift, z. B. `"Haus"` → „Haus A" |
| `layout` | optional `"table"` oder `"anglist"`; wird sonst automatisch erkannt |
| `grouped` | optional; wird sonst automatisch bestimmt (viele Kleinstgruppen → flache Liste) |

## Dateien

| Datei | Inhalt |
|---|---|
| `data/projects.json` | Register der erfassten Projekte |
| `data/latest.json` | aktueller Bestand aller Projekte inkl. Kennzahlen |
| `data/history.json` | eine Zeile je Erhebung – speist die Verlaufsgrafik |
| `data/changes.json` | Änderungsprotokoll: Status- und Preiswechsel, Zu- und Abgänge |
| `data/snapshots/JJJJ-MM-TT.json` | vollständiger Snapshot je Lauf |

Schlägt der Abruf einer Seite fehl, bleibt der zuletzt bekannte Stand dieses
Projekts erhalten (Kennzeichnung „Letzter Stand"). So löscht eine kurzzeitige
Störung weder den Bestand noch erzeugt sie falsche Änderungsmeldungen.

## Zeitplan

Der Workflow `.github/workflows/update-data.yml` läuft am **1. und 15. jedes Monats**
(05:17 UTC ≈ 07:17 Schweizer Zeit) und lässt sich unter *Actions → Verkaufsdaten
aktualisieren → Run workflow* jederzeit von Hand auslösen. Jeder Lauf schreibt eine
Zusammenfassung mit allen Änderungen in die Job-Summary.

## Lokal testen

```bash
node scripts/scrape.mjs        # ruft die Projektseiten live ab
python3 -m http.server 8000    # index.html unter http://localhost:8000 öffnen
```
