/* Synchroniseren tussen toestellen (enkel de installeerbare app op GitHub Pages; op claude.ai synchroniseert het account).
 *
 * Werkt zoals de synchronisatie van DuckDuckGo en dezelfde server als Voorraadbeheer (Cloudflare Worker, map
 * sync-server in die repository): een willekeurige koppelcode (160 bits) is het enige geheim. Daaruit worden op het
 * toestel afgeleid: het nummer van de "ruimte" op de server, een schrijftoken en de sleutel om te versleutelen
 * (AES-256-GCM). De server krijgt alleen versleutelde bytes en kent de code niet. Een eigen "salt" zorgt dat deze
 * tool nooit dezelfde ruimte gebruikt als Voorraadbeheer, ook niet met dezelfde code.
 *
 * Samenvoegen is drie-weg: `basis` is wat dit toestel en de server laatst gemeen hadden. Wat maar aan één kant
 * veranderde, wordt overgenomen; veranderde hetzelfde item aan beide kanten, dan per veld; alleen als hetzelfde veld
 * aan beide kanten anders werd, wint dit toestel. Een item dat aan de ene kant gewist en aan de andere kant gewijzigd
 * werd, blijft bestaan (er gaat geen transactie verloren).
 *
 * Werkt in de browser (window.SYNC) en in Node (voor de tests). */
