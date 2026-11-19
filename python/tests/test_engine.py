"""Rekenvoorbeelden en randgevallen. Bedragen in de asserts zijn met de hand nagerekend."""

from datetime import date
from decimal import Decimal as D

import pytest

from engine import (
    BasisUsed,
    EngineConfig,
    ExchangeComponent as C,
    HistoricMethod,
    FifoScope,
    TaxYearConfig,
    Transaction as T,
    TxType,
    calculate,
    compare_methods,
    ref_value_from_currency,
    ref_value_from_eur_rate,
)


def cfg_years(*years, **kw):
    """Config met (fictieve) parameters voor latere jaren, enkel voor tests."""
    return EngineConfig(years={y: TaxYearConfig(year=y) for y in years}, **kw)


def buy(d, asset, q, p, **kw):
    return T(trade_date=d, type=TxType.BUY, asset=asset, quantity=D(q), price=D(p), **kw)


def sell(d, asset, q, p, **kw):
    return T(trade_date=d, type=TxType.SELL, asset=asset, quantity=D(q), price=D(p), **kw)


# ---------------------------------------------------------------- uitgewerkt voorbeeld uit stap 3

def example_txs():
    return [
        buy(date(2024, 5, 1), "X", 100, 50, historic_proven=True),
        buy(date(2025, 5, 1), "X", 50, 120, historic_proven=True),
        buy(date(2026, 3, 1), "X", 50, 90),
        sell(date(2026, 9, 1), "X", 120, 110),
        buy(date(2026, 2, 1), "Y", 200, 30),
        sell(date(2026, 11, 1), "Y", 200, 25),
    ]


def test_example_fifo():
    rep = calculate(example_txs(), {"X": D("80")}, withheld={("default", 2026): D("360")})
    x = next(s for s in rep.sales if s.asset == "X")
    assert [(l.basis_used, l.result_eur) for l in x.lines] == [
        (BasisUsed.REF_2025, D("3000.00")),
        (BasisUsed.HISTORIC, D("0")),          # 110 < 120 -> herleid tot 0, geen verlies
    ]
    y = next(s for s in rep.sales if s.asset == "Y")
    assert y.result_eur == D("-1000.00")

    ys = rep.years[("default", 2026)]
    assert ys.gains_eur == D("3000.00")
    assert ys.losses_eur == D("-1000.00")
    assert ys.net_eur == D("2000.00")
    assert ys.base_used_eur == D("2000.00")
    assert ys.taxable_eur == 0 and ys.tax_eur == 0
    assert ys.carry_generated_eur == 0
    assert ys.refund_eur == D("360.00")


def test_example_average_method():
    rep = calculate(example_txs(), {"X": D("80")}, EngineConfig(historic_method=HistoricMethod.AVERAGE))
    x = next(s for s in rep.sales if s.asset == "X")
    # gemiddelde historische prijs 73,33 < fotowaarde 80 -> fotowaarde voor beide lots
    assert [l.basis_used for l in x.lines] == [BasisUsed.REF_2025, BasisUsed.REF_2025]
    assert x.result_eur == D("3600.00")
    assert rep.years[("default", 2026)].net_eur == D("2600.00")


def test_compare_methods_returns_both():
    res = compare_methods(example_txs(), {"X": D("80")})
    assert res["FIFO"].years[("default", 2026)].net_eur == D("2000.00")
    assert res["GEMIDDELD"].years[("default", 2026)].net_eur == D("2600.00")


# ---------------------------------------------------------------- verlies

def test_net_loss_is_floored_and_not_carried():
    txs = [buy(date(2026, 1, 5), "A", 10, 100), sell(date(2026, 6, 1), "A", 10, 80),
           buy(date(2026, 1, 5), "B", 10, 100), sell(date(2026, 7, 1), "B", 10, 105)]
    rep = calculate(txs, {}, cfg_years(2026, 2027), through_year=2027)
    y26 = rep.years[("default", 2026)]
    assert y26.net_eur == 0 and y26.lost_losses_eur == D("-150.00")
    # verlies van 2026 heeft geen effect op 2027
    assert rep.years[("default", 2027)].net_eur == 0


