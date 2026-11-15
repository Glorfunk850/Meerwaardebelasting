// node --test assets.test.js   (sleutels en namen van activa; verzonnen gegevens)
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("./assets.js");

const tx = (id, asset, extra = {}) => ({ id, type: "BUY", asset, owner: "ik", trade_date: "2025-01-02", quantity: "1", price: "1", ...extra });

test("herkent ISIN's en naamsleutels", () => {
  assert.equal(A.isIsin("BE0003565737"), true);
  assert.equal(A.isIsin("VOORBEELD NV (PA)"), false);
  assert.equal(A.isNameKey("VOORBEELD NV (PA)"), true);
  assert.equal(A.isNameKey("AAPL"), false);
  assert.equal(A.nameFromKey("VOORBEELD NV (PA)"), "VOORBEELD NV");
});

test("vult lege namen enkel in voor naamsleutels", () => {
  const s = { assets: { "VOORBEELD NV (PA)": { name: "" }, BE0003565737: { name: "" }, AAPL: { name: "" }, "OUD NV (BR)": { name: "Oud" } } };
  assert.equal(A.fillNames(s), 1);
  assert.equal(s.assets["VOORBEELD NV (PA)"].name, "VOORBEELD NV");
  assert.equal(s.assets.BE0003565737.name, "");
  assert.equal(s.assets.AAPL.name, "");
  assert.equal(s.assets["OUD NV (BR)"].name, "Oud");
});

test("hernoemt sleutel in activa, transacties en import-id's en bewaart een alias", () => {
  const s = {
    assets: { "VOORBEELD NV (PA)": { name: "", ref_value_eur: "8.5", currency: "EUR" } },
    transactions: [tx(1, "VOORBEELD NV (PA)", { import_id: "b:1" }), tx(2, "ANDER (BR)"),
      tx(3, "VOORBEELD NV (PA)", { type: "SELL", import_id: "corr:ik:VOORBEELD NV (PA)" }),
      tx(4, "VOORBEELD NV (PA)", { type: "DELISTING", import_id: "delist:ik:VOORBEELD NV (PA):2026-04-30" })],
  };
  assert.equal(A.renameAsset(s, "VOORBEELD NV (PA)", " fr0000000001 "), 3);
  assert.deepEqual(Object.keys(s.assets), ["FR0000000001"]);
  assert.equal(s.assets.FR0000000001.name, "VOORBEELD NV");
  assert.equal(s.assets.FR0000000001.ref_value_eur, "8.5");
  assert.deepEqual(s.transactions.map(t => t.asset), ["FR0000000001", "ANDER (BR)", "FR0000000001", "FR0000000001"]);
  assert.equal(s.transactions[0].import_id, "b:1");
  assert.equal(s.transactions[2].import_id, "corr:ik:FR0000000001");
  assert.equal(s.transactions[3].import_id, "delist:ik:FR0000000001:2026-04-30");
  assert.deepEqual(s.aliases, { "VOORBEELD NV (PA)": "FR0000000001" });
  // opnieuw hernoemen: oude alias volgt mee, geen cyclus
  A.renameAsset(s, "FR0000000001", "VBNV");
  assert.deepEqual(s.aliases, { "VOORBEELD NV (PA)": "VBNV", FR0000000001: "VBNV" });
  assert.throws(() => A.renameAsset(s, "VBNV", "  "), /leeg/);
});

test("samenvoegen met een bestaand actief vult lege velden aan", () => {
  const s = { assets: { "VOORBEELD NV (PA)": { name: "Voorbeeld", ref_value_eur: "8.5" }, FR0000000001: { name: "", ref_value_eur: null, asset_type: "aandeel" } },
    transactions: [tx(1, "VOORBEELD NV (PA)"), tx(2, "FR0000000001")] };
  A.renameAsset(s, "VOORBEELD NV (PA)", "FR0000000001");
  assert.deepEqual(s.assets, { FR0000000001: { name: "Voorbeeld", ref_value_eur: "8.5", asset_type: "aandeel" } });
  assert.ok(s.transactions.every(t => t.asset === "FR0000000001"));
});

test("aliassen worden toegepast op een nieuwe import", () => {
  const r = {
    transactions: [tx(1, "VOORBEELD NV (PA)"), tx(2, "ANDER (BR)")],
    positions: [{ asset: "VOORBEELD NV (PA)", quantity: "1" }], delistings: [{ asset: "VOORBEELD NV (PA)" }],
    assets: { "VOORBEELD NV (PA)": { name: "VOORBEELD NV" }, "ANDER (BR)": { name: "ANDER" } },
    refHints: { "VOORBEELD NV (PA)": { value: "8.5" } },
  };
  A.applyAliases(r, { "VOORBEELD NV (PA)": "OUDE", OUDE: "FR0000000001" });
  assert.deepEqual(r.transactions.map(t => t.asset), ["FR0000000001", "ANDER (BR)"]);
  assert.equal(r.positions[0].asset, "FR0000000001");
  assert.equal(r.delistings[0].asset, "FR0000000001");
  assert.deepEqual(Object.keys(r.assets), ["FR0000000001", "ANDER (BR)"]);
  assert.equal(r.refHints.FR0000000001.value, "8.5");
});

test("controlecijfer van ISIN's", () => {
  for (const ok of ["US0378331005", "BE0003565737", "NL0010273215", "IE00B4L5Y983"]) assert.equal(A.isinChecksumOk(ok), true, ok);
  for (const bad of ["US0378331006", "BE0003565730", "XX", "VOORBEELD NV (PA)"]) assert.equal(A.isinChecksumOk(bad), false, bad);
});

test("kandidaten en controle van voorgestelde ISIN's", () => {
  const s = { assets: { "VOORBEELD NV (PA)": { name: "VOORBEELD NV", currency: "EUR", ref_value_eur: "8.5" },
    "ANDER (NY)": { name: "", currency: "USD" }, BE0003565737: { name: "Voorbeeld" }, AAPL: { name: "", currency: "USD" } } };
  const items = A.isinCandidates(s);
  assert.deepEqual(items.map(i => [i.key, i.name, i.exchange]),
    [["VOORBEELD NV (PA)", "VOORBEELD NV", "PA"], ["ANDER (NY)", "ANDER", "NY"], ["AAPL", "AAPL", ""]]);
  const prompt = A.isinPrompt(items);
  assert.ok(prompt.includes("VOORBEELD NV (PA)") && !prompt.includes("8.5")); // geen bedragen naar Claude
  const res = A.parseIsinAnswer([
    { key: "VOORBEELD NV (PA)", isin: "us 0378331005", confidence: "hoog" },
    { key: "ANDER (NY)", isin: "US0378331006", confidence: "middel" },
    { key: "ONBEKEND", isin: "BE0003565737" },
  ], items);
  assert.equal(res[0].isin, "US0378331005"); assert.equal(res[0].problem, "");
  assert.equal(res[1].isin, ""); assert.equal(res[1].problem, "controlecijfer klopt niet");
  assert.equal(res[2].problem, "geen antwoord");
  assert.equal(A.parseIsinAnswer({ results: [{ key: "AAPL", isin: null }] }, items)[2].problem, "niet gevonden");
});
