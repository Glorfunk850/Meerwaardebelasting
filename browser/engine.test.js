// Zelfde rekenvoorbeelden als tests/test_engine.py.  node --test engine.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./engine.js");
const { D, calculate, compareMethods, defaultConfig } = M;

const eq = (a, b) => assert.equal(D(a).toFixed(2), D(b).toFixed(2));
function cfgYears(...ys) {
  const c = defaultConfig();
  for (const y of ys) c.years[y] = { ...c.years[2026], source: "test" };
  return c;
}
const buy = (d, a, q, p, kw = {}) => ({ trade_date: d, type: "BUY", asset: a, quantity: String(q), price: String(p), ...kw });
const sell = (d, a, q, p, kw = {}) => ({ trade_date: d, type: "SELL", asset: a, quantity: String(q), price: String(p), ...kw });
const year = (rep, y, owner = "default") => rep.years.find(x => x.year === y && x.owner === owner);

// ---------------------------------------------------------------- Decimal
test("decimal basics", () => {
  assert.equal(D("0.1").add("0.2").toString(), "0.3");
  assert.equal(D("1000").div("1.2").toFixed(2), "833.33");
  assert.equal(D("2.345").round(2).toString(), "2.35");
  assert.equal(D("-2.345").round(2).toString(), "-2.35");   // half-up = weg van nul (Python ROUND_HALF_UP)
  assert.equal(D("7,50").toFixed(2), "7.50");
  assert.throws(() => D("abc"));
  assert.throws(() => D("."));
});

// ---------------------------------------------------------------- voorbeeld
const example = () => [
  buy("2024-05-01", "X", 100, 50, { historic_proven: true }),
  buy("2025-05-01", "X", 50, 120, { historic_proven: true }),
  buy("2026-03-01", "X", 50, 90),
  sell("2026-09-01", "X", 120, 110),
  buy("2026-02-01", "Y", 200, 30),
  sell("2026-11-01", "Y", 200, 25),
];

test("example fifo", () => {
  const rep = calculate(example(), { X: "80" }, null, { "default|2026": "360" });
  const x = rep.sales.find(s => s.asset === "X");
  assert.deepEqual(x.lines.map(l => [l.basis_used, l.result_eur.toFixed(2)]), [["REF_31_12_2025", "3000.00"], ["HISTORISCH", "0.00"]]);
  eq(rep.sales.find(s => s.asset === "Y").result_eur, "-1000");
  const y = year(rep, 2026);
  eq(y.gains_eur, 3000); eq(y.losses_eur, -1000); eq(y.net_eur, 2000); eq(y.base_used_eur, 2000);
  eq(y.taxable_eur, 0); eq(y.tax_eur, 0); eq(y.carry_generated_eur, 0); eq(y.refund_eur, 360);
});

test("example average method", () => {
  const rep = calculate(example(), { X: "80" }, { ...defaultConfig(), historicMethod: "GEMIDDELD" });
  const x = rep.sales.find(s => s.asset === "X");
  assert.deepEqual(x.lines.map(l => l.basis_used), ["REF_31_12_2025", "REF_31_12_2025"]);
  eq(x.result_eur, 3600); eq(year(rep, 2026).net_eur, 2600);
});

test("compare methods", () => {
  const r = compareMethods(example(), { X: "80" }, defaultConfig());
  eq(year(r.FIFO, 2026).net_eur, 2000); eq(year(r.GEMIDDELD, 2026).net_eur, 2600);
});

// ---------------------------------------------------------------- verlies
test("net loss floored, not carried", () => {
  const txs = [buy("2026-01-05", "A", 10, 100), sell("2026-06-01", "A", 10, 80), buy("2026-01-05", "B", 10, 100), sell("2026-07-01", "B", 10, 105)];
  const rep = calculate(txs, {}, cfgYears(2027), {}, 2027);
  eq(year(rep, 2026).net_eur, 0); eq(year(rep, 2026).lost_losses_eur, -150); eq(year(rep, 2027).net_eur, 0);
});

