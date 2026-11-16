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
  const nf = r.transactions.find(t => t.asset === "VOORBEELD TECH INC.");
  assert.equal(nf.currency, "USD"); assert.equal(nf.fx_per_eur, M.D(1).div("0.9").round(10).toString());
  // kosten 4,00 EUR, waarvan taksen 2,00 EUR -> in USD
  assert.equal(nf.taxes, M.D("2").mul(nf.fx_per_eur).round(2).toString());
  const verkoop = r.transactions.find(t => t.type === "SELL");
  assert.equal(verkoop.asset, "OVERNAME NV"); assert.equal(verkoop.quantity, "50"); assert.equal(verkoop.taxes, "5.25"); assert.equal(verkoop.fees, "0.75");
  assert.equal(verkoop.saxo_result, "400"); assert.ok(verkoop.note.startsWith("Overname NV"));
  // posities eind 2025 en delisting-voorstel enkel voor Geschrapt NV
  assert.deepEqual(r.positions.map(p => [p.asset, p.quantity]).sort(), [["GESCHRAPT NV", "5"], ["OVERNAME NV", "50"]]);
  assert.deepEqual(r.delistings.map(d => [d.asset, d.date, d.quantity]), [["GESCHRAPT NV", "2026-07-29", "5"]]);
  assert.ok(r.warnings.some(w => w.includes("Overname NV") && w.includes("niets te doen")));
  assert.equal(new Set(r.transactions.map(t => t.import_id)).size, 5);
});

