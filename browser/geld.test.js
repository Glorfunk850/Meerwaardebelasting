// node --test geld.test.js   (geldbewegingen: groepering, dubbels en overzicht per jaar; verzonnen gegevens)
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("./geld.js");

const c = (kind, date, amount, extra = {}) => ({ kind, date, amount, currency: "EUR", owner: "ik", broker: "Saxo", status: "info", remark: "",
  import_id: `${kind}|${date}|${amount}`, ...extra });

test("labels en groepen", () => {
  assert.equal(G.label("STORTING"), "Storting");
  assert.equal(G.group("DIV_TERUG"), "Teruggeboekte dividenden");
  assert.equal(G.label("ONBEKEND"), "Andere");
});

test("import-id's: zelfde inhoud krijgt een volgnummer", () => {
  const id = G.idMaker("x:");
  assert.equal(id("a", 1), "x:a|1|1");
  assert.equal(id("a", 1), "x:a|1|2");
  assert.equal(id("b", null), "x:b||1");
});

test("enkel nieuwe geldbewegingen", () => {
  const old = [c("STORTING", "2026-01-01", "100")];
  const inc = [c("STORTING", "2026-01-01", "100"), c("OPNAME", "2026-02-01", "-50"), { ...c("ANDERE", "2026-03-01", "1"), import_id: "" }];
  assert.deepEqual(G.fresh(old, inc).map(x => x.kind), ["OPNAME", "ANDERE"]);
  assert.equal(G.fresh(undefined, inc).length, 3);
});

test("groepen voor het importvenster: nieuw en al verwerkt apart", () => {
  const g = G.groups([
    c("OPNAME", "2026-01-02", "-5"), c("STORTING", "2026-01-01", "100"), c("STORTING", "2026-02-01", "50"),
    c("MWB", "2026-03-01", "-20", { status: "verwerkt", remark: "al bij 'Ingehouden door broker'" }),
  ]);
  assert.deepEqual(g.map(x => [x.kind, x.count, x.status, x.remark]),
    [["STORTING", 2, "info", ""], ["OPNAME", 1, "info", ""], ["MWB", 1, "verwerkt", "al bij 'Ingehouden door broker'"]]);
});

test("geldoverzicht per jaar", () => {
  const cash = [
    c("STORTING", "2025-02-03", "5000"), c("OPNAME", "2025-12-15", "-1000"),
    c("STORTING", "2026-01-12", "6000"), c("OPNAME", "2026-09-30", "-1500.5"),
    c("KAPVERM", "2026-05-27", "48"), c("DIV_TERUG", "2026-05-02", "-12.40"),
    c("BOD", "2026-07-29", "1200", { status: "verwerkt" }), // telt niet mee in het overzicht
    c("STORTING", "2026-03-01", "999", { owner: "partner" }),
    c("STORTING", "2026-04-01", "700", { currency: "USD" }), // andere munt: apart geteld
  ];
  const txs = [
    { type: "DIVIDEND", trade_date: "2026-04-30", amount: "61", currency: "EUR", owner: "ik" },
    { type: "DIVIDEND", trade_date: "2026-06-10", amount: "110", currency: "USD", fx_per_eur: "1.1", owner: "ik" },
    { type: "DIVIDEND", trade_date: "2024-06-10", amount: "5", currency: "EUR", owner: "ik" }, // jaar zonder geldbewegingen
    { type: "BUY", trade_date: "2026-01-14", amount: "0", owner: "ik" },
  ];
  const withheld = [{ owner: "ik", year: 2026, amount: "32.10" }, { owner: "partner", year: 2026, amount: "5" }];
  const s = G.summary(cash, txs, withheld, { owner: "ik" });
  const str = r => [r.year, r.deposits, r.withdrawals, r.net, r.dividends, r.capital_reductions, r.withheld].map(String);
  assert.deepEqual(s.rows.map(str), [
    ["2025", "5000", "-1000", "4000", "0", "0", "0"],
    ["2026", "6000", "-1500.5", "4499.5", "148.6", "48", "-32.1"],
  ]);
  assert.deepEqual(str(s.total), ["Totaal", "11000", "-2500.5", "8499.5", "148.6", "48", "-32.1"]);
  assert.equal(s.foreign, 1);
  // filter op jaar; alle eigenaars
  assert.deepEqual(G.summary(cash, txs, withheld, { year: "2026" }).rows.map(str),
    [["2026", "6999", "-1500.5", "5498.5", "148.6", "48", "-37.1"]]);
  assert.deepEqual(G.summary([], txs, withheld).rows, []);
});