test("loss vs ref value", () => {
  const rep = calculate([buy("2022-01-01", "Z", 1, 150, { historic_proven: true }), sell("2027-03-01", "Z", 1, 80)], { Z: "100" }, cfgYears(2027));
  eq(rep.sales[0].result_eur, -20); assert.equal(rep.sales[0].lines[0].basis_used, "REF_31_12_2025");
});

// ---------------------------------------------------------------- stap-up
test("historic until 2030", () => {
  const rep = calculate([buy("2023-01-01", "S", 1, 150, { historic_proven: true }), sell("2026-06-01", "S", 1, 125)], { S: "120" });
  eq(rep.sales[0].result_eur, 0); assert.equal(rep.sales[0].lines[0].basis_used, "HISTORISCH");
});
test("historic not after 2030", () => {
  const rep = calculate([buy("2023-01-01", "S", 1, 150, { historic_proven: true }), sell("2031-01-02", "S", 1, 125)], { S: "120" },
    cfgYears(2027, 2028, 2029, 2030, 2031));
  eq(rep.sales[0].result_eur, 5); assert.equal(rep.sales[0].lines[0].basis_used, "REF_31_12_2025");
});
test("historic requires proof", () => {
  eq(calculate([buy("2023-01-01", "S", 1, 150), sell("2026-06-01", "S", 1, 125)], { S: "120" }).sales[0].result_eur, 5);
});
test("missed historic reported without proof", () => {
  const b = buy("2023-01-01", "S", 1, 150);
  let s = calculate([b, sell("2026-06-01", "S", 1, 125)], { S: "120" }).sales[0];
  eq(s.lines[0].missed_historic_eur, 5);
  assert.ok(s.warnings.some(w => w.includes("Mogelijk voordeel") && w.includes("5.00 EUR")));
  s = calculate([b, sell("2026-06-01", "S", 1, 200)], { S: "120" }).sales[0];
  eq(s.lines[0].missed_historic_eur, 30);
});
test("no missed historic when not applicable", () => {
  const cases = [
    [buy("2023-01-01", "S", 1, 150, { historic_proven: true }), sell("2026-06-01", "S", 1, 125)],
    [buy("2023-01-01", "S", 1, 100), sell("2026-06-01", "S", 1, 125)],
    [buy("2023-01-01", "S", 1, 150), sell("2026-06-01", "S", 1, 110)],
    [buy("2023-01-01", "S", 1, 150), sell("2031-01-02", "S", 1, 125)],
  ];
  for (const txs of cases) {
    const s = calculate(txs, { S: "120" }, cfgYears(2027, 2028, 2029, 2030, 2031)).sales[0];
    eq(s.lines[0].missed_historic_eur, 0);
    assert.ok(!s.warnings.some(w => w.includes("Mogelijk voordeel")));
  }
});
test("missed historic average method", () => {
  const txs = [buy("2023-01-01", "S", 100, 150, { historic_proven: true }), buy("2024-01-01", "S", 100, 130), sell("2026-06-01", "S", 100, 160)];
  const s = calculate(txs, { S: "120" }, { ...defaultConfig(), historicMethod: "GEMIDDELD" }).sales[0];
  eq(s.result_eur, 4000); eq(s.lines[0].missed_historic_eur, 2000);
});
test("historic lower uses ref", () => {
  eq(calculate([buy("2020-01-01", "S", 10, 10, { historic_proven: true }), sell("2026-06-01", "S", 10, 30)], { S: "25" }).sales[0].result_eur, 50);
});
test("missing ref throws", () => {
  assert.throws(() => calculate([buy("2025-01-01", "Q", 1, 1), sell("2026-02-01", "Q", 1, 2)], {}), /31\/12\/2025/);
});
test("pre-2026 sale consumes lots", () => {
  const rep = calculate([buy("2024-01-01", "P", 10, 10), buy("2025-01-01", "P", 10, 20), sell("2025-06-01", "P", 10, 30), sell("2026-06-01", "P", 10, 30)], { P: "25" });
  assert.equal(rep.sales.length, 1); assert.equal(rep.sales[0].lines[0].acquired, "2025-01-01"); eq(rep.sales[0].result_eur, 50);
});