def test_loss_on_pre_2026_asset_measured_against_ref_value():
    # KBC-voorbeeld: aankoop 150, fotowaarde 100, verkoop 80 -> minderwaarde 20 (niet 70)
    txs = [buy(date(2022, 1, 1), "Z", 1, 150, historic_proven=True), sell(date(2027, 3, 1), "Z", 1, 80)]
    rep = calculate(txs, {"Z": D("100")}, cfg_years(2026, 2027))
    assert rep.sales[0].result_eur == D("-20.00")
    assert rep.sales[0].lines[0].basis_used == BasisUsed.REF_2025


# ---------------------------------------------------------------- stap-up

def test_historic_higher_price_until_2030():
    # Bolero-voorbeeld: aankoop 150, fotowaarde 120, verkoop 125 -> 0 i.p.v. 5
    txs = [buy(date(2023, 1, 1), "S", 1, 150, historic_proven=True), sell(date(2026, 6, 1), "S", 1, 125)]
    rep = calculate(txs, {"S": D("120")})
    assert rep.sales[0].result_eur == 0
    assert rep.sales[0].lines[0].basis_used == BasisUsed.HISTORIC


def test_historic_price_no_longer_allowed_after_2030():
    years = range(2026, 2032)
    txs = [buy(date(2023, 1, 1), "S", 1, 150, historic_proven=True), sell(date(2031, 1, 2), "S", 1, 125)]
    rep = calculate(txs, {"S": D("120")}, cfg_years(*years))
    assert rep.sales[0].result_eur == D("5.00")
    assert rep.sales[0].lines[0].basis_used == BasisUsed.REF_2025


def test_historic_price_requires_proof():
    txs = [buy(date(2023, 1, 1), "S", 1, 150, historic_proven=False), sell(date(2026, 6, 1), "S", 1, 125)]
    assert calculate(txs, {"S": D("120")}).sales[0].result_eur == D("5.00")


def test_missed_historic_reported_without_proof():
    # aankoop 150, fotowaarde 120, verkoop 125: zonder bewijs 5 meerwaarde, met bewijs 0 -> 5 gemist
    txs = [buy(date(2023, 1, 1), "S", 1, 150), sell(date(2026, 6, 1), "S", 1, 125)]
    sale = calculate(txs, {"S": D("120")}).sales[0]
    assert sale.lines[0].missed_historic_eur == D("5.00")
    assert any("Mogelijk voordeel" in w and "5.00 EUR" in w for w in sale.warnings)
    # verkoop 200: met bewijs 50 i.p.v. 80 -> 30 gemist
    sale = calculate([txs[0], sell(date(2026, 6, 1), "S", 1, 200)], {"S": D("120")}).sales[0]
    assert sale.lines[0].missed_historic_eur == D("30.00")


def test_no_missed_historic_when_not_applicable():
    cases = [
        ([buy(date(2023, 1, 1), "S", 1, 150, historic_proven=True), sell(date(2026, 6, 1), "S", 1, 125)], {}),  # al gebruikt
        ([buy(date(2023, 1, 1), "S", 1, 100), sell(date(2026, 6, 1), "S", 1, 125)], {}),   # historisch lager
        ([buy(date(2023, 1, 1), "S", 1, 150), sell(date(2026, 6, 1), "S", 1, 110)], {}),   # minderwaarde
        ([buy(date(2023, 1, 1), "S", 1, 150), sell(date(2031, 1, 2), "S", 1, 125)], {"through": 2031}),  # na 2030
    ]
    for txs, kw in cases:
        cfg = cfg_years(*range(2026, 2032)) if kw else None
        sale = calculate(txs, {"S": D("120")}, cfg).sales[0]
        assert sale.lines[0].missed_historic_eur == 0
        assert not any("Mogelijk voordeel" in w for w in sale.warnings)


def test_missed_historic_average_method():
    # gemiddelde: één bewezen lot (100 @ 150) en één niet (100 @ 130) -> gemiddelde 140 niet bruikbaar
    txs = [buy(date(2023, 1, 1), "S", 100, 150, historic_proven=True), buy(date(2024, 1, 1), "S", 100, 130),
           sell(date(2026, 6, 1), "S", 100, 160)]
    sale = calculate(txs, {"S": D("120")}, EngineConfig(historic_method=HistoricMethod.AVERAGE)).sales[0]
    assert sale.result_eur == D("4000.00")
    assert sale.lines[0].missed_historic_eur == D("2000.00")


