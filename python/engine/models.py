from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional

ZERO = Decimal("0")
ONE = Decimal("1")


class TxType(str, Enum):
    BUY = "BUY"
    SELL = "SELL"
    SPLIT = "SPLIT"            # split_ratio = nieuwe stuks per oud stuk (4 = 4:1)
    DIVIDEND = "DIVIDEND"      # enkel registratie
    FEE = "FEE"                # enkel registratie
    TRANSFER_IN = "TRANSFER_IN"  # effecten overgezet van andere broker (oorspronkelijke datum + prijs)
    GIFT_IN = "GIFT_IN"        # schenking: datum + prijs van de schenker
    INHERIT_IN = "INHERIT_IN"  # erfenis: datum + prijs van de erflater
    DELISTING = "DELISTING"    # schrapping notering; delist_mode bepaalt het fiscale gevolg
    RUIL = "RUIL"              # omruiling bij fusie/overname: components = nieuwe effecten, price = cash per oud stuk


class DelistMode(str, Enum):
    NOTERING = "NOTERING"      # enkel schrapping: geen overdracht, positie blijft open
    UITKOOP = "UITKOOP"        # uitkoop/bod/squeeze-out tegen prijs: overdracht = verkoop
    WAARDELOOS = "WAARDELOOS"  # faillissement/vereffening zonder overdracht: geen gerealiseerde minderwaarde


ACQUISITION_TYPES = {TxType.BUY, TxType.TRANSFER_IN, TxType.GIFT_IN, TxType.INHERIT_IN}


class BasisUsed(str, Enum):
    PURCHASE = "AANKOOP"          # verworven vanaf 1/1/2026
    REF_2025 = "REF_31_12_2025"   # fotowaarde
    HISTORIC = "HISTORISCH"       # bewezen hogere historische prijs (verkoop t.e.m. 2030)
    UNKNOWN = "ONBEKEND"          # geen aanschaffingswaarde gekend -> 0


@dataclass
class ExchangeComponent:
    """Nieuw effect bij een omruiling: ratio = nieuwe stuks per oud stuk; value = waarde per nieuw stuk op de
    ruildatum (in de munt van de transactie), nodig om de aanschaffingswaarde te verdelen."""

    asset: str
    ratio: Decimal
    value: Optional[Decimal] = None


@dataclass
class Transaction:
    """Eén transactie. Prijzen in de transactiemunt; fx_per_eur volgt de
    ECB-notatie (1 EUR = fx_per_eur eenheden vreemde munt). Is eur_per_ccy
    ingevuld (1 eenheid munt = eur_per_ccy EUR), dan geldt die koers."""

    trade_date: date
    type: TxType
    asset: str                      # ISIN of ticker
    quantity: Decimal = ZERO
    price: Decimal = ZERO           # per stuk, in `currency`
    currency: str = "EUR"
    fx_per_eur: Decimal = ONE
    fees: Decimal = ZERO            # geregistreerd, niet aftrekbaar
    taxes: Decimal = ZERO           # geregistreerd, niet aftrekbaar
    owner: str = "default"
    broker: str = ""
    split_ratio: Optional[Decimal] = None
    historic_proven: bool = False   # voor activa van vóór 2026: is de aankoopprijs bewijsbaar?
    cost_known: bool = True         # False -> aanschaffingswaarde onbekend (=0)
    reynders_eur: Decimal = ZERO    # belastbare interestcomponent bij verkoop (aftrekbaar)
    amount: Decimal = ZERO          # voor DIVIDEND/FEE: totaalbedrag in `currency`
    delist_mode: str = ""           # voor DELISTING: NOTERING | UITKOOP | WAARDELOOS
    source: str = ""                # bv. "bolero.csv:12"
    eur_per_ccy: Optional[Decimal] = None  # koers in de andere richting: 1 munt = … EUR
    components: list[ExchangeComponent] = field(default_factory=list)  # voor RUIL

    def to_eur(self, amount: Decimal) -> Decimal:
        if self.eur_per_ccy is not None:
            if self.eur_per_ccy <= 0:
                raise ValueError(f"Ongeldige wisselkoers in {self.source or self}")
            return amount * self.eur_per_ccy
        if self.fx_per_eur <= 0:
            raise ValueError(f"Ongeldige wisselkoers in {self.source or self}")
        return amount / self.fx_per_eur