// ---------------------------------------------------------------- vrijstelling
test("exemption basic", () => {
  const y = year(calculate([buy("2026-01-02", "A", 1, 0), sell("2026-05-01", "A", 1, 11000)], {}), 2026);
  eq(y.taxable_eur, 1000); eq(y.tax_eur, 100);
});
test("carry forward belfius", () => {
  const rep = calculate([buy("2026-01-02", "A", 2, 0), sell("2027-05-01", "A", 1, 1500), sell("2028-05-01", "A", 1, 12000)], {}, cfgYears(2027, 2028));
  eq(year(rep, 2026).carry_generated_eur, 1000);
  const y27 = year(rep, 2027); eq(y27.carry_used_eur, 1000); eq(y27.base_used_eur, 500); eq(y27.carry_generated_eur, 500);
  const y28 = year(rep, 2028); eq(y28.exemption_available_eur, 10500); eq(y28.taxable_eur, 1500); eq(y28.tax_eur, 150);
});
test("no carry when first slice used", () => {
  eq(year(calculate([buy("2026-01-02", "A", 1, 0), sell("2026-05-01", "A", 1, 1000)], {}), 2026).carry_generated_eur, 0);
});
test("carry capped at five years", () => {
  const y = year(calculate([buy("2026-01-02", "A", 1, 0), sell("2032-05-01", "A", 1, 20000)], {}, cfgYears(2027, 2028, 2029, 2030, 2031, 2032)), 2032);
  eq(y.exemption_available_eur, 15000); eq(y.taxable_eur, 5000);
});
test("missing year config throws", () => {
  assert.throws(() => calculate([buy("2026-01-02", "A", 1, 0), sell("2027-05-01", "A", 1, 10)], {}), /2027/);
});

