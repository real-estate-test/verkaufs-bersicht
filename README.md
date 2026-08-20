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
| Suhrano Suhr | `navigator5.beyonity.ch/?id=…` | eingebettetes JSON `BVR_NAV` |

Der Scraper erkennt alle drei Layouts automatisch.

Suhrano ist ein Sonderfall: `suhrano.ch/angebot/` enthält keine Wohnungsdaten,
sondern verlinkt nur auf das Vermarktungstool von Beyonity. Dieses liefert den
vollständigen Bestand als JSON im Seitenquelltext mit – deshalb steht dort die
Navigator-Adresse als `url` und die öffentliche Projektseite als `link`.
Statusbezeichnungen und beschriftete Zusatzfelder liest der Parser aus dem JSON,
statt sie zu verdrahten. Die `custom_N`-Felder für Preis und Geschoss variieren
je Projekt und werden über ihren Inhalt bestimmt; bei Bedarf lässt sich das über
`fields` in `projects.json` festlegen.

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
| `layout` | optional `"table"`, `"anglist"` oder `"beyonity"`; wird sonst automatisch erkannt |
| `fields` | optional, nur Beyonity: feste Zuordnung von `price` / `floor` auf ein `custom_N`-Feld |
| `grouped` | optional; wird sonst automatisch bestimmt (viele Kleinstgruppen → flache Liste) |
| `parkingGroups` | optional: Gruppennamen, die Abstellplätze sind, obwohl der Name das nicht verrät |
| `livingGroups` | optional: Gruppennamen, die trotz Namen wie „Garagenhof" Wohnungen sind |

## Wohnungen und Parkierung

Heisst ein Gebäude „Garage", „Einstellhalle" oder „Parkplätze", sind das
Abstellplätze und keine Wohnungen – sie werden automatisch als Parkierung
eingestuft, separat ausgewiesen und aus den Wohnungskennzahlen genommen.

Trifft die Erkennung daneben, lässt sich das an jeder Gruppenüberschrift der
Übersicht mit einem Klick umschalten („⇄ als Parkierung" / „↩ als Wohnungen").
Diese Wahl gilt zunächst nur im jeweiligen Browser und überstimmt die Automatik.

Um sie für alle Geräte zu übernehmen, erscheint im Projektkopf der Link
„**Parkierung übernehmen**". Er öffnet einen vorausgefüllten GitHub-Eintrag;
der Workflow schreibt die Gruppen in `parkingGroups` / `livingGroups` und meldet
das Ergebnis zurück. Sobald das Register dieselbe Einstufung liefert, räumt die
Übersicht die lokale Übersteuerung von selbst weg und der Link verschwindet.

Bei einem noch nicht erfassten Projekt wandern die lokal gesetzten Gruppen
stattdessen beim „dauerhaft übernehmen" direkt in den Eintrag mit.

## Nutzungsmessung

Die Seite meldet Nutzungsereignisse an Google Analytics (Kennung im Kopf der
`index.html`). Die Auswertung ist **nicht** Teil der Seite und nur im
Analytics-Konto sichtbar.

| Ereignis | Wird ausgelöst | Angaben |
|---|---|---|
| `projekt_ansicht` | Klick auf einen Projekt-Chip | `projekt`, `projekt_name` |
| `filter_zimmer` | Klick auf einen Zimmer-Chip | `zimmer`, `projekt` |
| `filter_status` | Klick auf einen Status-Chip | `status`, `projekt` |
| `grundriss_klick` | Klick auf ein Grundriss-PDF | `projekt`, `projekt_name`, `einheit`, `gruppe`, `status`, `zimmer` |

Damit die Angaben in den Berichten erscheinen, müssen sie in GA4 einmalig unter
*Verwaltung → Benutzerdefinierte Definitionen* als **ereignisbezogene**
benutzerdefinierte Dimension angelegt werden – Parametername exakt wie oben.

Übertragen werden ausschliesslich Werte aus den Projektdaten, nie eingetippter
Text: der Suchbegriff wird bewusst nicht gemeldet. Ist die Messung blockiert,
bleiben alle Aufrufe wirkungslos und die Bedienung unverändert.

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