def test_historic_lower_than_ref_uses_ref():
    txs = [buy(date(2020, 1, 1), "S", 10, 10, historic_proven=True), sell(date(2026, 6, 1), "S", 10, 30)]
    assert calculate(txs, {"S": D("25")}).sales[0].result_eur == D("50.00")


def test_missing_ref_value_raises():
    with pytest.raises(ValueError, match="31/12/2025"):
        calculate([buy(date(2025, 1, 1), "Q", 1, 1), sell(date(2026, 2, 1), "Q", 1, 2)], {})


def test_pre_2026_sale_consumes_lots_without_tax():
    txs = [buy(date(2024, 1, 1), "P", 10, 10), buy(date(2025, 1, 1), "P", 10, 20),
           sell(date(2025, 6, 1), "P", 10, 30), sell(date(2026, 6, 1), "P", 10, 30)]
    rep = calculate(txs, {"P": D("25")})
    assert len(rep.sales) == 1
    assert rep.sales[0].lines[0].acquired == date(2025, 1, 1)  # eerste lot al verkocht in 2025
    assert rep.sales[0].result_eur == D("50.00")


# ---------------------------------------------------------------- vrijstelling en overdracht

def test_exemption_basic():
    txs = [buy(date(2026, 1, 2), "A", 1, 0), sell(date(2026, 5, 1), "A", 1, 11000)]
    ys = calculate(txs, {}).years[("default", 2026)]
    assert ys.taxable_eur == D("1000.00")
    assert ys.tax_eur == D("100.00")


def test_carry_forward_belfius_example():
    # 2026: niets -> 1.000 over; 2027: 1.500 meerwaarde -> eerst 1.000 overdracht, dan 500 basis
    # -> 500 van de eerste schijf over; 2028: 12.000 -> 10.500 vrij, 1.500 belastbaar
    txs = [buy(date(2026, 1, 2), "A", 2, 0),
           sell(date(2027, 5, 1), "A", 1, 1500), sell(date(2028, 5, 1), "A", 1, 12000)]
    rep = calculate(txs, {}, cfg_years(2026, 2027, 2028))
    y26, y27, y28 = (rep.years[("default", y)] for y in (2026, 2027, 2028))
    assert y26.carry_generated_eur == D("1000")
    assert (y27.carry_used_eur, y27.base_used_eur, y27.carry_generated_eur) == (D("1000"), D("500"), D("500"))
    assert y28.exemption_available_eur == D("10500")
    assert y28.taxable_eur == D("1500.00") and y28.tax_eur == D("150.00")


def test_no_carry_when_first_slice_used():
    txs = [buy(date(2026, 1, 2), "A", 1, 0), sell(date(2026, 5, 1), "A", 1, 1000)]
    ys = calculate(txs, {}).years[("default", 2026)]
    assert ys.carry_generated_eur == 0


def test_carry_capped_at_five_years():
    years = list(range(2026, 2033))
    txs = [buy(date(2026, 1, 2), "A", 1, 0), sell(date(2032, 5, 1), "A", 1, 20000)]
    ys = calculate(txs, {}, cfg_years(*years)).years[("default", 2032)]
    # overdracht van 2026 is vervallen; 2027-2031 = 5 x 1.000
    assert ys.exemption_available_eur == D("15000")
    assert ys.taxable_eur == D("5000.00")


def test_missing_year_config_raises():
    txs = [buy(date(2026, 1, 2), "A", 1, 0), sell(date(2027, 5, 1), "A", 1, 10)]
    with pytest.raises(KeyError, match="2027"):
        calculate(txs, {})


# ---------------------------------------------------------------- valuta, split, kosten, bijzondere gevallen

def test_fx_gain_is_taxable():
    # 10 x 100 USD; koop aan 1,20 USD/EUR, verkoop aan 1,10 USD/EUR
    txs = [buy(date(2026, 1, 5), "US", 10, 100, currency="USD", fx_per_eur=D("1.20")),
           sell(date(2026, 8, 1), "US", 10, 100, currency="USD", fx_per_eur=D("1.10"))]
    s = calculate(txs, {}).sales[0]
    assert s.proceeds_eur == D("909.09")
    assert s.lines[0].basis_eur == D("833.33")
    assert s.result_eur == D("75.76")


def test_split_preserves_total_cost():
    txs = [buy(date(2026, 1, 5), "S", 10, 100),
           T(trade_date=date(2026, 3, 1), type=TxType.SPLIT, asset="S", split_ratio=D("4")),
           sell(date(2026, 6, 1), "S", 40, 30)]
    assert calculate(txs, {}).sales[0].result_eur == D("200.00")


