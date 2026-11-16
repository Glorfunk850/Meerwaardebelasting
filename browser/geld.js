/* Geldbewegingen: regels uit een broker-export die geen effect hebben op de meerwaardebelasting
 * (stortingen, opnames, kapitaalverminderingen, teruggeboekte dividenden, ...), enkel ter info bewaard.
 * Ze worden apart van de transacties opgeslagen (state.cash) en gaan nooit naar de rekenkern.
 *
 * Een geldbeweging: { kind, date, amount (tekst, met teken, in `currency`; of null), currency, asset_name, description,
 *   status: "info" (nieuwe informatie) | "verwerkt" (zit al op een andere manier in de tool), remark, warn (remark is een aandachtspunt), owner, broker,
 *   import_id, import_source } */
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const M = node ? require("./engine.js") : root.MWB;
  const { D, ZERO } = M;

  // soort -> [label in de lijst, groep in het importvenster]
  const KINDS = {
    STORTING: ["Storting", "Stortingen"],
    OPNAME: ["Opname", "Opnames"],
    MWB: ["Ingehouden MWB", "Ingehouden meerwaardebelasting"],
    BOD: ["Cash overnamebod", "Cash bij overnamebiedingen"],
    FRACTIE: ["Cash fractie", "Cash bij splitsingen (fracties)"],
    KAPVERM: ["Kapitaalvermindering", "Kapitaalverminderingen"],
    DIV_TERUG: ["Dividend teruggeboekt", "Teruggeboekte dividenden"],
    DUBBEL: ["Dubbele regel", "Dubbele regels bij corporate actions"],
    CA: ["Corporate action", "Andere corporate actions"],
    WISSEL: ["Wisseltransactie", "Wisseltransacties"],
    TERUGSTORTING: ["Terugstorting kosten", "Terugstortingen (kosten)"],
    TAKSRECUP: ["Taksrecuperatie", "Recuperatie buitenlandse taks"],
    KOSTEN: ["Kosten", "Kosten corporate actions"],
    STORNO: ["Geannuleerd", "Geannuleerde boekingen (storno)"],
    ANDERE: ["Andere", "Andere regels"],
  };
  const label = kind => (KINDS[kind] || KINDS.ANDERE)[0];
  const group = kind => (KINDS[kind] || KINDS.ANDERE)[1];

  /** Maakt stabiele import-id's: dezelfde inhoud krijgt een volgnummer. */
  function idMaker(prefix) {
    const seen = new Map();
    return (...parts) => {
      const base = parts.map(p => String(p ?? "")).join("|");
      const k = (seen.get(base) || 0) + 1; seen.set(base, k);
      return `${prefix}${base}|${k}`;
    };
  }

  /** Geldbewegingen uit `incoming` die nog niet in `existing` zitten (zelfde import-id). */
  function fresh(existing, incoming) {
    const have = new Set((existing || []).map(c => c.import_id).filter(Boolean));
    return (incoming || []).filter(c => !c.import_id || !have.has(c.import_id));
  }

  /** Telling per groep voor het importvenster: [{ group, kind, status, remark, count }], in volgorde van KINDS. */
  function groups(cash) {
    const map = new Map();
    for (const c of cash) {
      const key = `${c.kind}|${c.status}`;
      const g = map.get(key) || { group: group(c.kind), kind: c.kind, status: c.status, remarks: new Set(), count: 0 };
      g.count++; if (c.status === "verwerkt" && c.remark) g.remarks.add(c.remark);
      map.set(key, g);
    }
    const order = Object.keys(KINDS);
    return [...map.values()].map(g => ({ ...g, remark: [...g.remarks].join("; ") }))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  }

  const toEur = t => {
    const amt = D(t.amount || 0);
    if (!t.currency || t.currency === "EUR") return amt;
    if (t.eur_per_ccy != null && t.eur_per_ccy !== "") return amt.mul(t.eur_per_ccy);
    return amt.div(t.fx_per_eur || 1);
  };

  /**
   * Geldoverzicht per jaar (bedragen in EUR, Dec). Enkel geldbewegingen in EUR tellen mee; andere munten worden geteld in `foreign`.
   * Dividend = netto dividenden (transacties) + teruggeboekte dividenden (geldbewegingen).
   * Ingehouden = door de broker ingehouden meerwaardebelasting (zoals bij Instellingen).
   */
  function summary(cash, transactions, withheld, { owner = "", year = "" } = {}) {
    const keep = (o, y) => (!owner || o === owner) && (!year || String(y) === String(year));
    const years = new Map(), foreign = { count: 0 };
    const row = y => {
      if (!years.has(y)) years.set(y, { year: y, deposits: ZERO, withdrawals: ZERO, dividends: ZERO, capital_reductions: ZERO, withheld: ZERO });
      return years.get(y);
    };
    for (const c of cash || []) {
      const y = c.date.slice(0, 4);
      if (!keep(c.owner, y) || c.amount == null || c.amount === "") continue;
      if (c.currency && c.currency !== "EUR") { if (["STORTING", "OPNAME", "KAPVERM", "DIV_TERUG"].includes(c.kind)) foreign.count++; continue; }
      const amt = D(c.amount);
      if (c.kind === "STORTING") row(y).deposits = row(y).deposits.add(amt);
      else if (c.kind === "OPNAME") row(y).withdrawals = row(y).withdrawals.add(amt);
      else if (c.kind === "KAPVERM") row(y).capital_reductions = row(y).capital_reductions.add(amt);
      else if (c.kind === "DIV_TERUG") row(y).dividends = row(y).dividends.add(amt);
    }
    // enkel jaren met geldbewegingen; dividenden en inhoudingen vullen die aan
    const cashYears = new Set(years.keys());
    for (const t of transactions || []) {
      const y = t.trade_date.slice(0, 4);
      if (t.type !== "DIVIDEND" || !keep(t.owner, y) || !cashYears.has(y)) continue;
      row(y).dividends = row(y).dividends.add(toEur(t));
    }
    for (const w of withheld || []) {
      const y = String(w.year);
      if (!keep(w.owner, y) || !cashYears.has(y)) continue;
      row(y).withheld = row(y).withheld.sub(D(w.amount || 0));
    }
    const rows = [...years.values()].sort((a, b) => a.year.localeCompare(b.year))
      .map(r => ({ ...r, net: r.deposits.add(r.withdrawals) }));
    const total = rows.reduce((t, r) => {
      for (const k of ["deposits", "withdrawals", "net", "dividends", "capital_reductions", "withheld"]) t[k] = t[k].add(r[k]);
      return t;
    }, { year: "Totaal", deposits: ZERO, withdrawals: ZERO, net: ZERO, dividends: ZERO, capital_reductions: ZERO, withheld: ZERO });
    return { rows, total, foreign: foreign.count };
  }

  const api = { KINDS, label, group, idMaker, fresh, groups, summary };
  if (node) module.exports = api; else root.GELD = api;
})(typeof window !== "undefined" ? window : globalThis);
