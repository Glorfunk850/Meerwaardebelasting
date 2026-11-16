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
