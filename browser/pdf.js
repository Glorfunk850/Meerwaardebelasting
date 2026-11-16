"use strict";
/*
 * Minimale PDF-generator zonder externe bibliotheek (voor het rapport als PDF).
 * Gebruikt de standaardlettertypes Helvetica en Helvetica-Bold met WinAnsiEncoding (Windows-1252): € en de
 * gangbare accenten werken, andere tekens worden '?'. A4, staand. Het document is een lijst blokken:
 *   { type: "h1" | "h2" | "h3", text }            titel (h2/h3 blijven bij het volgende blok)
 *   { type: "p", text, size?, color?, bold? }       alinea, automatisch afgebroken
 *   { type: "note", text, tone: "warn"|"ok"|"error" } tekst in een gekleurd kader
 *   { type: "kv", rows: [{ label, value, bold?, color?, sep? }] }  label links, waarde rechts
 *   { type: "table", cols: [{ title, width, align? }], rows: [[cel, ...]] }  width = aandeel (som 1);
 *       een cel is tekst of { text, color?, bold? }; de kop herhaalt na een paginawissel
 *   { type: "space", h? }
 * build({ title, footer?, blocks, date? }) geeft een Uint8Array met het PDF-bestand.
 */
(function (root) {
  // Breedtes (1/1000 em) van de tekens 32..255 in WinAnsiEncoding (Adobe Core14 AFM).
  const WIDTHS = {
    F1: "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,761,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500",
    F2: "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,761,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556",
  };
  for (const k in WIDTHS) WIDTHS[k] = WIDTHS[k].split(",").map(Number);
  // Unicode -> Windows-1252 voor de tekens in 0x80..0x9F
  const CP1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
    0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
    0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A,
    0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
  const SPACES = new Set([0x09, 0x0A, 0x0D, 0x2002, 0x2003, 0x2007, 0x2009, 0x200A, 0x202F]);

  /** Tekst als lijst tekencodes in Windows-1252 (onbekend -> '?'). */
  function encode(s) {
    const out = [];
    for (const ch of String(s ?? "")) {
      const c = ch.codePointAt(0);
      if (SPACES.has(c)) out.push(0x20);
      else if ((c >= 0x20 && c < 0x7F) || (c >= 0xA0 && c <= 0xFF)) out.push(c);
      else if (CP1252[c]) out.push(CP1252[c]);
      else if (c === 0x2212) out.push(0x2D); // minteken
      else if (c === 0x2264 || c === 0x2265) out.push(c === 0x2264 ? 0x3C : 0x3E);
      else out.push(0x3F);
    }
    return out;
  }
  function width(s, font, size) {
    const w = WIDTHS[font];
    return encode(s).reduce((t, c) => t + (w[c - 32] || 556), 0) * size / 1000;
  }
  /** Breekt tekst af op spaties (en harde regeleinden) zodat elke regel binnen maxW past. */
  function wrap(s, font, size, maxW) {
    const lines = [];
    for (const para of String(s ?? "").split("\n")) {
      let line = "";
      for (const word of para.split(/ +/)) {
        const cand = line ? line + " " + word : word;
        if (width(cand, font, size) <= maxW) { line = cand; continue; }
        if (line) lines.push(line);
        line = word;
        while (width(line, font, size) > maxW && line.length > 1) { // te lang woord: hard afbreken
          let n = line.length - 1;
          while (n > 1 && width(line.slice(0, n), font, size) > maxW) n--;
          lines.push(line.slice(0, n)); line = line.slice(n);
        }
      }
      lines.push(line);
    }
    return lines;
  }
  function pdfString(s) {
    return "(" + encode(s).map(c => c === 0x28 || c === 0x29 || c === 0x5C ? "\\" + String.fromCharCode(c)
      : c < 0x80 ? String.fromCharCode(c) : "\\" + c.toString(8).padStart(3, "0")).join("") + ")";
  }

  const COLORS = {
    ink: [0.106, 0.141, 0.188], muted: [0.365, 0.412, 0.471], accent: [0.122, 0.373, 0.545],
    pos: [0.078, 0.424, 0.263], neg: [0.69, 0.165, 0.216], line: [0.886, 0.902, 0.922], head: [0.957, 0.965, 0.973],
    warnBg: [1, 0.965, 0.878], warn: [0.49, 0.325, 0], okBg: [0.91, 0.957, 0.933], errorBg: [0.992, 0.925, 0.933],
  };
  const NOTE = { warn: ["warnBg", "warn"], ok: ["okBg", "pos"], error: ["errorBg", "neg"] };
  const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 42, BOTTOM = 52;
  const f = n => (Math.round(n * 100) / 100).toString();
  const rgb = (c, op) => `${(COLORS[c] || COLORS.ink).map(f).join(" ")} ${op}`;

  function build({ title = "", footer = "", blocks = [], date = null }) {
    const pages = [];
    let ops = null, y = 0;
    const contentW = PAGE_W - 2 * MARGIN;
    function newPage() { ops = []; pages.push(ops); y = PAGE_H - MARGIN; }
    function ensure(h) { if (!ops || y - h < BOTTOM) newPage(); }
    function text(x, yy, s, { font = "F1", size = 9, color = "ink" } = {}) {
      ops.push(`BT /${font} ${f(size)} Tf ${rgb(color, "rg")} ${f(x)} ${f(yy)} Td ${pdfString(s)} Tj ET`);
    }
    function textAligned(x, w, yy, s, opt, align) {
      const tw = width(s, opt.font || "F1", opt.size || 9);
      text(align === "right" ? x + w - tw : x, yy, s, opt);
    }
    function rect(x, yy, w, h, color) { ops.push(`${rgb(color, "rg")} ${f(x)} ${f(yy)} ${f(w)} ${f(h)} re f`); }
    function hline(x1, x2, yy, color = "line", lw = 0.6) { ops.push(`${rgb(color, "RG")} ${f(lw)} w ${f(x1)} ${f(yy)} m ${f(x2)} ${f(yy)} l S`); }

    function lines(ls, { font = "F1", size = 9, color = "ink", lead = 1.3, x = MARGIN } = {}) {
      for (const l of ls) { ensure(size * lead); y -= size * lead; text(x, y + size * 0.25, l, { font, size, color }); }
    }
    // blokhoogte voor "titel bij volgend blok houden"
    function firstHeight(b) {
      if (!b) return 0;
      if (b.type === "table") return 40;
      if (b.type === "kv") return 30;
      if (b.type === "note") return 30;
      return 20;
    }

    newPage();
    blocks.forEach((b, i) => {
      if (b.type === "h1") {
        lines(wrap(b.text, "F2", 17, contentW), { font: "F2", size: 17, color: "accent", lead: 1.25 });
        y -= 4;
      } else if (b.type === "h2" || b.type === "h3") {
        const size = b.type === "h2" ? 13 : 10.5, before = b.type === "h2" ? 14 : 9;
        const ls = wrap(b.text, "F2", size, contentW);
        const h = before + ls.length * size * 1.3 + firstHeight(blocks[i + 1]);
        if (y !== PAGE_H - MARGIN) { if (y - h < BOTTOM) newPage(); else y -= before; }
        lines(ls, { font: "F2", size, color: b.type === "h2" ? "accent" : "ink" });
        if (b.type === "h2") { y -= 3; hline(MARGIN, PAGE_W - MARGIN, y, "line", 0.8); }
        y -= 3;
      } else if (b.type === "p") {
        const size = b.size || 9, font = b.bold ? "F2" : "F1";
        lines(wrap(b.text, font, size, contentW), { font, size, color: b.color || "ink" });
        y -= 3;
      } else if (b.type === "space") {
        y -= b.h || 8;
      } else if (b.type === "note") {
        const size = 8.5, pad = 6, [bg, fg] = NOTE[b.tone] || NOTE.warn;
        const ls = wrap(b.text, "F1", size, contentW - 2 * pad);
        const h = ls.length * size * 1.3 + 2 * pad;
        if (h > PAGE_H - MARGIN - BOTTOM) { lines(ls, { size, color: fg }); y -= 4; return; }
        ensure(h + 4); y -= 2;
        rect(MARGIN, y - h, contentW, h, bg);
        let ly = y - pad;
        for (const l of ls) { ly -= size * 1.3; text(MARGIN + pad, ly + size * 0.25, l, { size, color: fg }); }
        y -= h + 5;
      } else if (b.type === "kv") {
        const size = 9, w = Math.min(contentW, 330), lead = size * 1.45;
        for (const r of b.rows) {
          if (r.sep) { ensure(6); y -= 3; hline(MARGIN, MARGIN + w, y); y -= 2; }
          const font = r.bold ? "F2" : "F1";
          const ls = wrap(r.label, font, size, w * 0.62);
          ensure(ls.length * lead);
          ls.forEach((l, j) => text(MARGIN, y - lead * (j + 1) + size * 0.3, l, { font, size, color: r.bold ? "ink" : "muted" }));
          textAligned(MARGIN, w, y - lead + size * 0.3, r.value, { font, size, color: r.color || "ink" }, "right");
          y -= ls.length * lead;
        }
        y -= 5;
      } else if (b.type === "table") {
        const size = b.size || 7.8, pad = 3, lead = size * 1.25;
        const xs = []; let acc = MARGIN;
        const ws = b.cols.map(c => c.width * contentW);
        ws.forEach(w => { xs.push(acc); acc += w; });
        const cellLines = (cell, j, font) => wrap(cell, font, size, ws[j] - 2 * pad);
        const head = b.cols.map((c, j) => cellLines(c.title, j, "F2"));
        const headH = Math.max(...head.map(l => l.length)) * lead + 2 * pad;
        function drawRow(cells, h, { font = "F1", color = null, bg = null } = {}) {
          if (bg) rect(MARGIN, y - h, contentW, h, bg);
          cells.forEach((c, j) => c.lines.forEach((l, k) => textAligned(xs[j] + pad, ws[j] - 2 * pad, y - pad - lead * (k + 1) + size * 0.3, l,
            { font: c.bold ? "F2" : font, size, color: c.color || color || "ink" }, b.cols[j].align)));
          y -= h;
          hline(MARGIN, PAGE_W - MARGIN, y, "line", 0.5);
        }
        const header = () => drawRow(head.map(l => ({ lines: l })), headH, { font: "F2", color: "muted", bg: "head" });
        ensure(headH + lead + 2 * pad); y -= 2; header();
        for (const row of b.rows) {
          const cells = row.map((c, j) => {
            const o = c && typeof c === "object" ? c : { text: c };
            return { ...o, lines: cellLines(o.text ?? "", j, o.bold ? "F2" : "F1") };
          });
          const h = Math.max(...cells.map(c => c.lines.length)) * lead + 2 * pad;
          if (y - h < BOTTOM) { newPage(); header(); }
          drawRow(cells, h);
        }
        y -= 7;
      }
    });

    // voettekst met paginanummers
    pages.forEach((p, i) => {
      ops = p;
      hline(MARGIN, PAGE_W - MARGIN, 36, "line", 0.5);
      text(MARGIN, 24, footer || title, { size: 7.5, color: "muted" });
      textAligned(MARGIN, contentW, 24, `Pagina ${i + 1} / ${pages.length}`, { size: 7.5, color: "muted" }, "right");
    });

    // PDF samenstellen (enkel ASCII, zodat tekenposities = byteposities)
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesId = add(null);
    const font = name => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
    const f1 = font("Helvetica"), f2 = font("Helvetica-Bold");
    const kids = pages.map(p => {
      const stream = p.join("\n");
      const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f(PAGE_W)} ${f(PAGE_H)}] ` +
        `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`);
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map(k => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
    const pdfDate = date ? `/CreationDate (D:${date.replace(/\D/g, "").slice(0, 14)})` : "";
    const info = add(`<< /Title ${pdfString(title)} /Producer (Meerwaardebelasting) ${pdfDate} >>`);
    let out = "%PDF-1.4\n";
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
    return bytes;
  }

  const api = { build, encode, width, wrap };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PDF = api;
})(typeof window !== "undefined" ? window : globalThis);
