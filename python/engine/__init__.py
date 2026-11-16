"""Rekenkern voor de Belgische meerwaardebelasting op financiële activa
(algemeen regime, wet van 6 april 2026, BS 21.04.2026).

DISCLAIMER: deze software is een rekenhulp en geen fiscaal advies.
Controleer resultaten altijd met de officiële bronnen of een adviseur.
"""

from .models import (
    Transaction,
    TxType,
    Lot,
    SaleLine,
    SaleResult,
    YearSummary,
    Report,
    BasisUsed,
    DelistMode,
    Event,
)
from .config import EngineConfig, TaxYearConfig, HistoricMethod, FifoScope, DEFAULT_YEARS
from .calculator import calculate, compare_methods, ref_value_from_currency

__all__ = [
    "Transaction",
    "TxType",
    "Lot",
    "SaleLine",
    "SaleResult",
    "YearSummary",
    "Report",
    "BasisUsed",
    "DelistMode",
    "Event",
    "EngineConfig",
    "TaxYearConfig",
    "HistoricMethod",
    "FifoScope",
    "DEFAULT_YEARS",
    "calculate",
    "compare_methods",
    "ref_value_from_currency",
]
