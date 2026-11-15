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
| `bolero.js` | Importer voor de Bolero-export "Cashbewegingen" (CSV) |
| `saxo.js` | Importer voor de Saxo-export "Trades" (Excel of CSV) |
| `xlsx.js` | Minimale Excel-lezer zonder externe bibliotheek |
| `build.py` | Voegt alles samen tot `index.html` |
| `manifest.webmanifest`, `sw.js`, `icon*` | Installeerbare app (PWA) op GitHub Pages; niet gebruikt op claude.ai |
| `*.test.js` | Tests (Node 18+) |

## Bouwen en testen

```bash
python3 build.py                 # maakt index.html
node --test engine.test.js       # rekenkern
node --test bolero.test.js       # Bolero-importer (synthetisch bestand)
node --test saxo.test.js         # Saxo-importer (synthetisch bestand)
node --test assets.test.js       # sleutels (ISIN/ticker) en namen van activa

# optioneel tegen je eigen exports:
BOLERO_FILE=pad/naar/cashmovements.csv node --test bolero.test.js
SAXO_FILE=pad/naar/Trades.xlsx node --test saxo.test.js
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

## Eigen keuzes en interpretaties

- Delisting: enkel een uitkoop/bod tegen prijs is een overdracht (verkoop); een loutere schrapping of waardeloos worden
  zonder overdracht is geen belastbaar moment. Niet uitdrukkelijk in de wet geregeld.
- Historische prijs bij meerdere aankopen vóór 2026: FIFO per lot of gemiddelde (instelbaar; het rapport toont het verschil).
- Valutawinst op cash in vreemde munt wordt niet berekend.
- Bolero: wisselkoers staat niet in de export; afgeleid uit wisseltransacties of geschat uit het nettobedrag (gemarkeerd).