def test_split_adjusts_ref_value():
    txs = [buy(date(2025, 1, 5), "S", 10, 50),
           T(trade_date=date(2026, 3, 1), type=TxType.SPLIT, asset="S", split_ratio=D("2")),
           sell(date(2026, 6, 1), "S", 20, 45)]
    # fotowaarde 80/stuk -> 40 na split; 20 x (45-40) = 100
    assert calculate(txs, {"S": D("80")}).sales[0].result_eur == D("100.00")


def test_fees_and_taxes_not_deductible():
    txs = [buy(date(2026, 1, 5), "F", 10, 100, fees=D("15")),
           sell(date(2026, 6, 1), "F", 10, 110, fees=D("15"), taxes=D("3.85"))]
    s = calculate(txs, {}).sales[0]
    assert s.result_eur == D("100.00")
    assert s.fees_eur == D("18.85")


def test_fifo_partial_lots_and_exact_proceeds_split():
    txs = [buy(date(2026, 1, 5), "F", 3, 10), buy(date(2026, 2, 5), "F", 3, 20),
           sell(date(2026, 6, 1), "F", 4, D("33.33"))]
    s = calculate(txs, {}).sales[0]
    assert [l.quantity for l in s.lines] == [D("3"), D("1")]
    assert sum(l.proceeds_eur for l in s.lines) == s.proceeds_eur == D("133.32")
    assert s.result_eur == D("133.32") - D("50")


def test_sale_without_purchase_uses_zero_basis_and_warns():
    s = calculate([sell(date(2026, 6, 1), "N", 5, 10)], {}).sales[0]
    assert s.result_eur == D("50.00")
    assert s.lines[0].basis_used == BasisUsed.UNKNOWN
    assert s.warnings


def test_gift_uses_donor_acquisition_value():
    gift = T(trade_date=date(2026, 2, 1), type=TxType.GIFT_IN, asset="G", quantity=D("10"), price=D("40"))
    rep = calculate([gift, sell(date(2026, 9, 1), "G", 10, 70)], {})
    assert rep.sales[0].result_eur == D("300.00")


def test_inherited_pre_2026_asset_gets_ref_value():
    inh = T(trade_date=date(2015, 1, 1), type=TxType.INHERIT_IN, asset="H", quantity=D("1"), price=D("10"))
    assert calculate([inh, sell(date(2026, 9, 1), "H", 1, 100)], {"H": D("90")}).sales[0].result_eur == D("10.00")


def test_unknown_cost_means_zero_basis():
    t = T(trade_date=date(2026, 2, 1), type=TxType.GIFT_IN, asset="G", quantity=D("1"), cost_known=False)
    s = calculate([t, sell(date(2026, 9, 1), "G", 1, 70)], {}).sales[0]
    assert s.result_eur == D("70.00") and s.lines[0].basis_used == BasisUsed.UNKNOWN


def test_reynders_deduction():
    txs = [buy(date(2026, 1, 5), "BF", 10, 100), sell(date(2026, 9, 1), "BF", 10, 110, reynders_eur=D("30"))]
    assert calculate(txs, {}).sales[0].result_eur == D("70.00")


def test_dividends_are_only_registered():
    div = T(trade_date=date(2026, 4, 1), type=TxType.DIVIDEND, asset="X", amount=D("120"),
            currency="USD", fx_per_eur=D("1.20"))
    rep = calculate([div], {})
    ys = rep.years[("default", 2026)]
    assert ys.dividends_eur == D("100.00") and ys.net_eur == 0


def test_fifo_scope_broker_vs_owner():
    txs = [buy(date(2026, 1, 5), "B", 1, 10, broker="bolero"),
           buy(date(2026, 2, 5), "B", 1, 50, broker="saxo"),
           sell(date(2026, 6, 1), "B", 1, 60, broker="saxo")]
    assert calculate(txs, {}).sales[0].result_eur == D("50.00")  # eigenaar: oudste lot (Bolero)
    by_broker = calculate(txs, {}, EngineConfig(fifo_scope=FifoScope.BROKER))
    assert by_broker.sales[0].result_eur == D("10.00")


