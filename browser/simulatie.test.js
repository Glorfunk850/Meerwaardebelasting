// node --test simulatie.test.js   (impact van een fictieve verkoop; verzonnen gegevens)
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./engine.js");
const S = require("./simulatie.js");

const cfg = () => M.defaultConfig();
const buy = (d, q, p, extra = {}) => ({ type: "BUY", trade_date: d, asset: "TEST NV", quantity: q, price: p, owner: "ik", ...extra });
const sell = (d, q, p, extra = {}) => ({ type: "SELL", trade_date: d, asset: "TEST NV", quantity: q, price: p, owner: "ik", ...extra });
const yr = (r, year) => r.years.find(y => y.year === year);

test("verkoop binnen de vrijstelling: geen extra belasting, minder vrije ruimte", () => {
  const r = S.simulate([buy("2026-02-01", "100", "50")], {}, cfg(), {}, [sell("2026-11-20", "100", "80")]);
  assert.equal(r.sales.length, 1);
  assert.equal(r.sales[0].result_eur.toFixed(2), "3000.00");
  const y = yr(r, 2026);
  assert.equal(y.delta.net_eur.toFixed(2), "3000.00");
  assert.equal(y.delta.tax_eur.toFixed(2), "0.00");
  assert.equal(y.room_before_eur.toFixed(2), "10000.00");
  assert.equal(y.room_after_eur.toFixed(2), "7000.00");
  // de overdraagbare schijf van 1.000 gaat verloren: de verkoop gebruikt de eerste 1.000 van de basisvrijstelling
  assert.equal(y.delta.carry_generated_eur.toFixed(2), "-1000.00");
  assert.equal(r.tax_delta_eur.toFixed(2), "0.00");
});

test("verkoop boven de vrijstelling: 10% op het deel erboven, bovenop bestaande verkopen", () => {
  const txs = [buy("2026-01-10", "200", "100"), sell("2026-03-01", "100", "180")]; // al 8.000 meerwaarde
  const r = S.simulate(txs, {}, cfg(), {}, [sell("2026-11-20", "100", "150")]); // + 5.000
  const y = yr(r, 2026);
  assert.equal(y.before.taxable_eur.toFixed(2), "0.00");
  assert.equal(y.after.taxable_eur.toFixed(2), "3000.00");
  assert.equal(y.delta.tax_eur.toFixed(2), "300.00");
  assert.equal(r.tax_delta_eur.toFixed(2), "300.00");
  assert.equal(y.room_after_eur.toFixed(2), "0.00");
});

test("verkoop met verlies verlaagt de belasting van hetzelfde jaar", () => {
  const txs = [buy("2026-01-10", "100", "100"), sell("2026-03-01", "100", "250"), // 15.000 meerwaarde -> 500 belasting
               { ...buy("2026-01-10", "10", "1000"), asset: "VERLIES NV" }];
  const r = S.simulate(txs, {}, cfg(), {}, [{ ...sell("2026-11-20", "10", "600"), asset: "VERLIES NV" }]); // -4.000
  const y = yr(r, 2026);
  assert.equal(y.before.tax_eur.toFixed(2), "500.00");
  assert.equal(y.after.tax_eur.toFixed(2), "100.00");
  assert.equal(r.tax_delta_eur.toFixed(2), "-400.00");
});

test("activa van vóór 2026: waarde 31/12/2025 als basis, ook in de simulatie", () => {
  const r = S.simulate([buy("2024-05-01", "100", "50")], { "TEST NV": "80" }, cfg(), {}, [sell("2026-11-20", "100", "90")]);
  assert.equal(r.sales[0].lines[0].basis_used, "REF_31_12_2025");
  assert.equal(r.sales[0].result_eur.toFixed(2), "1000.00");
});

test("verkoop in een later jaar verandert ook de overdracht naar dat jaar", () => {
  const c = cfg();
  c.years[2027] = { ...c.years[2026] };
  const txs = [buy("2026-01-10", "100", "100")];
  const r = S.simulate(txs, {}, c, {}, [sell("2027-03-01", "100", "220")]); // 12.000 in 2027
  assert.deepEqual(r.years.map(y => y.year), [2026, 2027]);
  const y26 = yr(r, 2026), y27 = yr(r, 2027);
  assert.equal(y26.changed, false); // geen verkoop in 2026: voor en na gelijk (de rekenkern rekent dan zonder rij)
  assert.equal(y27.before.exemption_available_eur.toFixed(2), "11000.00");
  assert.equal(y27.after.taxable_eur.toFixed(2), "1000.00");
  assert.equal(r.tax_delta_eur.toFixed(2), "100.00");
});

test("geen bestaande verkopen: jaar zonder rij telt als nul vooraf", () => {
  const r = S.simulate([buy("2026-01-10", "10", "10")], {}, cfg(), {}, [sell("2026-06-01", "10", "20")]);
  assert.equal(yr(r, 2026).before.net_eur.toFixed(2), "0.00");
  assert.equal(yr(r, 2026).delta.net_eur.toFixed(2), "100.00");
});

test("meer verkopen dan in bezit: nieuwe waarschuwing", () => {
  const r = S.simulate([buy("2026-01-10", "10", "10")], {}, cfg(), {}, [sell("2026-06-01", "15", "20")]);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /zonder gekende aankoop/);
});

test("bestaande gegevens blijven ongewijzigd", () => {
  const txs = [buy("2026-01-10", "10", "10")];
  const copy = JSON.stringify(txs);
  S.simulate(txs, {}, cfg(), {}, [sell("2026-06-01", "10", "20")]);
  assert.equal(JSON.stringify(txs), copy);
  assert.throws(() => S.simulate(txs, {}, cfg(), {}, []), /Geen transactie/);
});

test("stuks in bezit, ook per broker", () => {
  const txs = [buy("2026-01-10", "10", "10", { broker: "A" }), buy("2026-02-10", "5", "10", { broker: "B" }),
               sell("2026-03-01", "4", "12", { broker: "A" })];
  assert.equal(S.heldAt(txs, "2026-12-31", cfg(), "ik", "TEST NV").toString(), "11");
  assert.equal(S.heldAt(txs, "2026-02-01", cfg(), "ik", "TEST NV").toString(), "10");
  const perBroker = { ...cfg(), fifoScope: "BROKER" };
  assert.equal(S.heldAt(txs, "2026-12-31", perBroker, "ik", "TEST NV", "A").toString(), "6");
  assert.equal(S.heldAt(txs, "2026-12-31", perBroker, "ik", "TEST NV", "B").toString(), "5");
  assert.equal(S.heldAt(txs, "2026-12-31", cfg(), "ik", "ANDER").toString(), "0");
});
