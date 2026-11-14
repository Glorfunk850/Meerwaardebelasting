// node --test bolero.test.js   (synthetisch bestand in Bolero-formaat; optioneel: BOLERO_FILE=pad voor een echte export)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const M = require("./engine.js");
const B = require("./bolero.js");

const HDR = ",Datum transactie,,Valutadatum,,Transactie,,Type rekening,,Bedrag,,Munt,,Aantal,,Prijs,,Roerende voorheffing (EUR),,Munt,,Winst/verlies,,Meerwaardebelasting,,Munt";
const row = (d, desc, amt, ccy, q = "", p = "", rv = "", pl = "", mwb = "") =>
  `,${d},,${d},,${desc},,Cashrekening,,"${amt}",,${ccy},,${q},,"${p}",,"${rv}",,${rv ? "EUR" : ""},,"${pl}",,"${mwb}",,${pl ? "EUR" : ""}`;
// aflopend zoals Bolero
const SAMPLE = [
  ",,,,,,,,,,,,,,,,,,,,,,,,,", ",User-ID,,,,,,,,,,,,,,,,,,,,,,,,", HDR, ",,,,,,,,,,,,,,,,,,,,,,,,,",
  row("21/09/2026", "Verkoop Online VOORBEELD NV (PA)", "1.512,30", "EUR", "250", "6,10", "", "-600,00", "0"),
  row("18/08/2026", "Uitbetaling dividenden CP VOORBEELD NV (PA) 10.08.26", "62,50", "EUR", "250", "0,36", "26,79"),
  row("01/08/2026", "Overschrijving naar klant", "-1.200,00", "EUR"),
  row("05/03/2026", "Verkoop Online US CORP (NY)", "1.000,00", "EUR", "10", "110"),
  row("20/09/2025", "Wisseltransactie", "1.100,00", "USD"),
  row("20/09/2025", "Wisseltransactie", "-1.000,00", "EUR"),
  row("18/09/2025", "Aankoop Online US CORP (NY)", "-1.010,00", "USD", "10", "100"),
  row("09/01/2025", "Terugstorting", "4,90", "EUR"),
  row("09/01/2025", "Aankoop Online VOORBEELD NV (PA)", "-507,50", "EUR", "100", "5,00"),
  row("09/01/2025", "Aankoop Online VOORBEELD NV (PA)", "512,40", "EUR", "100", "5,00"),
  row("09/01/2025", "Aankoop Online VOORBEELD NV (PA)", "-512,40", "EUR", "100", "5,00"),
  row("06/05/2024", "Uitbetaling dividenden CP OUD NV (BR) 02.05.24", "35,00", "EUR", "50", "1,00", "15,00"),
  row("06/05/2024", "Uitbetaling dividenden CP OUD NV (BR) 02.05.24", "-35,00", "EUR", "50", "1,00", "15,00"),
  row("06/05/2024", "Uitbetaling dividenden CP OUD NV (BR) 02.05.24", "35,00", "EUR", "50", "1,00", "15,00"),
  row("02/02/2022", "Aankoop Online OUD NV (BR)", "-1.000,00", "EUR", "50", "19,90"),
  row("01/02/2021", "Aankoop Online VOORBEELD NV (PA)", "-1.500,00", "EUR", "150", "9,95"),
  row("01/02/2020", "Inschrijving VERDWENEN INC (NY)", "-500,00", "EUR", "100", "5,9"),
  row("01/02/2019", "Provisionering rekening klant", "5.000,00", "EUR"),
  ",,,,,,,,,,,,,,,,,,,,,,,,,",
  `,"Bolero is het execution-only beleggingsplatform
met een regel over twee lijnen",,,,`,
].join("\r\n");

test("csv parser handles quotes and multiline cells", () => {
  const rows = B.parseCsv('a,"b,c","d ""e""",\r\n"x\ny",z');
  assert.deepEqual(rows, [["a", "b,c", 'd "e"', ""], ["x\ny", "z"]]);
});

test("asset names normalised", () => {
  assert.deepEqual(B.assetName("PENNANTPARK FLOATING RATE CAPIT.(NY"), { id: "PENNANTPARK FLOATING RATE CAPIT. (NY)", exch: "NY" });
  assert.deepEqual(B.assetName("AEDIFICA GVV   (BR)"), { id: "AEDIFICA GVV (BR)", exch: "BR" });
  assert.equal(B.nameKey("CP AEDIFICA GVV   (BR) 14.05.26"), B.nameKey("AEDIFICA GVV   (BR)"));
});