def test_multiple_owners_have_separate_exemptions():
    txs = [buy(date(2026, 1, 5), "A", 2, 0, owner="an"), sell(date(2026, 6, 1), "A", 2, 6000, owner="an"),
           buy(date(2026, 1, 5), "A", 1, 0, owner="bert"), sell(date(2026, 6, 1), "A", 1, 4000, owner="bert")]
    rep = calculate(txs, {})
    assert rep.years[("an", 2026)].taxable_eur == D("2000.00")
    assert rep.years[("bert", 2026)].taxable_eur == 0


# ---------------------------------------------------------------- delisting

def delist(d, asset, mode, q=0, p=0, **kw):
    return T(trade_date=d, type=TxType.DELISTING, asset=asset, delist_mode=mode, quantity=D(q), price=D(p), **kw)


def test_delisting_notering_is_not_taxable_and_position_stays_open():
    txs = [buy(date(2026, 1, 5), "DL", 10, 100), delist(date(2026, 4, 1), "DL", "NOTERING"),
           sell(date(2026, 9, 1), "DL", 10, 120)]
    rep = calculate(txs, {})
    assert len(rep.sales) == 1 and rep.sales[0].kind == "VERKOOP"
    assert rep.sales[0].result_eur == D("200.00")          # aanschaffingswaarde blijft behouden
    assert rep.events[0].kind == "NOTERING" and rep.events[0].quantity_held == D("10")
    assert any("geen overdracht" in w for w in rep.warnings)


def test_delisting_buyout_sells_full_position():
    txs = [buy(date(2025, 3, 1), "UK", 10, 40), buy(date(2026, 2, 1), "UK", 5, 60),
           delist(date(2026, 6, 1), "UK", "UITKOOP", p=70)]
    rep = calculate(txs, {"UK": D("50")})
    s = rep.sales[0]
    assert s.kind == "UITKOOP" and s.quantity == D("15")
    # 10 x (70-50) + 5 x (70-60) = 250
    assert s.result_eur == D("250.00")
    assert "Uitkoop" in s.warnings[0]


def test_delisting_buyout_partial_quantity_and_currency():
    txs = [buy(date(2026, 1, 5), "US", 10, 100, currency="USD", fx_per_eur=D("1.25")),
           delist(date(2026, 6, 1), "US", "UITKOOP", q=4, p=110, currency="USD", fx_per_eur=D("1.10"))]
    s = calculate(txs, {}).sales[0]
    assert s.quantity == D("4") and s.result_eur == D("80.00")   # 400 - 320


def test_delisting_buyout_without_position():
    rep = calculate([delist(date(2026, 6, 1), "X", "UITKOOP", p=70)], {})
    assert rep.sales == [] and "geen stuks" in rep.events[0].note


def test_delisting_worthless_books_no_loss():
    txs = [buy(date(2026, 1, 5), "W", 10, 100), delist(date(2026, 6, 1), "W", "WAARDELOOS")]
    rep = calculate(txs, {})
    assert rep.sales == [] and rep.events[0].kind == "WAARDELOOS"
    assert any("niet uitgeklaard" in w for w in rep.warnings)
    # symbolische verkoop daarna levert wel een minderwaarde op
    rep2 = calculate(txs + [sell(date(2026, 7, 1), "W", 10, D("0.01"))], {})
    assert rep2.sales[0].result_eur == D("-999.90")


def test_delisting_unknown_mode_raises():
    with pytest.raises(ValueError, match="delisting"):
        calculate([delist(date(2026, 6, 1), "X", "FOO")], {})


def test_ref_value_only_needed_for_lots_sold_after_2025():
    # volledig verkocht vóór 2026: geen fotowaarde nodig
    txs = [buy(date(2019, 1, 1), "OLD", 10, 5), sell(date(2020, 1, 1), "OLD", 10, 8),
           buy(date(2026, 1, 5), "NEW", 1, 10), sell(date(2026, 2, 1), "NEW", 1, 12)]
    assert calculate(txs, {}).sales[0].result_eur == D("2.00")
    # nog open eind 2025 maar niet verkocht: ook geen fout
    assert calculate([buy(date(2024, 1, 1), "HOLD", 1, 5)], {}).sales == []


