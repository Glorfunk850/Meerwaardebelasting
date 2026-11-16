/* Rekenkern meerwaardebelasting (algemeen regime) — JavaScript-versie van engine/calculator.py.
 * Exacte decimale rekenkunde met BigInt (20 decimalen intern, afronding half-up zoals Python ROUND_HALF_UP).
 * Geen fiscaal advies. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ Decimal
  const SCALE = 20n;
  const F = 10n ** SCALE;

  function divRound(n, d) {
    if (d === 0n) throw new Error("Deling door nul");
    const neg = (n < 0n) !== (d < 0n);
    const a = n < 0n ? -n : n, b = d < 0n ? -d : d;
    let q = a / b;
    if (2n * (a % b) >= b) q += 1n;
    return neg ? -q : q;
  }

  class Dec {
    constructor(raw) { this.raw = raw; Object.freeze(this); }
    static parse(v) {
      if (v instanceof Dec) return v;
      if (typeof v === "number") {
        if (!Number.isInteger(v)) throw new Error("Gebruik strings voor niet-gehele getallen");
        return new Dec(BigInt(v) * F);
      }
      const s = String(v ?? "").trim().replace(/\s/g, "").replace(",", ".");
      const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
      if (!m || ((m[2] || "") === "" && (m[3] || "") === "")) throw new Error(`Geen geldig getal: ${v}`);
      const frac = m[3] || "";
      const full = BigInt((m[2] || "0") + frac);
      const exp = BigInt(frac.length);
      let raw = exp <= SCALE ? full * 10n ** (SCALE - exp) : divRound(full, 10n ** (exp - SCALE));
      if (m[1] === "-") raw = -raw;
      return new Dec(raw);
    }
    add(o) { return new Dec(this.raw + D(o).raw); }
    sub(o) { return new Dec(this.raw - D(o).raw); }
    mul(o) { return new Dec(divRound(this.raw * D(o).raw, F)); }
    div(o) { return new Dec(divRound(this.raw * F, D(o).raw)); }
    neg() { return new Dec(-this.raw); }
    cmp(o) { const r = D(o).raw; return this.raw < r ? -1 : this.raw > r ? 1 : 0; }
    lt(o) { return this.cmp(o) < 0; } lte(o) { return this.cmp(o) <= 0; }
    gt(o) { return this.cmp(o) > 0; } gte(o) { return this.cmp(o) >= 0; }
    eq(o) { return this.cmp(o) === 0; }
    isZero() { return this.raw === 0n; }
    round(places = 2) { const u = 10n ** (SCALE - BigInt(places)); return new Dec(divRound(this.raw, u) * u); }
    toFixed(places = 2) {
      const r = this.round(places).raw;
      const neg = r < 0n, a = neg ? -r : r;
      const ip = a / F, fp = (a % F).toString().padStart(Number(SCALE), "0").slice(0, places);
      return (neg && a !== 0n ? "-" : "") + ip.toString() + (places ? "." + fp : "");
    }
    toString() {
      const neg = this.raw < 0n, a = neg ? -this.raw : this.raw;
      const ip = a / F, fp = (a % F).toString().padStart(Number(SCALE), "0").replace(/0+$/, "");
      return (neg ? "-" : "") + ip.toString() + (fp ? "." + fp : "");
    }
    toJSON() { return this.toString(); }
    static max(a, b) { return a.gte(b) ? a : b; }
    static min(a, b) { return a.lte(b) ? a : b; }
  }
  function D(v) { return Dec.parse(v); }
  const ZERO = D(0), ONE = D(1);
  const money = x => x.round(2);
  const sum = arr => arr.reduce((a, b) => a.add(b), ZERO);

  // ------------------------------------------------------------ constanten
  const TxType = ["BUY", "SELL", "SPLIT", "DIVIDEND", "FEE", "TRANSFER_IN", "GIFT_IN", "INHERIT_IN", "DELISTING"];
  const DelistModes = ["NOTERING", "UITKOOP", "WAARDELOOS"];
  const ACQ = new Set(["BUY", "TRANSFER_IN", "GIFT_IN", "INHERIT_IN"]);
  const START = "2026-01-01";

  function defaultConfig() {
    return {
      years: { 2026: { rate: D("0.10"), baseExemption: D("10000"), carrySlice: D("1000"), carryValidityYears: 5,
                       source: "Wet 6.4.2026 (BS 21.4.2026); vrijstelling 2026 = 10.000 EUR" } },
      historicUntil: "2030-12-31",
      historicMethod: "FIFO",       // of "GEMIDDELD"
      fifoScope: "EIGENAAR",        // of "BROKER"
    };
  }
  function yearCfg(cfg, y) {
    const c = cfg.years[y];
    if (!c) throw new Error(`Geen fiscale parameters voor inkomstenjaar ${y}. Voeg het geïndexeerde vrijstellingsbedrag toe aan de configuratie.`);
    return c;
  }

  /** Normaliseer een transactie (strings/numbers -> Dec, defaults). */
  function tx(t) {
    return {
      trade_date: t.trade_date, type: t.type, asset: t.asset,
      quantity: D(t.quantity ?? 0), price: D(t.price ?? 0), currency: t.currency || "EUR",
      fx_per_eur: D(t.fx_per_eur ?? 1),
      eur_per_ccy: t.eur_per_ccy != null && t.eur_per_ccy !== "" ? D(t.eur_per_ccy) : null, fees: D(t.fees ?? 0), taxes: D(t.taxes ?? 0),
      owner: t.owner || "default", broker: t.broker || "",
      split_ratio: t.split_ratio != null && t.split_ratio !== "" ? D(t.split_ratio) : null,
      historic_proven: !!t.historic_proven, cost_known: t.cost_known !== false,
      reynders_eur: D(t.reynders_eur ?? 0), amount: D(t.amount ?? 0), source: t.source || "",
      delist_mode: t.delist_mode || "",
    };
  }
  /** Omrekening naar EUR: met eur_per_ccy (1 munt = … EUR) als die ingevuld is, anders met fx_per_eur (1 EUR = … munt). */
  function toEur(t, amount) {
    if (t.eur_per_ccy) {
      if (!t.eur_per_ccy.gt(ZERO)) throw new Error(`Ongeldige wisselkoers in ${t.source}`);
      return amount.mul(t.eur_per_ccy);
    }
    if (!t.fx_per_eur.gt(ZERO)) throw new Error(`Ongeldige wisselkoers in ${t.source}`);
    return amount.div(t.fx_per_eur);
  }

  // ------------------------------------------------------------ lots en verkopen
  const poolKey = (t, scope) => scope === "BROKER" ? `${t.owner}\u0000${t.broker}\u0000${t.asset}` : `${t.owner}\u0000${t.asset}`;
  const isPre = lot => lot.acquired < START;

  /** assumeProven: alsof elke aankoop van vóór 2026 met gekende prijs bewijsbaar is (voor de melding 'gemist voordeel'). */
  function historicUnit(lot, pool, method, assumeProven = false) {
    if (!isPre(lot)) return null;
    const ok = l => l.costKnown && (l.historicProven || assumeProven);
    if (method === "FIFO") return ok(lot) ? lot.unitCost : null;
    const pre = pool.filter(isPre);
    if (!pre.length || pre.some(l => !ok(l))) return null;
    const q = sum(pre.map(l => l.origQuantity));
    if (q.isZero()) return null;
    return sum(pre.map(l => l.origQuantity.mul(l.unitCost))).div(q);
  }

  function line(lot, qty, proceeds, basis, basisUsed, result, note = "") {
    return { lotId: lot ? lot.lotId : null, acquired: lot ? lot.acquired : null, quantity: qty,
             proceeds_eur: proceeds, basis_eur: basis, basis_used: basisUsed, result_eur: result, note,
             missed_historic_eur: ZERO };
  }

  function lineForLot(lot, qty, proceeds, saleDate, pool, cfg) {
    if (!isPre(lot)) {
      if (!lot.costKnown) return line(lot, qty, proceeds, ZERO, "ONBEKEND", proceeds, "Aanschaffingswaarde niet gekend: volledige prijs belastbaar");
      const basis = money(qty.mul(lot.unitCost));
      return line(lot, qty, proceeds, basis, "AANKOOP", proceeds.sub(basis));
    }
    if (!lot.unitRef) throw new Error(`Geen waarde op 31/12/2025 voor ${lot.asset} (nodig voor lot van ${lot.acquired}).`);
    const ref = money(qty.mul(lot.unitRef));
    if (proceeds.lt(ref)) return line(lot, qty, proceeds, ref, "REF_31_12_2025", proceeds.sub(ref));
    const hu = saleDate <= cfg.historicUntil ? historicUnit(lot, pool, cfg.historicMethod) : null;
    if (hu) {
      const hist = money(qty.mul(hu));
      if (hist.gt(ref)) {
        let note = "Hogere historische prijs gebruikt" + (proceeds.lt(hist) ? " (herleid tot 0)" : "");
        if (cfg.historicMethod === "GEMIDDELD") note += " [gemiddelde methode]";
        return line(lot, qty, proceeds, hist, "HISTORISCH", Dec.max(ZERO, proceeds.sub(hist)), note);
      }
    }
    const l = line(lot, qty, proceeds, ref, "REF_31_12_2025", proceeds.sub(ref));
    // gemist voordeel: hogere historische prijs, maar (een) aankoop niet als bewijsbaar aangeduid
    const hyp = !hu && saleDate <= cfg.historicUntil ? historicUnit(lot, pool, cfg.historicMethod, true) : null;
    if (hyp) {
      const hist = money(qty.mul(hyp));
      if (hist.gt(ref)) l.missed_historic_eur = proceeds.sub(ref).sub(Dec.max(ZERO, proceeds.sub(hist)));
    }
    return l;
  }

  function processSale(t, pool, cfg) {
    if (!t.quantity.gt(ZERO)) throw new Error(`Aantal moet positief zijn: ${t.source}`);
    const total = money(toEur(t, t.quantity.mul(t.price)));
    const sale = { trade_date: t.trade_date, owner: t.owner, broker: t.broker, asset: t.asset, quantity: t.quantity,
                   proceeds_eur: total, fees_eur: money(toEur(t, t.fees.add(t.taxes))), lines: [],
                   reynders_deduction_eur: ZERO, warnings: [], source: t.source, kind: "VERKOOP" };
    let remaining = t.quantity, allocated = ZERO;
    for (const lot of pool) {
      if (!remaining.gt(ZERO)) break;
      if (lot.quantity.isZero()) continue;
      const q = Dec.min(remaining, lot.quantity);
      remaining = remaining.sub(q);
      const part = remaining.isZero() ? total.sub(allocated) : money(total.mul(q).div(t.quantity));
      allocated = allocated.add(part);
      sale.lines.push(lineForLot(lot, q, part, t.trade_date, pool, cfg));
      lot.quantity = lot.quantity.sub(q);
    }
    if (remaining.gt(ZERO)) {
      const part = total.sub(allocated);
      sale.lines.push(line(null, remaining, part, ZERO, "ONBEKEND", part, "Geen aankoop gevonden: aanschaffingswaarde 0"));
      sale.warnings.push(`${remaining} stuks zonder gekende aankoop; volledige opbrengst (${part.toFixed(2)} EUR) als meerwaarde behandeld.`);
    }
    if (!t.reynders_eur.isZero()) {
      const gross = sum(sale.lines.map(l => l.result_eur));
      const ded = Dec.min(money(t.reynders_eur), Dec.max(gross, ZERO));
      sale.reynders_deduction_eur = ded;
      if (ded.lt(t.reynders_eur)) sale.warnings.push("Reynders-aftrek beperkt tot de positieve meerwaarde van deze verkoop.");
    }
    const missed = sum(sale.lines.map(l => l.missed_historic_eur));
    if (missed.gt(ZERO))
      sale.warnings.push(`Mogelijk voordeel: de historische aankoopprijs ligt hoger dan de waarde op 31/12/2025, maar de aankoop is niet als bewijsbaar aangeduid. ` +
        `Met bewijs zou de meerwaarde ${missed.toFixed(2)} EUR lager zijn: vink 'Ik kan deze aankoopprijs bewijzen' aan bij de aankoop als je een bewijsstuk hebt.`);
    if (sale.lines.some(l => l.basis_used === "HISTORISCH"))
      sale.warnings.push("Historische aankoopprijs gebruikt: zelf inroepen in de aangifte en bewijsstukken bewaren.");
    sale.result_eur = sum(sale.lines.map(l => l.result_eur)).sub(sale.reynders_deduction_eur);
    return sale;
  }

  // ------------------------------------------------------------ hoofdfunctie
  /** transactions: array (plain objects), refValues: {asset: "80.00"}, withheld: {"owner|year": "360"} */
  function calculate(transactions, refValues, cfg, withheld = {}, throughYear = null) {
    cfg = cfg || defaultConfig();
    const txs = transactions.map((t, i) => ({ ...tx(t), _i: i }))
      .sort((a, b) => a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a._i - b._i);
    const pools = new Map(), sales = [], dividends = new Map(), events = [];
    const pool = k => { if (!pools.has(k)) pools.set(k, []); return pools.get(k); };
    let nextId = 1;

    for (const t of txs) {
      if (!TxType.includes(t.type)) throw new Error(`Onbekend transactietype: ${t.type}`);
      const p = pool(poolKey(t, cfg.fifoScope));
      if (ACQ.has(t.type)) {
        if (!t.quantity.gt(ZERO)) throw new Error(`Aantal moet positief zijn: ${t.source}`);
        const lot = { lotId: nextId++, owner: t.owner, broker: t.broker, asset: t.asset, acquired: t.trade_date,
                      quantity: t.quantity, origQuantity: t.quantity,
                      unitCost: t.cost_known ? toEur(t, t.price) : ZERO,
                      historicProven: t.historic_proven, costKnown: t.cost_known, unitRef: null, source: t.source };
        // fotowaarde pas vereist als dit lot ná 2025 verkocht wordt
        if (isPre(lot) && refValues[t.asset] != null && refValues[t.asset] !== "") lot.unitRef = D(refValues[t.asset]);
        p.push(lot);
      } else if (t.type === "SPLIT") {
        const r = t.split_ratio;
        if (!r || !r.gt(ZERO)) throw new Error(`Split zonder geldige ratio: ${t.source}`);
        for (const lot of p) {
          lot.quantity = lot.quantity.mul(r); lot.origQuantity = lot.origQuantity.mul(r);
          lot.unitCost = lot.unitCost.div(r); if (lot.unitRef) lot.unitRef = lot.unitRef.div(r);
        }
      } else if (t.type === "SELL") {
        if (t.trade_date < START) {
          consume(p, t.quantity);
        } else sales.push(processSale(t, p, cfg));
      } else if (t.type === "DELISTING") {
        processDelisting(t, p, cfg, sales, events);
      } else if (t.type === "DIVIDEND") {
        const k = `${t.owner}|${t.trade_date.slice(0, 4)}`;
        dividends.set(k, (dividends.get(k) || ZERO).add(toEur(t, t.amount)));
      }
    }
    const years = summarize(sales, dividends, cfg, withheld, throughYear);
    const warnings = sales.flatMap(s => s.warnings.map(w => `${s.trade_date} ${s.asset}: ${w}`))
      .concat(events.filter(e => e.kind !== "UITKOOP").map(e => `${e.trade_date} ${e.asset}: ${e.note}`));
    return { sales, years, warnings, events,
             disclaimer: "Deze berekening is een hulpmiddel en geen fiscaal advies. Controleer altijd met de officiële bronnen (FOD Financiën) of een adviseur." };
  }

  const DELIST_NOTES = {
    NOTERING: "Schrapping van de notering is geen overdracht en dus geen belastbaar moment. " +
      "De positie blijft open met dezelfde aanschaffingswaarde; registreer een latere verkoop of uitkoop apart.",
    UITKOOP: "Uitkoop/bod bij delisting: behandeld als overdracht ten bezwarende titel (verkoop).",
    WAARDELOOS: "Waardeloos geworden zonder overdracht: de belasting viseert overdrachten ten bezwarende titel, " +
      "dus de tool boekt geen minderwaarde. Een overdracht voor een symbolische prijs (bv. aan je broker) kan wel " +
      "een minderwaarde opleveren: registreer die dan als verkoop. Wettelijk niet uitgeklaard; vraag advies.",
  };

  function consume(pool, qty) {
    for (const lot of pool) { if (!qty.gt(ZERO)) break; const u = Dec.min(qty, lot.quantity); lot.quantity = lot.quantity.sub(u); qty = qty.sub(u); }
  }

  function processDelisting(t, pool, cfg, sales, events) {
    const mode = t.delist_mode || "NOTERING";
    if (!DelistModes.includes(mode)) throw new Error(`Onbekende soort delisting: ${mode} (${t.source})`);
    const held = sum(pool.map(l => l.quantity));
    let note = DELIST_NOTES[mode];
    if (mode === "UITKOOP") {
      const qty = t.quantity.gt(ZERO) ? t.quantity : held;
      if (!qty.gt(ZERO)) note = "Uitkoop geregistreerd, maar er zijn geen stuks in bezit: geen verkoop berekend.";
      else if (t.trade_date < START) consume(pool, qty);
      else {
        const sale = processSale({ ...t, type: "SELL", quantity: qty }, pool, cfg);
        sale.kind = "UITKOOP";
        sale.warnings.unshift(note);
        sales.push(sale);
      }
    } else if (!held.gt(ZERO)) note = `Geen stuks in bezit op het moment van de delisting. ${note}`;
    events.push({ trade_date: t.trade_date, owner: t.owner, broker: t.broker, asset: t.asset, kind: mode,
                  quantity_held: held, note, source: t.source });
  }

  function summarize(sales, dividends, cfg, withheld, throughYear) {
    const wk = Object.keys(withheld).map(k => { const i = k.lastIndexOf("|"); return [k.slice(0, i), Number(k.slice(i + 1))]; });
    const dk = [...dividends.keys()].map(k => { const i = k.lastIndexOf("|"); return [k.slice(0, i), Number(k.slice(i + 1))]; });
    const owners = [...new Set([...sales.map(s => s.owner), ...wk.map(x => x[0]), ...dk.map(x => x[0])])].sort();
    if (!owners.length) return [];
    const first = 2026;
    let last = Math.max(first, ...sales.map(s => Number(s.trade_date.slice(0, 4))), ...wk.map(x => x[1]));
    if (throughYear) last = Math.max(last, throughYear);

    const out = [];
    for (const owner of owners) {
      let carries = new Map();
      for (let year = first; year <= last; year++) {
        const yc = yearCfg(cfg, year);
        const own = sales.filter(s => s.owner === owner && Number(s.trade_date.slice(0, 4)) === year);
        const y = { owner, year, sale_count: own.length, gains_eur: ZERO, losses_eur: ZERO, carry_used_eur: ZERO };
        for (const s of own) { if (s.result_eur.gte(ZERO)) y.gains_eur = y.gains_eur.add(s.result_eur); else y.losses_eur = y.losses_eur.add(s.result_eur); }
        const total = y.gains_eur.add(y.losses_eur);
        y.net_eur = Dec.max(total, ZERO);
        y.lost_losses_eur = Dec.min(total, ZERO);

        carries = new Map([...carries].filter(([cy]) => year - cy <= yc.carryValidityYears));
        y.exemption_available_eur = yc.baseExemption.add(sum([...carries.values()]));
        let remaining = y.net_eur;
        for (const cy of [...carries.keys()].sort((a, b) => a - b)) {
          const use = Dec.min(remaining, carries.get(cy));
          carries.set(cy, carries.get(cy).sub(use));
          y.carry_used_eur = y.carry_used_eur.add(use);
          remaining = remaining.sub(use);
        }
        carries = new Map([...carries].filter(([, a]) => a.gt(ZERO)));
        y.base_used_eur = Dec.min(remaining, yc.baseExemption);
        remaining = remaining.sub(y.base_used_eur);
        y.carry_generated_eur = yc.carrySlice.sub(Dec.min(yc.carrySlice, y.base_used_eur));
        if (y.carry_generated_eur.gt(ZERO)) carries.set(year, y.carry_generated_eur);
        y.carry_detail = Object.fromEntries(carries);
        y.taxable_eur = remaining;
        y.tax_eur = money(remaining.mul(yc.rate));
        y.withheld_eur = money(D(withheld[`${owner}|${year}`] ?? 0));
        y.refund_eur = y.withheld_eur.sub(y.tax_eur);
        y.dividends_eur = money(dividends.get(`${owner}|${year}`) || ZERO);
        out.push(y);
      }
    }
    return out;
  }

  /** Posities per eigenaar/actief na alle transacties t.e.m. `date` (FIFO-verbruik zoals in calculate). */
  function holdingsAt(transactions, date, cfg) {
    cfg = cfg || defaultConfig();
    const txs = transactions.map((t, i) => ({ ...tx(t), _i: i })).filter(t => t.trade_date <= date)
      .sort((a, b) => a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a._i - b._i);
    const pools = new Map();
    for (const t of txs) {
      const k = poolKey(t, cfg.fifoScope);
      if (!pools.has(k)) pools.set(k, { owner: t.owner, asset: t.asset, lots: [] });
      const p = pools.get(k).lots;
      if (ACQ.has(t.type)) p.push({ quantity: t.quantity });
      else if (t.type === "SPLIT" && t.split_ratio && t.split_ratio.gt(ZERO)) p.forEach(l => { l.quantity = l.quantity.mul(t.split_ratio); });
      else if (t.type === "SELL" || (t.type === "DELISTING" && t.delist_mode === "UITKOOP")) {
        let q = t.quantity.gt(ZERO) ? t.quantity : sum(p.map(l => l.quantity));
        for (const l of p) { if (!q.gt(ZERO)) break; const u = Dec.min(q, l.quantity); l.quantity = l.quantity.sub(u); q = q.sub(u); }
      }
    }
    const out = new Map();
    for (const { owner, asset, lots } of pools.values()) {
      const q = sum(lots.map(l => l.quantity)), k = `${owner}\u0000${asset}`;
      out.set(k, { owner, asset, quantity: (out.get(k)?.quantity || ZERO).add(q) });
    }
    return [...out.values()].filter(h => h.quantity.gt(ZERO));
  }

  /** Waarde 31/12/2025 per stuk in EUR uit de slotkoers in vreemde munt en de wisselkoers van
   *  31/12/2025 (ECB-notatie: 1 EUR = fxPerEur eenheden munt); afgerond op 10 decimalen. */
  function refValueFromCurrency(price, fxPerEur) {
    const p = D(price), fx = D(fxPerEur);
    if (!fx.gt(ZERO)) throw new Error("Wisselkoers op 31/12/2025 moet groter dan 0 zijn.");
    if (p.lt(ZERO)) throw new Error("Slotkoers op 31/12/2025 mag niet negatief zijn.");
    return p.div(fx).round(10);
  }

  /** Idem, met de wisselkoers in de andere richting: 1 eenheid munt = eurPerUnit EUR; afgerond op 10 decimalen. */
  function refValueFromEurRate(price, eurPerUnit) {
    const p = D(price), r = D(eurPerUnit);
    if (!r.gt(ZERO)) throw new Error("Wisselkoers op 31/12/2025 moet groter dan 0 zijn.");
    if (p.lt(ZERO)) throw new Error("Slotkoers op 31/12/2025 mag niet negatief zijn.");
    return p.mul(r).round(10);
  }

  function compareMethods(transactions, refValues, cfg, withheld, throughYear) {
    const res = {};
    for (const m of ["FIFO", "GEMIDDELD"]) res[m] = calculate(transactions, refValues, { ...cfg, historicMethod: m }, withheld, throughYear);
    return res;
  }

  const api = { Dec, D, ZERO, ONE, money, TxType, DelistModes, ACQ, defaultConfig, calculate, compareMethods, holdingsAt, refValueFromCurrency, refValueFromEurRate };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MWB = api;
})(typeof window !== "undefined" ? window : globalThis);
