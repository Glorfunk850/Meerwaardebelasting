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

  const api = { isIsin, isNameKey, nameFromKey, fillNames, applyAliases, renameAsset, normKey };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ASSETS = api;
})(typeof window !== "undefined" ? window : globalThis);
