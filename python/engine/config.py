from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import Enum


class HistoricMethod(str, Enum):
    """Hoe de historische (pre-2026) aankoopprijs bepaald wordt.
    Onduidelijk punt: FIFO per lot, of gemiddelde van alle pre-2026 aankopen (KBC)."""

    FIFO = "FIFO"
    AVERAGE = "GEMIDDELD"


class FifoScope(str, Enum):
    """FIFO over alle brokers van de eigenaar, of per broker apart (zoals de bank rekent)."""

    OWNER = "EIGENAAR"
    BROKER = "BROKER"


@dataclass(frozen=True)
class TaxYearConfig:
    year: int
    rate: Decimal = Decimal("0.10")
    base_exemption: Decimal = Decimal("10000")
    carry_slice: Decimal = Decimal("1000")   # enkel de eerste schijf is overdraagbaar
    carry_validity_years: int = 5
    source: str = ""


# Alleen jaren met een officieel bekend bedrag. Indexatie voor 2027+ is nog niet
# gepubliceerd: de engine weigert te rekenen voor een jaar zonder config.
DEFAULT_YEARS: dict[int, TaxYearConfig] = {
    2026: TaxYearConfig(
        year=2026,
        source="Wet 6.4.2026 (BS 21.4.2026); vrijstelling 2026 = 10.000 EUR",
    ),
}


@dataclass
class EngineConfig:
    years: dict[int, TaxYearConfig] = field(default_factory=lambda: dict(DEFAULT_YEARS))
    start_date: date = date(2026, 1, 1)
    historic_until: date = date(2030, 12, 31)
    historic_method: HistoricMethod = HistoricMethod.FIFO
    fifo_scope: FifoScope = FifoScope.OWNER

    def year(self, year: int) -> TaxYearConfig:
        try:
            return self.years[year]
        except KeyError:
            raise KeyError(
                f"Geen fiscale parameters voor inkomstenjaar {year}. "
                f"Voeg het geïndexeerde vrijstellingsbedrag toe aan de configuratie."
            ) from None
