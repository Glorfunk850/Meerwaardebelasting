"use strict";
const test = require("node:test");
const assert = require("node:assert");
const B = require("./bewijs.js");

test("inhoudstype volgens extensie, ook bij leeg of afwijkend browsertype", () => {
  assert.strictEqual(B.contentType("Afrekening.PDF", ""), "application/pdf");
  assert.strictEqual(B.contentType("foto.jpeg", "image/jpeg"), "image/jpeg");
  assert.strictEqual(B.contentType("lijst.csv", "application/vnd.ms-excel"), "text/csv");
  assert.strictEqual(B.contentType("scan", "image/png"), "image/png");
  assert.strictEqual(B.contentType("brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), null);
  assert.strictEqual(B.contentType("x.html", "text/html"), null);
});

test("controle van bestanden", () => {
  assert.strictEqual(B.checkFile("a.pdf", "application/pdf", 1000), null);
  assert.match(B.checkFile("a.docx", "", 1000), /bestandstype/);
  assert.match(B.checkFile("a.pdf", "", 0), /leeg/);
  assert.match(B.checkFile("a.pdf", "", B.MAX_BYTES + 1), /20 MB/);
});

test("grootte leesbaar", () => {
  assert.strictEqual(B.sizeLabel(500), "500 B");
  assert.strictEqual(B.sizeLabel(2048), "2 kB");
  assert.strictEqual(B.sizeLabel(1572864), "1,5 MB");
});

test("ontbrekende bewijzen: verwervingen in bezit en belastbare verkopen", () => {
  const tx = [
    { id: 1, type: "BUY", owner: "ik", asset: "ACME", trade_date: "2024-03-01" },
    { id: 2, type: "BUY", owner: "ik", asset: "ACME", trade_date: "2024-05-01", attachments: [{ id: "a1" }] },
    { id: 3, type: "BUY", owner: "ik", asset: "OUD", trade_date: "2020-01-01" },
    { id: 4, type: "SELL", owner: "ik", asset: "OUD", trade_date: "2025-06-01" },
    { id: 5, type: "SELL", owner: "ik", asset: "WEG", trade_date: "2026-02-01" },
    { id: 6, type: "DIVIDEND", owner: "ik", asset: "ACME", trade_date: "2026-02-01" },
    { id: 7, type: "BUY", owner: "partner", asset: "ACME", trade_date: "2024-03-01" },
    { id: 8, type: "GIFT_IN", owner: "ik", asset: "ACME", trade_date: "2019-03-01" },
  ];
  const held = new Set(["ik\u0000ACME"]);
  assert.deepStrictEqual(B.missingProof(tx, held).map(t => t.id), [1, 5, 8]);
});

test("verwijderde en gebruikte bijlagen", () => {
  const before = [{ id: "a" }, { id: "b" }], after = [{ id: "b" }, { id: "c" }];
  assert.deepStrictEqual(B.removedAttachments(before, after).map(a => a.id), ["a"]);
  assert.deepStrictEqual(B.removedAttachments(undefined, after), []);
  assert.deepStrictEqual([...B.usedIds([{ attachments: [{ id: "x" }] }, {}])], ["x"]);
});

test("base64 heen en terug, ook groot en binair", () => {
  const bytes = new Uint8Array(100000).map((_, i) => (i * 37) % 256);
  const b64 = B.toBase64(bytes);
  assert.strictEqual(b64, Buffer.from(bytes).toString("base64"));
  assert.deepStrictEqual(B.fromBase64(b64), bytes);
});

test("back-up: bijlagen verzamelen, splitsen en herkoppelen", () => {
  const tx = [{ attachments: [{ id: "a", name: "x.pdf" }, { id: "b", name: "y.png" }] }, { attachments: [{ id: "a", name: "x.pdf" }] }, {}];
  assert.deepStrictEqual(B.allAttachments(tx).map(a => a.id), ["a", "b"]);
  const { state, files } = B.splitBackup({ transactions: tx, proof_files: { a: { data: "QQ==" } } });
  assert.strictEqual(state.proof_files, undefined);
  assert.deepStrictEqual(Object.keys(files), ["a"]);
  assert.deepStrictEqual(B.splitBackup({ transactions: [] }).files, {});
  const n = B.remapAttachments(tx, new Map([["a", { id: "n1", store: "account" }]]));
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(tx[0].attachments[0], { id: "n1", name: "x.pdf", store: "account" });
  assert.strictEqual(tx[0].attachments[1].id, "b");
});
