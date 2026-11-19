"""Berekening van de meerwaardebelasting (algemeen regime).

Stappen:
 1. transacties sorteren en omzetten naar EUR (koers op transactiedatum)
 2. lots opbouwen (aankoop, overdracht, schenking, erfenis); splits verwerken
 3. verkopen FIFO matchen op lots
 4. basis per lot: aankoop (>=2026) of fotowaarde 31/12/2025, met optionele
    hogere bewezen historische prijs voor verkopen t.e.m. 31/12/2030
    (nooit tot een minderwaarde)
 5. Reynders-aftrek per verkoop
 6. per eigenaar/jaar: meer- en minderwaarden verrekenen (geen overdracht van verlies)
 7. vrijstelling: eerst overdrachten (oudste eerst, 5 jaar geldig), dan basis;
    nieuwe overdracht = ongebruikt deel van de eerste schijf
 8. belasting = tarief x belastbaar, vergelijken met ingehouden bronheffing
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable, Mapping, Optional

from .config import EngineConfig, FifoScope, HistoricMethod
from .models import (
    ACQUISITION_TYPES,
    ZERO,
    BasisUsed,
    DelistMode,
    Event,
    ExchangeComponent,
    Lot,
    Report,
    SaleLine,
    SaleResult,
    Transaction,
    TxType,
    YearSummary,
)

CENT = Decimal("0.01")


def money(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


def _pool_key(tx_or_lot, scope: FifoScope) -> tuple:
    if scope == FifoScope.BROKER:
        return (tx_or_lot.owner, tx_or_lot.broker, tx_or_lot.asset)
    return (tx_or_lot.owner, tx_or_lot.asset)


def _historic_unit_cost(lot: Lot, pool: list[Lot], method: HistoricMethod,
                        assume_proven: bool = False) -> Optional[Decimal]:
    """Historische kost per stuk die mag gebruikt worden, of None.
    assume_proven: alsof elke aankoop van vóór 2026 met gekende prijs bewijsbaar is (melding 'gemist voordeel')."""
    if not lot.pre_2026:
        return None

    def ok(l: Lot) -> bool:
        return l.cost_known and (l.historic_proven or assume_proven)

    if method == HistoricMethod.FIFO:
        return lot.unit_cost_eur if ok(lot) else None
    pre = [l for l in pool if l.pre_2026]
    if not pre or any(not ok(l) for l in pre):
        return None
    total_qty = sum((l.orig_quantity for l in pre), ZERO)
    if total_qty == 0:
        return None
    return sum((l.orig_quantity * l.unit_cost_eur for l in pre), ZERO) / total_qty


def _line_for_lot(
    lot: Lot,
    qty: Decimal,
    proceeds: Decimal,
    sale_date: date,
    pool: list[Lot],
    cfg: EngineConfig,
) -> SaleLine:
    if not lot.pre_2026:
        if not lot.cost_known:
            return SaleLine(lot.lot_id, lot.acquired, qty, proceeds, ZERO, BasisUsed.UNKNOWN,
                            proceeds, "Aanschaffingswaarde niet gekend: volledige prijs belastbaar")
        basis = money(qty * lot.unit_cost_eur)
        return SaleLine(lot.lot_id, lot.acquired, qty, proceeds, basis, BasisUsed.PURCHASE, proceeds - basis)

    # verworven vóór 2026 -> fotowaarde
    if lot.unit_ref_eur is None:
        raise ValueError(
            f"Geen waarde op 31/12/2025 voor {lot.asset} (nodig voor lot van {lot.acquired})."
        )
    ref = money(qty * lot.unit_ref_eur)
    if proceeds < ref:
        # minderwaarde altijd t.o.v. fotowaarde
        return SaleLine(lot.lot_id, lot.acquired, qty, proceeds, ref, BasisUsed.REF_2025, proceeds - ref)

    hist_unit = _historic_unit_cost(lot, pool, cfg.historic_method) if sale_date <= cfg.historic_until else None
    if hist_unit is not None:
        hist = money(qty * hist_unit)
        if hist > ref:
            result = max(ZERO, proceeds - hist)
            note = "Hogere historische prijs gebruikt" + (" (herleid tot 0)" if proceeds < hist else "")
            if cfg.historic_method == HistoricMethod.AVERAGE:
                note += " [gemiddelde methode]"
            return SaleLine(lot.lot_id, lot.acquired, qty, proceeds, hist, BasisUsed.HISTORIC, result, note)
    line = SaleLine(lot.lot_id, lot.acquired, qty, proceeds, ref, BasisUsed.REF_2025, proceeds - ref)
    # gemist voordeel: hogere historische prijs, maar (een) aankoop niet als bewijsbaar aangeduid
    if hist_unit is None and sale_date <= cfg.historic_until:
        hyp = _historic_unit_cost(lot, pool, cfg.historic_method, assume_proven=True)
        if hyp is not None:
            hist = money(qty * hyp)
            if hist > ref:
                line.missed_historic_eur = (proceeds - ref) - max(ZERO, proceeds - hist)
    return line


def _new_lot(tx: Transaction, lot_id: int, ref_values: Mapping[str, Decimal]) -> Lot:
    if tx.quantity <= 0:
        raise ValueError(f"Aantal moet positief zijn: {tx.source}")
    lot = Lot(
        lot_id=lot_id, owner=tx.owner, broker=tx.broker, asset=tx.asset,
        acquired=tx.trade_date, quantity=tx.quantity, orig_quantity=tx.quantity,
        unit_cost_eur=tx.to_eur(tx.price) if tx.cost_known else ZERO,
        historic_proven=tx.historic_proven, cost_known=tx.cost_known, source=tx.source,
    )
    if lot.pre_2026 and tx.asset in ref_values:
        lot.unit_ref_eur = Decimal(ref_values[tx.asset])
    # ontbreekt de fotowaarde, dan pas een fout als dit lot ná 2025 verkocht wordt
    return lot


def _apply_split(tx: Transaction, pool: list[Lot]) -> None:
    r = tx.split_ratio
    if not r or r <= 0:
        raise ValueError(f"Split zonder geldige ratio: {tx.source}")
    for lot in pool:
        lot.quantity *= r
        lot.orig_quantity *= r
        lot.unit_cost_eur /= r
        if lot.unit_ref_eur is not None:
            lot.unit_ref_eur /= r


def _consume(pool: list[Lot], qty: Decimal) -> None:
    """Verkoop vóór 2026: lots FIFO verbruiken, niet belastbaar."""
    for lot in pool:
        if qty <= 0:
            break
        q = min(qty, lot.quantity)
        lot.quantity -= q
        qty -= q


def calculate(
    transactions: Iterable[Transaction],
    ref_values: Mapping[str, Decimal],
    cfg: Optional[EngineConfig] = None,
    withheld: Optional[Mapping[tuple[str, int], Decimal]] = None,
    through_year: Optional[int] = None,
) -> Report:
    """ref_values: asset -> waarde per stuk in EUR op 31/12/2025.
    withheld: (eigenaar, jaar) -> door broker ingehouden meerwaardebelasting."""
    cfg = cfg or EngineConfig()
    withheld = withheld or {}
    txs = sorted(transactions, key=lambda t: t.trade_date)  # stabiel: invoervolgorde binnen dezelfde dag

    pools: dict[tuple, list[Lot]] = defaultdict(list)
    sales: list[SaleResult] = []
    events: list[Event] = []
    dividends: dict[tuple[str, int], Decimal] = defaultdict(lambda: ZERO)
    next_id = 1

    for tx in txs:
        pool = pools[_pool_key(tx, cfg.fifo_scope)]
        if tx.type in ACQUISITION_TYPES:
            pool.append(_new_lot(tx, next_id, ref_values))
            next_id += 1
        elif tx.type == TxType.SPLIT:
            _apply_split(tx, pool)
        elif tx.type == TxType.SELL:
            if tx.trade_date < cfg.start_date:
                _consume(pool, tx.quantity)
            else:
                sales.append(_process_sale(tx, pool, cfg))
        elif tx.type == TxType.DIVIDEND:
            dividends[(tx.owner, tx.trade_date.year)] += tx.to_eur(tx.amount)
        elif tx.type == TxType.DELISTING:
            _process_delisting(tx, pool, cfg, sales, events)
        elif tx.type == TxType.RUIL:
            next_id = _process_exchange(tx, pool, pools, ref_values, cfg, sales, events, next_id)
        # FEE: enkel registratie

    years = _summarize(sales, dividends, cfg, withheld, through_year)
    warnings = [f"{s.trade_date} {s.asset}: {w}" for s in sales for w in s.warnings]
    warnings += [f"{e.trade_date} {e.asset}: {e.note}" for e in events
                 if e.kind not in (DelistMode.UITKOOP.value, TxType.RUIL.value)]
    warnings += [f"{e.trade_date} {e.asset}: {e.warning}" for e in events if e.warning]
    return Report(sales=sales, years=years, warnings=warnings, events=events)


DELIST_NOTES = {
    DelistMode.NOTERING: (
        "Schrapping van de notering is geen overdracht en dus geen belastbaar moment. "
        "De positie blijft open met dezelfde aanschaffingswaarde; registreer een latere verkoop of uitkoop apart."
    ),
    DelistMode.UITKOOP: "Uitkoop/bod bij delisting: behandeld als overdracht ten bezwarende titel (verkoop).",
    DelistMode.WAARDELOOS: (
        "Waardeloos geworden zonder overdracht: de belasting viseert overdrachten ten bezwarende titel, "
        "dus de tool boekt geen minderwaarde. Een overdracht voor een symbolische prijs (bv. aan je broker) kan wel "
        "een minderwaarde opleveren: registreer die dan als verkoop. Wettelijk niet uitgeklaard; vraag advies."
    ),
}


def _process_delisting(tx: Transaction, pool: list[Lot], cfg: EngineConfig,
                       sales: list[SaleResult], events: list[Event]) -> None:
    try:
        mode = DelistMode(tx.delist_mode or DelistMode.NOTERING.value)
    except ValueError:
        raise ValueError(f"Onbekende soort delisting: {tx.delist_mode!r} ({tx.source})") from None
    held = sum((l.quantity for l in pool), ZERO)
    note = DELIST_NOTES[mode]
    if mode == DelistMode.UITKOOP:
        qty = tx.quantity if tx.quantity > 0 else held
        if qty <= 0:
            note = "Uitkoop geregistreerd, maar er zijn geen stuks in bezit: geen verkoop berekend."
        elif tx.trade_date < cfg.start_date:
            _consume(pool, qty)
        else:
            sale = _process_sale(replace(tx, type=TxType.SELL, quantity=qty), pool, cfg)
            sale.kind = "UITKOOP"
            sale.warnings.insert(0, note)
            sales.append(sale)
    elif held <= 0:
        note = f"Geen stuks in bezit op het moment van de delisting. {note}"
    events.append(Event(tx.trade_date, tx.owner, tx.broker, tx.asset, mode.value, held, note, tx.source))


def _process_sale(tx: Transaction, pool: list[Lot], cfg: EngineConfig) -> SaleResult:
    if tx.quantity <= 0:
        raise ValueError(f"Aantal moet positief zijn: {tx.source}")
    proceeds_total = money(tx.to_eur(tx.quantity * tx.price))
    sale = SaleResult(
        trade_date=tx.trade_date, owner=tx.owner, broker=tx.broker, asset=tx.asset,
        quantity=tx.quantity, proceeds_eur=proceeds_total,
        fees_eur=money(tx.to_eur(tx.fees + tx.taxes)), source=tx.source,
    )
    remaining = tx.quantity
    allocated = ZERO
    # lots blijven in de pool (ook met 0 stuks) zodat de gemiddelde methode
    # alle pre-2026 aankopen kent
    for lot in pool:
        if remaining <= 0:
            break
        if lot.quantity == 0:
            continue
        q = min(remaining, lot.quantity)
        remaining -= q
        if remaining == 0:
            part = proceeds_total - allocated  # restbedrag: som klopt exact
        else:
            part = money(proceeds_total * q / tx.quantity)
        allocated += part
        sale.lines.append(_line_for_lot(lot, q, part, tx.trade_date, pool, cfg))
        lot.quantity -= q

    if remaining > 0:
        part = proceeds_total - allocated
        sale.lines.append(SaleLine(None, None, remaining, part, ZERO, BasisUsed.UNKNOWN, part,
                                   "Geen aankoop gevonden: aanschaffingswaarde 0"))
        sale.warnings.append(
            f"{remaining} stuks zonder gekende aankoop; volledige opbrengst ({part} EUR) als meerwaarde behandeld."
        )

    if tx.reynders_eur:
        gross = sum((l.result_eur for l in sale.lines), ZERO)
        ded = min(money(tx.reynders_eur), max(gross, ZERO))
        sale.reynders_deduction_eur = ded
        if ded < tx.reynders_eur:
            sale.warnings.append("Reynders-aftrek beperkt tot de positieve meerwaarde van deze verkoop.")
    return _finish_sale(sale)


def _finish_sale(sale: SaleResult) -> SaleResult:
    missed = sum((l.missed_historic_eur for l in sale.lines), ZERO)
    if missed > 0:
        sale.warnings.append(
            "Mogelijk voordeel: de historische aankoopprijs ligt hoger dan de waarde op 31/12/2025, maar de aankoop "
            "is niet als bewijsbaar aangeduid. "
            f"Met bewijs zou de meerwaarde {money(missed)} EUR lager zijn: vink 'Ik kan deze aankoopprijs bewijzen' "
            "aan bij de aankoop als je een bewijsstuk hebt."
        )
    if any(l.basis_used == BasisUsed.HISTORIC for l in sale.lines):
        sale.warnings.append(
            "Historische aankoopprijs gebruikt: zelf inroepen in de aangifte en bewijsstukken bewaren."
        )
    return sale


# ---------------------------------------------------------------- omruiling (fusie, overname met ruil in aandelen)

def _exchange_weights(tx: Transaction, ratio_of) -> Optional[tuple[list[Decimal], Decimal]]:
    """Verdeling van de aanschaffingswaarde over de nieuwe effecten en de cash (opleg), volgens hun waarde op de
    ruildatum. Eén nieuw effect zonder cash: alles gaat over. Anders zijn alle waarden nodig; zonder -> None."""
    comps, cash = tx.components, tx.price
    if len(comps) == 1 and cash == 0:
        return [Decimal(1)], ZERO
    if any(not c.value for c in comps):
        return None
    parts = [ratio_of(c) * c.value for c in comps]
    total = sum(parts, ZERO) + cash
    if total <= 0:
        return None
    return [x / total for x in parts], cash / total


def _fmt(x: Decimal) -> str:
    """Zoals Dec.toString in engine.js: zonder exponent en zonder nullen achteraan."""
    s = format(x, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def _process_exchange(tx: Transaction, pool: list[Lot], pools, ref_values: Mapping[str, Decimal],
                      cfg: EngineConfig, sales: list[SaleResult], events: list[Event], next_id: int) -> int:
    comps = tx.components
    if not comps:
        raise ValueError(f"Omruiling zonder nieuwe effecten: {tx.source}")
    for c in comps:
        if not c.asset:
            raise ValueError(f"Omruiling: naam van het nieuwe effect ontbreekt ({tx.source})")
        if c.asset == tx.asset:
            raise ValueError(f"Omruiling: het nieuwe effect moet verschillen van {tx.asset} ({tx.source})")
        if (c.quantity if c.quantity else c.ratio) <= 0:
            raise ValueError(f"Omruiling: ratio voor {c.asset} moet groter dan 0 zijn ({tx.source})")
        if c.value is not None and c.value < 0:
            raise ValueError(f"Omruiling: waarde van {c.asset} mag niet negatief zijn ({tx.source})")
    if tx.price < 0:
        raise ValueError(f"Omruiling: cash per stuk mag niet negatief zijn ({tx.source})")
    late = tx.trade_date >= cfg.start_date
    held = sum((l.quantity for l in pool), ZERO)
    qty = min(tx.quantity, held) if tx.quantity > 0 else held
    event = Event(tx.trade_date, tx.owner, tx.broker, tx.asset, TxType.RUIL.value, held, "", tx.source,
                  quantity=qty, components=list(comps))
    events.append(event)
    if qty <= 0:
        event.note = event.warning = "Omruiling geregistreerd, maar er zijn geen stuks in bezit: niets omgeruild."
        return next_id

    def ratio_of(c: ExchangeComponent) -> Decimal:  # nieuwe stuks per oud stuk
        return c.quantity / qty if c.quantity else c.ratio

    w = _exchange_weights(tx, ratio_of)
    if w is None and late:
        raise ValueError(
            f"Omruiling van {tx.asset} op {tx.trade_date}: vul voor elk nieuw effect de waarde per stuk "
            "op de ruildatum in (nodig om de aanschaffingswaarde te verdelen over de nieuwe effecten en de cash)."
        )

    parts: list[tuple[Lot, Decimal]] = []
    remaining = qty
    for lot in pool:
        if remaining <= 0:
            break
        if lot.quantity == 0:
            continue
        q = min(remaining, lot.quantity)
        parts.append((lot, q))
        remaining -= q
        lot.quantity -= q
    for lot, _ in parts:
        if late and lot.pre_2026 and lot.unit_ref_eur is None:
            raise ValueError(
                f"Geen waarde op 31/12/2025 voor {tx.asset} (nodig voor de omruiling op {tx.trade_date} "
                f"van het lot van {lot.acquired})."
            )

    # nieuwe loten: zelfde verwervingsdatum, aanschaffingswaarde verdeeld volgens de waarde op de ruildatum
    for i, c in enumerate(comps):
        f = w[0][i] if w else None
        r = ratio_of(c)
        target = pools[_pool_key(replace(tx, asset=c.asset), cfg.fifo_scope)]
        given = ZERO
        for j, (lot, q) in enumerate(parts):
            # totaal ontvangen aantal: evenredig over de loten, het laatste lot krijgt de rest (som exact)
            if not c.quantity:
                n = q * c.ratio
            elif j == len(parts) - 1:
                n = c.quantity - given
            else:
                n = c.quantity * q / qty
            given += n
            unit_ref = None
            if lot.pre_2026:
                if not late:
                    if c.asset in ref_values and ref_values[c.asset] not in (None, ""):
                        unit_ref = Decimal(ref_values[c.asset])
                else:
                    unit_ref = lot.unit_ref_eur * f / r
            target.append(Lot(
                lot_id=next_id, owner=lot.owner, broker=lot.broker, asset=c.asset, acquired=lot.acquired,
                quantity=n, orig_quantity=n, unit_cost_eur=lot.unit_cost_eur * f / r if f is not None else ZERO,
                historic_proven=lot.historic_proven, cost_known=lot.cost_known and f is not None,
                source=tx.source, unit_ref_eur=unit_ref,
            ))
            next_id += 1

    per = " + ".join(f"{c.asset} ({_fmt(c.quantity)} st. in totaal)" if c.quantity else f"{_fmt(c.ratio)} {c.asset}"
                     for c in comps) + (
        f" + {_fmt(tx.price)} {tx.currency} cash" if tx.price > 0 else "")
    if not late:
        if w:
            tail = (", verdeeld volgens de waarde op de ruildatum (eigen interpretatie, te bevestigen)."
                    if len(comps) > 1 or tx.price > 0 else ".")
        else:
            tail = (". De aankoopprijs is niet verdeeld (waarde per nieuw stuk op de ruildatum niet ingevuld): "
                    "geen hogere historische prijs mogelijk.")
        event.note = (f"Omruiling vóór 2026 ({per} per stuk): geen belastbaar moment. Voor de nieuwe effecten geldt "
                      f"hun waarde op 31/12/2025; de aankoopdatum en -prijs van {tx.asset} gaan over op de nieuwe "
                      f"effecten{tail}")
        if not w and any(lot.cost_known for lot, _ in parts):
            event.warning = (
                "Omruiling zonder waarde per nieuw stuk op de ruildatum: de historische aankoopprijs "
                f"van {tx.asset} is niet verdeeld over {', '.join(c.asset for c in comps)}, dus een hogere "
                "historische prijs kan niet gebruikt worden."
            )
        return next_id

    event.note = (
        f"Omruiling ({per} per stuk): voor het ruildeel geen belastbaar moment; de aanschaffingswaarde en de waarde op "
        "31/12/2025 gaan over op de nieuwe effecten, verdeeld volgens de waarde op de ruildatum. Eigen interpretatie "
        "(fiscale neutraliteit bij ruil van aandelen), niet uitdrukkelijk bevestigd."
        + (" De cash (opleg) is als verkoop behandeld." if tx.price > 0 else "")
    )
    if tx.price > 0:
        # cash: verkoop van het deel van de loten dat overeenkomt met het aandeel van de cash in de waarde
        wc = w[1]
        total = money(tx.to_eur(qty * tx.price))
        sale = SaleResult(
            trade_date=tx.trade_date, owner=tx.owner, broker=tx.broker, asset=tx.asset, quantity=qty,
            proceeds_eur=total, fees_eur=money(tx.to_eur(tx.fees + tx.taxes)), source=tx.source, kind="RUIL",
            warnings=["Cash bij omruiling (opleg): behandeld als verkoop van het deel van de aandelen dat de cash "
                      "vertegenwoordigt (eigen interpretatie, te bevestigen)."],
        )

        def scale(l: Lot) -> Lot:
            return replace(l, unit_cost_eur=l.unit_cost_eur * wc,
                           unit_ref_eur=l.unit_ref_eur * wc if l.unit_ref_eur is not None else None)

        vpool = [scale(l) for l in pool]
        allocated = ZERO
        for i, (lot, q) in enumerate(parts):
            part = total - allocated if i == len(parts) - 1 else money(total * q / qty)
            allocated += part
            sale.lines.append(_line_for_lot(scale(lot), q, part, tx.trade_date, vpool, cfg))
        sales.append(_finish_sale(sale))
    return next_id


def _summarize(sales, dividends, cfg: EngineConfig, withheld, through_year) -> dict:
    owners = {s.owner for s in sales} | {o for (o, _) in withheld} | {o for (o, _) in dividends}
    if not owners:
        return {}
    first = cfg.start_date.year
    last = max([s.trade_date.year for s in sales] + [y for (_, y) in withheld] + [first])
    if through_year:
        last = max(last, through_year)

    out: dict[tuple[str, int], YearSummary] = {}
    for owner in sorted(owners):
        carries: dict[int, Decimal] = {}
        for year in range(first, last + 1):
            yc = cfg.year(year)
            ys = YearSummary(owner=owner, year=year)
            own = [s for s in sales if s.owner == owner and s.trade_date.year == year]
            ys.sale_count = len(own)
            for s in own:
                r = s.result_eur
                if r >= 0:
                    ys.gains_eur += r
                else:
                    ys.losses_eur += r
            total = ys.gains_eur + ys.losses_eur
            ys.net_eur = max(total, ZERO)
            ys.lost_losses_eur = min(total, ZERO)

            # overdrachten: geldig voor de 5 volgende jaren
            carries = {y: a for y, a in carries.items() if year - y <= yc.carry_validity_years}
            ys.exemption_available_eur = yc.base_exemption + sum(carries.values(), ZERO)

            remaining = ys.net_eur
            for y in sorted(carries):
                use = min(remaining, carries[y])
                carries[y] -= use
                ys.carry_used_eur += use
                remaining -= use
            carries = {y: a for y, a in carries.items() if a > 0}

            ys.base_used_eur = min(remaining, yc.base_exemption)
            remaining -= ys.base_used_eur
            ys.carry_generated_eur = yc.carry_slice - min(yc.carry_slice, ys.base_used_eur)
            if ys.carry_generated_eur > 0:
                carries[year] = ys.carry_generated_eur
            ys.carry_detail = dict(carries)

            ys.taxable_eur = remaining
            ys.tax_eur = money(remaining * yc.rate)
            ys.withheld_eur = money(Decimal(withheld.get((owner, year), ZERO)))
            ys.refund_eur = ys.withheld_eur - ys.tax_eur
            ys.dividends_eur = money(dividends.get((owner, year), ZERO))
            out[(owner, year)] = ys
    return out


REF_PLACES = Decimal("1e-10")


def ref_value_from_currency(price, fx_per_eur) -> Decimal:
    """Waarde 31/12/2025 per stuk in EUR uit de slotkoers in vreemde munt en de wisselkoers
    van 31/12/2025 (ECB-notatie: 1 EUR = fx_per_eur eenheden munt); afgerond op 10 decimalen."""
    p, fx = Decimal(price), Decimal(fx_per_eur)
    if fx <= 0:
        raise ValueError("Wisselkoers op 31/12/2025 moet groter dan 0 zijn.")
    if p < 0:
        raise ValueError("Slotkoers op 31/12/2025 mag niet negatief zijn.")
    return (p / fx).quantize(REF_PLACES, rounding=ROUND_HALF_UP)


def ref_value_from_eur_rate(price, eur_per_unit) -> Decimal:
    """Idem, met de wisselkoers in de andere richting: 1 eenheid munt = eur_per_unit EUR;
    afgerond op 10 decimalen."""
    p, r = Decimal(price), Decimal(eur_per_unit)
    if r <= 0:
        raise ValueError("Wisselkoers op 31/12/2025 moet groter dan 0 zijn.")
    if p < 0:
        raise ValueError("Slotkoers op 31/12/2025 mag niet negatief zijn.")
    return (p * r).quantize(REF_PLACES, rounding=ROUND_HALF_UP)


def compare_methods(transactions, ref_values, cfg: Optional[EngineConfig] = None, **kw) -> dict[str, Report]:
    """Berekent beide interpretaties van de historische prijs naast elkaar."""
    cfg = cfg or EngineConfig()
    return {
        m.value: calculate(list(transactions), ref_values, replace(cfg, historic_method=m), **kw)
        for m in HistoricMethod
    }
