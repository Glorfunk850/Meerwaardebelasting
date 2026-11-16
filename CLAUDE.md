# Werkafspraken

Rekenhulp voor de Belgische meerwaardebelasting (zie README.md). Communicatie met de eigenaar in het Nederlands.

## Werkwijze
- Elke wijziging als commit op een eigen branch (nooit rechtstreeks naar `main` pushen), met groene tests,
  en daarvan een pull request naar `main` openen. De eigenaar merget.
- Pas na de merge de gebouwde `browser/index.html` van `main` publiceren op de bestaande claude.ai-pagina
  (artifact-slug `89e61c58-cfa4-48d1-9afc-65a63a42cb25`, link https://claude.ai/artifact/J2eLYeeUADSGqJ98q5auji).
  Eerder publiceren enkel als de eigenaar daar uitdrukkelijk om vraagt; zeg dan dat de pagina vooruitloopt op `main`.
- Wijkt de live pagina af van `main` (bv. werk van een andere branch dat nog niet gemerged is), niets overschrijven:
  eerst uitzoeken welke branch het is en de eigenaar vragen wat er moet gebeuren.
  Een openbare pagina kan niet bijgewerkt worden: vraag de eigenaar ze tijdelijk privé te zetten.
- Geen nieuwe pagina aanmaken: de opgeslagen gegevens van de gebruiker horen bij deze pagina.

## Code
- Rekenregels bestaan twee keer: `python/engine/` en `browser/engine.js`. Elke regelwijziging in beide doorvoeren,
  met tests in `python/tests/test_engine.py` en `browser/engine.test.js`, en de resultaten moeten identiek blijven.
- `browser/index.html` wordt gebouwd met `python3 build.py` (in `browser/`); nooit rechtstreeks bewerken.
  CI controleert dat het gecommitte bestand overeenkomt met de bronnen.
- Bedragen altijd exact decimaal (Python `Decimal`, JS `Dec` op BigInt), nooit floats.

## Tests
```bash
cd python && python3 -m pytest -q
cd browser && node --test engine.test.js bolero.test.js saxo.test.js bewijs.test.js pdf.test.js
```

## Privacy
- Nooit echte broker-exports, back-ups, databanken of bedragen/namen uit de portefeuille van de eigenaar committen,
  ook niet in testdata. Testbestanden gebruiken verzonnen gegevens.
- Bij fiscale regels: bron en datum vermelden; onduidelijke punten markeren in plaats van gokken.