@dataclass
class Lot:
    lot_id: int
    owner: str
    broker: str
    asset: str
    acquired: date
    quantity: Decimal               # resterend aantal
    orig_quantity: Decimal          # oorspronkelijk aantal (split-gecorrigeerd)
    unit_cost_eur: Decimal          # historische/werkelijke kost per stuk
    historic_proven: bool
    cost_known: bool
    source: str = ""
    unit_ref_eur: Optional[Decimal] = None  # fotowaarde 31/12/2025 per stuk (pre-2026 lots)

    @property
    def pre_2026(self) -> bool:
        return self.acquired < date(2026, 1, 1)


@dataclass
class SaleLine:
    lot_id: Optional[int]
    acquired: Optional[date]
    quantity: Decimal
    proceeds_eur: Decimal
    basis_eur: Decimal
    basis_used: BasisUsed
    result_eur: Decimal             # + meerwaarde / - minderwaarde
    note: str = ""
    missed_historic_eur: Decimal = Decimal("0")  # lagere meerwaarde als de aankoop bewijsbaar was aangeduid


@dataclass
class SaleResult:
    trade_date: date
    owner: str
    broker: str
    asset: str
    quantity: Decimal
    proceeds_eur: Decimal
    fees_eur: Decimal
    lines: list[SaleLine] = field(default_factory=list)
    reynders_deduction_eur: Decimal = ZERO
    warnings: list[str] = field(default_factory=list)
    source: str = ""
    kind: str = "VERKOOP"           # VERKOOP, UITKOOP (delisting) of RUIL (cash bij omruiling)

    @property
    def result_eur(self) -> Decimal:
        return sum((l.result_eur for l in self.lines), ZERO) - self.reynders_deduction_eur


@dataclass
class Event:
    """Gebeurtenis zonder (of naast) belastbaar moment, bv. een delisting."""

    trade_date: date
    owner: str
    broker: str
    asset: str
    kind: str                       # DelistMode-waarde of RUIL
    quantity_held: Decimal          # aantal in bezit vlak vóór de gebeurtenis
    note: str
    source: str = ""
    quantity: Decimal = ZERO        # RUIL: omgeruild aantal
    components: list[ExchangeComponent] = field(default_factory=list)
    warning: str = ""               # RUIL: waarschuwing voor het rapport


@dataclass
class YearSummary:
    owner: str
    year: int
    gains_eur: Decimal = ZERO
    losses_eur: Decimal = ZERO      # negatief getal
    net_eur: Decimal = ZERO         # >= 0
    lost_losses_eur: Decimal = ZERO  # niet verrekenbaar saldo (niet overdraagbaar)
    exemption_available_eur: Decimal = ZERO
    carry_used_eur: Decimal = ZERO
    base_used_eur: Decimal = ZERO
    carry_generated_eur: Decimal = ZERO
    carry_detail: dict[int, Decimal] = field(default_factory=dict)  # beschikbare overdrachten (jaar -> bedrag) na dit jaar
    taxable_eur: Decimal = ZERO
    tax_eur: Decimal = ZERO
    withheld_eur: Decimal = ZERO
    refund_eur: Decimal = ZERO      # + terug te vorderen / - bij te betalen
    dividends_eur: Decimal = ZERO   # enkel informatief
    sale_count: int = 0


@dataclass
class Report:
    sales: list[SaleResult]
    years: dict[tuple[str, int], YearSummary]
    warnings: list[str]
    events: list[Event] = field(default_factory=list)
    disclaimer: str = (
        "Deze berekening is een hulpmiddel en geen fiscaal advies. "
        "Controleer altijd met de officiële bronnen (FOD Financiën) of een adviseur."
    )