def test_ref_value_from_foreign_currency():
    # slotkoers 150 USD, ECB-koers 31/12/2025 1 EUR = 1,1745 USD (verzonnen)
    ref = ref_value_from_currency("150", "1.1745")
    assert ref == D("127.7139208174")
    assert ref_value_from_currency("12.5", "1") == D("12.5")
    txs = [buy(date(2020, 1, 1), "US", 10, 100, currency="USD", fx_per_eur=D("1.10")),
           sell(date(2026, 3, 1), "US", 10, 160, currency="USD", fx_per_eur=D("1.15"))]
    line = calculate(txs, {"US": ref}).sales[0].lines[0]
    assert line.basis_eur == D("1277.14") and line.result_eur == D("114.16")
    with pytest.raises(ValueError):
        ref_value_from_currency("150", "0")
    with pytest.raises(ValueError):
        ref_value_from_currency("-1", "1.2")


def test_ref_value_from_eur_rate():
    # slotkoers 150 USD, koers 31/12/2025 1 USD = 0,8514 EUR (verzonnen)
    assert ref_value_from_eur_rate("150", "0.8514") == D("127.71")
    assert ref_value_from_eur_rate("33.333", "0.12345678901") == D("4.1151851481")
    with pytest.raises(ValueError):
        ref_value_from_eur_rate("150", "0")
    with pytest.raises(ValueError):
        ref_value_from_eur_rate("-1", "0.85")


def test_fx_in_both_directions_gives_same_result():
    # 1 EUR = 1,25 USD is hetzelfde als 1 USD = 0,80 EUR
    a = [buy(date(2026, 1, 5), "US", 10, 100, currency="USD", fx_per_eur=D("1.25")),
         sell(date(2026, 6, 1), "US", 10, 130, currency="USD", fx_per_eur=D("1.25"))]
    b = [buy(date(2026, 1, 5), "US", 10, 100, currency="USD", eur_per_ccy=D("0.80")),
         sell(date(2026, 6, 1), "US", 10, 130, currency="USD", eur_per_ccy=D("0.80"))]
    ra, rb = calculate(a, {}), calculate(b, {})
    assert ra.sales[0].result_eur == rb.sales[0].result_eur == D("240.00")
    # onrond: 1 USD = 0,8514 EUR
    c = [buy(date(2026, 1, 5), "US", 3, D("33.33"), currency="USD", eur_per_ccy=D("0.8514")),
         sell(date(2026, 6, 1), "US", 3, D("41.17"), currency="USD", eur_per_ccy=D("0.8571"))]
    s = calculate(c, {}).sales[0]
    assert s.proceeds_eur == D("105.86") and s.result_eur == D("20.73")
    with pytest.raises(ValueError):
        calculate([buy(date(2026, 1, 5), "US", 1, 1, currency="USD", eur_per_ccy=D("0"))], {})


# ---------------------------------------------------------------- omruiling (fusie/overname)

def ruil(d, asset, comps, cash=0, q=0, **kw):
    return T(trade_date=d, type=TxType.RUIL, asset=asset, quantity=D(q), price=D(cash),
             components=[C(a, D(r), None if v is None else D(v)) for a, r, v in comps], **kw)


def test_exchange_before_2026_splits_historic_cost_by_value():
    # 100 OUD @ 50; ruil: 0,5 NA (waarde 60) + 0,25 NB (waarde 40) + 10 cash -> gewichten 30/10/10 van 50
    txs = [buy(date(2020, 1, 10), "OUD", 100, 50, historic_proven=True),
           ruil(date(2023, 3, 31), "OUD", [("NA", "0.5", 60), ("NB", "0.25", 40)], cash=10),
           sell(date(2026, 6, 1), "NA", 50, 70), sell(date(2026, 6, 1), "NB", 25, 35)]
    rep = calculate(txs, {"NA": D("55"), "NB": D("30")})
    na, nb = rep.sales
    assert [(l.acquired, l.basis_used, l.basis_eur, l.result_eur) for l in na.lines] == [
        (date(2020, 1, 10), BasisUsed.HISTORIC, D("3000.00"), D("500.00"))]  # 60 per NA > 55
    assert [(l.basis_used, l.basis_eur, l.result_eur) for l in nb.lines] == [
        (BasisUsed.HISTORIC, D("1000.00"), D("0"))]  # 40 per NB > 30, herleid tot 0
    assert [e.kind for e in rep.events] == ["RUIL"] and rep.events[0].quantity == D("100")
    assert "vóór 2026" in rep.events[0].note
    assert not any("RUIL" in w or "Omruiling" in w for w in rep.warnings)


