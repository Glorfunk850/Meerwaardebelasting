/* Minimale .xlsx-lezer: zip uitpakken (DecompressionStream) en werkbladen als rijen teruggeven.
 * Ondersteunt gedeelde teksten, inline teksten, getallen en booleans. Datums komen als Excel-serienummer (getal). */
(function (root) {
  "use strict";

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Geen geldig Excel-bestand (zip-structuur niet gevonden).");
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {}, dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Beschadigd Excel-bestand.");
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      const lNameLen = dv.getUint16(local + 26, true), lExtraLen = dv.getUint16(local + 28, true);
      const start = local + 30 + lNameLen + lExtraLen;
      files[name] = { method, data: u8.subarray(start, start + csize) };
      p += 46 + nameLen + extraLen + commLen;
    }
    return {
      names: Object.keys(files),
      async text(name) {
        const f = files[name];
        if (!f) return null;
        const raw = f.method === 0 ? f.data : f.method === 8 ? await inflateRaw(f.data) : null;
        if (!raw) throw new Error(`Niet-ondersteunde compressie in ${name}`);
        return dec.decode(raw);
      },
    };
  }

  const unesc = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e.toLowerCase()]
    ?? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const textOf = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unesc(m[1])).join("");
  const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

  /** -> { sheetName: [[cel, …], …] } */
  async function readXlsx(buf) {
    const z = await unzip(buf);
    const wb = await z.text("xl/workbook.xml");
    if (!wb) throw new Error("Geen Excel-werkmap gevonden.");
    const rels = (await z.text("xl/_rels/workbook.xml.rels")) || "";
    const relMap = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => {
      const id = /Id="([^"]+)"/.exec(m[0])[1], target = /Target="([^"]+)"/.exec(m[0])[1];
      return [id, target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "")];
    }));
    const ssXml = (await z.text("xl/sharedStrings.xml")) || "";
    const shared = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));
    const out = {};
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = unesc(/name="([^"]*)"/.exec(m[0])[1]);
      const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
      const xml = await z.text(relMap[rid] || "");
      if (!xml) continue;
      const rows = [];
      for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rNum = Number(/\br="(\d+)"/.exec(rm[0])?.[1] || rows.length + 1);
        const row = [];
        for (const cm of (rm[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cm[1], body = cm[2] || "";
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
          const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
          const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
          let val = null;
          if (t === "s") val = shared[Number(v)] ?? "";
          else if (t === "inlineStr") val = textOf(body);
          else if (t === "str") val = v != null ? unesc(v) : "";
          else if (t === "b") val = v === "1";
          else if (v != null) val = Number(v);
          row[ref ? colIndex(ref) : row.length] = val;
        }
        rows[rNum - 1] = row;
      }
      out[name] = Array.from(rows, r => r ? Array.from(r, c => c === undefined ? null : c) : []);
    }
    return out;
  }

  /** Excel-serienummer -> "JJJJ-MM-DD" */
  function excelDate(v) {
    if (typeof v === "string") { const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(v) || /^(\d\d)[-/](\d\d)[-/](\d{4})/.exec(v); return m ? (m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`) : null; }
    if (typeof v !== "number" || !isFinite(v)) return null;
    const d = new Date(Math.round((Math.floor(v) - 25569) * 864e5));
    return d.toISOString().slice(0, 10);
  }

  const api = { readXlsx, excelDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.XLSX_LITE = api;
})(typeof window !== "undefined" ? window : globalThis);
