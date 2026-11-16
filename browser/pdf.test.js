"use strict";
const test = require("node:test");
const assert = require("node:assert");
const P = require("./pdf.js");

const ascii = b => String.fromCharCode(...b);

test("tekens naar Windows-1252: euro, accenten, onbekend wordt '?'", () => {
  assert.deepStrictEqual(P.encode("€ é–ü"), [0x80, 0x20, 0xE9, 0x96, 0xFC]);
  assert.deepStrictEqual(P.encode("a b≠"), [0x61, 0x20, 0x62, 0x3F]);
});

test("breedte en afbreken van regels", () => {
  assert.strictEqual(P.width("ii", "F1", 10), 4.44);
  assert.ok(P.width("W", "F2", 10) > P.width("i", "F2", 10));
  const lines = P.wrap("een twee drie vier vijf zes zeven acht", "F1", 10, 60);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(P.width(l, "F1", 10) <= 60, l);
  assert.strictEqual(lines.join(" "), "een twee drie vier vijf zes zeven acht");
  assert.deepStrictEqual(P.wrap("a\nb", "F1", 10, 100), ["a", "b"]);
  for (const l of P.wrap("x".repeat(80), "F1", 10, 50)) assert.ok(P.width(l, "F1", 10) <= 50);
});

test("geldig PDF-bestand met correcte xref", () => {
  const bytes = P.build({ title: "Test (rapport)", date: "2026-11-16T10:00:00Z", blocks: [
    { type: "h1", text: "Rapport € 1.234,56" },
    { type: "kv", rows: [{ label: "Netto", value: "€ 10,00", bold: true }, { label: "Belasting", value: "€ 1,00", sep: true }] },
    { type: "note", tone: "warn", text: "Let op" },
    { type: "table", cols: [{ title: "A", width: 0.5 }, { title: "B", width: 0.5, align: "right" }], rows: [["x", { text: "1", color: "pos" }]] },
  ] });
  const s = ascii(bytes);
  assert.ok(s.startsWith("%PDF-1.4\n") && s.endsWith("%%EOF\n"));
  assert.ok(bytes.every(b => b < 0x80), "enkel ASCII");
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(xref).startsWith("xref\n"));
  const entries = s.slice(xref).split("\n").slice(2).filter(l => / \d{5} n $/.test(l));
  entries.forEach((e, i) => assert.ok(s.slice(Number(e.slice(0, 10))).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index + m[0].length;
    assert.strictEqual(s.slice(start + Number(m[1]), start + Number(m[1]) + 10), "\nendstream");
  }
  assert.ok(s.includes("(Rapport \\200 1.234,56) Tj"));
  assert.ok(s.includes("/Title (Test \\(rapport\\))"));
  assert.ok(s.includes("/CreationDate (D:20261116100000)"));
  assert.ok(s.includes("(Pagina 1 / 1) Tj"));
});

test("lange tabel loopt over meerdere pagina's met herhaalde kop", () => {
  const rows = Array.from({ length: 200 }, (_, i) => [`rij ${i}`, String(i)]);
  const s = ascii(P.build({ title: "T", blocks: [{ type: "table", cols: [{ title: "Kolomkop", width: 0.7 }, { title: "Nr", width: 0.3, align: "right" }], rows }] }));
  const pages = Number(/\/Count (\d+)/.exec(s)[1]);
  assert.ok(pages >= 3, `pagina's: ${pages}`);
  assert.strictEqual(s.split("(Kolomkop) Tj").length - 1, pages);
  assert.ok(s.includes(`(Pagina ${pages} / ${pages}) Tj`));
  assert.ok(s.includes("(rij 199) Tj"));
});