test("engine result for imported sale", () => {
  const r = S.parseSaxoSheets(sheets());
  const rep = M.calculate(r.transactions, { "OVERNAME NV": "21.50" });
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

test("actief = naam; ISIN apart bewaard en aangevuld uit andere regels; herimport verhuist oude codes", () => {
  const sh = sheets();
  sh.Transacties.push(
    row({ date: "2026-02-02", id: "T7", action: "Koop 3 @ 40.00 EUR", amount: -122.00, costs: -2, name: "Voorbeeld ETF Acc", isin: null, qty: 3, price: 40 }),
    row({ date: "2026-01-02", id: "T6", action: "Koop 2 @ 40.00 EUR", amount: -82.00, costs: -2, name: "Voorbeeld ETF Acc", isin: "IE0000000009", qty: 2, price: 40 }),
    row({ date: "2026-01-04", id: "T9", action: "Koop 1 @ 9.00 EUR", amount: -11.00, costs: -2, name: "Helemaal Niets NV", isin: null, qty: 1, price: 9 }),
    // zelfde naam, ander effect
    row({ date: "2026-01-05", id: "T10", action: "Koop 1 @ 9.00 EUR", amount: -11.00, costs: -2, name: "Voorbeeld ETF Acc", isin: "LU0000000008", qty: 1, price: 9 }));
  const r = S.parseSaxoSheets(sh);
  const by = id => r.transactions.find(t => t.import_id.startsWith(`s:${id}|`)).asset;
  // zelfde naam, twee ISIN's: twee aparte activa, één ervan met de ISIN erbij
  assert.notEqual(by("T6"), by("T10"));
  assert.deepEqual([by("T6"), by("T10")].sort(), ["VOORBEELD ETF ACC", by("T6") === "VOORBEELD ETF ACC" ? "VOORBEELD ETF ACC (LU0000000008)" : "VOORBEELD ETF ACC (IE0000000009)"].sort());
  assert.equal(by("T7"), "VOORBEELD ETF ACC"); // naam zonder ISIN: geen ISIN geraden
  assert.equal(by("T9"), "HELEMAAL NIETS NV");
  assert.ok(r.warnings.some(w => w.includes("T7") === false && w.includes("meerdere ISIN")));
  assert.equal(r.assets["HELEMAAL NIETS NV"].isin, "");
  assert.equal(r.assets["VOORBEELD TECH INC."].name, "Voorbeeld Tech Inc.");
  // vroeger onder de ISIN of een ticker opgeslagen -> plan om naar de naam te verhuizen
  const old = r.transactions.map(t => ({ ...t, asset: t.asset === "VOORBEELD TECH INC." ? "US0000000001" : t.asset === "HELEMAAL NIETS NV" ? "HNN" : t.asset }));
  assert.deepEqual([...S.keyMigrations(old, r.transactions)].sort(), [["HNN", "HELEMAAL NIETS NV"], ["US0000000001", "VOORBEELD TECH INC."]]);
  assert.equal(S.keyMigrations(r.transactions, r.transactions).size, 0);
  // import-id's stabiel
  assert.deepEqual(r.transactions.map(t => t.import_id), S.parseSaxoSheets(sh).transactions.map(t => t.import_id));
});

test("regel zonder ISIN krijgt de ISIN van hetzelfde instrument", () => {
  const sh = sheets();
  sh.Transacties.push(
    row({ date: "2026-02-02", id: "T7", action: "Koop 3 @ 40.00 EUR", amount: -122.00, costs: -2, name: "Voorbeeld ETF Acc", isin: null, qty: 3, price: 40 }),
    row({ date: "2026-01-02", id: "T6", action: "Koop 2 @ 40.00 EUR", amount: -82.00, costs: -2, name: "Voorbeeld ETF Acc", isin: "IE0000000009", qty: 2, price: 40 }));
  const r = S.parseSaxoSheets(sh);
  assert.deepEqual(r.transactions.filter(t => t.note.startsWith("Voorbeeld ETF")).map(t => t.asset), ["VOORBEELD ETF ACC", "VOORBEELD ETF ACC"]);
  assert.equal(r.assets["VOORBEELD ETF ACC"].isin, "IE0000000009");
  assert.ok(!r.warnings.some(w => w.includes("Voorbeeld ETF") && w.includes("geen ISIN")));
});

// ---------------------------------------------------------------- standaardexport "Transacties" (sinds 2026)
// Blad "Transacties": één regel per boeking; blad "_Transacties": aantal en prijs per uitvoering (ook corporate actions).
const TH = ["Gebruikersnaam", "Transactiedatum", "Valutadatum", "Rekening-ID", "Transactie-ID", " Positie-ID", "Corporate action-Id", "Bk Record Id",
  "Booking Id", "Transactietype", "Acties", "Boekingsbedrag", "Valuta", "Omrekeningskoers", "Conversion cost", "Totale kosten", "Gerealiseerde W/V",
  "IBAN", "Opmerking", "Instrument", "Instrumentsymbool", "Instrument ISIN", "Instrumentvaluta", "Type", "Uitwisselingsbeschrijving"];
const EH = ["Rekening-ID", "Transactie-ID", "Bk Record Id", "Booking Id", "Corporate action-Id", "Acties", "Order-ID", "Aangepaste transactiedatum",
  "Trade execution date", "Trade Event Type", "Trade Type", "Openen/sluiten", "Traded Quantity", "Prijs", "Verhandelde waarde", "Spreadkosten",
  "From Derivative", "Underlying asset type", "Instrument", "Instrumentsymbool", "Instrument ISIN", "Instrumentvaluta", "Type", "Uitwisselingsbeschrijving"];
const BH = ["Rekening-ID", "Transactie-ID", "Bk Record Id", "Booking Id", "Corporate action-Id", "Acties", "Amount Type", "Amount Type Id",
  "Boekingsbedrag", "Conversion cost", "Omrekeningskoers", "Boekingsdatum", "Ex-datum", "Transactiedatum", "Eligible quantity", "Instrument", "Instrument ISIN", "Instrumentvaluta"];
const mk = H => o => H.map(k => (k in o ? o[k] : null));
const day = iso => Math.floor(serial(iso));
const INS = {
  A: { "Instrument": "Alfa Bouw NV", "Instrumentsymbool": "ALFA:xbru", "Instrument ISIN": "BE0000000101", "Instrumentvaluta": "EUR", "Type": "Stock" },
  B: { "Instrument": "Beta Corp.", "Instrumentsymbool": "BETA:xnys", "Instrument ISIN": "US0000000102", "Instrumentvaluta": "USD", "Type": "Stock" },
  C: { "Instrument": "*Delisted 20260801 (Gamma Foods)", "Instrumentsymbool": "GAM:xbru", "Instrument ISIN": "BE0000000103", "Instrumentvaluta": "EUR", "Type": "Stock" },
  D: { "Instrument": "Delta Media N.V.", "Instrumentsymbool": "DEL:xams", "Instrument ISIN": "NL0000000104", "Instrumentvaluta": "EUR", "Type": "Stock" },
};
function standardExport() {
  const T = mk(TH), E = mk(EH), Bk = mk(BH);
  const trade = (date, id, ins, action, amount, costs, { rate = 1, pl = null } = {}) =>
    T({ "Transactiedatum": serial(date), "Transactie-ID": id, "Transactietype": "Transactie", "Acties": action, "Boekingsbedrag": amount, "Valuta": "EUR",
      "Omrekeningskoers": rate, "Totale kosten": costs, "Gerealiseerde W/V": pl, ...INS[ins] });
  const exec = (date, id, ins, qty, price, extra = {}) =>
    E({ "Transactie-ID": id, "Aangepaste transactiedatum": day(date), "Trade execution date": serial(date), "Traded Quantity": qty, "Prijs": price,
      "Verhandelde waarde": -qty * price, "Openen/sluiten": qty > 0 ? "To Open" : "To Close", "Trade Event Type": qty > 0 ? "Gekocht" : "Verkocht", ...INS[ins], ...extra });
  const ca = (date, id, ins, action, amount, extra = {}) =>
    T({ "Transactiedatum": serial(date), "Corporate action-Id": id, "Transactietype": "Corporate action", "Acties": action, "Boekingsbedrag": amount,
      "Valuta": "EUR", "Omrekeningskoers": 1, "Totale kosten": 0, ...INS[ins], ...extra });
  // aflopend zoals Saxo
  return {
    Transacties: [TH,
      ca("2026-10-01", "CA3", "C", null, -20, { "Bk Record Id": 903 }),                       // ingehouden meerwaardebelasting op het bod
      trade("2026-09-15", "X6", "A", "Verkoop -40 @ 30.00 EUR", 1194.90, -5.10, { pl: 190 }),
      ca("2026-07-01", "CA3", "C", "Openbaar overnamebod", 600),
      ca("2026-05-05", "CA4", "A", "Cashdividend", 30.80),
      ca("2026-05-03", "CA4", "A", "Cashdividend - Reversal", -30.80),
      ca("2026-05-02", "CA4", "A", "Cashdividend", 30.80),
      ca("2026-04-20", "CA5", "D", "Cashdividend - Reversal", -12),                         // volledig teruggeboekt
      ca("2026-04-10", "CA5", "D", "Cashdividend", 12),
      ca("2026-03-02", "CA6", "A", "Waardevermindering", 25),
      ca("2026-02-01", "CA7", "B", "Cashdividend", 8.5, { "Omrekeningskoers": 0.9 }),
      T({ "Transactiedatum": serial("2026-01-20"), "Transactietype": "Storting/opname", "Acties": "Storting", "Boekingsbedrag": 500, "Valuta": "EUR" }),
      ca("2025-12-02", "CA2", "D", "Omgekeerde aandelensplitsing", 3.6),                      // fractie in cash
      ca("2025-11-18", "CA2", "D", "Omgekeerde aandelensplitsing", 0),
      trade("2025-09-01", "X4", "D", "Koop 125 @ 2.00 EUR", -253, -3),
      trade("2025-06-10", "X3", "C", "Koop 4 @ 120.00 EUR", -485, -5),
      trade("2025-03-03", "X2", "B", "Koop 10 @ 50.00 USD", -455, -5, { rate: 0.9 }),
      trade("2025-02-03", "X1", "A", "Koop 100 @ 20.00 EUR", -2010, -10),
    ],
    _Transacties: [EH,
      exec("2026-10-01", "X5", "C", -4, 150, { "Corporate action-Id": "CA3", "Bk Record Id": 903 }),   // herboeking van het bod
      exec("2026-09-15", "X6", "A", -40, 30, { "Acties": "Verkoop -40 @ 30.00 EUR" }),
      exec("2026-07-01", "X5", "C", -4, 150, { "Corporate action-Id": "CA3", "Acties": "Openbaar overnamebod" }),
      exec("2026-06-01", "X7", "A", 1, 31, { "Corporate action-Id": "CA8", "Acties": "Herbeleggingsdividend" }),
      exec("2025-11-18", "X8", "D", -125, 2, { "Corporate action-Id": "CA2", "Acties": "Omgekeerde aandelensplitsing" }),
      exec("2025-11-18", "X9", "D", 12, 20, { "Corporate action-Id": "CA2", "Acties": "Omgekeerde aandelensplitsing" }),
      exec("2025-09-01", "X4", "D", 125, 2), exec("2025-06-10", "X3", "C", 4, 120), exec("2025-03-03", "X2", "B", 10, 50), exec("2025-02-03", "X1", "A", 100, 20),
    ],
    Bookings: [BH,
      Bk({ "Bk Record Id": 903, "Corporate action-Id": "CA3", "Amount Type": "Meerwaardebelasting", "Boekingsbedrag": -20, "Boekingsdatum": day("2026-10-01") }),
      Bk({ "Transactie-ID": "X6", "Amount Type": "Meerwaardebelasting", "Boekingsbedrag": -19, "Boekingsdatum": day("2026-09-15") }),
      Bk({ "Transactie-ID": "X6", "Amount Type": "Commissie", "Boekingsbedrag": -0.9, "Boekingsdatum": day("2026-09-15") }),
      Bk({ "Transactie-ID": "X6", "Amount Type": "Beurstaks 0.35%", "Boekingsbedrag": -4.2, "Boekingsdatum": day("2026-09-15") }),
      Bk({ "Corporate action-Id": "CA2", "Amount Type": "Corporate actions - Fracties", "Boekingsbedrag": 3.6, "Boekingsdatum": day("2025-12-02") }),
      Bk({ "Transactie-ID": "X1", "Amount Type": "Beurstaks 0.35%", "Boekingsbedrag": -7, "Boekingsdatum": day("2025-02-03") }),
    ],
  };
}

test("standaardexport: transacties uit _Transacties met bedragen en kosten uit Transacties", () => {
  const r = S.parseSaxoSheets(standardExport(), { owner: "ik", fileName: "std.xlsx" });
  const tx = id => r.transactions.find(t => t.import_id.startsWith(`s:${id}|`));
  const x1 = tx("X1");
  assert.equal(x1.type, "BUY"); assert.equal(x1.trade_date, "2025-02-03"); assert.equal(x1.asset, "ALFA BOUW NV");
  assert.equal(x1.quantity, "100"); assert.equal(x1.price, "20"); assert.equal(x1.taxes, "7"); assert.equal(x1.fees, "3");
  assert.equal(x1.import_source, "std.xlsx (_Transacties:11)");
  const x2 = tx("X2");
  assert.equal(x2.currency, "USD"); assert.equal(x2.fx_per_eur, M.D(1).div("0.9").round(10).toString());
  // verkoop: kosten zonder de ingehouden meerwaardebelasting
  const x6 = tx("X6");
  assert.equal(x6.type, "SELL"); assert.equal(x6.taxes, "4.2"); assert.equal(x6.fees, "0.9"); assert.equal(x6.saxo_result, "190");
  // overnamebod: één verkoop op de datum van het bod (de herboeking telt niet)
  const bod = r.transactions.filter(t => t.import_id.startsWith("s:X5|"));
  assert.equal(bod.length, 1); assert.equal(bod[0].trade_date, "2026-07-01"); assert.equal(bod[0].type, "SELL");
  assert.equal(bod[0].asset, "GAMMA FOODS"); assert.ok(bod[0].note.includes("Openbaar overnamebod"));
  const dub = r.cash.filter(c => c.kind === "DUBBEL");
  assert.equal(dub.length, 1); assert.equal(dub[0].status, "verwerkt"); assert.equal(dub[0].date, "2026-10-01");
  // stockdividend = aankoop zonder kosten
  const x7 = tx("X7");
  assert.equal(x7.type, "BUY"); assert.equal(x7.quantity, "1"); assert.equal(x7.price, "31"); assert.equal(x7.fees, "0");
  assert.equal(new Set(r.transactions.map(t => t.import_id)).size, r.transactions.length);
  assert.deepEqual(r.period, ["2025-02-03", "2026-09-15"]);
});

test("standaardexport: omgekeerde splitsing, dividenden, kapitaalvermindering en ingehouden belasting", () => {
  const r = S.parseSaxoSheets(standardExport(), { owner: "ik", fileName: "std.xlsx" });
  // 125 -> 12 bij 1 nieuw voor 10 oud: splitsing 0,1 en fractie 0,5 verkocht voor 3,60
  const split = r.transactions.find(t => t.type === "SPLIT");
  assert.equal(split.asset, "DELTA MEDIA N.V."); assert.equal(split.trade_date, "2025-11-18"); assert.equal(split.split_ratio, "0.1");
  const frac = r.transactions.find(t => t.import_id === "s:frac:CA2");
  assert.equal(frac.type, "SELL"); assert.equal(frac.quantity, "0.5"); assert.equal(frac.price, "7.2"); assert.equal(frac.trade_date, "2025-12-02");
  assert.ok(!r.transactions.some(t => t.import_id.startsWith("s:X8|") || t.import_id.startsWith("s:X9|")));
  const pos = Object.fromEntries(r.positions.map(p => [p.asset, p.quantity]));
  assert.deepEqual(pos, { "ALFA BOUW NV": "100", "BETA CORP.": "10", "GAMMA FOODS": "4", "DELTA MEDIA N.V.": "12" });
  // dividenden: netto per corporate action; volledig teruggeboekt = niets
  const divs = r.transactions.filter(t => t.type === "DIVIDEND");
  assert.deepEqual(divs.map(t => [t.asset, t.trade_date, t.amount]).sort(),
    [["ALFA BOUW NV", "2026-05-02", "30.8"], ["BETA CORP.", "2026-02-01", "8.5"]]);
  // geldbewegingen: enkel ter info, met een verwijzing als ze al op een andere manier verwerkt zijn
  assert.deepEqual(r.skipped, {});
  const cash = kind => r.cash.filter(c => c.kind === kind).map(c => [c.date, c.amount, c.status, c.asset_name]).sort();
  assert.deepEqual(cash("DIV_TERUG"), [["2026-04-10", "12", "info", "Delta Media N.V."], ["2026-04-20", "-12", "info", "Delta Media N.V."]]);
  assert.deepEqual(cash("STORTING"), [["2026-01-20", "500", "info", ""]]);
  assert.deepEqual(cash("KAPVERM"), [["2026-03-02", "25", "info", "Alfa Bouw NV"]]);
  assert.ok(r.cash.find(c => c.kind === "KAPVERM").remark.includes("nakijken")); assert.equal(r.cash.find(c => c.kind === "KAPVERM").warn, true);
  assert.ok(!r.cash.some(c => c.kind === "DIV_TERUG" && c.warn));
  assert.ok(r.warnings.some(w => w.includes("Waardevermindering") && w.includes("niet uitdrukkelijk")));
  assert.deepEqual(cash("MWB"), [["2026-10-01", "-20", "verwerkt", "Gamma Foods"]]);
  assert.deepEqual(cash("BOD"), [["2026-07-01", "600", "verwerkt", "Gamma Foods"]]);
  assert.deepEqual(cash("FRACTIE"), [["2025-11-18", "0", "verwerkt", "Delta Media N.V."], ["2025-12-02", "3.6", "verwerkt", "Delta Media N.V."]]);
  assert.equal(r.cash.length, 9);
  assert.ok(r.cash.every(c => c.owner === "ik" && c.broker === "Saxo" && c.currency === "EUR" && c.import_source.startsWith("std.xlsx (")));
  const ids = r.cash.map(c => c.import_id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(S.parseSaxoSheets(standardExport(), { owner: "ik", fileName: "std.xlsx" }).cash.map(c => c.import_id), ids);
  // ingehouden meerwaardebelasting per jaar
  assert.deepEqual(r.withheld, { 2026: "39" });
  assert.ok(r.warnings.some(w => w.includes("Saxo hield meerwaardebelasting in")));
  // geschrapt na het bod: niets meer te doen
  assert.deepEqual(r.delistings, []);
  // de rekenkern kan alles verwerken
  const rep = M.calculate(r.transactions, { "ALFA BOUW NV": "25", "GAMMA FOODS": "130" });
  const sale = rep.sales.find(s => s.asset === "ALFA BOUW NV");
  assert.equal(sale.result_eur.toFixed(2), "200.00"); // 40 x (30 - 25)
  assert.equal(rep.sales.find(s => s.asset === "GAMMA FOODS").result_eur.toFixed(2), "80.00"); // 4 x (150 - 130)
});

test("datums als tekst: ook één cijfer voor dag of maand", () => {
  assert.equal(X.excelDate("11-09-2026"), "2026-09-11");
  assert.equal(X.excelDate("1/9/2026"), "2026-09-01");
  assert.equal(X.excelDate("11.09.2026 14:02"), "2026-09-11");
  assert.equal(X.excelDate("2026-09-11T10:00:00"), "2026-09-11");
  assert.equal(X.excelDate("31/13/2026"), null);
});

test("standaardexport: uitvoeringen zonder (juiste) boeking en boekingen zonder uitvoering worden toch ingelezen", () => {
  const sh = standardExport(), T = mk(TH), E = mk(EH);
  const E1 = { "Instrument": "Epsilon Licht NV", "Instrumentsymbool": "EPS:xams", "Instrument ISIN": "NL0000000105", "Instrumentvaluta": "EUR", "Type": "Stock" };
  const exec = (date, id, ins, qty, price) => E({ "Transactie-ID": id, "Aangepaste transactiedatum": day(date), "Traded Quantity": qty, "Prijs": price,
    "Verhandelde waarde": -qty * price, "Openen/sluiten": qty > 0 ? "To Open" : "To Close", ...ins });
  sh._Transacties.splice(1, 0,
    exec("2026-09-11", "Y1", E1, -10, 25),                 // verkoop zonder boeking
    exec("2026-08-03", "Y2", INS.B, 2, 60),                // USD, zonder boeking: koers van de dichtstbijzijnde dag
    exec("2026-04-02", "Y3", E1, 4, 22),                   // boeking staat onder een ander transactie-id
    exec("2025-05-05", "Y4", E1, 6, 20));
  sh.Transacties.splice(1, 0,
    T({ "Transactiedatum": serial("2026-04-02"), "Transactie-ID": "Z3", "Transactietype": "Transactie", "Acties": "Koop 4 @ 22.00 EUR",
      "Boekingsbedrag": -91, "Valuta": "EUR", "Omrekeningskoers": 1, "Totale kosten": -3, ...E1 }),
    T({ "Transactiedatum": serial("2026-10-20"), "Transactie-ID": "Z5", "Transactietype": "Transactie", "Acties": "Verkoop -3 @ 70.00 USD",
      "Boekingsbedrag": 186, "Valuta": "EUR", "Omrekeningskoers": 0.9, "Totale kosten": -3, "Gerealiseerde W/V": 25, ...INS.B }),
    T({ "Transactiedatum": serial("2026-10-21"), "Transactie-ID": "Z6", "Transactietype": "Transactie", "Acties": "Overboeking",
      "Boekingsbedrag": -1, "Valuta": "EUR", ...INS.B }),
    T({ "Transactiedatum": serial("2025-05-05"), "Transactie-ID": "Y4", "Transactietype": "Transactie", "Acties": "Koop 6 @ 20.00 EUR",
      "Boekingsbedrag": -122, "Valuta": "EUR", "Omrekeningskoers": 1, "Totale kosten": -2, ...E1 }));
  const r = S.parseSaxoSheets(sh, { fileName: "std.xlsx" });
  const tx = id => r.transactions.find(t => t.import_id.startsWith(`s:${id}|`));
  const y1 = tx("Y1");
  assert.equal(y1.type, "SELL"); assert.equal(y1.trade_date, "2026-09-11"); assert.equal(y1.asset, "EPSILON LICHT NV");
  assert.equal(y1.quantity, "10"); assert.equal(y1.price, "25"); assert.equal(y1.fees, "0"); assert.equal(y1.taxes, "0");
  assert.ok(r.warnings.some(w => w.includes("Epsilon Licht NV op 2026-09-11 heeft geen boeking")));
  const y2 = tx("Y2");
  assert.equal(y2.currency, "USD"); assert.equal(y2.fx_per_eur, M.D(1).div("0.9").round(10).toString());
  assert.ok(r.warnings.some(w => w.includes("Beta Corp.") && w.includes("omrekeningskoers van 2026-10-20")));
  assert.equal(r.skipped["Uitgevoerd zonder boeking (ingelezen zonder kosten)"], 2);
  // gekoppeld via ISIN en datum: kosten uit de boeking
  const y3 = tx("Y3");
  assert.equal(y3.type, "BUY"); assert.equal(y3.fees, "3");
  assert.ok(r.warnings.some(w => w.includes("boeking gevonden via ISIN en datum")));
  // boeking zonder uitvoering: aantal en prijs uit de omschrijving
  const z5 = tx("Z5");
  assert.equal(z5.type, "SELL"); assert.equal(z5.quantity, "3"); assert.equal(z5.price, "70"); assert.equal(z5.trade_date, "2026-10-20");
  assert.equal(z5.fees, M.D(3).mul(z5.fx_per_eur).round(2).toString()); assert.equal(z5.saxo_result, "25");
  assert.ok(r.warnings.some(w => w.includes("geen uitvoering in _Transacties")));
  const loose = r.cash.filter(c => c.description.startsWith("Transactie zonder aantal of prijs"));
  assert.equal(loose.length, 1); assert.equal(loose[0].kind, "ANDERE"); assert.equal(loose[0].status, "info");
  assert.equal(new Set(r.transactions.map(t => t.import_id)).size, r.transactions.length);
  // de rekenkern kan alles verwerken
  const rep = M.calculate(r.transactions, { "ALFA BOUW NV": "25", "GAMMA FOODS": "130", "EPSILON LICHT NV": "21", "BETA CORP.": "55" });
  assert.equal(rep.sales.find(s => s.asset === "EPSILON LICHT NV").result_eur.toFixed(2), "36.00"); // FIFO: 6 x (25 - 21) + 4 x (25 - 22)
});

test("oude export: uitgevoerde order zonder bedrag wordt ingelezen, een pending order niet", () => {
  const sh = sheets();
  sh.Transacties.splice(1, 0, row({ date: "2026-09-11", id: "T8", action: "Verkoop -5 @ 31.00 EUR", amount: null, costs: null,
    name: "*Delisted 20260729 (Geschrapt NV)", isin: "BE0000000003", oc: "To Close", qty: -5, price: 31 }));
  const r = S.parseSaxoSheets(sh);
  const t8 = r.transactions.find(t => t.import_id.startsWith("s:T8|"));
  assert.equal(t8.type, "SELL"); assert.equal(t8.quantity, "5"); assert.equal(t8.fees, "0");
  assert.equal(r.skipped["Niet (volledig) uitgevoerde orders"], 1); // de pending order
});

test("oude export: stortingen en andere geldbewegingen op hetzelfde blad", () => {
  const sh = sheets(), set = (r, k, v) => { r[H.indexOf(k)] = v; return r; };
  const cash = (date, type, action, amount) => {
    const r = row({ date, id: null, action, amount, costs: null, name: null, isin: null, qty: null, price: null });
    set(r, "Type", null); set(r, "Openen/sluiten", null); return set(r, "Transactietype", type);
  };
  sh.Transacties.push(cash("2025-01-02", "Storting/opname", "Storting", 2000), cash("2026-02-03", "Storting/opname", "Opname", -300),
    cash("2026-03-04", "Rente", "Debetrente", -1.25));
  const r = S.parseSaxoSheets(sh, { fileName: "oud.xlsx" });
  assert.deepEqual(r.cash.map(c => [c.kind, c.date, c.amount, c.status]).sort(),
    [["ANDERE", "2026-03-04", "-1.25", "info"], ["OPNAME", "2026-02-03", "-300", "info"], ["STORTING", "2025-01-02", "2000", "info"]]);
  assert.ok(r.cash.find(c => c.kind === "ANDERE").description.includes("Debetrente"));
  assert.ok(!Object.keys(r.skipped).some(k => k.startsWith("Type")));
});