// ---------------------------------------------------------------- bijzondere gevallen
test("fx gain taxable", () => {
  const s = calculate([buy("2026-01-05", "US", 10, 100, { currency: "USD", fx_per_eur: "1.20" }),
                       sell("2026-08-01", "US", 10, 100, { currency: "USD", fx_per_eur: "1.10" })], {}).sales[0];
  eq(s.proceeds_eur, "909.09"); eq(s.lines[0].basis_eur, "833.33"); eq(s.result_eur, "75.76");
});
test("split preserves cost", () => {
  eq(calculate([buy("2026-01-05", "S", 10, 100), { trade_date: "2026-03-01", type: "SPLIT", asset: "S", split_ratio: "4" },
                sell("2026-06-01", "S", 40, 30)], {}).sales[0].result_eur, 200);
});
test("split adjusts ref", () => {
  eq(calculate([buy("2025-01-05", "S", 10, 50), { trade_date: "2026-03-01", type: "SPLIT", asset: "S", split_ratio: "2" },
                sell("2026-06-01", "S", 20, 45)], { S: "80" }).sales[0].result_eur, 100);
});
test("fees not deductible", () => {
  const s = calculate([buy("2026-01-05", "F", 10, 100, { fees: "15" }), sell("2026-06-01", "F", 10, 110, { fees: "15", taxes: "3.85" })], {}).sales[0];
  eq(s.result_eur, 100); eq(s.fees_eur, "18.85");
});
test("fifo partial lots exact split", () => {
  const s = calculate([buy("2026-01-05", "F", 3, 10), buy("2026-02-05", "F", 3, 20), sell("2026-06-01", "F", 4, "33.33")], {}).sales[0];
  assert.deepEqual(s.lines.map(l => l.quantity.toString()), ["3", "1"]);
  eq(s.lines.reduce((a, l) => a.add(l.proceeds_eur), D(0)), "133.32"); eq(s.proceeds_eur, "133.32"); eq(s.result_eur, "83.32");
});
test("sale without purchase", () => {
  const s = calculate([sell("2026-06-01", "N", 5, 10)], {}).sales[0];
  eq(s.result_eur, 50); assert.equal(s.lines[0].basis_used, "ONBEKEND"); assert.ok(s.warnings.length);
});
test("gift donor value", () => {
  eq(calculate([{ trade_date: "2026-02-01", type: "GIFT_IN", asset: "G", quantity: "10", price: "40" }, sell("2026-09-01", "G", 10, 70)], {}).sales[0].result_eur, 300);
});
test("inherited pre-2026 gets ref", () => {
  eq(calculate([{ trade_date: "2015-01-01", type: "INHERIT_IN", asset: "H", quantity: "1", price: "10" }, sell("2026-09-01", "H", 1, 100)], { H: "90" }).sales[0].result_eur, 10);
});
test("unknown cost zero basis", () => {
  const s = calculate([{ trade_date: "2026-02-01", type: "GIFT_IN", asset: "G", quantity: "1", cost_known: false }, sell("2026-09-01", "G", 1, 70)], {}).sales[0];
  eq(s.result_eur, 70); assert.equal(s.lines[0].basis_used, "ONBEKEND");
});
test("reynders", () => {
  eq(calculate([buy("2026-01-05", "BF", 10, 100), sell("2026-09-01", "BF", 10, 110, { reynders_eur: "30" })], {}).sales[0].result_eur, 70);
});
test("dividends registered only", () => {
  const y = year(calculate([{ trade_date: "2026-04-01", type: "DIVIDEND", asset: "X", amount: "120", currency: "USD", fx_per_eur: "1.20" }], {}), 2026);
  eq(y.dividends_eur, 100); eq(y.net_eur, 0);
});
test("fifo scope", () => {
  const txs = [buy("2026-01-05", "B", 1, 10, { broker: "bolero" }), buy("2026-02-05", "B", 1, 50, { broker: "saxo" }), sell("2026-06-01", "B", 1, 60, { broker: "saxo" })];
  eq(calculate(txs, {}).sales[0].result_eur, 50);
  eq(calculate(txs, {}, { ...defaultConfig(), fifoScope: "BROKER" }).sales[0].result_eur, 10);
});
test("multiple owners", () => {
  const rep = calculate([buy("2026-01-05", "A", 2, 0, { owner: "an" }), sell("2026-06-01", "A", 2, 6000, { owner: "an" }),
                         buy("2026-01-05", "A", 1, 0, { owner: "bert" }), sell("2026-06-01", "A", 1, 4000, { owner: "bert" })], {});
  eq(year(rep, 2026, "an").taxable_eur, 2000); eq(year(rep, 2026, "bert").taxable_eur, 0);
});

