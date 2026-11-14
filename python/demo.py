"""Toont het uitgewerkte voorbeeld als controleerbaar overzicht.  python3 demo.py"""

from datetime import date
from decimal import Decimal as D

from engine import Transaction as T, TxType, calculate

txs = [
    T(date(2024, 5, 1), TxType.BUY, "X", D("100"), D("50"), historic_proven=True, source="vb:1"),
    T(date(2025, 5, 1), TxType.BUY, "X", D("50"), D("120"), historic_proven=True, source="vb:2"),
    T(date(2026, 3, 1), TxType.BUY, "X", D("50"), D("90"), source="vb:3"),
    T(date(2026, 9, 1), TxType.SELL, "X", D("120"), D("110"), fees=D("7.50"), source="vb:4"),
    T(date(2026, 2, 1), TxType.BUY, "Y", D("200"), D("30"), source="vb:5"),
    T(date(2026, 11, 1), TxType.SELL, "Y", D("200"), D("25"), source="vb:6"),
]
rep = calculate(txs, {"X": D("80")}, withheld={("default", 2026): D("360")})

print("PER VERKOOP")
for s in rep.sales:
    print(f"\n{s.trade_date}  {s.asset}  {s.quantity} st.  opbrengst {s.proceeds_eur}  (kosten {s.fees_eur}, niet aftrekbaar)")
    for l in s.lines:
        print(f"   lot {l.acquired}  {l.quantity:>5} st.  opbrengst {l.proceeds_eur:>9}  "
              f"basis {l.basis_eur:>9} [{l.basis_used.value}]  resultaat {l.result_eur:>9}  {l.note}")
    print(f"   => {s.result_eur}")

print("\nJAAROVERZICHT")
for (owner, year), y in rep.years.items():
    print(f"{owner} {year}: meerwaarden {y.gains_eur}, minderwaarden {y.losses_eur}, netto {y.net_eur}")
    print(f"   vrijstelling beschikbaar {y.exemption_available_eur}: overdracht {y.carry_used_eur} + basis {y.base_used_eur}")
    print(f"   belastbaar {y.taxable_eur} -> belasting {y.tax_eur}; ingehouden {y.withheld_eur}; terug {y.refund_eur}")
    print(f"   nieuwe overdracht naar {year + 1}: {y.carry_generated_eur}")

print("\nWAARSCHUWINGEN")
for w in rep.warnings:
    print(" -", w)
print("\n" + rep.disclaimer)
