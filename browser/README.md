# Meerwaardebelasting – browserversie

De versie die op je claude.ai-link draait. Alles werkt in de browser; er is geen server nodig.

> **Disclaimer:** rekenhulp, geen fiscaal advies. Controleer met de FOD Financiën of een adviseur.

## Bestanden

| Bestand | Inhoud |
|---|---|
| `index.html` | De volledige pagina (gebouwd, alles ingesloten). Open lokaal in een browser of publiceer. |
| `template.html` | HTML en CSS met plaatshouders voor de scripts |
| `engine.js` | Rekenkern (exacte decimalen met BigInt): FIFO, fotowaarde 31/12/2025, historische prijs t.e.m. 2030, vrijstelling en overdracht, delisting |
| `app.js` | Interface, validatie, opslag (Claude-account in delen of browser), back-up, import |
| `bolero.js` | Importer voor de Bolero-export "Cashbewegingen" (Excel of CSV) |
| `saxo.js` | Importer voor de Saxo-export "Transacties" (standaard, Excel) en de oudere export "Trades" (Excel of CSV) |
| `xlsx.js` | Minimale Excel-lezer zonder externe bibliotheek |
| `bewijs.js` | Bewijsstukken bij transacties: toegelaten bestandstypes, welke transacties nog een bewijs missen |
| `build.py` | Voegt alles samen tot `index.html` |
| `manifest.webmanifest`, `sw.js`, `icon*` | Installeerbare app (PWA) op GitHub Pages; niet gebruikt op claude.ai |
| `*.test.js` | Tests (Node 18+) |

## Bouwen en testen

```bash
python3 build.py                 # maakt index.html
node --test engine.test.js       # rekenkern
node --test bolero.test.js       # Bolero-importer (synthetisch bestand)
node --test saxo.test.js         # Saxo-importer (synthetisch bestand)
node --test bewijs.test.js       # bewijsstukken

# optioneel tegen je eigen exports:
BOLERO_FILE=pad/naar/cashmovements.xlsx node --test bolero.test.js   # of .csv
SAXO_FILE=pad/naar/Transactions.xlsx node --test saxo.test.js
```

Lokaal openen: `python3 -m http.server` in deze map en ga naar http://localhost:8000. Buiten claude.ai bewaart de
pagina gegevens alleen in je browser (localStorage); maak een back-up via Instellingen.

## Installeren als app (GitHub Pages)

Op https://glorfunk850.github.io/Meerwaardebelasting/ is de tool als app te installeren (Chrome/Edge: 'App installeren'
in de adresbalk of via Instellingen → *Als app installeren*; iPhone/iPad: Safari → Deel → *Zet op beginscherm*).
De service worker (`sw.js`) haalt altijd eerst de nieuwste versie op en valt zonder verbinding terug op de laatst
bewaarde kopie. Verhoog `CACHE` in `sw.js` als je de lijst met bestanden wijzigt.

Gegevens staan in die versie alleen in de browser (localStorage), los van de claude.ai-pagina. Overzetten gaat via
Instellingen → Back-up downloaden en Back-up herstellen. Op claude.ai en bij een lokaal geopend bestand doet de
installatiecode niets.

## Bewijsstukken

Bij elke transactie kun je bestanden toevoegen (PDF, JPG, PNG, WEBP, GIF, TXT, CSV; max. 20 MB per bestand), bv. het
borderel of de afrekening van de bank. Op claude.ai staan ze bij de pagina in je Claude-account (capability `assets`,
even privé als de pagina); elders in de browser (IndexedDB). De transactie bewaart enkel naam, type, grootte en
verwijzing. De gewone back-up bevat dus enkel die gegevens; *Back-up met bewijsstukken* (Instellingen) zet ook de
bestanden zelf erin (base64 in het veld `proof_files`, ca. een derde groter dan de bestanden samen). Bij herstellen worden
die bestanden opnieuw opgeslagen op de plaats waar je herstelt (en niet dubbel als ze er al staan); `proof_files` komt
nooit in de bewaarde toestand. Zo verhuis je bewijsstukken ook tussen claude.ai en de app-versie. Zonder zo'n back-up zijn
bestanden van de ene plaats op de andere niet te openen.

De filter *Bewijs ontbreekt* toont verwervingen van activa die nog in bezit zijn en verkopen die belastbaar zijn
(vanaf 2026) of van activa die nog in bezit zijn, zonder bewijsstuk.

## Eigen keuzes en interpretaties

- Delisting: enkel een uitkoop/bod tegen prijs is een overdracht (verkoop); een loutere schrapping of waardeloos worden
  zonder overdracht is geen belastbaar moment. Niet uitdrukkelijk in de wet geregeld.
- Historische prijs bij meerdere aankopen vóór 2026: FIFO per lot of gemiddelde (instelbaar; het rapport toont het verschil).
- Valutawinst op cash in vreemde munt wordt niet berekend.
- Bolero: wisselkoers staat niet in de export; afgeleid uit wisseltransacties of geschat uit het nettobedrag (gemarkeerd).
- Bolero: de Excel-export wordt omgezet naar dezelfde regels als de CSV-export. Transacties die al geïmporteerd zijn
  (ook via het andere formaat) worden herkend op import-id of op inhoud (type, datum, effect, aantal, prijs, bedrag).
- Saxo, standaardexport "Transacties": aantal en prijs komen uit het blad `_Transacties`, bedrag, koers en kosten uit
  `Transacties` (gekoppeld op transactie-id), de opsplitsing van de kosten uit `Bookings`. Corporate actions:
  - overnamebod/uitkoop: verkoop op de datum van het bod (een latere herboeking met hetzelfde transactie-id telt niet);
  - (omgekeerde) splitsing: splitsing met de gangbare verhouding (bv. 1 nieuw voor 10 oud) plus verkoop van de fractie
    tegen het cashbedrag uit `Bookings`;
  - stockdividend (herbeleggingsdividend): aankoop tegen de prijs van Saxo, zonder kosten;
  - kapitaalvermindering ("Waardevermindering"): niet geïmporteerd, met waarschuwing. **Open punt:** of zo'n
    terugbetaling de aanschaf- of fotowaarde verlaagt, regelt de wet niet uitdrukkelijk.
  - dividenden: netto per corporate action (terugboekingen afgetrokken).
- Ingehouden meerwaardebelasting: Bolero (kolom bij elke verkoop) en Saxo (boekingen "Meerwaardebelasting" in `Bookings`)
  worden per jaar en per broker opgeteld bij *Ingehouden door broker*. Een zelf ingevuld bedrag blijft staan; een export
  verhoogt het bedrag van een broker enkel (een export die maar een deel van het jaar dekt, verlaagt het niet).
