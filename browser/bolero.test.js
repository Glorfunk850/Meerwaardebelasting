// node --test bolero.test.js   (synthetisch bestand in Bolero-formaat; optioneel: BOLERO_FILE=pad voor een echte export, CSV of Excel)
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

// Excel-export: dezelfde kolommen, maar datums als serienummer (12u) en bedragen als getal
const serial = dmy => Date.UTC(+dmy.slice(6, 10), +dmy.slice(3, 5) - 1, +dmy.slice(0, 2)) / 864e5 + 25569 + 0.5;
function sampleAsSheet() {
  const rows = B.parseCsv(SAMPLE);
  const h = rows.find(r => r.includes("Datum transactie"));
  const numCols = ["Bedrag", "Aantal", "Prijs", "Roerende voorheffing (EUR)", "Winst/verlies", "Meerwaardebelasting"].map(k => h.indexOf(k));
  const dateCols = [h.indexOf("Datum transactie"), h.indexOf("Valutadatum")];
  return rows.map(r => r === h ? r : r.map((c, j) => c === "" ? null
    : dateCols.includes(j) && /^\d\d\/\d\d\/\d{4}$/.test(c) ? serial(c)
    : numCols.includes(j) && /^-?[\d.]+(,\d+)?$/.test(c) ? Number(c.replace(/\./g, "").replace(",", ".")) : c));
}

test("Belgische getalnotatie zoals in de CSV", () => {
  assert.equal(B.beNum(1601.95, true), "1.601,95"); assert.equal(B.beNum(-1200, true), "-1.200,00");
  assert.equal(B.beNum(5.21), "5,21"); assert.equal(B.beNum(310), "310"); assert.equal(B.beNum(-959.45), "-959,45");
});

test("Excel-export geeft dezelfde transacties als de CSV", () => {
  const csv = B.parseBolero(SAMPLE, { owner: "ik", fileName: "s.csv" });
  const xl = B.parseBoleroSheets({ Sheet0: sampleAsSheet() }, { owner: "ik", fileName: "s.xlsx" });
  const strip = t => { const { import_id, import_source, ...rest } = t; return rest; };
  assert.deepEqual(xl.transactions.map(strip), csv.transactions.map(strip));
  assert.deepEqual(xl.skipped, csv.skipped);
  assert.equal(xl.positions.length, csv.positions.length);
  // zelfs waar de tekst van de getallen verschilt ("6,10" tegenover 6.1) herkent de import ze als dezelfde
  assert.deepEqual(B.duplicateFlags(csv.transactions, xl.transactions), xl.transactions.map(() => true));
  assert.equal(B.parseBoleroSheets({ Blad1: [["a"], [1]] }), null);
});

test("dubbels: op import-id en voor Bolero op inhoud, met aantallen", () => {
  const t = { type: "BUY", trade_date: "2026-02-03", asset: "X (BR)", quantity: "10", price: "5.00", amount: "0", import_id: "b:1" };
  const existing = [t, { ...t, import_id: "b:2" }];
  // twee gelijke aankopen al aanwezig; drie binnenkomend (andere id's) -> de derde is nieuw
  assert.deepEqual(B.duplicateFlags(existing, [{ ...t, import_id: "b:7" }, { ...t, price: "5", import_id: "b:8" }, { ...t, import_id: "b:9" }]), [true, true, false]);
  // id-overeenkomst verbruikt de inhoudsovereenkomst
  assert.deepEqual(B.duplicateFlags(existing, [{ ...t, import_id: "b:9" }, t, { ...t, import_id: "b:2" }]), [false, true, true]);
  // Saxo enkel op id
  assert.deepEqual(B.duplicateFlags([{ ...t, import_id: "s:1|1" }], [{ ...t, import_id: "s:2|1" }]), [false]);
});

test("waarschuwing als de export niet alle aankopen bevat", () => {
  const rows = B.parseCsv(SAMPLE).filter(r => !/Aankoop Online US CORP/.test(r.join()));
  const r = B.parseBoleroRows(rows, { fileName: "kort.csv" });
  assert.ok(/niet alle aankopen voor: US CORP \(NY\)/.test(r.warnings[0]));
  assert.deepEqual(r.period, ["2019-02-01", "2026-09-21"]); assert.deepEqual(r.incomplete, ["US CORP (NY)"]);
  assert.ok(!B.parseBolero(SAMPLE).warnings.some(w => w.includes("niet alle aankopen")));
});

test("real export (optional)", { skip: !process.env.BOLERO_FILE }, async () => {
  const file = fs.readFileSync(process.env.BOLERO_FILE);
  const r = file[0] === 0x50 && file[1] === 0x4b
    ? B.parseBoleroSheets(await require("./xlsx.js").readXlsx(file))
    : B.parseBolero(file.toString("utf8"));
  assert.ok(r.transactions.length > 0);
  const rep = M.calculate(r.transactions, Object.fromEntries(Object.entries(r.refHints).map(([k, v]) => [k, v.value])));
  // enkel verkopen waarvan de aankopen in de export staan
  for (const t of r.transactions.filter(t => t.type === "SELL" && t.bolero_result != null && !r.incomplete.includes(t.asset))) {
    const s = rep.sales.find(x => x.asset === t.asset && x.trade_date === t.trade_date);
    assert.equal(s.result_eur.toFixed(2), D2(t.bolero_result), `${t.asset} ${t.trade_date}`);
  }
  function D2(v) { return M.D(v).toFixed(2); }
});