def test_exchange_before_2026_without_values_uses_ref_only():
    txs = [buy(date(2020, 1, 10), "OUD", 100, 50, historic_proven=True),
           ruil(date(2023, 3, 31), "OUD", [("NA", "0.5", None), ("NB", "0.25", None)], cash=10),
           sell(date(2026, 6, 1), "NA", 50, 70)]
    rep = calculate(txs, {"NA": D("55")})
    l = rep.sales[0].lines[0]
    assert (l.basis_used, l.result_eur, l.missed_historic_eur) == (BasisUsed.REF_2025, D("750.00"), D("0"))
    assert any("niet verdeeld" in w for w in rep.warnings)


def test_exchange_single_component_transfers_cost():
    txs = [buy(date(2024, 3, 1), "OUD", 10, 100, historic_proven=True),
           ruil(date(2025, 6, 1), "OUD", [("NIEUW", "2", None)]),
           sell(date(2026, 6, 1), "NIEUW", 20, 60)]
    rep = calculate(txs, {"NIEUW": D("40")})
    l = rep.sales[0].lines[0]
    assert (l.basis_used, l.basis_eur, l.result_eur) == (BasisUsed.HISTORIC, D("1000.00"), D("200.00"))


def test_exchange_from_2026_cash_is_sale_and_cost_carries_over():
    txs = [buy(date(2026, 2, 1), "OUD", 10, 100),
           ruil(date(2026, 6, 1), "OUD", [("NIEUW", "1", 90)], cash=30),
           sell(date(2026, 9, 1), "NIEUW", 10, 95)]
    rep = calculate(txs, {})
    cash, s = rep.sales
    assert (cash.kind, cash.proceeds_eur, cash.lines[0].basis_eur, cash.result_eur) == ("RUIL", D("300.00"), D("250.00"), D("50.00"))
    assert (s.lines[0].acquired, s.lines[0].basis_eur, s.result_eur) == (date(2026, 2, 1), D("750.00"), D("200.00"))
    assert rep.years[("default", 2026)].net_eur == D("250.00")


def test_exchange_from_2026_of_pre_2026_lot_splits_ref_value():
    # ref OUD 100; ruil 2 NIEUW (waarde 60) + 30 cash -> 120/150 = 0,8 en 0,2
    txs = [buy(date(2025, 1, 5), "OUD", 10, 80),
           ruil(date(2026, 6, 1), "OUD", [("NIEUW", "2", 60)], cash=30, currency="USD", fx_per_eur=D("1")),
           sell(date(2026, 9, 1), "NIEUW", 20, 45)]
    rep = calculate(txs, {"OUD": D("100")})
    cash, s = rep.sales
    assert (cash.lines[0].basis_used, cash.lines[0].basis_eur, cash.result_eur) == (BasisUsed.REF_2025, D("200.00"), D("100.00"))
    assert (s.lines[0].basis_used, s.lines[0].basis_eur, s.result_eur) == (BasisUsed.REF_2025, D("800.00"), D("100.00"))


def test_exchange_partial_quantity_and_no_position():
    txs = [buy(date(2026, 1, 5), "OUD", 10, 100), buy(date(2026, 1, 6), "OUD", 10, 120),
           ruil(date(2026, 3, 1), "OUD", [("NIEUW", "1", None)], q=15),
           sell(date(2026, 4, 1), "OUD", 5, 130), sell(date(2026, 4, 1), "NIEUW", 15, 150)]
    rep = calculate(txs, {})
    oud, nieuw = rep.sales
    assert oud.result_eur == D("50.00")                    # rest van lot 2 (120)
    assert nieuw.result_eur == D("2250.00") - D("1600.00")  # 10 x 100 + 5 x 120
    assert [l.acquired for l in nieuw.lines] == [date(2026, 1, 5), date(2026, 1, 6)]
    rep = calculate([ruil(date(2026, 3, 1), "X", [("Y", "1", None)])], {})
    assert rep.events[0].quantity == 0 and any("geen stuks in bezit" in w for w in rep.warnings)


