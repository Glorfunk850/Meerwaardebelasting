// node --test saxo.test.js   (synthetisch; optioneel SAXO_FILE=pad voor een echte export)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const M = require("./engine.js");
const S = require("./saxo.js");
const X = require("./xlsx.js");

const H = ["Gebruikersnaam", "Transactiedatum", "Valutadatum", " Positie-ID", "Transactie-ID", "Corporate action-Id", "Bk Record Id", "Booking Id",
  "Transactietype", "Acties", "Boekingsbedrag (EUR)", "Valuta", "Omrekeningskoers", "Conversion cost", "Gerealiseerde W/V", "Totale kosten", "Instrument",
  "Instrumentsymbool", "Instrument ISIN", "Instrumentvaluta", "Type", "Uitwisselingsbeschrijving", "Order-ID", "Aangepaste transactiedatum",
  "Trade execution date", "Trade Event Type", "Trade Type", "Openen/sluiten", "Traded Quantity", "Prijs", "Verhandelde waarde", "Spreadkosten",
  "From Derivative", "Underlying asset type"];
const serial = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 + 25569 + 0.4;
function row({ date, id, action, amount, rate = 1, pl = null, costs, name, isin, ccy = "EUR", oc = "To Open", qty, price }) {
  const r = Array(H.length).fill(null);
  const set = (k, v) => { r[H.indexOf(k)] = v; };
  set("Transactiedatum", serial(date)); set("Aangepaste transactiedatum", Math.floor(serial(date))); set("Transactie-ID", id);
  set("Transactietype", "Transactie"); set("Acties", action); set("Boekingsbedrag (EUR)", amount); set("Omrekeningskoers", rate);
  set("Gerealiseerde W/V", pl); set("Totale kosten", costs); set("Instrument", name); set("Instrument ISIN", isin); set("Instrumentvaluta", ccy);
  set("Openen/sluiten", oc); set("Traded Quantity", qty); set("Prijs", price); set("Type", "Stock");
  return r;
}
const sheets = () => ({
  Transacties: [H,
    row({ date: "2026-08-20", id: null, action: "Koop 40 @ 14.30 ", amount: null, costs: 0, name: "Pending ETN", isin: null, oc: "Pending", qty: 40, price: 14.3 }),
    row({ date: "2026-07-28", id: "T5", action: "Koop 10 @ 50.00 USD", amount: -454.00, rate: 0.9, costs: -4, name: "Voorbeeld Tech Inc.", isin: "US0000000001", ccy: "USD", qty: 10, price: 50 }),
    row({ date: "2026-01-26", id: "T4", action: "Verkoop -50 @ 30.00 EUR", amount: 1494.00, pl: 400, costs: -6, name: "*Delsited 20260430 (Overname NV)", isin: "NL0000000002", oc: "To Close", qty: -50, price: 30 }),
    row({ date: "2025-07-10", id: "T3", action: "Koop 5 @ 100.00 EUR", amount: -505.00, costs: -5, name: "*Delisted 20260729 (Geschrapt NV)", isin: "BE0000000003", qty: 5, price: 100 }),
    row({ date: "2025-03-28", id: "T2", action: "Koop 25 @ 20.00 EUR", amount: -505.00, costs: -5, name: "*Delsited 20260430 (Overname NV)", isin: "NL0000000002", qty: 25, price: 20 }),
    row({ date: "2025-03-03", id: "T1", action: "Koop 25 @ 18.00 EUR", amount: -455.00, costs: -5, name: "*Delsited 20260430 (Overname NV)", isin: "NL0000000002", qty: 25, price: 18 }),
  ],
  Bookings: [["Rekening-ID", "Transactie-ID", "Acties", "Amount Type", "Boekingsbedrag", "Omrekeningskoers"],
    ["x", "T4", "Verkoop", "Beurstaks 0.35%", -5.25, 1], ["x", "T4", "Verkoop", "Commissie", -0.75, 1],
    ["x", "T5", "Koop", "Beurstaks 0.35%", -1.80, 0.9], ["x", "T5", "Koop", "Franse financiële transactiebelasting", -0.2, 0.9]],
});

test("delisted tag", () => {
  assert.deepEqual(S.delistedTag("*Delsited 20260430 (Overname NV)"), { date: "2026-04-30", name: "Overname NV" });
  assert.deepEqual(S.delistedTag("*Delisted 20260729 (Geschrapt NV)"), { date: "2026-07-29", name: "Geschrapt NV" });
  assert.equal(S.delistedTag("Voorbeeld Tech Inc."), null);
});

test("excel serial dates", () => {
  assert.equal(X.excelDate(46254.3355671296), "2026-08-20");
  assert.equal(X.excelDate(45658), "2025-01-01");
});

