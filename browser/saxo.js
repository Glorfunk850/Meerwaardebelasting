/* Importer voor de Saxo-export "Trades" (Excel, of dezelfde kolommen als CSV).
 * Blad "Transacties": één regel per uitgevoerde order, met ISIN, prijs in instrumentmunt,
 * omrekeningskoers (EUR per eenheid instrumentmunt) en totale kosten in EUR.
 * Blad "Bookings" (optioneel): opsplitsing van de kosten (commissie, beurstaks, Franse FTT).
 * Dividenden en corporate actions staan niet in deze export. */
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const M = node ? require("./engine.js") : root.MWB;
  const X = node ? require("./xlsx.js") : root.XLSX_LITE;
  const { D, ZERO } = M;

  const norm = s => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  function num(v) {
    if (v == null || v === "" || v === "-") return null;
    if (typeof v === "number") {
      if (!isFinite(v)) return null;
      let s = String(v);
      if (/e/i.test(s)) s = v.toFixed(12);
      return D(s);
    }
    const s = String(v).trim();
    // CSV kan "1.234,56" (BE) of "1234.56" bevatten
    return D(/,\d{1,6}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, ""));
  }
  const abs = d => (d.lt(0) ? d.neg() : d);

  /** "*Delsited 20260430 (JDE Peet's)" -> { date: "2026-04-30", name: "JDE Peet's" } */
  function delistedTag(name) {
    const m = /^\*\s*del\w*?ted\s+(\d{4})(\d\d)(\d\d)\s*\((.+)\)\s*$/i.exec(String(name || "").trim());
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, name: m[4].trim() } : null;
  }

  function tableFrom(rows, required) {
    const hIdx = rows.findIndex(r => r && required.every(k => r.some(c => norm(c) === k)));
    if (hIdx < 0) return null;
    const h = rows[hIdx].map(norm);
    return { col: k => h.indexOf(k), rows: rows.slice(hIdx + 1).map((r, i) => ({ r: r || [], n: hIdx + i + 2 })) };
  }

  /** sheets: { naam: rijen } (uit readXlsx) of { csv: rijen } */
  function parseSaxoSheets(sheets, { owner = "ik", broker = "Saxo", fileName = "saxo.xlsx" } = {}) {
    const all = Object.entries(sheets);
    let T = null, sheetName = null;
    for (const [name, rows] of all) {
      T = tableFrom(rows, ["transactiedatum", "instrument isin", "traded quantity", "prijs"]);
      if (T) { sheetName = name; break; }
    }
    if (!T) throw new Error("Dit lijkt geen Saxo-export van transacties: de kolommen 'Transactiedatum', 'Instrument ISIN', 'Traded Quantity' en 'Prijs' ontbreken.");
    const c = {
      date: T.col("transactiedatum"), tradeDate: T.col("aangepaste transactiedatum"), type: T.col("transactietype"),
      action: T.col("acties"), amount: T.col("boekingsbedrag (eur)"), rate: T.col("omrekeningskoers"), costs: T.col("totale kosten"),
      pl: T.col("gerealiseerde w/v"), instr: T.col("instrument"), symbol: T.col("instrumentsymbool"), isin: T.col("instrument isin"),
      ccy: T.col("instrumentvaluta"), kind: T.col("type"), openClose: T.col("openen/sluiten"), qty: T.col("traded quantity"),
      price: T.col("prijs"), value: T.col("verhandelde waarde"), txid: T.col("transactie-id"), exch: T.col("uitwisselingsbeschrijving"),
    };

    // kostenopsplitsing uit "Bookings"
    const taxesById = new Map();
    for (const [name, rows] of all) {
      if (name === sheetName) continue;
      const B = tableFrom(rows, ["transactie-id", "amount type", "boekingsbedrag"]);
      if (!B) continue;
      const bi = B.col("transactie-id"), bt = B.col("amount type"), ba = B.col("boekingsbedrag");
      for (const { r } of B.rows) {
        const id = String(r[bi] ?? "").trim(), type = norm(r[bt]);
        if (!id || !/beurstaks|transactiebelasting|stamp|ftt|taks/.test(type)) continue;
        const amt = num(r[ba]); if (!amt) continue;
        taxesById.set(id, (taxesById.get(id) || ZERO).add(abs(amt))); // boekingsbedrag staat in EUR
      }
    }

    const out = [], warnings = [], skipped = {}, assets = {}, delistInfo = new Map();
    const seen = new Map();
    let firstDate = null, lastDate = null;
    const lines = T.rows.filter(({ r }) => r.some(v => v != null && v !== "")).reverse(); // export is aflopend
    // regels zonder ISIN: ISIN van een andere regel met hetzelfde instrument (naam of symbool) gebruiken
    const isinByName = new Map(), isinBySymbol = new Map();
    const instrName = r => { const raw = String(r[c.instr] ?? "").trim(), tag = delistedTag(raw); return norm(tag ? tag.name : raw); };
    for (const { r } of lines) {
      const isin = String(r[c.isin] ?? "").trim().toUpperCase(), sym = norm(r[c.symbol]);
      if (!isin) continue;
      if (instrName(r)) isinByName.set(instrName(r), isin);
      if (sym) isinBySymbol.set(sym, isin);
    }
    for (const { r, n } of lines) {
      const src = `${fileName}:${n}`;
      const type = norm(r[c.type]);
      const date = X.excelDate(r[c.tradeDate] ?? r[c.date]) || X.excelDate(r[c.date]);
      if (!date) { warnings.push(`${src}: geen geldige datum, overgeslagen.`); continue; }
      if (type && type !== "transactie") { skipped[`Type '${r[c.type]}'`] = (skipped[`Type '${r[c.type]}'`] || 0) + 1; continue; }
      const oc = norm(r[c.openClose]);
      const isin = String(r[c.isin] ?? "").trim().toUpperCase()
        || isinByName.get(instrName(r)) || (norm(r[c.symbol]) && isinBySymbol.get(norm(r[c.symbol]))) || "";
      const rawName = String(r[c.instr] ?? "").trim();
      const tag = delistedTag(rawName);
      const name = tag ? tag.name : rawName;
      if (oc === "pending" || r[c.amount] == null || r[c.amount] === "") {
        skipped["Niet (volledig) uitgevoerde orders"] = (skipped["Niet (volledig) uitgevoerde orders"] || 0) + 1;
        warnings.push(`${src}: order ${String(r[c.action] || "").trim()} in ${name} op ${date} staat als '${r[c.openClose] || "zonder boeking"}' – niet geïmporteerd. Importeer later een nieuwere export.`);
        continue;
      }
      const qtyRaw = num(r[c.qty]), price = num(r[c.price]);
      if (!qtyRaw || qtyRaw.isZero() || price == null) { warnings.push(`${src}: aantal of prijs ontbreekt (${name}), overgeslagen.`); continue; }
      if (!isin) warnings.push(`${src}: geen ISIN voor ${name}; de naam wordt gebruikt als sleutel.`);
      const isSell = qtyRaw.lt(0) || oc === "to close" && /verkoop/i.test(String(r[c.action]));
      const qty = abs(qtyRaw);
      const ccy = String(r[c.ccy] || "EUR").trim().toUpperCase() || "EUR";
      const rate = num(r[c.rate]); // EUR per eenheid instrumentmunt
      let fx = D(1);
      if (ccy !== "EUR") {
        if (!rate || !rate.gt(0)) { warnings.push(`${src}: geen omrekeningskoers voor ${name} (${ccy}), overgeslagen.`); continue; }
        fx = D(1).div(rate).round(10);
      }
      const costsEur = abs(num(r[c.costs]) || ZERO);
      const txid = String(r[c.txid] ?? "").trim();
      const taxEur = Dmin(taxesById.get(txid) || ZERO, costsEur);
      const toCcy = eurAmt => (ccy === "EUR" ? eurAmt : eurAmt.mul(fx)).round(2);
      const asset = isin || name.toUpperCase();
      const base = `saxo|${txid || ""}|${date}|${asset}|${qtyRaw}|${price}`;
      const k = (seen.get(base) || 0) + 1; seen.set(base, k);
      const t = {
        type: isSell ? "SELL" : "BUY", trade_date: date, asset, quantity: qty.toString(), price: price.toString(), currency: ccy,
        fx_per_eur: fx.toString(), fees: toCcy(costsEur.sub(taxEur)).toString(), taxes: toCcy(taxEur).toString(), owner, broker,
        historic_proven: !isSell && date < "2026-01-01", cost_known: true, reynders_eur: "0", amount: "0", split_ratio: null,
        note: [name, ccy !== "EUR" ? `koers Saxo: 1 ${ccy} = ${rate} EUR` : ""].filter(Boolean).join("; "),
        import_id: "s:" + (txid ? `${txid}|${k}` : base + "|" + k), import_source: src,
      };
      const pl = num(r[c.pl]);
      if (isSell && pl != null) t.saxo_result = pl.toString();
      out.push(t);
      assets[asset] ??= { currency: ccy, name, symbol: String(r[c.symbol] || "").trim(), kind: String(r[c.kind] || "").trim() };
      if (tag) delistInfo.set(asset, { date: tag.date, name });
      firstDate = !firstDate || date < firstDate ? date : firstDate;
      lastDate = !lastDate || date > lastDate ? date : lastDate;
    }

    // delistings die Saxo in de naam markeert: voorstel als je op die datum nog stuks had
    const delistings = [];
    for (const [asset, info] of delistInfo) {
      const held = M.holdingsAt(out, info.date).find(h => h.asset === asset);
      const afterExport = lastDate && info.date > lastDate;
      if (held) delistings.push({ asset, name: info.name, date: info.date, quantity: held.quantity.toString(), afterExport });
      else warnings.push(`${info.name} (${asset}): door Saxo gemarkeerd als geschrapt op ${info.date}; je had op die datum geen stuks meer, dus er is niets te doen.`);
    }

    const positions = M.holdingsAt(out, "2025-12-31").map(h => ({
      asset: h.asset, name: assets[h.asset]?.name || "", quantity: h.quantity.toString(), lastDividend: null, suspicious: false, refHint: null,
    }));
    if (firstDate && firstDate > "2015-01-01")
      warnings.push(`De export loopt van ${firstDate} tot ${lastDate}. Had je bij Saxo al effecten vóór ${firstDate}, exporteer dan een langere periode: anders ontbreken aankopen en klopt FIFO niet.`);
    if (out.some(t => t.saxo_result != null && t.trade_date >= "2026-01-01" && positions.some(p => p.asset === t.asset)))
      warnings.push("Saxo's 'Gerealiseerde W/V' is berekend op je aankoopprijs; voor effecten van vóór 2026 rekent de wet met de waarde op 31/12/2025. Verschillen zijn dus normaal.");
    warnings.push("Saxo is een buitenlandse broker: er wordt geen Belgische meerwaardebelasting ingehouden. Je geeft deze meerwaarden zelf aan.");
    return { source: "saxo", transactions: out, skipped, warnings, refHints: {}, assets, positions, delistings, fileName, rows: lines.length, period: [firstDate, lastDate] };
  }
  const Dmin = (a, b) => (a.lte(b) ? a : b);

  async function parseSaxoFile(buf, opts) {
    const sheets = await X.readXlsx(buf);
    return parseSaxoSheets(sheets, opts);
  }

  const api = { parseSaxoSheets, parseSaxoFile, delistedTag };
  if (node) module.exports = api; else root.SAXO = api;
})(typeof window !== "undefined" ? window : globalThis);
