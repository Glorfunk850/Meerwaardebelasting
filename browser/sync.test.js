// node --test sync.test.js   (synchroniseren: koppelcode, versleuteling en samenvoegen; verzonnen gegevens)
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./sync.js");

const tx = (id, extra = {}) => ({ id, type: "BUY", trade_date: "2026-03-01", asset: "VOORBEELD NV", quantity: "10", price: "50", owner: "ik", ...extra });
const staat = (extra = {}) => ({ version: 1, nextId: 1, transactions: [], cash: [], assets: {}, withheld: [],
  years: { 2026: { rate: "0.10", base_exemption: "10000" } }, settings: { historic_method: "FIFO", fifo_scope: "EIGENAAR" }, ...extra });

test("koppelcode: 32 tekens heen en terug, ook slordig getypt", () => {
  const code = S.nieuweCode();
  assert.equal(code.length, 32);
  assert.deepEqual(S.codeBytes(code), S.codeBytes(code.toLowerCase()));
  const netjes = S.codeNetjes(code);
  assert.match(netjes, /^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  assert.equal(S.naarCode(S.codeBytes(netjes)), code);
  assert.deepEqual(S.codeBytes(code.replace(/0/g, "O")), S.codeBytes(code));
  assert.equal(S.codeBytes("te kort"), null);
  assert.equal(S.codeBytes("U".repeat(32)), null); // U zit niet in het alfabet
});

test("sleutels: vast per code, eigen ruimte per code", async () => {
  const code = S.nieuweCode();
  const a = await S.sleutels(code), b = await S.sleutels(S.codeNetjes(code)), c = await S.sleutels(S.nieuweCode());
  assert.match(a.ruimte, /^[0-9a-f]{32}$/); // zoals de server verwacht
  assert.equal(a.ruimte, b.ruimte);
  assert.equal(a.token, b.token);
  assert.notEqual(a.ruimte, c.ruimte);
  assert.ok(a.token.length >= 40);
  await assert.rejects(S.sleutels("fout"), /32 tekens/);
});

test("versleutelen en ontsleutelen; andere code of beschadigd pakket faalt", async () => {
  const code = S.nieuweCode(), k = await S.sleutels(code);
  const s = staat({ transactions: [tx(1, { price: "12.3456" })] });
  const pakket = await S.versleutelen(s, k);
  assert.equal(pakket[0], 77);
  assert.ok(!Buffer.from(pakket).toString("latin1").includes("VOORBEELD")); // niet leesbaar op de server
  assert.deepEqual(await S.ontsleutelen(pakket, k), s);
  await assert.rejects(S.ontsleutelen(pakket, await S.sleutels(S.nieuweCode())), /ontsleuteld/);
  const kapot = pakket.slice(); kapot[kapot.length - 1] ^= 1;
  await assert.rejects(S.ontsleutelen(kapot, k), /ontsleuteld/);
  const vreemd = pakket.slice(); vreemd[0] = 86;
  await assert.rejects(S.ontsleutelen(vreemd, k), /niet van deze tool/);
});

test("samenvoegen: transacties van beide toestellen blijven", () => {
  const basis = staat({ transactions: [tx(1)], nextId: 2 });
  const lokaal = staat({ transactions: [tx(1), tx(5, { asset: "LOKAAL NV" })], nextId: 6 });
  const extern = staat({ transactions: [tx(1), tx(9, { asset: "EXTERN NV" })], nextId: 10 });
  const m = S.samenvoegen(basis, lokaal, extern);
  assert.deepEqual(m.transactions.map(t => t.id), [1, 9, 5]);
  assert.equal(m.nextId, 10);
});

test("samenvoegen: alle toestellen komen op dezelfde volgorde uit (telt bij transacties op dezelfde dag)", () => {
  const basis = staat({ transactions: [tx(1), tx(2)] });
  const a = staat({ transactions: [tx(1), tx(2), tx(10, { type: "SELL" })] }); // toestel A verkoopt
  const b = staat({ transactions: [tx(2), tx(1), tx(20)] }); // toestel B, andere volgorde, koopt
  const server1 = S.samenvoegen(basis, a, b); // A haalt de versie van B op en stuurt het resultaat
  const opB = S.samenvoegen(b, b, server1); // B haalt dat op
  assert.deepEqual(server1.transactions.map(t => t.id), [2, 1, 20, 10]);
  assert.deepEqual(opB.transactions.map(t => t.id), server1.transactions.map(t => t.id));
});

test("samenvoegen: wissen en wijzigen", () => {
  const basis = staat({ transactions: [tx(1), tx(2), tx(3)] });
  // lokaal 1 gewist; extern 2 gewist en 3 gewijzigd
  const lokaal = staat({ transactions: [tx(2), tx(3)] });
  const extern = staat({ transactions: [tx(1), tx(3, { quantity: "20" })] });
  assert.deepEqual(S.samenvoegen(basis, lokaal, extern).transactions, [tx(3, { quantity: "20" })]);
  // lokaal gewist, extern gewijzigd: de wijziging blijft (niets gaat verloren)
  const m = S.samenvoegen(basis, staat({ transactions: [tx(2), tx(3)] }), staat({ transactions: [tx(1, { price: "60" }), tx(2), tx(3)] }));
  assert.deepEqual(m.transactions.map(t => t.id), [1, 2, 3]);
  assert.equal(m.transactions[0].price, "60");
});

test("samenvoegen: zelfde transactie aan beide kanten, ander veld → beide wijzigingen", () => {
  const basis = staat({ transactions: [tx(1)] });
  const m = S.samenvoegen(basis, staat({ transactions: [tx(1, { price: "51" })] }), staat({ transactions: [tx(1, { broker: "Saxo" })] }));
  assert.deepEqual(m.transactions, [tx(1, { price: "51", broker: "Saxo" })]);
  // zelfde veld: dit toestel wint
  const n = S.samenvoegen(basis, staat({ transactions: [tx(1, { price: "51" })] }), staat({ transactions: [tx(1, { price: "52" })] }));
  assert.equal(n.transactions[0].price, "51");
});

test("samenvoegen: activa, jaren, instellingen en ingehouden bedragen per sleutel", () => {
  const a = { name: "", asset_type: "aandeel", currency: "EUR", ref_value_eur: null, ref_source: "" };
  const basis = staat({ assets: { "VOORBEELD NV": a }, withheld: [{ owner: "ik", year: 2026, amount: "100" }] });
  const lokaal = staat({ assets: { "VOORBEELD NV": { ...a, ref_value_eur: "80" } }, withheld: [{ owner: "ik", year: 2026, amount: "150" }],
    settings: { historic_method: "GEMIDDELD", fifo_scope: "EIGENAAR" } });
  const extern = staat({ assets: { "VOORBEELD NV": { ...a, isin: "BE0000000000" }, "ANDER NV": a },
    withheld: [{ owner: "ik", year: 2026, amount: "100" }, { owner: "partner", year: 2026, amount: "40" }],
    years: { 2026: { rate: "0.10", base_exemption: "10000" }, 2027: { rate: "0.10", base_exemption: "10100" } },
    settings: { historic_method: "FIFO", fifo_scope: "BROKER" } });
  const m = S.samenvoegen(basis, lokaal, extern);
  assert.deepEqual(m.assets, { "VOORBEELD NV": { ...a, ref_value_eur: "80", isin: "BE0000000000" }, "ANDER NV": a });
  assert.deepEqual(m.withheld, [{ owner: "ik", year: 2026, amount: "150" }, { owner: "partner", year: 2026, amount: "40" }]);
  assert.deepEqual(Object.keys(m.assets).sort(), ["ANDER NV", "VOORBEELD NV"]);
  assert.deepEqual(Object.keys(m.years), ["2026", "2027"]);
  assert.deepEqual(m.settings, { historic_method: "GEMIDDELD", fifo_scope: "BROKER" });
});

test("samenvoegen zonder basis: alles van beide kanten", () => {
  const m = S.samenvoegen(null, staat({ transactions: [tx(1)], cash: [{ id: 2, kind: "STORTING" }] }), staat({ transactions: [tx(3)] }));
  assert.deepEqual(m.transactions.map(t => t.id), [3, 1]);
  assert.deepEqual(m.cash, [{ id: 2, kind: "STORTING" }]);
});

test("nieuwe id's: doortellen zonder synchronisatie, uniek op tijd met synchronisatie", () => {
  const s = staat({ nextId: 7 });
  assert.equal(S.nieuwId(s, false), 7);
  assert.equal(s.nextId, 8);
  const nu = 1_790_000_000_000;
  const a = S.nieuwId(s, true, nu), b = S.nieuwId(s, true, nu);
  assert.ok(a >= nu * 1000 && b > a && Number.isSafeInteger(b));
  const herdoopt = S.nieuweIds(staat({ transactions: [tx(1), tx(2)], cash: [{ id: 3 }] }), (() => { let i = 100; return () => i++; })());
  assert.deepEqual([...herdoopt.transactions.map(t => t.id), ...herdoopt.cash.map(c => c.id)], [100, 101, 102]);
  assert.deepEqual(S.telling(herdoopt), { transacties: 2, geldbewegingen: 1 });
});