// ---------------------------------------------------------------- delisting
const delist = (d, a, mode, q = "0", p = "0", kw = {}) => ({ trade_date: d, type: "DELISTING", asset: a, delist_mode: mode, quantity: q, price: p, ...kw });
test("delisting notering", () => {
  const rep = calculate([buy("2026-01-05", "DL", 10, 100), delist("2026-04-01", "DL", "NOTERING"), sell("2026-09-01", "DL", 10, 120)], {});
  assert.equal(rep.sales.length, 1); assert.equal(rep.sales[0].kind, "VERKOOP"); eq(rep.sales[0].result_eur, 200);
  assert.equal(rep.events[0].kind, "NOTERING"); assert.equal(rep.events[0].quantity_held.toString(), "10");
  assert.ok(rep.warnings.some(w => w.includes("geen overdracht")));
});
test("delisting buyout full", () => {
  const rep = calculate([buy("2025-03-01", "UK", 10, 40), buy("2026-02-01", "UK", 5, 60), delist("2026-06-01", "UK", "UITKOOP", "0", "70")], { UK: "50" });
  const s = rep.sales[0];
  assert.equal(s.kind, "UITKOOP"); assert.equal(s.quantity.toString(), "15"); eq(s.result_eur, 250); assert.ok(s.warnings[0].includes("Uitkoop"));
});
test("delisting buyout partial fx", () => {
  const s = calculate([buy("2026-01-05", "US", 10, 100, { currency: "USD", fx_per_eur: "1.25" }),
                       delist("2026-06-01", "US", "UITKOOP", "4", "110", { currency: "USD", fx_per_eur: "1.10" })], {}).sales[0];
  assert.equal(s.quantity.toString(), "4"); eq(s.result_eur, 80);
});
test("delisting buyout without position", () => {
  const rep = calculate([delist("2026-06-01", "X", "UITKOOP", "0", "70")], {});
  assert.equal(rep.sales.length, 0); assert.ok(rep.events[0].note.includes("geen stuks"));
});
test("delisting worthless", () => {
  const base = [buy("2026-01-05", "W", 10, 100), delist("2026-06-01", "W", "WAARDELOOS")];
  const rep = calculate(base, {});
  assert.equal(rep.sales.length, 0); assert.equal(rep.events[0].kind, "WAARDELOOS"); assert.ok(rep.warnings.some(w => w.includes("niet uitgeklaard")));
  eq(calculate([...base, sell("2026-07-01", "W", 10, "0.01")], {}).sales[0].result_eur, "-999.90");
});
test("delisting unknown mode", () => {
  assert.throws(() => calculate([delist("2026-06-01", "X", "FOO")], {}), /delisting/);
});

// ---------------------------------------------------------------- fotowaarde enkel wanneer nodig + posities
test("ref only needed when used", () => {
  const txs = [buy("2019-01-01", "OLD", 10, 5), sell("2020-01-01", "OLD", 10, 8), buy("2026-01-05", "NEW", 1, 10), sell("2026-02-01", "NEW", 1, 12)];
  eq(calculate(txs, {}).sales[0].result_eur, 2);
  assert.equal(calculate([buy("2024-01-01", "HOLD", 1, 5)], {}).sales.length, 0);
});
test("holdingsAt", () => {
  const txs = [buy("2019-01-01", "A", 10, 5), sell("2020-01-01", "A", 4, 8), { trade_date: "2021-01-01", type: "SPLIT", asset: "A", split_ratio: "2" },
               buy("2024-01-01", "B", 3, 1), delist("2025-06-01", "B", "UITKOOP", "0", "2"), buy("2026-02-01", "C", 1, 1),
               sell("2018-01-01", "Z", 5, 1)];
  const h = M.holdingsAt(txs, "2025-12-31");
  assert.deepEqual(h.map(x => [x.asset, x.quantity.toString()]), [["A", "12"]]);
});

test("waarde 31/12/2025 uit slotkoers in vreemde munt", () => {
  const ref = M.refValueFromCurrency("150", "1.1745");
  assert.equal(ref.toString(), "127.7139208174");
  assert.equal(M.refValueFromCurrency("12.5", "1").toString(), "12.5");
  const txs = [buy("2020-01-01", "US", 10, 100, { currency: "USD", fx_per_eur: "1.10" }),
               sell("2026-03-01", "US", 10, 160, { currency: "USD", fx_per_eur: "1.15" })];
  const l = calculate(txs, { US: ref.toString() }).sales[0].lines[0];
  eq(l.basis_eur, "1277.14"); eq(l.result_eur, "114.16");
  assert.throws(() => M.refValueFromCurrency("150", "0"));
  assert.throws(() => M.refValueFromCurrency("-1", "1.2"));
});

test("waarde 31/12/2025 met wisselkoers munt -> EUR", () => {
  assert.equal(M.refValueFromEurRate("150", "0.8514").toString(), "127.71");
  assert.equal(M.refValueFromEurRate("33.333", "0.12345678901").toString(), "4.1151851481");
  assert.throws(() => M.refValueFromEurRate("150", "0"));
  assert.throws(() => M.refValueFromEurRate("-1", "0.85"));
});

