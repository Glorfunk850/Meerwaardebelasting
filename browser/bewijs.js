"use strict";
/*
 * Bewijsstukken (bijlagen) bij transacties: zuivere hulpfuncties, los van de opslag.
 * Een bijlage in de toestand: { id, name, type, size, added, store } met store "account" (claude.ai-pagina,
 * bestand bij de pagina zelf) of "browser" (IndexedDB, buiten claude.ai). Het bestand zelf zit nooit in de JSON.
 */
(function (root) {
  const MAX_BYTES = 20 * 1024 * 1024; // limiet per bestand van de claude.ai-opslag
  const TYPES = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/markdown",
  };
  const ACCEPT = Object.keys(TYPES).map(e => "." + e).join(",") + "," + [...new Set(Object.values(TYPES))].join(",");
  const ACQ = ["BUY", "TRANSFER_IN", "GIFT_IN", "INHERIT_IN"];

  /** Inhoudstype op basis van de extensie (de browser geeft soms een leeg of afwijkend type); null = niet toegelaten. */
  function contentType(name, browserType) {
    const ext = String(name || "").toLowerCase().split(".").pop();
    if (TYPES[ext]) return TYPES[ext];
    const t = String(browserType || "").split(";")[0].trim().toLowerCase();
    return Object.values(TYPES).includes(t) ? t : null;
  }

  /** Controle vóór het opslaan; geeft een foutmelding of null. */
  function checkFile(name, browserType, size) {
    if (!contentType(name, browserType))
      return `'${name}': dit bestandstype kan niet bewaard worden. Gebruik PDF, een foto (JPG, PNG, WEBP, GIF) of tekst (TXT, CSV).`;
    if (!size) return `'${name}' is leeg.`;
    if (size > MAX_BYTES) return `'${name}' is groter dan 20 MB.`;
    return null;
  }

  function sizeLabel(n) {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
    return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
  }

  /**
   * Transacties die een bewijs zouden moeten hebben maar er geen hebben: verwervingen (aankoop, overdracht,
   * schenking, erfenis) en verkopen van activa die (per eigenaar) nog in bezit zijn, plus alle verkopen
   * vanaf 2026 (belastbaar moment). heldKeys = Set van `${owner}\u0000${asset}`.
   */
  function missingProof(transactions, heldKeys) {
    return transactions.filter(t => {
      if ((t.attachments || []).length) return false;
      const held = heldKeys.has(`${t.owner}\u0000${t.asset}`);
      if (ACQ.includes(t.type)) return held;
      if (t.type === "SELL" || (t.type === "DELISTING" && t.delist_mode === "UITKOOP"))
        return held || t.trade_date >= "2026-01-01";
      return false;
    });
  }

  /** Bijlagen die na het bewerken niet meer gebruikt worden (om de bestanden zelf te verwijderen). */
  function removedAttachments(before, after) {
    const keep = new Set((after || []).map(a => a.id));
    return (before || []).filter(a => !keep.has(a.id));
  }

  /** Alle bijlagen waar nog een transactie naar verwijst. */
  function usedIds(transactions) {
    return new Set(transactions.flatMap(t => (t.attachments || []).map(a => a.id)));
  }

  // ------------------------------------------------------------ back-up met bestanden
  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  /** Unieke bijlagen (per id) uit de transacties, in volgorde van voorkomen. */
  function allAttachments(transactions) {
    const seen = new Map();
    for (const t of transactions) for (const a of t.attachments || []) if (!seen.has(a.id)) seen.set(a.id, a);
    return [...seen.values()];
  }
  /** Verwijzingen vervangen na herstel: map oude id -> nieuwe bijlage (id, store, …). Geeft het aantal aanpassingen. */
  function remapAttachments(transactions, map) {
    let n = 0;
    for (const t of transactions) {
      if (!t.attachments) continue;
      t.attachments = t.attachments.map(a => { const m = map.get(a.id); if (!m) return a; n++; return { ...a, ...m }; });
    }
    return n;
  }
  /** Back-up splitsen in toestand en bestanden (de bestanden horen nooit in de opgeslagen toestand). */
  function splitBackup(obj) {
    if (!obj || typeof obj !== "object") return { state: obj, files: {} };
    const { proof_files, ...state } = obj;
    return { state, files: proof_files && typeof proof_files === "object" ? proof_files : {} };
  }

  const api = { MAX_BYTES, ACCEPT, contentType, checkFile, sizeLabel, missingProof, removedAttachments, usedIds,
    toBase64, fromBase64, allAttachments, remapAttachments, splitBackup };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BEWIJS = api;
})(typeof window !== "undefined" ? window : globalThis);
