# Meerwaardebelasting-tool: rekenkern

Rekenkern voor de Belgische meerwaardebelasting op financiële activa, algemeen regime
(wet van 6 april 2026, BS 21 april 2026). Pure Python, enkel standaardbibliotheek, `Decimal` overal.

> **Disclaimer:** dit is een rekenhulp, geen fiscaal advies. Controleer resultaten met de
> FOD Financiën (circulaire 2026/C/74) of een adviseur.

## Structuur

```
web/
  app.py         Flask: JSON-API + statische frontend
  db.py          SQLite-schema (bedragen als TEXT)
  static/        index.html, app.js, style.css (geen build-stap)
engine/
  models.py      Transaction, Lot, SaleLine, SaleResult, YearSummary, Report
  config.py      TaxYearConfig per jaar + keuzes (historische methode, FIFO-scope)
  calculator.py  calculate() en compare_methods()
tests/           tests met handmatig nagerekende voorbeelden
demo.py          uitgewerkt voorbeeld als controleerbaar overzicht
```

## Webapp starten

Vereist enkel Python 3.10+ en Flask (`pip install flask`).

```bash
python3 -m web.app                       # http://127.0.0.1:5000
MEERWAARDE_DB=~/meerwaarde.db python3 -m web.app   # eigen databankpad
```

De app draait lokaal (127.0.0.1) en bewaart alles in één SQLite-bestand. Tabbladen:

- **Rapport**: per jaar en eigenaar netto meerwaarde, vrijstelling (basis/overdracht), belasting,
  ingehouden bronheffing en terug te vorderen bedrag; per verkoop de lot-opsplitsing; verschil met
  de alternatieve historische methode; CSV-export per verkoop.
- **Transacties**: invoeren, bewerken (klik op een rij), verwijderen, filteren.
- **Activa**: waarde op 31/12/2025 per actief (verplicht voor posities van vóór 2026).
- **Instellingen**: historische methode, FIFO-scope, fiscale parameters per jaar, ingehouden bronheffing.

### API (JSON)

| Methode | Pad | |
|---|---|---|
| GET/POST | `/api/transactions` | lijst (filters `year`, `owner`, `asset`) / nieuw |
| PUT/DELETE | `/api/transactions/<id>` | bewerken / verwijderen |
| GET, PUT, DELETE | `/api/assets`, `/api/assets/<isin>` | activa + waarde 31/12/2025 |
| GET, PUT, DELETE | `/api/years`, `/api/years/<jaar>` | tarief, vrijstelling, overdracht |
| GET, PUT, DELETE | `/api/withheld`, `/api/withheld/<eigenaar>/<jaar>` | ingehouden bronheffing |
| GET/PUT | `/api/settings` | historische methode, FIFO-scope |
| GET | `/api/report`, `/api/report/sales.csv` | rapport / CSV |

Bedragen gaan als strings over de API (Decimal-precisie); komma of punt als decimaalteken.

## Rekenkern los gebruiken

```bash
python3 -m pytest -q   # tests (rekenkern + API)
python3 demo.py        # voorbeeld
```

```python
from engine import calculate, Transaction, TxType
report = calculate(transactions, ref_values={"BE0003565737": Decimal("62.40")},
                   withheld={("default", 2026): Decimal("360")})
```

- `ref_values`: slotkoers per stuk in EUR op 31/12/2025, voor elk actief dat vóór 2026 werd verworven.
- `fx_per_eur`: ECB-notatie (1 EUR = x vreemde munt).
- `historic_proven=True` op een pre-2026 aankoop laat toe de hogere historische prijs te gebruiken (verkopen t.e.m. 2030).

## Geïmplementeerde regels

| Regel | Implementatie |
|---|---|
| Tarief 10% | `TaxYearConfig.rate` |
| Vrijstelling 10.000 (2026) | `base_exemption`; latere jaren moeten expliciet worden toegevoegd (indexatie onbekend) |
| Overdracht | ongebruikt deel eerste schijf van 1.000, 5 jaar geldig, oudste eerst gebruikt |
| Fotowaarde 31/12/2025 | basis voor lots van vóór 2026 |
| Historische prijs | enkel indien bewezen, verkoop ≤ 31/12/2030, nooit tot minderwaarde |
| Minderwaarden | enkel binnen hetzelfde jaar; negatief saldo vervalt |
| FIFO | per eigenaar (instelbaar: per broker) |
| Kosten/taksen | geregistreerd, niet aftrekbaar |
| Valuta | omrekening tegen koers op aankoop- resp. verkoopdatum |
| Split | aantal × ratio, prijs ÷ ratio (ook fotowaarde) |
| Schenking/erfenis | `GIFT_IN`/`INHERIT_IN` met datum en prijs van de rechtsvoorganger |
| Onbekende aanschaffingswaarde | basis 0 + waarschuwing |
| Reynders-taks | `reynders_eur` op de verkoop, afgetrokken tot max. de positieve meerwaarde |
| Dividenden | enkel geregistreerd (informatief in jaaroverzicht) |

## Open punten (instelbaar of gemarkeerd)

- Historische prijs: FIFO per lot of gemiddelde (`HistoricMethod`); `compare_methods()` toont beide.
- Wisselkoerswinst op cash in vreemde munt: niet berekend.
- Fusies/ruil/andere corporate actions: niet automatisch; manueel te controleren.
- Volgorde binnen dezelfde dag: invoervolgorde.