test("wisselkoers in beide richtingen geeft hetzelfde resultaat", () => {
  const a = [buy("2026-01-05", "US", 10, 100, { currency: "USD", fx_per_eur: "1.25" }),
             sell("2026-06-01", "US", 10, 130, { currency: "USD", fx_per_eur: "1.25" })];
  const b = [buy("2026-01-05", "US", 10, 100, { currency: "USD", eur_per_ccy: "0.80" }),
             sell("2026-06-01", "US", 10, 130, { currency: "USD", eur_per_ccy: "0.80" })];
  eq(calculate(a, {}).sales[0].result_eur, "240"); eq(calculate(b, {}).sales[0].result_eur, "240");
  const c = [buy("2026-01-05", "US", 3, "33.33", { currency: "USD", eur_per_ccy: "0.8514" }),
             sell("2026-06-01", "US", 3, "41.17", { currency: "USD", eur_per_ccy: "0.8571" })];
  const s = calculate(c, {}).sales[0];
  eq(s.proceeds_eur, "105.86"); eq(s.result_eur, "20.73");
  assert.throws(() => calculate([buy("2026-01-05", "US", 1, 1, { currency: "USD", eur_per_ccy: "0" })], {}));
});

// ---------------------------------------------------------------- omruiling (fusie/overname)
const ruil = (d, a, comps, cash = 0, q = 0, kw = {}) => ({ trade_date: d, type: "RUIL", asset: a, quantity: String(q), price: String(cash),
  components: comps.map(([asset, ratio, value]) => ({ asset, ratio, value: value == null ? null : String(value) })), ...kw });
const lineSig = l => [l.acquired, l.basis_used, l.basis_eur.toFixed(2), l.result_eur.toFixed(2)];

test("exchange before 2026 splits historic cost by value", () => {
  const txs = [buy("2020-01-10", "OUD", 100, 50, { historic_proven: true }),
    ruil("2023-03-31", "OUD", [["NA", "0.5", 60], ["NB", "0.25", 40]], 10),
    sell("2026-06-01", "NA", 50, 70), sell("2026-06-01", "NB", 25, 35)];
  const rep = calculate(txs, { NA: "55", NB: "30" });
  const [na, nb] = rep.sales;
  assert.deepEqual(na.lines.map(lineSig), [["2020-01-10", "HISTORISCH", "3000.00", "500.00"]]);
  assert.deepEqual(nb.lines.map(lineSig), [["2020-01-10", "HISTORISCH", "1000.00", "0.00"]]);
  assert.deepEqual(rep.events.map(e => e.kind), ["RUIL"]); eq(rep.events[0].quantity, "100");
  assert.ok(rep.events[0].note.includes("vóór 2026"));
  assert.ok(!rep.warnings.some(w => w.includes("Omruiling")));
  assert.deepEqual(M.holdingsAt(txs, "2025-12-31").map(h => [h.asset, h.quantity.toString()]).sort(), [["NA", "50"], ["NB", "25"]]);
});

test("exchange before 2026 without values uses ref only", () => {
  const txs = [buy("2020-01-10", "OUD", 100, 50, { historic_proven: true }),
    ruil("2023-03-31", "OUD", [["NA", "0.5", null], ["NB", "0.25", null]], 10), sell("2026-06-01", "NA", 50, 70)];
  const rep = calculate(txs, { NA: "55" });
  const l = rep.sales[0].lines[0];
  assert.equal(l.basis_used, "REF_31_12_2025"); eq(l.result_eur, "750"); eq(l.missed_historic_eur, "0");
  assert.ok(rep.warnings.some(w => w.includes("niet verdeeld")));
});

test("exchange single component transfers cost", () => {
  const txs = [buy("2024-03-01", "OUD", 10, 100, { historic_proven: true }), ruil("2025-06-01", "OUD", [["NIEUW", "2", null]]),
    sell("2026-06-01", "NIEUW", 20, 60)];
  assert.deepEqual(calculate(txs, { NIEUW: "40" }).sales[0].lines.map(lineSig), [["2024-03-01", "HISTORISCH", "1000.00", "200.00"]]);
});

