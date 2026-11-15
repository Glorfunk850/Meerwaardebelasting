/* Beheer van de sleutels van activa (ISIN/ticker) los van de naam.
 * De Bolero-export bevat geen ISIN's: daar wordt de naam (met beurscode) als sleutel gebruikt.
 * De gebruiker kan die sleutel achteraf vervangen door de ISIN of ticker; de oude sleutel blijft
 * als alias bewaard zodat een latere import van hetzelfde bestand op hetzelfde actief terechtkomt. */
(function (root) {
  "use strict";

  const isIsin = k => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(k || ""));
  /** Sleutel die uit een naam bestaat (Bolero, of Saxo zonder ISIN): bevat een spatie of beurscode. */
  const isNameKey = k => !isIsin(k) && /\s/.test(String(k || ""));
  /** "VOORBEELD NV (PA)" -> "VOORBEELD NV" */
  const nameFromKey = k => String(k).replace(/\s*\(\w\w\)$/, "").trim();

  /** Vul ontbrekende namen in voor activa waarvan de sleutel zelf een naam is. Geeft het aantal terug. */
  function fillNames(state) {
    let n = 0;
    for (const [k, a] of Object.entries(state.assets || {}))
      if (a && !a.name && isNameKey(k)) { a.name = nameFromKey(k); n++; }
    return n;
  }

  const resolve = (aliases, k) => {
    const seen = new Set();
    while (aliases && aliases[k] && !seen.has(k)) { seen.add(k); k = aliases[k]; }
    return k;
  };

  /** Zet de sleutels in een importresultaat om volgens de aliassen (in place). */
  function applyAliases(r, aliases) {
    if (!aliases || !Object.keys(aliases).length) return r;
    const map = k => resolve(aliases, k);
    for (const t of r.transactions || []) t.asset = map(t.asset);
    for (const p of r.positions || []) p.asset = map(p.asset);
    for (const d of r.delistings || []) d.asset = map(d.asset);
    const remap = obj => {
      if (!obj) return obj;
      const out = {};
      for (const [k, v] of Object.entries(obj)) { const nk = map(k); out[nk] ??= v; }
      return out;
    };
    r.assets = remap(r.assets);
    r.refHints = remap(r.refHints);
    return r;
  }

  /** Normaliseer een door de gebruiker ingevoerde sleutel. */
  const normKey = k => String(k || "").replace(/\s+/g, " ").trim().toUpperCase();

  /**
   * Hernoem sleutel `from` naar `to` in de hele toestand: activa, transacties, import-id's van
   * correcties/delistings en aliassen. Bestaat `to` al, dan worden beide samengevoegd (velden van
   * `to` hebben voorrang, lege velden worden aangevuld). Geeft het aantal aangepaste transacties terug.
   */
  function renameAsset(state, from, to) {
    to = normKey(to);
    if (!to) throw new Error("ISIN/ticker mag niet leeg zijn.");
    if (from === to) return 0;
    const src = state.assets[from] || {};
    const dst = state.assets[to];
    const merged = { ...src };
    if (dst) for (const [k, v] of Object.entries(dst)) if (v != null && v !== "") merged[k] = v;
    if (!merged.name && isNameKey(from)) merged.name = nameFromKey(from);
    if (dst && !dst.hidden) delete merged.hidden;
    delete state.assets[from];
    state.assets[to] = merged;

    let n = 0;
    for (const t of state.transactions) {
      if (t.asset === from) { t.asset = to; n++; }
      if (typeof t.import_id === "string") {
        if (t.import_id === `corr:${t.owner}:${from}`) t.import_id = `corr:${t.owner}:${to}`;
        else if (t.import_id.startsWith(`delist:${t.owner}:${from}:`))
          t.import_id = `delist:${t.owner}:${to}:` + t.import_id.slice(`delist:${t.owner}:${from}:`.length);
      }
    }
    state.aliases ??= {};
    for (const [k, v] of Object.entries(state.aliases)) if (v === from) state.aliases[k] = to;
    delete state.aliases[to];
    state.aliases[from] = to;
    return n;
  }

  // ------------------------------------------------------------ ISIN's laten voorstellen
  /** Controlecijfer van een ISIN (ISO 6166): letters -> 10..35, dan Luhn over alle cijfers. */
  function isinChecksumOk(isin) {
    if (!isIsin(isin)) return false;
    const digits = [...isin].map(c => (/[0-9]/.test(c) ? c : String(c.charCodeAt(0) - 55))).join("");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }

  /** Activa zonder ISIN als sleutel, met wat Claude nodig heeft om ze te herkennen (geen bedragen). */
  function isinCandidates(state) {
    return Object.entries(state.assets || {})
      .filter(([k]) => !isIsin(k))
      .map(([k, a]) => {
        const m = /\((\w\w)\)$/.exec(k);
        return { key: k, name: (a && a.name) || nameFromKey(k), exchange: m ? m[1] : "", currency: (a && a.currency) || "" };
      });
  }

  const EXCHANGES = "BR=Euronext Brussel, PA=Euronext Parijs, AS=Euronext Amsterdam, LS=Euronext Lissabon, MI=Milaan, MC=Madrid, " +
    "FR/DE/XE=Duitsland, VI=Wenen, HE=Helsinki, IR=Dublin, DU=Düsseldorf, NY=New York (NYSE), NA=Nasdaq, LO=Londen, " +
    "OS=Oslo, ST=Stockholm, CO=Kopenhagen, SW=Zwitserland, TO=Toronto, MO=Montreal";

  /** Opdracht voor Claude: geef per effect de ISIN, of null als je het niet zeker weet. */
  function isinPrompt(items) {
    return [
      "Je helpt een Belgische belegger de ISIN-codes te vinden van effecten uit een broker-export (Bolero).",
      "De namen zijn door de broker afgekort en in hoofdletters. De beurscode tussen haakjes betekent: " + EXCHANGES + ".",
      "Geef voor elk effect de ISIN van precies dat effect (aandeel, ETF of fonds) zoals het op die beurs noteert.",
      "Raad niet: ben je niet zeker welk effect bedoeld wordt, geef dan isin null. Een fout ISIN is erger dan geen.",
      "Antwoord ALLEEN met JSON in deze vorm, één element per effect, met dezelfde key:",
      '[{"key": "...", "isin": "XX0000000000" of null, "ticker": "..." of null, "official_name": "..." of null, "confidence": "hoog" | "middel" | "laag", "remark": "korte uitleg of leeg"}]',
      "",
      "Effecten:",
      JSON.stringify(items.map(i => ({ key: i.key, name: i.name, exchange: i.exchange || null, currency: i.currency || null }))),
    ].join("\n");
  }

  /** Antwoord van Claude controleren: enkel gekende sleutels, geldig ISIN-formaat en controlecijfer. */
  function parseIsinAnswer(answer, items) {
    const list = Array.isArray(answer) ? answer : Array.isArray(answer && answer.results) ? answer.results : [];
    const byKey = new Map(items.map(i => [i.key, i]));
    const out = new Map();
    for (const r of list) {
      if (!r || typeof r !== "object" || !byKey.has(r.key) || out.has(r.key)) continue;
      const isin = r.isin ? normKey(r.isin).replace(/\s/g, "") : "";
      const confidence = ["hoog", "middel", "laag"].includes(r.confidence) ? r.confidence : "laag";
      let problem = "";
      if (!isin) problem = "niet gevonden";
      else if (!isIsin(isin)) problem = "geen geldig ISIN-formaat";
      else if (!isinChecksumOk(isin)) problem = "controlecijfer klopt niet";
      out.set(r.key, { ...byKey.get(r.key), isin: problem ? "" : isin, ticker: String(r.ticker || "").trim(),
        official_name: String(r.official_name || "").trim(), confidence, remark: String(r.remark || "").trim(), problem });
    }
    return items.map(i => out.get(i.key) || { ...i, isin: "", ticker: "", official_name: "", confidence: "laag", remark: "", problem: "geen antwoord" });
  }

  const api = { isIsin, isNameKey, nameFromKey, fillNames, applyAliases, renameAsset, normKey,
    isinChecksumOk, isinCandidates, isinPrompt, parseIsinAnswer };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ASSETS = api;
})(typeof window !== "undefined" ? window : globalThis);
