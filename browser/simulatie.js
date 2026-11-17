/* Simulatie: wat is de impact van een (nog niet uitgevoerde) transactie, bv. een verkoop, op de meerwaardebelasting?
 * Rekent de bestaande transacties twee keer door met de rekenkern (MWB.calculate): zonder en met de fictieve
 * transactie(s), en vergelijkt het resultaat per eigenaar en inkomstenjaar. Er wordt niets opgeslagen.
 * De regels zelf zitten enkel in de rekenkern; deze module voegt geen rekenregels toe. Geen fiscaal advies. */
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const M = node ? require("./engine.js") : root.MWB;
  const { ZERO, Dec } = M;

  const SOURCE = "simulatie";
  const NEUTRAL = "\u0000simulatie-neutraal";
  const isSim = s => String(s.source || "").startsWith(SOURCE);
  const FIELDS = ["net_eur", "exemption_available_eur", "taxable_eur", "tax_eur", "carry_generated_eur", "refund_eur"];

  /** Nog vrij te besteden vrijstelling in een jaar: hoeveel netto meerwaarde er nog belastingvrij bij kan. */
  const room = y => y ? Dec.max(ZERO, y.exemption_available_eur.sub(y.net_eur)) : null;

  function emptyYear(owner, year) {
    const y = { owner, year, sale_count: 0 };
    for (const f of FIELDS) y[f] = ZERO;
    return y;
  }

  /**
   * transactions/refValues/cfg/withheld: zoals voor MWB.calculate. extra: fictieve transacties (plain objects).
   * Geeft { before, after, sales (de fictieve verkopen met hun loten), years (per eigenaar/jaar: voor, na, verschil),
   *         tax_delta_eur (totaal over alle jaren), warnings (nieuwe waarschuwingen door de simulatie) }.
   */
  function simulate(transactions, refValues, cfg, withheld, extra) {
    if (!extra || !extra.length) throw new Error("Geen transactie om te simuleren.");
    const sim = extra.map((t, i) => ({ ...t, source: `${SOURCE} ${i + 1}` }));
    // Neutrale verkoop (resultaat 0, eigen actief) per betrokken eigenaar, in beide berekeningen: zo levert de
    // rekenkern ook een jaaroverzicht (vrijstelling, overdracht) voor wie zonder de simulatie geen verkopen heeft.
    const neutral = [...new Set(sim.map(t => t.owner || "default"))].flatMap(owner => [
      { type: "BUY", trade_date: "2026-01-01", asset: NEUTRAL, quantity: "1", price: "0", owner, source: NEUTRAL },
      { type: "SELL", trade_date: "2026-01-01", asset: NEUTRAL, quantity: "1", price: "0", owner, source: NEUTRAL }]);
    const after = M.calculate(transactions.concat(neutral, sim), refValues, cfg, withheld);
    const lastYear = Math.max(2026, ...after.years.map(y => y.year));
    const before = M.calculate(transactions.concat(neutral), refValues, cfg, withheld, lastYear);

    const years = after.years.map(a => {
      const b = before.years.find(x => x.owner === a.owner && x.year === a.year) || emptyYear(a.owner, a.year);
      const delta = Object.fromEntries(FIELDS.map(f => [f, a[f].sub(b[f])]));
      return { owner: a.owner, year: a.year, before: b, after: a, delta, sale_count: a.sale_count - b.sale_count,
               room_before_eur: room(b), room_after_eur: room(a),
               changed: FIELDS.some(f => !delta[f].isZero()) };
    });
    const known = new Set(before.warnings);
    return {
      before, after, years,
      sales: after.sales.filter(isSim),
      tax_delta_eur: years.reduce((s, y) => s.add(y.delta.tax_eur), ZERO),
      warnings: after.warnings.filter(w => !known.has(w)),
    };
  }

  /** Stuks in bezit voor eigenaar/actief (en broker, als FIFO per broker loopt) op een datum. */
  function heldAt(transactions, date, cfg, owner, asset, broker) {
    const scoped = cfg.fifoScope === "BROKER" && broker != null ? transactions.filter(t => (t.broker || "") === broker) : transactions;
    const h = M.holdingsAt(scoped, date, cfg).find(x => x.owner === owner && x.asset === asset);
    return h ? h.quantity : ZERO;
  }

  const api = { simulate, heldAt, room, SOURCE };
  if (node) module.exports = api; else root.SIM = api;
})(typeof window !== "undefined" ? window : globalThis);
