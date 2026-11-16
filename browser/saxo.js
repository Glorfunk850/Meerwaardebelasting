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
  const G = node ? require("./geld.js") : root.GELD;
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

  // kolommen van de gecombineerde tabel (vroegere export "Trades": alles op één blad)
  const COMBINED = ["transactiedatum", "aangepaste transactiedatum", "transactietype", "acties", "boekingsbedrag (eur)", "omrekeningskoers",
    "totale kosten", "gerealiseerde w/v", "instrument", "instrumentsymbool", "instrument isin", "instrumentvaluta", "type", "openen/sluiten",
    "traded quantity", "prijs", "verhandelde waarde", "transactie-id", "uitwisselingsbeschrijving", "corporate action-id", "_bron", "_info"];
  const str = v => String(v ?? "").trim();

  /**
   * Standaardexport "Transacties" (sinds 2026): blad "Transacties" (één regel per boeking: bedrag, kosten, koers,
   * dividenden, stortingen) en blad "_Transacties" (één regel per uitvoering: aantal en prijs, ook bij corporate actions).
   * -> { rows: gecombineerde tabel zoals de vroegere export, cash: rijen van "Transacties" (dividenden e.d.), splits }
   */
  function combineTransactionsExport(all) {
    let E = null, B = null, bName = null, eName = null;
    for (const [name, rows] of all) {
      if (!E) { E = tableFrom(rows, ["transactie-id", "instrument isin", "traded quantity", "prijs", "aangepaste transactiedatum"]); if (E) eName = name; }
      if (!B) { B = tableFrom(rows, ["transactiedatum", "transactietype", "boekingsbedrag", "transactie-id"]); if (B) bName = name; }
    }
    if (!E || !B) return null;
    const get = (T, r) => k => { const i = T.col(k); return i < 0 ? null : r[i]; };
    const booked = new Map(), loose = [], cash = [];
    for (const { r, n } of B.rows) {
      if (!r.some(v => v != null && v !== "")) continue;
      const g = get(B, r), id = str(g("transactie-id"));
      if (norm(g("transactietype")) !== "transactie") cash.push({ g, n, sheet: bName });
      else if (id && !booked.has(id)) booked.set(id, { g, n });
      else loose.push({ g, n }); // transactie zonder (uniek) transactie-id
    }
    // corporate actions staan soms twee keer in "_Transacties" met hetzelfde transactie-id (bv. herboeking voor de
    // meerwaardebelasting): enkel de vroegste telt
    const execs = E.rows.filter(({ r }) => r.some(v => v != null && v !== "")).map(({ r, n }) => ({ g: get(E, r), n }));
    const dateOf = g => X.excelDate(g("aangepaste transactiedatum") ?? g("trade execution date")) || "";
    const first = new Map(), dupes = [];
    for (const e of [...execs].sort((a, b) => dateOf(a.g).localeCompare(dateOf(b.g)))) {
      const id = str(e.g("transactie-id")), ca = str(e.g("corporate action-id"));
      if (ca && id && first.has(id)) { dupes.push(e); continue; }
      if (id) first.set(id, e);
    }
    // boekingen die bij geen enkele uitvoering horen: kandidaat voor een uitvoering zonder (juist) transactie-id
    const execIds = new Set(execs.map(e => str(e.g("transactie-id"))).filter(Boolean));
    const spare = [...[...booked].filter(([id]) => !execIds.has(id)).map(([, b]) => b), ...loose];
    const isinOf = g => str(g("instrument isin")).toUpperCase();
    const rows = [COMBINED], splits = [];
    for (const e of execs) {
      if (dupes.includes(e)) continue;
      const g = e.g, id = str(g("transactie-id")), ca = str(g("corporate action-id"));
      let b = booked.get(id)?.g, info = null;
      if (!b && !ca) {
        // zelfde ISIN, dag en richting (een verkoop brengt geld op)
        const sell = num(g("traded quantity"))?.lt(0), date = dateOf(g);
        const i = spare.findIndex(({ g: bg }) => isinOf(g) && isinOf(bg) === isinOf(g) && X.excelDate(bg("transactiedatum")) === date &&
          (num(bg("boekingsbedrag"))?.gt(0) ?? sell) === sell);
        if (i >= 0) {
          b = spare[i].g; spare.splice(i, 1);
          info = `boeking gevonden via ISIN en datum (transactie-id ${id || "leeg"} in ${eName}, ${str(b("transactie-id")) || "leeg"} in ${bName}).`;
        }
      }
      if (ca && !b && /splitsing|split/i.test(str(g("acties")))) { splits.push(e); continue; }
      const v = {
        "transactiedatum": b ? b("transactiedatum") : g("aangepaste transactiedatum"), "aangepaste transactiedatum": g("aangepaste transactiedatum"),
        "transactietype": b ? b("transactietype") : "", "acties": str(g("acties")) || (b ? b("acties") : ""),
        // zonder boeking: corporate action (bedrag = verhandelde waarde) of nog niet geboekt
        "boekingsbedrag (eur)": b ? b("boekingsbedrag") : ca ? g("verhandelde waarde") : null,
        "omrekeningskoers": b ? b("omrekeningskoers") : null, "totale kosten": b ? b("totale kosten") : 0,
        "gerealiseerde w/v": b ? b("gerealiseerde w/v") : null, "corporate action-id": ca || null, "_bron": `${eName}:${e.n}`, "_info": info,
      };
      rows.push(COMBINED.map(k => (k in v ? v[k] : g(k))));
    }
    // boekingen zonder uitvoering: aantal en prijs uit de omschrijving ("Verkoop -40 @ 30.00 EUR")
    const unmatched = [];
    for (const { g, n } of spare) {
      const m = /^\s*(koop|verkoop)\s+(-?[\d.,]+)\s*@\s*([\d.,]+)/i.exec(str(g("acties")));
      const q = m && num(m[2]), p = m && num(m[3]);
      if (!q || q.isZero() || !p) { unmatched.push({ g, n, sheet: bName }); continue; }
      const qty = /^verkoop$/i.test(m[1]) ? (q.lt(0) ? q : q.neg()) : abs(q);
      const v = {
        "aangepaste transactiedatum": g("transactiedatum"), "boekingsbedrag (eur)": g("boekingsbedrag"), "traded quantity": qty.toString(),
        "prijs": p.toString(), "verhandelde waarde": null, "openen/sluiten": null, "corporate action-id": null, "_bron": `${bName}:${n}`,
        "_info": `geen uitvoering in ${eName}: aantal en prijs gehaald uit de omschrijving '${str(g("acties"))}'. Controleer.`,
      };
      rows.push(COMBINED.map(k => (k in v ? v[k] : g(k))));
    }
    return { rows, cash, splits, dupes, unmatched,
      bookedCcy: [...booked.values(), ...loose].map(b => str(b.g("valuta")).toUpperCase()).filter(c => c && c !== "EUR") };
  }

  /** sheets: { naam: rijen } (uit readXlsx) of { csv: rijen } */
  function parseSaxoSheets(sheets, { owner = "ik", broker = "Saxo", fileName = "saxo.xlsx" } = {}) {
    const all = Object.entries(sheets);
    let T = null, sheetName = null;
    for (const [name, rows] of all) {
      T = tableFrom(rows, ["transactiedatum", "instrument isin", "traded quantity", "prijs"]);
      if (T) { sheetName = name; break; }
    }
    const combo = T ? null : combineTransactionsExport(all);
    if (combo) { T = tableFrom(combo.rows, ["transactiedatum", "instrument isin", "traded quantity", "prijs"]); sheetName = null; }
    if (!T) throw new Error("Dit lijkt geen Saxo-export van transacties: de kolommen 'Transactiedatum', 'Instrument ISIN', 'Traded Quantity' en 'Prijs' ontbreken.");
    const c = {
      date: T.col("transactiedatum"), tradeDate: T.col("aangepaste transactiedatum"), type: T.col("transactietype"),
      action: T.col("acties"), amount: T.col("boekingsbedrag (eur)"), rate: T.col("omrekeningskoers"), costs: T.col("totale kosten"),
      pl: T.col("gerealiseerde w/v"), instr: T.col("instrument"), symbol: T.col("instrumentsymbool"), isin: T.col("instrument isin"),
      ccy: T.col("instrumentvaluta"), kind: T.col("type"), openClose: T.col("openen/sluiten"), qty: T.col("traded quantity"),
      price: T.col("prijs"), value: T.col("verhandelde waarde"), txid: T.col("transactie-id"), exch: T.col("uitwisselingsbeschrijving"),
      ca: T.col("corporate action-id"), src: T.col("_bron"), info: T.col("_info"),
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

    const out = [], warnings = [], skipped = {}, assets = {}, delistInfo = new Map(), cash = [];
    const count = k => { skipped[k] = (skipped[k] || 0) + 1; };
    const cashId = G.idMaker("s:cash:");
    const seen = new Map();
    let firstDate = null, lastDate = null;
    const lines = T.rows.filter(({ r }) => r.some(v => v != null && v !== "")).reverse(); // export is aflopend
    // het actief heet zoals het instrument (naam, zoals bij Bolero); de ISIN wordt apart bewaard.
    // Regels zonder ISIN krijgen die van een andere regel met hetzelfde instrument (naam of symbool).
    // Eén naam per ISIN: de recentste naam in de export (bij een naamswijziging blijft het één actief).
    const isinByName = new Map(), isinBySymbol = new Map(), nameByIsin = new Map();
    const instrName = r => { const raw = String(r[c.instr] ?? "").trim(), tag = delistedTag(raw); return (tag ? tag.name : raw).replace(/\s+/g, " "); };
    for (const { r } of lines) {
      const isin = String(r[c.isin] ?? "").trim().toUpperCase(), sym = norm(r[c.symbol]);
      if (!isin) continue;
      if (instrName(r)) {
        const k = norm(instrName(r));
        isinByName.set(k, isinByName.has(k) && isinByName.get(k) !== isin ? null : isin); // null: naam bij meerdere ISIN's
        nameByIsin.set(isin, instrName(r));
      }
      if (sym) isinBySymbol.set(sym, isin);
    }
    const keyByIsin = new Map(), isinByKey = new Map();
    const assetKey = (isin, name) => {
      if (!isin) return name.toUpperCase();
      if (keyByIsin.has(isin)) return keyByIsin.get(isin);
      let key = (nameByIsin.get(isin) || name).toUpperCase();
      if (isinByKey.has(key) && isinByKey.get(key) !== isin) key = `${key} (${isin})`; // zelfde naam, ander effect
      keyByIsin.set(isin, key); isinByKey.set(key, isin);
      return key;
    };
    // omrekeningskoersen per munt (voor een uitvoering zonder boeking: de koers van de dichtstbijzijnde dag)
    const ratesByCcy = new Map();
    for (const { r } of lines) {
      const ccy = String(r[c.ccy] || "").trim().toUpperCase(), rate = num(r[c.rate]), date = X.excelDate(r[c.date]);
      if (!ccy || ccy === "EUR" || !rate || !rate.gt(0) || !date) continue;
      ratesByCcy.set(ccy, [...(ratesByCcy.get(ccy) || []), { date, rate }]);
    }
    const days = d => Date.parse(d + "T00:00:00Z") / 864e5;
    const nearestRate = (ccy, date) => (ratesByCcy.get(ccy) || [])
      .reduce((best, x) => (!best || Math.abs(days(x.date) - days(date)) < Math.abs(days(best.date) - days(date)) ? x : best), null);
    for (const { r, n } of lines) {
      const src = c.src >= 0 && r[c.src] ? `${fileName} (${r[c.src]})` : `${fileName}:${n}`;
      const type = norm(r[c.type]);
      const date = X.excelDate(r[c.tradeDate] ?? r[c.date]) || X.excelDate(r[c.date]);
      if (!date) { warnings.push(`${src}: geen geldige datum, overgeslagen.`); continue; }
      if (type && type !== "transactie") {
        // oude export: geldbewegingen staan op hetzelfde blad
        const amt = num(r[c.amount]), action = String(r[c.action] ?? "").trim(), name = instrName(r);
        const kind = type === "storting/opname" ? (amt && amt.lt(0) ? "OPNAME" : "STORTING") : "ANDERE";
        cash.push({ kind, date, amount: amt ? amt.toString() : null, currency: "EUR", asset_name: name,
          description: [String(r[c.type]).trim(), action].filter(Boolean).join(": "), status: "info", remark: "", owner, broker,
          import_id: cashId(String(r[c.txid] ?? "").trim(), date, type, action, amt, name), import_source: src });
        continue;
      }
      const oc = norm(r[c.openClose]);
      const ownIsin = String(r[c.isin] ?? "").trim().toUpperCase();
      const symbol = String(r[c.symbol] ?? "").trim();
      const isin = ownIsin || isinByName.get(norm(instrName(r))) || (symbol && isinBySymbol.get(norm(symbol))) || "";
      const rawName = String(r[c.instr] ?? "").trim();
      const tag = delistedTag(rawName);
      const name = tag ? tag.name : rawName;
      if (oc === "pending") {
        skipped["Niet (volledig) uitgevoerde orders"] = (skipped["Niet (volledig) uitgevoerde orders"] || 0) + 1;
        warnings.push(`${src}: order ${String(r[c.action] || "").trim()} in ${name} op ${date} staat als '${r[c.openClose]}' – niet geïmporteerd. Importeer later een nieuwere export.`);
        continue;
      }
      // uitgevoerd maar (nog) zonder boeking: toch inlezen met aantal en prijs, zonder kosten
      const noBooking = r[c.amount] == null || r[c.amount] === "";
      if (c.info >= 0 && r[c.info]) warnings.push(`${src}: ${name} op ${date}: ${r[c.info]}`);
      const qtyRaw = num(r[c.qty]), price = num(r[c.price]);
      if (!qtyRaw || qtyRaw.isZero() || price == null) { warnings.push(`${src}: aantal of prijs ontbreekt (${name}), overgeslagen.`); continue; }
      if (!isin) warnings.push(`${src}: geen ISIN voor ${name} in de export` +
        (isinByName.get(norm(instrName(r))) === null ? " (de naam hoort bij meerdere ISIN's: controleer bij welk effect deze transactie hoort)." : "."));
      const isSell = qtyRaw.lt(0) || oc === "to close" && /verkoop/i.test(String(r[c.action]));
      const qty = abs(qtyRaw);
      const ccy = String(r[c.ccy] || "EUR").trim().toUpperCase() || "EUR";
      let rate = num(r[c.rate]), rateFrom = null; // EUR per eenheid instrumentmunt
      let fx = D(1);
      if (ccy !== "EUR") {
        if ((!rate || !rate.gt(0)) && noBooking) { const x = nearestRate(ccy, date); if (x) { rate = x.rate; rateFrom = x.date; } }
        if (!rate || !rate.gt(0)) { warnings.push(`${src}: geen omrekeningskoers voor ${name} (${ccy}), overgeslagen.`); continue; }
        fx = D(1).div(rate).round(10);
      }
      if (noBooking) {
        count("Uitgevoerd zonder boeking (ingelezen zonder kosten)");
        warnings.push(`${src}: ${isSell ? "verkoop" : "aankoop"} van ${qty} ${name} op ${date} heeft geen boeking in de export (geen bedrag of kosten). ` +
          `Ingelezen met aantal en prijs van de uitvoering, zonder kosten` + (rateFrom ? ` en met de omrekeningskoers van ${rateFrom} (1 ${ccy} = ${rate} EUR)` : "") +
          ". Vul de kosten zelf aan; een latere import vervangt deze transactie niet.");
      }
      const costsEur = abs(num(r[c.costs]) || ZERO);
      const txid = String(r[c.txid] ?? "").trim();
      const taxEur = Dmin(taxesById.get(txid) || ZERO, costsEur);
      const toCcy = eurAmt => (ccy === "EUR" ? eurAmt : eurAmt.mul(fx)).round(2);
      const asset = assetKey(isin, name);
      // import-id zoals vroeger (met ISIN of naam), zodat een herimport dezelfde transacties herkent
      const base = `saxo|${txid || ""}|${date}|${ownIsin || name.toUpperCase()}|${qtyRaw}|${price}`;
      const k = (seen.get(base) || 0) + 1; seen.set(base, k);
      const t = {
        type: isSell ? "SELL" : "BUY", trade_date: date, asset, quantity: qty.toString(), price: price.toString(), currency: ccy,
        fx_per_eur: fx.toString(), fees: toCcy(costsEur.sub(taxEur)).toString(), taxes: toCcy(taxEur).toString(), owner, broker,
        historic_proven: !isSell && date < "2026-01-01", cost_known: true, reynders_eur: "0", amount: "0", split_ratio: null,
        note: [name, ccy !== "EUR" ? `koers Saxo: 1 ${ccy} = ${rate} EUR` : "",
          c.ca >= 0 && r[c.ca] ? `corporate action: ${String(r[c.action] || "").trim() || "zonder omschrijving"}` : ""].filter(Boolean).join("; "),
        import_id: "s:" + (txid ? `${txid}|${k}` : base + "|" + k), import_source: src,
      };
      const pl = num(r[c.pl]);
      if (isSell && pl != null) t.saxo_result = pl.toString();
      out.push(t);
      assets[asset] ??= { currency: ccy, name, isin, symbol, kind: String(r[c.kind] || "").trim() };
      if (tag) delistInfo.set(asset, { date: tag.date, name });
      firstDate = !firstDate || date < firstDate ? date : firstDate;
      lastDate = !lastDate || date > lastDate ? date : lastDate;
    }

    const withheld = {};
    if (combo?.unmatched.length) {
      for (const { g, n, sheet } of combo.unmatched) {
        const date = X.excelDate(g("transactiedatum")), amt = num(g("boekingsbedrag")), action = str(g("acties"));
        if (!date) continue;
        cash.push({ kind: "ANDERE", date, amount: amt ? amt.toString() : null, currency: str(g("valuta")).toUpperCase() || "EUR",
          asset_name: str(g("instrument")), description: `Transactie zonder aantal of prijs: ${action || "zonder omschrijving"}`, status: "info",
          remark: "niet als transactie ingelezen: voeg ze zelf toe", warn: true, owner, broker,
          import_id: cashId(str(g("transactie-id")), date, "unmatched", action, amt), import_source: `${fileName} (${sheet}:${n})` });
      }
      warnings.push(`${fileName} (${combo.unmatched.map(u => `${u.sheet}:${u.n}`).join(", ")}): transactie zonder uitvoering en zonder leesbare omschrijving – niet geïmporteerd. Voeg ze zelf toe.`);
    }
    if (combo) {
      const extra = corporateActions(combo, { out, cash, cashId, warnings, skipped, assets, assetKey, owner, broker, fileName, sheets: all });
      Object.assign(withheld, extra.withheld);
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
    const wYears = Object.keys(withheld);
    if (wYears.length) warnings.push(`Saxo hield meerwaardebelasting in: ${wYears.map(y => `${y}: € ${withheld[y]}`).join(", ")}. Dit bedrag wordt bij 'Ingehouden door broker' opgeteld.`);
    else if (!combo) warnings.push("Deze export toont geen door Saxo ingehouden meerwaardebelasting. Controleer op je Saxo-overzicht of er iets ingehouden werd; zo niet, dan geef je deze meerwaarden zelf aan.");
    return { source: "saxo", transactions: out, cash, withheld, skipped, warnings, refHints: {}, assets, positions, delistings, fileName, rows: lines.length, period: [firstDate, lastDate] };
  }
  const Dmin = (a, b) => (a.lte(b) ? a : b);

  /**
   * Standaardexport: dividenden, splitsingen, andere corporate actions en ingehouden meerwaardebelasting.
   * Voegt transacties toe aan `out` en geeft { withheld: { jaar: bedrag } } terug.
   */
  function corporateActions(combo, { out, cash, cashId, warnings, skipped, assets, assetKey, owner, broker, fileName, sheets }) {
    const count = k => { skipped[k] = (skipped[k] || 0) + 1; };
    let Bk = null;
    for (const [, rows] of sheets) if ((Bk = tableFrom(rows, ["amount type", "boekingsbedrag", "boekingsdatum"]))) break;
    const bookings = Bk ? Bk.rows.map(({ r }) => k => { const i = Bk.col(k); return i < 0 ? null : r[i]; }) : [];
    const nameOf = g => { const raw = str(g("instrument")), tag = delistedTag(raw); return (tag ? tag.name : raw).replace(/\s+/g, " "); };
    const assetOf = g => {
      const isin = str(g("instrument isin")).toUpperCase(), name = nameOf(g), key = assetKey(isin, name);
      assets[key] ??= { currency: str(g("instrumentvaluta")).toUpperCase() || "EUR", name, isin, symbol: str(g("instrumentsymbool")), kind: str(g("type")) };
      return key;
    };
    const base = { owner, broker, historic_proven: false, cost_known: true, reynders_eur: "0", fees: "0", taxes: "0", currency: "EUR", fx_per_eur: "1" };

    // ingehouden meerwaardebelasting per jaar (negatief geboekt; een terugbetaling is positief)
    const withheldD = {}, mwbRecords = new Set();
    for (const g of bookings) {
      if (norm(g("amount type")) !== "meerwaardebelasting") continue;
      const date = X.excelDate(g("boekingsdatum")), amt = num(g("boekingsbedrag"));
      if (!date || !amt) continue;
      const y = date.slice(0, 4);
      withheldD[y] = (withheldD[y] || ZERO).sub(amt);
      if (str(g("bk record id"))) mwbRecords.add(str(g("bk record id")));
    }
    const withheld = Object.fromEntries(Object.entries(withheldD).filter(([, v]) => !v.isZero()).map(([y, v]) => [y, v.round(2).toString()]));

    // geldbeweging ter info (telt niet mee voor de belasting)
    const addCash = (kind, g, src, { status = "info", remark = "", warn = false, amount, date, description, currency } = {}) => {
      const d = date || X.excelDate(g("transactiedatum")), amt = amount !== undefined ? amount : num(g("boekingsbedrag"));
      if (!d) return;
      const action = str(g("acties"));
      cash.push({ kind, date: d, amount: amt ? amt.toString() : amt === null ? null : "0", currency: currency || str(g("valuta")).toUpperCase() || "EUR",
        asset_name: nameOf(g), description: description ?? (action || str(g("transactietype"))), status, remark, ...(warn ? { warn } : {}), owner, broker,
        import_id: cashId(str(g("transactie-id")), str(g("bk record id")), str(g("corporate action-id")), d, kind, action, amt), import_source: src });
    };

    // dividenden: per corporate action netto (incl. terugboekingen)
    const divs = new Map();
    for (const { g, n, sheet } of combo.cash) {
      const type = norm(g("transactietype")), action = str(g("acties")), src = `${fileName} (${sheet}:${n})`;
      const date = X.excelDate(g("transactiedatum")), amt = num(g("boekingsbedrag"));
      if (type === "storting/opname") { addCash(amt && amt.lt(0) ? "OPNAME" : "STORTING", g, src); continue; }
      if (type !== "corporate action") { addCash("ANDERE", g, src, { description: [str(g("transactietype")), action].filter(Boolean).join(": ") }); continue; }
      if (/dividend/i.test(action) && date && amt) {
        const key = str(g("corporate action-id")) || `${str(g("instrument isin"))}|${date}`;
        const d = divs.get(key) || { g, sum: ZERO, date: null, actions: new Set(), src, lines: [] };
        d.sum = d.sum.add(amt); d.actions.add(action.replace(/\s*-\s*reversal$/i, "")); d.lines.push({ g, src });
        if (amt.gt(ZERO) && (!d.date || date < d.date)) { d.date = date; d.g = g; d.src = src; }
        divs.set(key, d);
      } else if (!action && mwbRecords.has(str(g("bk record id"))))
        addCash("MWB", g, src, { status: "verwerkt", remark: "al bij 'Ingehouden door broker'", description: "Ingehouden meerwaardebelasting" });
      else if (/splitsing|split|fractie/i.test(action)) addCash("FRACTIE", g, src, { status: "verwerkt", remark: "al verwerkt als verkoop van de fractie" });
      else if (/bod|overname|uitkoop/i.test(action)) addCash("BOD", g, src, { status: "verwerkt", remark: "al verwerkt als verkoop" });
      else if (/vermindering|terugbetaling/i.test(action)) {
        addCash("KAPVERM", g, src, { remark: "laat nakijken of dit de aanschaf- of fotowaarde verlaagt", warn: true });
        warnings.push(`${src}: ${action} ${nameOf(g)} op ${date}: € ${amt} ontvangen. Niet als transactie geïmporteerd (wel als geldbeweging): dit is geen verkoop. ` +
          "Of een kapitaalvermindering de aanschaf- of fotowaarde verlaagt, regelt de wet niet uitdrukkelijk – laat dit nakijken.");
      } else {
        addCash("CA", g, src, { remark: "controleer de betrokken positie", warn: true });
        warnings.push(`${src}: corporate action '${action || "zonder omschrijving"}' (${nameOf(g)}, ${date}, € ${amt ?? "?"}) niet als transactie geïmporteerd. Controleer de betrokken positie.`);
      }
    }
    for (const [key, d] of divs) {
      if (!d.date || !d.sum.gt(ZERO)) {
        for (const { g, src } of d.lines) addCash("DIV_TERUG", g, src, { remark: "dividend en terugboeking heffen elkaar op" });
        continue;
      }
      out.push({ ...base, type: "DIVIDEND", trade_date: d.date, asset: assetOf(d.g), amount: d.sum.round(2).toString(), quantity: "0", price: "0",
        split_ratio: null, note: `netto; ${[...d.actions].join(", ")}`, import_id: `s:div:${key}`, import_source: d.src });
    }

    // (omgekeerde) splitsingen: Saxo boekt een verkoop van de oude en een aankoop van de nieuwe stuks
    const groups = new Map();
    for (const e of combo.splits) { const k = str(e.g("corporate action-id")); groups.set(k, [...(groups.get(k) || []), e]); }
    for (const [ca, list] of groups) {
      const sells = list.filter(e => num(e.g("traded quantity"))?.lt(0)), buys = list.filter(e => num(e.g("traded quantity"))?.gt(0));
      const src = `${fileName} (${list.map(e => `_Transacties:${e.n}`).join(", ")})`;
      if (sells.length !== 1 || buys.length !== 1 || str(sells[0].g("instrument isin")) !== str(buys[0].g("instrument isin"))) {
        count("Splitsingen niet herkend");
        warnings.push(`${src}: splitsing (corporate action ${ca}) niet herkend – niet geïmporteerd. Voeg ze zelf toe als splitsing.`);
        continue;
      }
      const oldQ = abs(num(sells[0].g("traded quantity"))), newQ = num(buys[0].g("traded quantity"));
      const date = X.excelDate(buys[0].g("aangepaste transactiedatum")), asset = assetOf(buys[0].g), name = nameOf(buys[0].g);
      // gangbare verhouding (1 nieuw voor n oud of n nieuw voor 1 oud); het restant is een fractie die in cash uitbetaald wordt
      let ratio = null;
      const o = Number(oldQ.toString()), nw = Number(newQ.toString());
      if (nw < o) { const k = Math.round(o / nw); if (k > 1 && Math.floor(o / k) === nw) ratio = D(1).div(k); }
      else { const k = Math.round(nw / o); if (k >= 1 && o * k === nw) ratio = D(k); }
      let exact = true;
      if (!ratio) { ratio = newQ.div(oldQ); exact = false; }
      out.push({ ...base, type: "SPLIT", trade_date: date, asset, quantity: "0", price: "0", amount: "0", split_ratio: ratio.toString(),
        note: `${name}; ${str(buys[0].g("acties")) || "splitsing"}: ${oldQ} → ${newQ}`, import_id: `s:split:${ca}`, import_source: src });
      const frac = oldQ.mul(ratio).sub(newQ);
      let msg = `${name}: ${str(buys[0].g("acties")) || "splitsing"} op ${date}, ${oldQ} → ${newQ} stuks, verwerkt als splitsing met verhouding ${ratio}`;
      if (!exact) msg += " (geen gangbare verhouding gevonden: controleer)";
      if (frac.gt(ZERO)) {
        const cash = bookings.filter(g => str(g("corporate action-id")) === ca && /fractie/i.test(str(g("amount type"))));
        const cashAmt = cash.reduce((s, g) => s.add(num(g("boekingsbedrag")) || ZERO), ZERO);
        const cashDate = cash.map(g => X.excelDate(g("boekingsdatum"))).filter(Boolean).sort()[0];
        const fDate = cashDate && cashDate > date ? cashDate : date;
        out.push({ ...base, type: "SELL", trade_date: fDate, asset, quantity: frac.toString(), price: cashAmt.gt(ZERO) ? cashAmt.div(frac).round(6).toString() : "0",
          amount: "0", split_ratio: null, note: `${name}; fractie na ${str(buys[0].g("acties")) || "splitsing"}, uitbetaald in cash`, import_id: `s:frac:${ca}`, import_source: src });
        msg += `; fractie ${frac} verkocht voor € ${cashAmt.round(2)}` + (cashAmt.gt(ZERO) ? "" : " (geen cashbedrag gevonden: controleer)");
      }
      warnings.push(msg + ".");
    }
    for (const e of combo.dupes) {
      const v = num(e.g("verhandelde waarde"));
      addCash("DUBBEL", e.g, `${fileName} (_Transacties:${e.n})`, { status: "verwerkt", remark: "kopie van een andere regel, telt niet",
        date: X.excelDate(e.g("aangepaste transactiedatum") ?? e.g("trade execution date")), amount: v ?? null,
        description: `${str(e.g("acties")) || "corporate action"} (${num(e.g("traded quantity")) ?? "?"} stuks)`,
        currency: str(e.g("instrumentvaluta")).toUpperCase() || "EUR" });
    }
    if (combo.bookedCcy.length) warnings.push(`Je Saxo-rekening boekt in ${[...new Set(combo.bookedCcy)].join(", ")}: dividenden en kosten zijn als EUR overgenomen. Controleer ze.`);
    return { withheld };
  }

  /**
   * Eerder geïmporteerde transacties (zelfde import-id) die onder een andere naam staan, bv. de ISIN of
   * een ticker uit een vorige versie, verhuizen naar de naam van deze import. -> Map oude -> nieuwe naam
   */
  function keyMigrations(existing, incoming) {
    const byId = new Map(existing.filter(t => t.import_id).map(t => [t.import_id, t]));
    const plan = new Map();
    for (const t of incoming) {
      const old = byId.get(t.import_id);
      if (old && old.asset !== t.asset && !plan.has(old.asset)) plan.set(old.asset, t.asset);
    }
    return plan;
  }

  async function parseSaxoFile(buf, opts) {
    const sheets = await X.readXlsx(buf);
    return parseSaxoSheets(sheets, opts);
  }

  const api = { parseSaxoSheets, parseSaxoFile, delistedTag, keyMigrations };
  if (node) module.exports = api; else root.SAXO = api;
})(typeof window !== "undefined" ? window : globalThis);