test("exchange from 2026: cash is sale, cost carries over", () => {
  const txs = [buy("2026-02-01", "OUD", 10, 100), ruil("2026-06-01", "OUD", [["NIEUW", "1", 90]], 30), sell("2026-09-01", "NIEUW", 10, 95)];
  const rep = calculate(txs, {});
  const [cash, s] = rep.sales;
  assert.equal(cash.kind, "RUIL"); eq(cash.proceeds_eur, "300"); eq(cash.lines[0].basis_eur, "250"); eq(cash.result_eur, "50");
  assert.deepEqual(s.lines.map(lineSig), [["2026-02-01", "AANKOOP", "750.00", "200.00"]]);
  eq(year(rep, 2026).net_eur, "250");
});

test("exchange from 2026 of pre-2026 lot splits ref value", () => {
  const txs = [buy("2025-01-05", "OUD", 10, 80), ruil("2026-06-01", "OUD", [["NIEUW", "2", 60]], 30, 0, { currency: "USD", fx_per_eur: "1" }),
    sell("2026-09-01", "NIEUW", 20, 45)];
  const [cash, s] = calculate(txs, { OUD: "100" }).sales;
  assert.deepEqual(cash.lines.map(lineSig), [["2025-01-05", "REF_31_12_2025", "200.00", "100.00"]]);
  assert.deepEqual(s.lines.map(lineSig), [["2025-01-05", "REF_31_12_2025", "800.00", "100.00"]]);
});

test("exchange partial quantity and no position", () => {
  const txs = [buy("2026-01-05", "OUD", 10, 100), buy("2026-01-06", "OUD", 10, 120), ruil("2026-03-01", "OUD", [["NIEUW", "1", null]], 0, 15),
    sell("2026-04-01", "OUD", 5, 130), sell("2026-04-01", "NIEUW", 15, 150)];
  const [oud, nieuw] = calculate(txs, {}).sales;
  eq(oud.result_eur, "50"); eq(nieuw.result_eur, "650");
  assert.deepEqual(nieuw.lines.map(l => l.acquired), ["2026-01-05", "2026-01-06"]);
  assert.deepEqual(M.holdingsAt(txs.slice(0, 3), "2026-03-01").map(h => [h.asset, h.quantity.toString()]), [["OUD", "5"], ["NIEUW", "15"]]);
  const rep = calculate([ruil("2026-03-01", "X", [["Y", "1", null]])], {});
  eq(rep.events[0].quantity, "0"); assert.ok(rep.warnings.some(w => w.includes("geen stuks in bezit")));
});

test("exchange errors", () => {
  assert.throws(() => calculate([buy("2026-01-05", "OUD", 1, 1), ruil("2026-03-01", "OUD", [["A", "1", null], ["B", "1", 5]])], {}), /waarde per stuk/);
  assert.throws(() => calculate([ruil("2023-03-01", "OUD", [["A", "0", null]])], {}), /ratio/);
  assert.throws(() => calculate([ruil("2023-03-01", "OUD", [])], {}), /zonder nieuwe effecten/);
  assert.throws(() => calculate([buy("2025-01-05", "OUD", 1, 1), ruil("2026-03-01", "OUD", [["A", "1", null]])], {}), /31\/12\/2025/);
});

test("exchange average method includes received lots", () => {
  const cfg = { ...defaultConfig(), historicMethod: "GEMIDDELD" };
  const txs = [buy("2021-01-05", "OUD", 10, 100, { historic_proven: true }), ruil("2022-01-05", "OUD", [["N", "1", null]]),
    buy("2024-01-05", "N", 10, 60, { historic_proven: true }), sell("2026-06-01", "N", 20, 90)];
  const s = calculate(txs, { N: "70" }, cfg).sales[0];
  assert.deepEqual(s.lines.map(l => l.basis_used), ["HISTORISCH", "HISTORISCH"]); eq(s.result_eur, "200");
});