(function (root) {
  "use strict";
  const node = typeof module !== "undefined" && module.exports;
  const ALFABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: geen I, L, O, U
  const SALT = "meerwaardebelasting-sync-v1";
  const MAGIC = 77; // 'M'
  const enc = t => new TextEncoder().encode(t);
  const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  const b64url = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // ------------------------------------------------------------------ koppelcode
  function naarCode(bytes) {
    let bits = 0, w = 0, uit = "";
    for (const x of bytes) { w = ((w << 8) | x) & 0xffff; bits += 8; while (bits >= 5) { uit += ALFABET[(w >>> (bits - 5)) & 31]; bits -= 5; } }
    if (bits) uit += ALFABET[(w << (5 - bits)) & 31];
    return uit;
  }
  /** Code zoals getypt (met of zonder streepjes, kleine letters, O voor 0 …) → 20 bytes, of null als ze niet klopt. */
  function codeBytes(tekst) {
    const t = String(tekst || "").toUpperCase().replace(/[\s\-–.]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    if (t.length !== 32 || [...t].some(c => !ALFABET.includes(c))) return null;
    const uit = new Uint8Array(20);
    let bits = 0, w = 0, i = 0;
    for (const c of t) { w = ((w << 5) | ALFABET.indexOf(c)) & 0xffff; bits += 5; if (bits >= 8) { uit[i++] = (w >>> (bits - 8)) & 255; bits -= 8; } }
    return uit;
  }
  const nieuweCode = () => naarCode(crypto.getRandomValues(new Uint8Array(20)));
  const codeNetjes = code => { const b = codeBytes(code); return b ? naarCode(b).match(/.{4}/g).join("-") : ""; };

  // ------------------------------------------------------------------ sleutels en versleuteling
  async function sleutels(code) {
    const bytes = codeBytes(code);
    if (!bytes) throw new Error("Deze code klopt niet: ze heeft 32 tekens (cijfers en letters).");
    const basis = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits", "deriveKey"]);
    const hkdf = info => ({ name: "HKDF", hash: "SHA-256", salt: enc(SALT), info: enc(info) });
    return {
      ruimte: hex(await crypto.subtle.deriveBits(hkdf("ruimte"), basis, 128)),
      token: b64url(await crypto.subtle.deriveBits(hkdf("schrijven"), basis, 256)),
      aes: await crypto.subtle.deriveKey(hkdf("versleutelen"), basis, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    };
  }
  const zip = async (bytes, in_) => new Uint8Array(await new Response(new Blob([bytes]).stream()
    .pipeThrough(in_ ? new CompressionStream("gzip") : new DecompressionStream("gzip"))).arrayBuffer());
  // pakket: 'M', formaat 1, gecomprimeerd (0/1), 12 bytes iv, versleutelde gegevens
  async function versleutelen(gegevens, k) {
    let ruw = enc(JSON.stringify(gegevens)), gz = 0;
    if (typeof CompressionStream === "function") { ruw = await zip(ruw, true); gz = 1; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const geheim = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc(k.ruimte) }, k.aes, ruw));
    const uit = new Uint8Array(15 + geheim.length);
    uit.set([MAGIC, 1, gz]); uit.set(iv, 3); uit.set(geheim, 15);
    return uit;
  }
  async function ontsleutelen(buffer, k) {
    const b = new Uint8Array(buffer);
    if (b[0] !== MAGIC || b[1] !== 1) throw new Error("Het pakket op de server is niet van deze tool, of van een nieuwere versie. Werk de app bij.");
    let ruw;
    try { ruw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(3, 15), additionalData: enc(k.ruimte) }, k.aes, b.slice(15))); }
    catch { throw new Error("De gegevens op de server konden niet ontsleuteld worden. Klopt de code?"); }
    if (b[2] === 1) ruw = await zip(ruw, false);
    return JSON.parse(new TextDecoder().decode(ruw));
  }

  // ------------------------------------------------------------------ samenvoegen
  const isObj = x => x !== null && typeof x === "object" && !Array.isArray(x);
  /** Diep vergelijken; de volgorde van de sleutels telt niet, undefined telt als afwezig. */
  function gelijk(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => gelijk(x, b[i]));
    if (isObj(a)) {
      if (!isObj(b)) return false;
      const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
      return ka.length === kb.length && ka.every(k => gelijk(a[k], b[k]));
    }
    return false;
  }
  /** Eén waarde: b = basis, l = lokaal, r = extern; undefined = bestaat niet (meer). */
  function waarde(b, l, r) {
    if (gelijk(l, r)) return l;
    if (gelijk(l, b)) return r; // alleen extern gewijzigd
    if (gelijk(r, b)) return l; // alleen lokaal gewijzigd
    if (l === undefined) return r; // lokaal gewist, extern gewijzigd: houden
    if (r === undefined) return l;
    if (isObj(l) && isObj(r)) return object(isObj(b) ? b : {}, l, r);
    return l;
  }
  function object(b, l, r) {
    b = isObj(b) ? b : {}; l = isObj(l) ? l : {}; r = isObj(r) ? r : {};
    const uit = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const v = waarde(b[k], l[k], r[k]);
      if (v !== undefined) uit[k] = v;
    }
    return uit;
  }
  /** Lijst van items met een sleutel: per item samenvoegen. Volgorde: die van de server, met wat alleen op dit toestel
   *  bijkwam achteraan. Zo komen alle toestellen op dezelfde volgorde uit; die telt, want de rekenkern houdt bij
   *  transacties op dezelfde dag de volgorde van de lijst aan (engine.js). */
  function items(b, l, r, sleutel) {
    const kaart = a => new Map((Array.isArray(a) ? a : []).filter(isObj).map(x => [sleutel(x), x]));
    const B = kaart(b), L = kaart(l), R = kaart(r), uit = [], gezien = new Set();
    for (const k of [...R.keys(), ...L.keys()]) {
      if (gezien.has(k)) continue;
      gezien.add(k);
      const v = waarde(B.get(k), L.get(k), R.get(k));
      if (v !== undefined) uit.push(v);
    }
    return uit;
  }
  const OP_ID = x => String(x.id);
  const LIJSTEN = {
    transactions: OP_ID,
    cash: OP_ID,
    withheld: w => `${w.owner}\u0000${w.year}`, // één bedrag per eigenaar en jaar
  };
  const OBJECTEN = ["assets", "years", "settings"]; // per sleutel (actief, jaar, instelling) en per veld

  /** De volledige toestand samenvoegen. basis mag null zijn (dan wordt alles van beide kanten gehouden). */
  function samenvoegen(basis, lokaal, extern) {
    const b = basis || {}, l = lokaal || {}, r = extern || {};
    const uit = {};
    for (const k of new Set([...Object.keys(l), ...Object.keys(r)])) {
      let v;
      if (LIJSTEN[k]) v = items(b[k], l[k], r[k], LIJSTEN[k]);
      else if (OBJECTEN.includes(k)) v = object(b[k], l[k], r[k]);
      else if (k === "nextId") v = Math.max(+l[k] || 1, +r[k] || 1);
      else v = waarde(b[k], l[k], r[k]);
      if (v !== undefined) uit[k] = v;
    }
    return uit;
  }

  /** Een nieuw id. Met synchronisatie maken meerdere toestellen transacties aan: dan een id op basis van de tijd
   *  (in microseconden, plus toeval), dat niet botst. Zonder synchronisatie gewoon doortellen. */
  function nieuwId(state, gesynchroniseerd, nu = Date.now()) {
    const n = Math.max(+state.nextId || 1, gesynchroniseerd ? nu * 1000 + Math.floor(Math.random() * 1000) : 0);
    state.nextId = n + 1;
    return n;
  }
  /** Transacties en geldbewegingen van dit toestel een nieuw, uniek id geven (bij koppelen met behoud van beide). */
  function nieuweIds(state, maakId) {
    const uit = JSON.parse(JSON.stringify(state));
    for (const t of uit.transactions || []) t.id = maakId();
    for (const c of uit.cash || []) c.id = maakId();
    return uit;
  }
  const telling = s => ({ transacties: (s?.transactions || []).length, geldbewegingen: (s?.cash || []).length });

  const api = { naarCode, codeBytes, nieuweCode, codeNetjes, sleutels, versleutelen, ontsleutelen, gelijk, samenvoegen, nieuwId, nieuweIds, telling };
  if (node) module.exports = api; else root.SYNC = api;
})(typeof window !== "undefined" ? window : globalThis);
