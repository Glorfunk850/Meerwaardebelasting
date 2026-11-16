/* Importer voor de Bolero-export "Cashbewegingen" (Excel of CSV).
 * Zet aankopen, verkopen, inschrijvingen en dividenden om naar transacties voor de rekenkern.
 * Het bestand bevat geen ISIN's, splitsingen, overnames of overboekingen van effecten:
 * het importscherm laat de gebruiker daarom de posities op 31/12/2025 bevestigen. */
(function (root) {
  "use strict";
  const M = typeof module !== "undefined" && module.exports ? require("./engine.js") : root.MWB;
  const { D, ZERO } = M;

  // ------------------------------------------------------------ CSV
  function parseCsv(text, delim = ",") {
    const rows = []; let row = [], field = "", q = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Belgische notatie: "1.601,95" / "-959,45" / "4"
  function bnum(s) {
    s = String(s ?? "").trim();
    if (!s) return null;
    return D(s.replace(/\./g, "").replace(",", "."));
  }
  const isoDate = d => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;

  // ------------------------------------------------------------ namen en munten
  const EXCH_CCY = {
    BR: "EUR", PA: "EUR", AS: "EUR", FR: "EUR", MI: "EUR", LS: "EUR", MC: "EUR", DE: "EUR", VI: "EUR", HE: "EUR",
    DU: "EUR", XE: "EUR", IR: "EUR", NY: "USD", NA: "USD", OS: "NOK", ST: "SEK", CO: "DKK", SW: "CHF", MO: "CAD", TO: "CAD",
    LO: null, // Londen: GBP of USD (GDR's), afgeleid uit het bedrag
  };

  /** "PENNANTPARK FLOATING RATE CAPIT.(NY" -> { id: "PENNANTPARK FLOATING RATE CAPIT. (NY)", exch: "NY" } */
  function assetName(raw) {
    let s = String(raw).replace(/\s+/g, " ").trim();
    const m = /\s*\((\w\w)\)?\s*$/.exec(s);
    let exch = null;
    if (m) { exch = m[1].toUpperCase(); s = s.slice(0, m.index).trim() + ` (${exch})`; }
    return { id: s.toUpperCase(), exch };
  }
  /** Sleutel om dividendnamen ("CP BENETEAU S.A. (PA) 17.06.26") aan handelsnamen te koppelen. */
  function nameKey(raw) {
    let n = String(raw).toUpperCase().replace(/^CP\s+/, "").replace(/\s+\d\d\.\d\d\.\d\d\s*$/, "");
    n = n.replace(/\s*\(\w\w\)?\s*$/, "");
    return n.replace(/[^A-Z0-9]/g, "").slice(0, 9);
  }
  function dividendAssetName(raw) {
    let s = String(raw).replace(/\s+/g, " ").trim().replace(/^CP\s+/i, "").replace(/\s+\d\d\.\d\d\.\d\d$/, "");
    return assetName(s).id;
  }

  const TRADE = /^(Aankoop Online|Aankoop|Verkoop Online|Verkoop|Inschrijving)\s+(.+)$/i;
  const DIVIDEND = /^Uitbetaling (dividenden|effecten)\s+(.+)$/i;
  // geldbewegingen zonder effect op de belasting -> soort (zie geld.js)
  const SKIP = [
    [/^Wisseltransactie/i, "WISSEL"],
    [/^Overschrijving naar klant/i, "OPNAME"],
    [/^Provisionering rekening klant/i, "STORTING"],
    [/^Terugstorting/i, "TERUGSTORTING"],
    [/^Taksrecuperatie/i, "TAKSRECUP"],
    [/^Kost igv corporate actions/i, "KOSTEN"],
  ];

  /** FNV-1a 64-bit als korte, stabiele sleutel voor herimport. */
  function fnv64(str) {
    let h = 0xcbf29ce484222325n;
    for (const ch of new TextEncoder().encode(str)) { h ^= BigInt(ch); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
    return h.toString(16).padStart(16, "0");
  }

  // ------------------------------------------------------------ Excel
  /** Belgische notatie zoals in de CSV-export: "1.601,95" (met duizendtal) of "5,21". */
  function beNum(v, thousands) {
    let s = Math.abs(v) < 1e-6 && v !== 0 ? v.toFixed(12) : String(v);
    if (/e/i.test(s)) s = v.toFixed(12);
    const neg = s.startsWith("-"); if (neg) s = s.slice(1);
    let [ip, fp = ""] = s.split(".");
    if (thousands) { fp = (fp + "00").slice(0, Math.max(2, fp.length)); ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, "."); }
    return (neg ? "-" : "") + ip + (fp ? "," + fp : "");
  }
  /** Werkblad van de Excel-export (rijen uit readXlsx) -> rijen met teksten zoals in de CSV-export. */
  function rowsFromSheet(rows) {
    const hIdx = rows.findIndex(r => r && r.some(c => String(c ?? "").trim() === "Datum transactie"));
    if (hIdx < 0) return null;
    const h = rows[hIdx].map(c => String(c ?? "").trim());
    const dateCols = new Set(["Datum transactie", "Valutadatum"].map(k => h.indexOf(k)).filter(i => i >= 0));
    const amountCol = h.indexOf("Bedrag");
    const dmy = v => { const d = new Date(Math.round((Math.floor(v) - 25569) * 864e5)).toISOString(); return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`; };
    const width = Math.max(...rows.map(r => (r ? r.length : 0)));
    return rows.map((r, i) => Array.from({ length: width }, (_, j) => {
      const c = r ? r[j] : null;
      if (c == null) return "";
      if (i <= hIdx || typeof c !== "number") return String(c);
      if (dateCols.has(j)) return dmy(c);
      return beNum(c, j === amountCol);
    }));
  }
  /** sheets: { naam: rijen } uit readXlsx -> resultaat van parseBolero, of null als het geen Bolero-export is. */
  function parseBoleroSheets(sheets, opts = {}) {
    for (const rows of Object.values(sheets)) {
      const csvRows = rowsFromSheet(rows);
      if (csvRows) return parseBoleroRows(csvRows, { fileName: "bolero.xlsx", ...opts });
    }
    return null;
  }

  /**
   * Welke binnenkomende transacties staan er al? Op import-id, en voor Bolero ook op inhoud (type, datum, effect,
   * aantal, prijs, bedrag), zodat CSV en Excel van dezelfde periode elkaar herkennen. -> [true/false per transactie]
   */
  function contentKey(t) {
    const n = v => { try { return D(v ?? "0").toString(); } catch { return String(v); } };
    return [t.type, t.trade_date, t.asset, n(t.quantity), n(t.price), t.type === "DIVIDEND" ? n(t.amount) : ""].join("|");
  }
  function duplicateFlags(existing, incoming) {
    const ids = new Set(existing.map(t => t.import_id).filter(Boolean));
    const free = new Map();
    for (const t of existing) if (String(t.import_id || "").startsWith("b:")) { const k = contentKey(t); free.set(k, (free.get(k) || 0) + 1); }
    const take = k => { const c = free.get(k) || 0; if (c > 0) free.set(k, c - 1); return c > 0; };
    const flags = incoming.map(t => ids.has(t.import_id));
    incoming.forEach((t, i) => { if (flags[i] && String(t.import_id || "").startsWith("b:")) take(contentKey(t)); });
    incoming.forEach((t, i) => { if (!flags[i] && String(t.import_id || "").startsWith("b:")) flags[i] = take(contentKey(t)); });
    return flags;
  }

  // ------------------------------------------------------------ hoofdfunctie
  function parseBolero(text, opts = {}) {
    return parseBoleroRows(parseCsv(text), opts);
  }
  function parseBoleroRows(rows, { owner = "ik", broker = "Bolero", fileName = "bolero.csv" } = {}) {
    const hIdx = rows.findIndex(r => r.some(c => c.trim() === "Datum transactie"));
    if (hIdx < 0) throw new Error("Dit lijkt geen Bolero-export van cashbewegingen: de kolom 'Datum transactie' ontbreekt.");
    const h = rows[hIdx].map(c => c.trim());
    const col = name => h.indexOf(name);
    const C = {
      date: col("Datum transactie"), desc: col("Transactie"), amount: col("Bedrag"), qty: col("Aantal"), price: col("Prijs"),
      rv: col("Roerende voorheffing (EUR)"), pl: col("Winst/verlies"), mwb: col("Meerwaardebelasting"),
    };
    C.ccy = h.indexOf("Munt", C.amount);
    for (const [k, v] of Object.entries(C)) if (v < 0) throw new Error(`Kolom ontbreekt in de Bolero-export: ${k}`);

    // regels met een datum, chronologisch (de export is aflopend; volgorde binnen een dag omkeren)
    const lines = [];
    rows.forEach((r, i) => {
      const d = String(r[C.date] ?? "").trim();
      if (/^\d\d\/\d\d\/\d{4}$/.test(d)) lines.push({ n: i + 1, r, date: isoDate(d), desc: (r[C.desc] || "").trim() });
    });
    lines.reverse();

    // wisselkoersen uit wisseltransacties (paren EUR <-> vreemde munt op dezelfde dag)
    const fxObs = []; // {date, ccy, rate}
    const wissel = lines.filter(l => /^Wisseltransactie/i.test(l.desc));
    for (let i = 0; i + 1 < wissel.length; i++) {
      const a = wissel[i], b = wissel[i + 1];
      if (a.date !== b.date) continue;
      const ca = a.r[C.ccy].trim(), cb = b.r[C.ccy].trim(), va = bnum(a.r[C.amount]), vb = bnum(b.r[C.amount]);
      if (!va || !vb || va.isZero() || vb.isZero() || (ca === "EUR") === (cb === "EUR")) continue;
      const [eurV, fxV, ccy] = ca === "EUR" ? [va, vb, cb] : [vb, va, ca];
      if (eurV.lt(0) === fxV.lt(0)) continue; // een wissel heeft tegengestelde tekens
      const absE = eurV.lt(0) ? eurV.neg() : eurV, absF = fxV.lt(0) ? fxV.neg() : fxV;
      if (absE.lt("1")) continue; // afrondingsresten
      fxObs.push({ date: a.date, ccy, rate: absF.div(absE) });
      i++;
    }
    const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5;
    function fxFor(ccy, date) {
      let best = null;
      for (const o of fxObs) if (o.ccy === ccy) {
        const dist = Math.abs(dayNum(o.date) - dayNum(date));
        if (!best || dist < best.dist) best = { rate: o.rate, dist, date: o.date };
      }
      return best;
    }

    const out = [], warnings = [], fxWarnings = [], skipped = {}, refHints = {}, assets = {}, cash = [];
    const addCash = (kind, l, { status = "info", remark = "", warn = false, importId: id } = {}) => {
      const amount = bnum(l.r[C.amount]);
      cash.push({ kind, date: l.date, amount: amount == null ? null : amount.toString(), currency: (l.r[C.ccy] || "").trim() || "EUR",
        asset_name: "", description: l.desc, status, remark, ...(warn ? { warn } : {}), owner, broker, import_id: id || "c" + importId(l), import_source: `${fileName}:${l.n}` });
    };
    const lineOf = new Map(); // transactie -> exportregel (voor geannuleerde boekingen)
    const seen = new Map();
    const importId = l => {
      const base = `bolero|${l.date}|${l.desc}|${l.r[C.amount]}|${l.r[C.qty]}|${l.r[C.price]}`;
      const k = (seen.get(base) || 0) + 1; seen.set(base, k);
      return "b:" + fnv64(`${base}|${k}`);
    };
    const tradeKeys = new Map(); // nameKey -> asset id
    const storno = []; // te annuleren regels

    for (const l of lines) {
      const src = `${fileName}:${l.n}`;
      const amount = bnum(l.r[C.amount]), amtCcy = (l.r[C.ccy] || "").trim() || "EUR";
      const qty = bnum(l.r[C.qty]), price = bnum(l.r[C.price]);
      let m;
      if ((m = TRADE.exec(l.desc))) {
        const verb = m[1].toLowerCase(), isSell = verb.startsWith("verkoop");
        const { id, exch } = assetName(m[2]);
        tradeKeys.set(nameKey(m[2]), id);
        if (!qty || !qty.gt(ZERO) || price == null || amount == null) { warnings.push(`${src}: ${l.desc} – aantal, prijs of bedrag ontbreekt, overgeslagen.`); continue; }
        // storno: aankoop met positief bedrag of verkoop met negatief bedrag
        if ((!isSell && amount.gt(ZERO)) || (isSell && amount.lt(ZERO))) { storno.push({ l, id, isSell, qty, amount }); continue; }

        const gross = qty.mul(price), net = amount.lt(ZERO) ? amount.neg() : amount;
        let ccy = exch ? EXCH_CCY[exch] : undefined, fx = D(1), note = [];
        if (ccy === "EUR") { /* prijs in EUR, ook als het bedrag in een andere munt geboekt staat */ }
        else if (amtCcy === "EUR") {
          const ratio = gross.div(net); // vreemde munt per EUR, incl. kosten -> schatting
          const dev = ratio.sub(1);
          if (ccy === undefined && dev.lt("0.06") && dev.gt("-0.06")) ccy = "EUR";
          else {
            if (ccy == null) ccy = exch === "LO" ? (ratio.lt(1) ? "GBP" : "USD") : "EUR";
            if (ccy !== "EUR") { fx = ratio.round(6); note.push(`wisselkoers geschat uit het nettobedrag (incl. kosten): ${fx}`); }
          }
        } else {
          if (ccy == null) ccy = amtCcy;
          const f = fxFor(ccy, l.date);
          if (f) { fx = f.rate.round(6); if (f.dist > 7) note.push(`wisselkoers van ${f.date} (geen wissel binnen 7 dagen)`); }
          else { fx = null; }
        }
        if (fx === null) { warnings.push(`${src}: ${l.desc} – geen wisselkoers ${ccy}/EUR gevonden, overgeslagen.`); continue; }
        // kosten (enkel exact als bedrag en prijs in dezelfde munt staan)
        let fees = ZERO;
        if (ccy === amtCcy) { const diff = isSell ? gross.sub(net) : net.sub(gross); if (diff.gt(ZERO)) fees = diff.round(2); }
        if (ccy !== "EUR" && fx && note.length) fxWarnings.push({ asset: id, date: l.date, text: `${src}: ${id} (${l.date}) – ${note[0]}.` });

        const t = {
          type: isSell ? "SELL" : "BUY", trade_date: l.date, asset: id, quantity: qty.toString(), price: price.toString(),
          currency: ccy, fx_per_eur: fx.toString(), fees: fees.toString(), taxes: "0", owner, broker,
          historic_proven: !isSell && l.date < "2026-01-01", cost_known: true, reynders_eur: "0", amount: "0", split_ratio: null,
          note: [verb === "inschrijving" ? "inschrijving" : "", ...note].filter(Boolean).join("; "),
          import_id: importId(l), import_source: src,
        };
        const pl = bnum(l.r[C.pl]), mwb = bnum(l.r[C.mwb]);
        if (isSell && pl != null) { t.bolero_result = pl.toString(); if (mwb != null) t.bolero_tax = mwb.toString(); }
        assets[id] ??= { currency: ccy };
        out.push(t); lineOf.set(t, l);
      } else if ((m = DIVIDEND.exec(l.desc))) {
        if (amount == null) continue;
        const name = m[2];
        const id = tradeKeys.get(nameKey(name)) || dividendAssetName(name);
        if (amount.lt(ZERO)) { storno.push({ l, id, dividend: true, amount }); continue; }
        let fx = D(1);
        if (amtCcy !== "EUR") { const f = fxFor(amtCcy, l.date); fx = f ? f.rate.round(6) : null; }
        if (fx === null) { warnings.push(`${src}: dividend ${name} in ${amtCcy} zonder wisselkoers, overgeslagen.`); continue; }
        const rv = bnum(l.r[C.rv]);
        const dv = {
          type: "DIVIDEND", trade_date: l.date, asset: id, amount: amount.toString(), currency: amtCcy, fx_per_eur: fx.toString(),
          quantity: "0", price: "0", fees: "0", taxes: "0", owner, broker, historic_proven: false, cost_known: true, reynders_eur: "0",
          split_ratio: null, note: `netto${rv ? `; roerende voorheffing € ${rv}` : ""}${m[1].toLowerCase() === "effecten" ? "; coupon/recht" : ""}`,
          import_id: importId(l), import_source: src,
        };
        out.push(dv); lineOf.set(dv, l);
      } else if (/^Inboeking corporate action/i.test(l.desc)) {
        addCash("CA", l, { remark: "controleer de betrokken posities", warn: true });
        warnings.push(`${src}: ${l.desc} – corporate action (bv. overname of omruiling) staat niet volledig in de export. Controleer de betrokken posities.`);
      } else {
        const s = SKIP.find(([re]) => re.test(l.desc));
        addCash(s ? s[1] : "ANDERE", l, s ? {} : { remark: "onbekend type", warn: true });
        if (!s) warnings.push(`${src}: onbekend type '${l.desc}', niet als transactie ingelezen (wel als geldbeweging).`);
      }
    }

    // storno's: telkens één overeenkomstige regel annuleren
    for (const s of storno) {
      const want = s.amount.lt(ZERO) ? s.amount.neg() : s.amount;
      const idx = out.findIndex(t => t.asset === s.id && t.trade_date === s.l.date && !t._cancelled && (s.dividend
        ? t.type === "DIVIDEND" && D(t.amount).eq(want)
        : t.type === (s.isSell ? "SELL" : "BUY") && D(t.quantity).eq(s.qty)
          && (D(t.price).mul(t.quantity).add(t.fees).sub(want).round(2).isZero() || D(t.price).mul(t.quantity).sub(t.fees).sub(want).round(2).isZero())));
      if (idx >= 0) {
        const t = out[idx]; t._cancelled = true;
        addCash("STORNO", lineOf.get(t), { status: "verwerkt", remark: "geannuleerd door een correctieboeking", importId: "c" + t.import_id });
        addCash("STORNO", s.l, { status: "verwerkt", remark: "correctieboeking" });
      } else {
        addCash("STORNO", s.l, { remark: "correctie zonder overeenkomstige boeking", warn: true });
        warnings.push(`${fileName}:${s.l.n}: correctie '${s.l.desc}' zonder overeenkomstige boeking, niet als transactie ingelezen (wel als geldbeweging).`);
      }
    }
    const transactions = out.filter(t => !t._cancelled);

    // fotowaarde afleiden uit Bolero's eigen resultaat bij verkopen in 2026+
    // (enkel als het volledig verkochte deel uit lots van vóór 2026 komt)
    for (const t of transactions) {
      if (t.type !== "SELL" || t.bolero_result == null || t.trade_date < "2026-01-01") continue;
      const before = M.holdingsAt(transactions.filter(x => x !== t && x.trade_date < t.trade_date), "2025-12-31")
        .find(h => h.asset === t.asset && h.owner === t.owner);
      const bought2026 = transactions.some(x => x.asset === t.asset && x.type === "BUY" && x.trade_date >= "2026-01-01" && x.trade_date <= t.trade_date);
      const soldEarlier2026 = transactions.some(x => x !== t && x.asset === t.asset && x.type === "SELL" && x.trade_date >= "2026-01-01" && x.trade_date < t.trade_date);
      if (!before || before.quantity.lt(t.quantity) || bought2026 || soldEarlier2026) continue;
      const grossEur = D(t.price).mul(t.quantity).div(t.fx_per_eur);
      const ref = grossEur.sub(t.bolero_result).div(t.quantity);
      if (ref.gt(ZERO) && D(t.bolero_result).lt(ZERO)) // bij verlies rekent Bolero altijd t.o.v. de fotowaarde
        refHints[t.asset] = { value: ref.round(4).toString(), from: `afgeleid uit Bolero's resultaat op de verkoop van ${t.trade_date}` };
    }
    // posities op 31/12/2025 ter controle: laatste dividend als aanwijzing dat je ze nog had
    const held = M.holdingsAt(transactions, "2025-12-31");
    const divKeys = transactions.filter(t => t.type === "DIVIDEND").map(t => ({ k: nameKey(t.asset), date: t.trade_date }));
    const positions = held.map(h => {
      const k = nameKey(h.asset);
      const last = divKeys.filter(d => k.length >= 4 && (d.k.startsWith(k) || k.startsWith(d.k)) && d.k.length >= 4)
        .map(d => d.date).sort().pop() || null;
      const activity2026 = transactions.some(t => t.asset === h.asset && t.trade_date >= "2026-01-01" && t.type !== "DIVIDEND");
      const suspicious = !activity2026 && (!last || last < "2024-07-01");
      return { asset: h.asset, quantity: h.quantity.toString(), lastDividend: last, suspicious, refHint: refHints[h.asset] || null };
    });
    // wisselkoerswaarschuwingen enkel voor effecten die na 2025 nog meetellen
    const relevant = new Set([...held.map(h => h.asset), ...transactions.filter(t => t.trade_date >= "2026-01-01").map(t => t.asset)]);
    for (const w of fxWarnings) if (relevant.has(w.asset)) warnings.push(w.text + " Telt mee als dit lot na 2025 verkocht wordt en de historische prijs gebruikt wordt.");
    // verkopen zonder (voldoende) aankopen in deze export: de periode is te kort, tenzij die aankopen al eerder geïmporteerd zijn
    const short = [];
    for (const t of transactions) if (t.type === "SELL") {
      const h = M.holdingsAt(transactions.filter(x => x !== t && x.trade_date <= t.trade_date), t.trade_date).find(x => x.asset === t.asset);
      if (!h || h.quantity.lt(t.quantity)) short.push(t.asset);
    }
    const period = lines.length ? [lines[0].date, lines[lines.length - 1].date] : [null, null];
    if (short.length)
      warnings.unshift(`De export loopt van ${period[0]} tot ${period[1]} en bevat niet alle aankopen voor: ${[...new Set(short)].join(", ")}. ` +
        "Importeer ook een export vanaf je eerste aankoop (of voeg de aankopen zelf toe), anders kan de meerwaarde niet berekend worden.");
    return { transactions, cash, skipped, warnings, refHints, assets, positions, fileName, rows: lines.length, period, incomplete: [...new Set(short)] };
  }

  const api = { parseBolero, parseBoleroRows, parseBoleroSheets, rowsFromSheet, beNum, duplicateFlags, contentKey, parseCsv, assetName, nameKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BOLERO = api;
})(typeof window !== "undefined" ? window : globalThis);