test("parse sample export", () => {
  const r = B.parseBolero(SAMPLE, { owner: "ik", fileName: "s.csv" });
  const by = type => r.transactions.filter(t => t.type === type);
  // storno: van de drie Voorbeeld-aankopen op 09/01/2025 blijft er één over (507,50 = 500,00 + 7,50 kosten)
  const jan = by("BUY").filter(t => t.trade_date === "2025-01-09");
  assert.equal(jan.length, 1); assert.equal(jan[0].fees, "7.5");
  // dividendstorno: één van de twee
  assert.equal(by("DIVIDEND").filter(t => t.asset === "OUD NV (BR)").length, 1);
  // EUR-verkoop met Bolero-resultaat en kosten
  const s = by("SELL").find(t => t.asset === "VOORBEELD NV (PA)");
  assert.equal(s.price, "6.1"); assert.equal(s.fees, "12.7"); assert.equal(s.bolero_result, "-600"); assert.equal(s.currency, "EUR");
  // USD-aankoop met bedrag in USD: koers uit de wisseltransactie (1100/1000)
  const ub = by("BUY").find(t => t.asset === "US CORP (NY)");
  assert.equal(ub.currency, "USD"); assert.equal(ub.fx_per_eur, "1.1"); assert.equal(ub.fees, "10");
  // USD-verkoop met bedrag in EUR: koers geschat (1100 / 1000)
  const us = by("SELL").find(t => t.asset === "US CORP (NY)");
  assert.equal(us.fx_per_eur, "1.1"); assert.ok(us.note.includes("geschat"));
  // inschrijving telt als aankoop; historische prijs bewijsbaar voor aankopen vóór 2026
  assert.ok(by("BUY").some(t => t.asset === "VERDWENEN INC (NY)" && t.note.startsWith("inschrijving") && t.historic_proven));
  // overgeslagen geldbewegingen
  assert.equal(r.skipped["Wisseltransacties"], 2); assert.equal(r.skipped["Terugstortingen (kosten)"], 1);
  assert.equal(r.skipped["Geannuleerde boekingen (storno)"], 4);
  // fotowaarde afgeleid uit Bolero: (250 x 6,10 + 600) / 250 = 8,50
  assert.equal(r.refHints["VOORBEELD NV (PA)"].value, "8.5");
  // posities op 31/12/2025: Voorbeeld 150+100, Oud 50, US Corp 10, Verdwenen 100 (geen dividend -> verdacht)
  const pos = Object.fromEntries(r.positions.map(p => [p.asset, p]));
  assert.equal(pos["VOORBEELD NV (PA)"].quantity, "250"); assert.equal(pos["VOORBEELD NV (PA)"].suspicious, false);
  assert.equal(pos["VERDWENEN INC (NY)"].suspicious, true);
  assert.equal(pos["OUD NV (BR)"].suspicious, true); // laatste dividend 2024-05 en geen activiteit in 2026
  assert.equal(pos["US CORP (NY)"].suspicious, false); // verkocht in 2026
  // import-ids stabiel bij herimport
  const r2 = B.parseBolero(SAMPLE, { owner: "ik", fileName: "s.csv" });
  assert.deepEqual(r.transactions.map(t => t.import_id), r2.transactions.map(t => t.import_id));
  assert.equal(new Set(r.transactions.map(t => t.import_id)).size, r.transactions.length);
});

test("imported transactions run through the engine and match Bolero", () => {
  const r = B.parseBolero(SAMPLE, { owner: "ik" });
  const refs = { "VOORBEELD NV (PA)": r.refHints["VOORBEELD NV (PA)"].value, "US CORP (NY)": "95" };
  const rep = M.calculate(r.transactions, refs);
  const s = rep.sales.find(x => x.asset === "VOORBEELD NV (PA)");
  assert.equal(s.result_eur.toFixed(2), "-600.00");
});

test("rejects other files", () => {
  assert.throws(() => B.parseBolero("a,b,c\n1,2,3"), /Datum transactie/);
});

test("real export (optional)", { skip: !process.env.BOLERO_FILE }, () => {
  const r = B.parseBolero(fs.readFileSync(process.env.BOLERO_FILE, "utf8"));
  assert.ok(r.transactions.length > 0);
  const rep = M.calculate(r.transactions, Object.fromEntries(Object.entries(r.refHints).map(([k, v]) => [k, v.value])));
  for (const t of r.transactions.filter(t => t.type === "SELL" && t.bolero_result != null)) {
    const s = rep.sales.find(x => x.asset === t.asset && x.trade_date === t.trade_date);
    assert.equal(s.result_eur.toFixed(2), D2(t.bolero_result), `${t.asset} ${t.trade_date}`);
  }
  function D2(v) { return M.D(v).toFixed(2); }
});
