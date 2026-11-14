# Meerwaardebelasting

Rekenhulp voor de Belgische meerwaardebelasting op financiële activa voor particuliere beleggers
(algemeen regime, wet van 6 april 2026, BS 21 april 2026; circulaire 2026/C/74).

> **Disclaimer:** dit is een rekenhulp, geen fiscaal advies. Controleer resultaten altijd met de FOD Financiën
> of een adviseur.

## Twee versies

| Map | Wat | Gebruik |
|---|---|---|
| [`browser/`](browser/) | Volledige tool in één HTML-pagina: transacties, rapport, delisting, import van Bolero- en Saxo-exports, back-up. Draait volledig in de browser. | Dagelijks gebruik; installeerbaar als app via [GitHub Pages](https://glorfunk850.github.io/Meerwaardebelasting/) |
| [`python/`](python/) | Dezelfde rekenkern in Python (`engine/`) met een lokale Flask-webapp (`web/`) en SQLite. | Referentie-implementatie, scripts, lokaal draaien |

Beide rekenkernen volgen dezelfde regels en geven identieke resultaten (getoetst met gelijke testgevallen en
willekeurige scenario's). De Python-webapp heeft nog geen import en geen delisting in de schermen; de Python-rekenkern
kent delisting wel.

## Rekenregels (samenvatting)

- Tarief 10%; vrijstelling 2026 € 10.000 per persoon (latere jaren: geïndexeerd bedrag zelf toevoegen).
- Overdracht van het ongebruikte deel van de eerste schijf van € 1.000, 5 jaar geldig, oudste eerst gebruikt.
- Activa van vóór 2026: waarde op 31/12/2025; hogere bewezen historische prijs enkel voor verkopen t.e.m. 31/12/2030
  en nooit tot een minderwaarde.
- Minderwaarden enkel binnen hetzelfde jaar; geen overdracht van verlies.
- FIFO; kosten en taksen niet aftrekbaar; vreemde munt tegen de koers op aankoop- en verkoopdatum.
- Delisting: uitkoop/bod = verkoop; loutere schrapping of waardeloos zonder overdracht = geen belastbaar moment
  (eigen interpretatie, niet uitdrukkelijk geregeld).

Open punten staan in de README van elke versie.

## Snel starten

```bash
# browserversie
cd browser && python3 build.py && python3 -m http.server   # http://localhost:8000
node --test engine.test.js bolero.test.js saxo.test.js

# Python-versie
cd python && pip install -r requirements.txt
python3 -m pytest -q
python3 -m web.app                                          # http://127.0.0.1:5000
```

## Privacy

Zet nooit echte broker-exports, back-ups of databanken in deze repository. `.gitignore` sluit de gangbare
bestandsnamen uit; de tests gebruiken enkel verzonnen gegevens.