test("parse sample", () => {
  const r = S.parseSaxoSheets(sheets(), { owner: "ik" });
  assert.equal(r.transactions.length, 5);
  assert.equal(r.skipped["Niet (volledig) uitgevoerde orders"], 1);
  const nf = r.transactions.find(t => t.asset === "US0000000001");
  assert.equal(nf.currency, "USD"); assert.equal(nf.fx_per_eur, M.D(1).div("0.9").round(10).toString());
  // kosten 4,00 EUR, waarvan taksen 2,00 EUR -> in USD
  assert.equal(nf.taxes, M.D("2").mul(nf.fx_per_eur).round(2).toString());
  const verkoop = r.transactions.find(t => t.type === "SELL");
  assert.equal(verkoop.asset, "NL0000000002"); assert.equal(verkoop.quantity, "50"); assert.equal(verkoop.taxes, "5.25"); assert.equal(verkoop.fees, "0.75");
  assert.equal(verkoop.saxo_result, "400"); assert.ok(verkoop.note.startsWith("Overname NV"));
  // posities eind 2025 en delisting-voorstel enkel voor Geschrapt NV
  assert.deepEqual(r.positions.map(p => [p.asset, p.quantity]).sort(), [["BE0000000003", "5"], ["NL0000000002", "50"]]);
  assert.deepEqual(r.delistings.map(d => [d.asset, d.date, d.quantity]), [["BE0000000003", "2026-07-29", "5"]]);
  assert.ok(r.warnings.some(w => w.includes("Overname NV") && w.includes("niets te doen")));
  assert.equal(new Set(r.transactions.map(t => t.import_id)).size, 5);
});

test("engine result for imported sale", () => {
  const r = S.parseSaxoSheets(sheets());
  const rep = M.calculate(r.transactions, { NL0000000002: "21.50" });
  // 50 x 30 = 1500 ; fotowaarde 50 x 21,50 = 1075 -> 425
  assert.equal(rep.sales[0].result_eur.toFixed(2), "425.00");
});

test("rejects other files", () => {
  assert.throws(() => S.parseSaxoSheets({ Blad1: [["a", "b"], [1, 2]] }), /Saxo-export/);
});

test("real export (optional)", { skip: !process.env.SAXO_FILE }, async () => {
  const r = await S.parseSaxoFile(fs.readFileSync(process.env.SAXO_FILE));
  assert.ok(r.transactions.length > 0);
  // kostprijs: |boekingsbedrag| ≈ verhandelde waarde in EUR ± kosten (afronding)
  for (const t of r.transactions) assert.ok(M.D(t.fx_per_eur).gt(0));
});

test("zonder ISIN: ISIN uit een andere regel, anders de ticker; import-id blijft gelijk", () => {
  const sh = sheets();
  const withSym = (r, sym) => { r[H.indexOf("Instrumentsymbool")] = sym; return r; };
  sh.Transacties.push(
    withSym(row({ date: "2026-02-02", id: "T7", action: "Koop 3 @ 40.00 EUR", amount: -122.00, costs: -2, name: "Voorbeeld ETF Acc", isin: null, qty: 3, price: 40 }), "VETF:xams"),
    withSym(row({ date: "2026-01-02", id: "T6", action: "Koop 2 @ 40.00 EUR", amount: -82.00, costs: -2, name: "Voorbeeld ETF Acc", isin: "IE0000000009", qty: 2, price: 40 }), "VETF:xams"),
    withSym(row({ date: "2026-01-03", id: "T8", action: "Koop 1 @ 9.00 EUR", amount: -11.00, costs: -2, name: "Zonder Code ETF", isin: null, qty: 1, price: 9 }), "ZCE:xetr"),
    row({ date: "2026-01-04", id: "T9", action: "Koop 1 @ 9.00 EUR", amount: -11.00, costs: -2, name: "Helemaal Niets NV", isin: null, qty: 1, price: 9 }));
  const r = S.parseSaxoSheets(sh);
  const by = n => r.transactions.filter(t => t.note.startsWith(n));
  assert.deepEqual(by("Voorbeeld ETF").map(t => t.asset), ["IE0000000009", "IE0000000009"]);
  assert.equal(by("Zonder Code")[0].asset, "ZCE");
  assert.equal(r.assets.ZCE.name, "Zonder Code ETF");
  assert.equal(by("Helemaal Niets")[0].asset, "HELEMAAL NIETS NV");
  assert.equal(S.tickerOf("EMIM:xams"), "EMIM");
  // vroeger opgeslagen onder de naam -> plan om naar de nieuwe code te verhuizen; ISIN's blijven ongemoeid
  const old = r.transactions.map(t => ({ ...t, asset: t.note.startsWith("Zonder Code") ? "ZONDER CODE ETF" : t.note.startsWith("Voorbeeld ETF") ? "VOORBEELD ETF ACC" : t.asset }));
  const plan = S.keyMigrations(old, r.transactions);
  assert.deepEqual([...plan].sort(), [["VOORBEELD ETF ACC", "IE0000000009"], ["ZONDER CODE ETF", "ZCE"]]);
  assert.equal(S.keyMigrations(r.transactions, r.transactions).size, 0);
  // import-id's veranderen niet door de nieuwe codes
  const r2 = S.parseSaxoSheets(sh);
  assert.deepEqual(r.transactions.map(t => t.import_id), r2.transactions.map(t => t.import_id));
});