test("exchange notes match python", () => {
  const rep = calculate([buy("2020-01-10", "OUD", 10, 5), ruil("2023-03-31", "OUD", [["NA", "0.1598", null], ["NB", "0.0376", null]], "1.0406", 0, { currency: "USD", fx_per_eur: "1.08" })], {});
  assert.equal(rep.events[0].note, "Omruiling vóór 2026 (0.1598 NA + 0.0376 NB + 1.0406 USD cash per stuk): geen belastbaar moment. " +
    "Voor de nieuwe effecten geldt hun waarde op 31/12/2025; de aankoopdatum en -prijs van OUD gaan over op de nieuwe effecten. " +
    "De aankoopprijs is niet verdeeld (waarde per nieuw stuk op de ruildatum niet ingevuld): geen hogere historische prijs mogelijk.");
});

const ruilQ = (d, a, comps, cash = 0, kw = {}) => ({ trade_date: d, type: "RUIL", asset: a, quantity: "0", price: String(cash),
  components: comps.map(([asset, quantity, value]) => ({ asset, quantity: String(quantity), value: value == null ? null : String(value) })), ...kw });

test("exchange total quantity splits cost by value", () => {
  const txs = [buy("2020-01-10", "OUD", 40, 10, { historic_proven: true }), buy("2021-01-10", "OUD", 60, 10, { historic_proven: true }),
    ruilQ("2023-03-31", "OUD", [["NA", 20, 25], ["NB", 30, 10]], 2), sell("2026-06-01", "NA", 20, 30)];
  const rep = calculate(txs, { NA: "22" });
  const s = rep.sales[0];
  assert.deepEqual(s.lines.map(l => [l.acquired, l.quantity.toString(), l.basis_used, l.basis_eur.toFixed(2)]),
    [["2020-01-10", "8", "HISTORISCH", "200.00"], ["2021-01-10", "12", "HISTORISCH", "300.00"]]);
  eq(s.result_eur, "100");
  assert.ok(rep.events[0].note.includes("NA (20 st. in totaal) + NB (30 st. in totaal) + 2 EUR cash"));
  assert.deepEqual(M.holdingsAt(txs.slice(0, 3), "2025-12-31").map(h => [h.asset, h.quantity.toString()]), [["NA", "20"], ["NB", "30"]]);
});

test("exchange total quantity is exact over lots", () => {
  const txs = [buy("2020-01-01", "OUD", 1, 3), buy("2020-02-01", "OUD", 1, 3), buy("2020-03-01", "OUD", 1, 3),
    ruilQ("2023-01-01", "OUD", [["N", 1, null]]), sell("2026-02-01", "N", 1, 12)];
  const s = calculate(txs, { N: "10" }).sales[0];
  assert.equal(s.lines.length, 3); assert.equal(s.lines.reduce((a, l) => a.add(l.quantity), D(0)).toString(), "1");
  assert.deepEqual(s.warnings, []); eq(s.result_eur, "2.01"); // 3 loten x (4,00 - 3,33): afronding per lot
});

test("lotsAt shows lots as the engine builds them", () => {
  const txs = [buy("2020-01-10", "OUD", 40, 10), buy("2021-01-10", "OUD", 60, 10), ruilQ("2023-03-31", "OUD", [["NA", 20, null]]), sell("2024-01-01", "NA", 5, 1)];
  assert.deepEqual(M.lotsAt(txs, {}, null, "2023-12-31").map(l => [l.asset, l.acquired, l.quantity.toString(), l.unit_cost_eur.toString()]),
    [["NA", "2020-01-10", "8", "50"], ["NA", "2021-01-10", "12", "50"]]);
  assert.deepEqual(M.lotsAt(txs, {}, null, "2024-12-31").map(l => l.quantity.toString()), ["3", "12"]);
});