def test_exchange_errors():
    with pytest.raises(ValueError, match="waarde per stuk"):
        calculate([buy(date(2026, 1, 5), "OUD", 1, 1),
                   ruil(date(2026, 3, 1), "OUD", [("A", "1", None), ("B", "1", 5)])], {})
    with pytest.raises(ValueError, match="ratio"):
        calculate([ruil(date(2023, 3, 1), "OUD", [("A", "0", None)])], {})
    with pytest.raises(ValueError, match="zonder nieuwe effecten"):
        calculate([ruil(date(2023, 3, 1), "OUD", [])], {})
    with pytest.raises(ValueError, match="31/12/2025"):
        calculate([buy(date(2025, 1, 5), "OUD", 1, 1), ruil(date(2026, 3, 1), "OUD", [("A", "1", None)])], {})


def test_exchange_average_method_includes_received_lots():
    cfg = EngineConfig(historic_method=HistoricMethod.AVERAGE)
    txs = [buy(date(2021, 1, 5), "OUD", 10, 100, historic_proven=True),
           ruil(date(2022, 1, 5), "OUD", [("N", "1", None)]),
           buy(date(2024, 1, 5), "N", 10, 60, historic_proven=True),
           sell(date(2026, 6, 1), "N", 20, 90)]
    s = calculate(txs, {"N": D("70")}, cfg).sales[0]
    assert [l.basis_used for l in s.lines] == [BasisUsed.HISTORIC, BasisUsed.HISTORIC]
    assert s.result_eur == D("200.00")  # 20 x 90 - 20 x 80


def test_exchange_notes_match_js():
    rep = calculate([buy(date(2020, 1, 10), "OUD", 10, 5),
                     ruil(date(2023, 3, 31), "OUD", [("NA", "0.1598", None), ("NB", "0.0376", None)], cash=D("1.0406"),
                          currency="USD", fx_per_eur=D("1.08"))], {})
    assert rep.events[0].note == (
        "Omruiling vóór 2026 (0.1598 NA + 0.0376 NB + 1.0406 USD cash per stuk): geen belastbaar moment. "
        "Voor de nieuwe effecten geldt hun waarde op 31/12/2025; de aankoopdatum en -prijs van OUD gaan over op de nieuwe effecten. "
        "De aankoopprijs is niet verdeeld (waarde per nieuw stuk op de ruildatum niet ingevuld): geen hogere historische prijs mogelijk.")


def ruil_q(d, asset, comps, cash=0, **kw):
    """Omruiling met het totaal ontvangen aantal per nieuw effect (zoals uit een import)."""
    return T(trade_date=d, type=TxType.RUIL, asset=asset, price=D(cash),
             components=[C(a, value=None if v is None else D(v), quantity=D(q)) for a, q, v in comps], **kw)


def test_exchange_total_quantity_splits_cost_by_value():
    # 100 OUD @ 10; 20 NA (waarde 25) + 30 NB (waarde 10) + 2 cash per oud stuk -> per oud stuk 5 / 3 / 2 van 10
    txs = [buy(date(2020, 1, 10), "OUD", 40, 10, historic_proven=True), buy(date(2021, 1, 10), "OUD", 60, 10, historic_proven=True),
           ruil_q(date(2023, 3, 31), "OUD", [("NA", 20, 25), ("NB", 30, 10)], cash=2),
           sell(date(2026, 6, 1), "NA", 20, 30)]
    rep = calculate(txs, {"NA": D("22")})
    s = rep.sales[0]
    assert [(l.acquired, l.quantity, l.basis_used, l.basis_eur) for l in s.lines] == [
        (date(2020, 1, 10), D("8"), BasisUsed.HISTORIC, D("200.00")), (date(2021, 1, 10), D("12"), BasisUsed.HISTORIC, D("300.00"))]
    assert s.result_eur == D("100.00")
    assert "NA (20 st. in totaal) + NB (30 st. in totaal) + 2 EUR cash" in rep.events[0].note


def test_exchange_total_quantity_is_exact_over_lots():
    txs = [buy(date(2020, 1, 1), "OUD", 1, 3), buy(date(2020, 2, 1), "OUD", 1, 3), buy(date(2020, 3, 1), "OUD", 1, 3),
           ruil_q(date(2023, 1, 1), "OUD", [("N", 1, None)]), sell(date(2026, 2, 1), "N", 1, 12)]
    s = calculate(txs, {"N": D("10")}).sales[0]
    assert len(s.lines) == 3 and sum(l.quantity for l in s.lines) == 1
    assert not s.warnings and s.result_eur == D("2.01")  # 3 loten x (4,00 - 3,33): afronding per lot
