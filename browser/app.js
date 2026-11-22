"use strict";
/* Interface + opslag. Alle berekeningen via MWB (engine.js). */
const { D, Dec, calculate, defaultConfig } = window.MWB;
const GELD = window.GELD;

const TYPE_LABELS = {
  BUY: "Aankoop", SELL: "Verkoop", SPLIT: "Splitsing", DIVIDEND: "Dividend", FEE: "Kosten",
  TRANSFER_IN: "Overdracht in", GIFT_IN: "Schenking", INHERIT_IN: "Erfenis", DELISTING: "Delisting",
  RUIL: "Omruiling (fusie/overname)",
};
const DELIST_LABELS = { NOTERING: "Enkel schrapping notering", UITKOOP: "Uitkoop / bod tegen prijs", WAARDELOOS: "Waardeloos (faillissement/vereffening)" };
const DELIST_SHORT = { NOTERING: "schrapping", UITKOOP: "uitkoop", WAARDELOOS: "waardeloos" };
const EVENT_SHORT = { ...DELIST_SHORT, RUIL: "omruiling" };
const BASIS_LABELS = { AANKOOP: "aankoopprijs", REF_31_12_2025: "waarde 31/12/2025", HISTORISCH: "historische prijs", ONBEKEND: "onbekend (0)" };
const ACQ = ["BUY", "TRANSFER_IN", "GIFT_IN", "INHERIT_IN"];
const ASSET_TYPES = ["aandeel", "etf", "obligatie", "fonds", "crypto", "valuta", "verzekering", "ander"];
const TABS = ["rapport", "simulatie", "transacties", "activa", "instellingen"];
const DEFAULT_OWNER = "ik";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = v => v == null ? "–" : "€ " + nf.format(Number(v));
function num(v) {
  if (v == null || v === "") return "";
  const s = String(v), neg = s.startsWith("-");
  const [i, d] = s.replace("-", "").split(".");
  const ip = BigInt(i || "0").toLocaleString("nl-BE");
  const dp = d ? d.replace(/0+$/, "") : "";
  return (neg ? "-" : "") + (dp ? `${ip},${dp}` : ip);
}
const signClass = v => Number(v) > 0 ? "pos" : Number(v) < 0 ? "neg" : "";

// ================================================================ toestand
function emptyState() {
  return {
    version: 1, nextId: 1, transactions: [], cash: [], assets: {}, withheld: [],
    years: { 2026: { rate: "0.10", base_exemption: "10000", carry_slice: "1000", carry_validity_years: 5,
                     source: "Wet 6.4.2026 (BS 21.4.2026); vrijstelling 2026 = 10.000 EUR" } },
    settings: { historic_method: "FIFO", fifo_scope: "EIGENAAR" },
  };
}
let state = emptyState();

function validState(s) {
  const ok = s && typeof s === "object" && Array.isArray(s.transactions) && s.assets && typeof s.assets === "object"
    && s.years && s.settings && Array.isArray(s.withheld);
  if (ok && !Array.isArray(s.cash)) s.cash = []; // opgeslagen vóór er geldbewegingen waren
  return ok;
}

// ================================================================ opslag
const LS_KEY = "meerwaarde-state-v1";
const storage = { mode: "geheugen", db: null, ref: null, base: null, writing: false, pending: null, lastJson: null };
const CHUNK = 90000; // tekens per opslagdeel (documentlimiet 256 KB, ruime marge voor escaping)

function lsGet() { try { return localStorage.getItem(LS_KEY); } catch { return null; } }
function lsSet(v) { try { localStorage.setItem(LS_KEY, v); return true; } catch { return false; } }

async function initStorage() {
  const local = lsGet();
  if (local) { try { const s = JSON.parse(local); if (validState(s)) { state = s; if (migrateToNames()) lsSet(JSON.stringify(state)); } } catch {} }
  let lsOk = false;
  try { localStorage.setItem(LS_KEY + "-test", "1"); localStorage.removeItem(LS_KEY + "-test"); lsOk = true; } catch {}
  storage.mode = lsOk ? "browser" : "geheugen";
  renderStorageStatus();
  render();

  const use = window.claude && typeof window.claude.use === "function" ? window.claude.use.bind(window.claude) : null;
  if (!use) return;
  try {
    const [db, user] = await Promise.all([use("db"), use("user")]);
    const uid = user ? await user.id() : null;
    if (!db || !uid) return;
    storage.db = db;
    storage.base = `data/users/${uid}/state`;
    storage.ref = db.doc(storage.base);
    storage.mode = "account-laden";
    renderStorageStatus();
    const timer = setTimeout(() => { if (storage.mode === "account-laden") { storage.mode = "account-traag"; renderStorageStatus(); } }, 10000);
    storage.ref.onSnapshot(async snap => {
      clearTimeout(timer);
      const wasLoading = storage.mode !== "account";
      storage.mode = "account";
      if (snap.exists) {
        // eigen (lopende) schrijfacties niet terug inlezen: enkel wijzigingen van een ander toestel
        const busy = () => storage.writing || storage.pending != null || snap.metadata.hasPendingWrites;
        if (!busy()) {
          const json = await readStoredJson(snap.data());
          if (json && json !== storage.lastJson && !busy()) {
            try {
              const s = JSON.parse(json);
              if (validState(s)) { state = s; storage.lastJson = json; lsSet(json); if (migrateToNames()) persist(); render(); }
            } catch {}
          }
        }
      } else if (wasLoading && state.transactions.length) {
        persist(); // gegevens uit deze browser naar het account overzetten
      }
      renderStorageStatus();
    }, err => {
      clearTimeout(timer);
      storage.mode = storage.mode === "account" ? "account-fout" : (lsGet() !== null ? "browser" : "geheugen");
      storage.ref = null;
      renderStorageStatus(err && err.code);
    });
  } catch { /* geen account-opslag: lokaal verder */ }
}

/** Hoofddocument bevat de JSON zelf, of verwijst naar delen state-p0, state-p1, … met dezelfde stempel. */
async function readStoredJson(d) {
  if (typeof d.json === "string") return d.json;
  if (!d.parts) return null;
  const parts = await Promise.all(Array.from({ length: d.parts }, (_, i) => storage.db.doc(`${storage.base}-p${i}`).get()));
  if (parts.some(p => !p.exists || p.data().stamp !== d.stamp)) return null; // nog niet volledig geschreven
  return parts.map(p => p.data().chunk).join("");
}
function persist() {
  const json = JSON.stringify(state);
  lsSet(json);
  syncPlan();
  if (!storage.ref) return;
  storage.pending = json;
  flush();
}
async function flush() {
  if (storage.writing || storage.pending == null || !storage.ref) return;
  const json = storage.pending; storage.pending = null; storage.writing = true;
  storage.lastJson = json;
  try {
    const updated = new Date().toISOString();
    if (json.length <= CHUNK) await storage.ref.set({ json, updated });
    else {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const n = Math.ceil(json.length / CHUNK);
      for (let i = 0; i < n; i++)
        await storage.db.doc(`${storage.base}-p${i}`).set({ chunk: json.slice(i * CHUNK, (i + 1) * CHUNK), stamp, i });
      await storage.ref.set({ parts: n, stamp, updated });
    }
  } catch (e) {
    if (e && e.code === "unavailable") { await new Promise(r => setTimeout(r, 800 + Math.random() * 800)); storage.pending ??= json; }
    else { toast("Opslaan in je account mislukt" + (e && e.code ? ` (${e.code})` : "") + ". Je gegevens staan nog in deze browser."); }
  } finally { storage.writing = false; if (storage.pending != null) flush(); }
}
function commit() { persist(); render(); }

// ================================================================ synchroniseren tussen toestellen (sync.js)
// Enkel buiten claude.ai (de installeerbare app op GitHub Pages): op claude.ai synchroniseert het Claude-account al.
// Versleuteld op het toestel met de koppelcode; de server (dezelfde als Voorraadbeheer) ziet alleen onleesbare bytes.
// De koppeling (code, server, laatst gedeelde versie) staat alleen op dit toestel, in localStorage.
const SYNC = window.SYNC;
const SYNC_KEY = "meerwaarde-sync-v1";
const SYNC_SERVER = "https://voorraad-sync.chug-erratic-roman.workers.dev"; // eigen Cloudflare Worker (zie README)
const sync = { z: null, k: null, timer: null, chain: Promise.resolve(), busy: false, proposal: null, showCode: false, codeForm: false, hashLink: null };
const syncAvailable = () => !window.claude && typeof crypto !== "undefined" && !!crypto.subtle;
const syncOn = () => !!(sync.z && sync.k);
function newId() { return SYNC.nieuwId(state, syncOn()); }
const deepCopy = x => JSON.parse(JSON.stringify(x));

function syncSave() {
  try {
    if (sync.z) localStorage.setItem(SYNC_KEY, JSON.stringify(sync.z)); else localStorage.removeItem(SYNC_KEY);
  } catch { /* geen opslag: de koppeling geldt dan tot de pagina sluit */ }
}
function syncLoadStored() { try { return JSON.parse(localStorage.getItem(SYNC_KEY) || "null"); } catch { return null; } }
const serverNeat = a => { let t = String(a || "").trim().replace(/\/+$/, ""); if (t && !/^https?:\/\//i.test(t)) t = "https://" + t; return t; };

async function syncServer(server, k, method, { version = 0, fresh = false, body } = {}) {
  const h = {};
  if (method !== "GET") h.Authorization = "Bearer " + k.token;
  if (method === "GET" && version) h["If-None-Match"] = `"${version}"`;
  if (method === "PUT") { h["Content-Type"] = "application/octet-stream"; if (fresh) h["If-None-Match"] = "*"; else h["If-Match"] = `"${version}"`; }
  const stop = new AbortController(), clock = setTimeout(() => stop.abort(), 30000);
  let r;
  try { r = await fetch(`${server}/r/${k.ruimte}`, { method, headers: h, body, cache: "no-store", signal: stop.signal }); }
  catch { throw Object.assign(new Error(navigator.onLine ? "De synchronisatieserver is niet bereikbaar." : "Geen internet."), { network: true }); }
  finally { clearTimeout(clock); }
  const et = r.headers.get("ETag");
  return { status: r.status, version: et ? +et.replace(/\D/g, "") : 0, r };
}
async function syncCheckServer(server) {
  if (!/^https:\/\/[^/\s]+\.[^/\s]+|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(server)) throw new Error("Dit is geen geldig adres van een synchronisatieserver.");
  let t = "";
  try { t = await (await fetch(server + "/", { cache: "no-store" })).text(); }
  catch { throw new Error(navigator.onLine ? `${server} is niet bereikbaar.` : "Geen internet."); }
  if (!/synchronisatieserver/i.test(t)) throw new Error(`Op ${server} staat geen synchronisatieserver.`);
}
/** Samengevoegde of overgenomen toestand in gebruik nemen (zonder zelf een nieuwe synchronisatie te plannen). */
function syncAdopt(s) {
  if (!validState(s)) throw new Error("De gegevens op de server hebben niet de vorm van deze tool.");
  state = s;
  migrateToNames();
  lsSet(JSON.stringify(state));
  render();
}

/** Eén ronde: ophalen, samenvoegen, versturen. Bij een botsing (ander toestel was sneller) opnieuw. */
async function syncRound() {
  if (!syncOn()) return;
  // een ander venster van de app kan intussen gesynchroniseerd of gestopt hebben
  const stored = syncLoadStored();
  if (!stored && sync.z.version) { sync.z = null; sync.k = null; renderSync(); return; }
  if (stored && stored.code === sync.z.code && (stored.version || 0) > (sync.z.version || 0)) Object.assign(sync.z, stored);
  const z = sync.z, k = sync.k;
  for (let attempt = 0; attempt < 5; attempt++) {
    const a = await syncServer(z.server, k, "GET", { version: z.version });
    if (sync.z !== z) return; // intussen gestopt
    let remote, version;
    if (a.status === 304) { remote = z.basis; version = z.version; }
    else if (a.status === 200) { remote = await SYNC.ontsleutelen(await a.r.arrayBuffer(), k); version = a.version; }
    else if (a.status === 404 && z.version) {
      await syncStop();
      toast("De synchronisatie is gestopt: de gegevens werden op een ander toestel van de server gewist. Je gegevens op dit toestel blijven staan.", true);
      return;
    } else if (a.status === 404) { remote = null; version = 0; }
    else throw new Error(`De synchronisatieserver gaf een fout (${a.status}).`);
    if (sync.z !== z) return;

    if (remote) {
      const local = deepCopy(state);
      const merged = SYNC.samenvoegen(z.basis, local, remote);
      if (!SYNC.gelijk(merged, local)) syncAdopt(merged);
    }
    z.basis = remote; z.version = version; syncSave();
    const together = deepCopy(state);
    if (remote && SYNC.gelijk(together, remote)) { z.last = new Date().toISOString(); z.error = null; syncSave(); return; }
    const b = await syncServer(z.server, k, "PUT", { version, fresh: !remote, body: await SYNC.versleutelen(together, k) });
    if (sync.z !== z) return;
    if (b.status === 200) { z.basis = together; z.version = b.version; z.last = new Date().toISOString(); z.error = null; syncSave(); return; }
    if (b.status === 412) continue; // een ander toestel bewaarde intussen iets: opnieuw ophalen en samenvoegen
    if (b.status === 401) throw new Error("De server weigert de wijzigingen. Koppel dit toestel opnieuw.");
    if (b.status === 413) throw new Error("Je gegevens zijn te groot voor de synchronisatieserver.");
    throw new Error(`De synchronisatieserver gaf een fout (${b.status}).`);
  }
  throw new Error("Synchroniseren lukte niet: de gegevens veranderden steeds opnieuw. Probeer het zo nog eens.");
}
function syncNow() {
  clearTimeout(sync.timer); sync.timer = null;
  if (!syncOn()) return Promise.resolve();
  const r = sync.chain.then(async () => {
    if (!syncOn()) return;
    sync.busy = true; renderSync();
    try { await syncRound(); } catch (e) {
      if (sync.z) { sync.z.error = e.message || "Synchroniseren lukte niet."; sync.z.offline = !!e.network; syncSave(); }
      throw e;
    } finally { sync.busy = false; renderSync(); }
  });
  sync.chain = r.catch(() => {});
  return r;
}
function syncPlan(wait = 1500) {
  if (!syncOn()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => syncNow().catch(() => {}), wait);
}
async function syncStart(z) { sync.k = await SYNC.sleutels(z.code); sync.z = z; syncSave(); }
async function syncStop() { clearTimeout(sync.timer); sync.timer = null; sync.z = null; sync.k = null; syncSave(); renderSync(); }

async function syncEnable() {
  const server = serverNeat(SYNC_SERVER);
  await syncCheckServer(server);
  await syncStart({ server, code: SYNC.nieuweCode(), version: 0, basis: null, last: null, error: null });
  sync.showCode = true;
  try { await syncNow(); } catch (e) { await syncStop(); throw e; }
}
/** Stap 1 van koppelen: met de code ophalen wat er op de server staat. */
async function syncPreview(code, server = SYNC_SERVER) {
  server = serverNeat(server);
  if (!SYNC.codeBytes(code)) throw new Error("Deze code klopt niet: ze heeft 32 tekens (cijfers en letters). Kijk ze nog eens na.");
  await syncCheckServer(server);
  const k = await SYNC.sleutels(code);
  const a = await syncServer(server, k, "GET");
  if (a.status === 404) throw new Error("Met deze code staat er niets op de server. Kijk de code nog eens na.");
  if (a.status !== 200) throw new Error(`De synchronisatieserver gaf een fout (${a.status}).`);
  const remote = await SYNC.ontsleutelen(await a.r.arrayBuffer(), k);
  if (!validState(remote)) throw new Error("De gegevens op de server hebben niet de vorm van deze tool.");
  sync.proposal = { server, code: SYNC.naarCode(SYNC.codeBytes(code)), version: a.version, remote };
}
/** Stap 2: koppelen. "vervangen": dit toestel neemt de gegevens van het andere over; "samenvoegen": beide houden. */
async function syncLink(how) {
  const p = sync.proposal; sync.proposal = null;
  if (!p) return;
  await syncStart({ server: p.server, code: p.code, version: p.version, basis: p.remote, last: null, error: null });
  if (how === "samenvoegen") {
    const ids = { nextId: state.nextId };
    const own = SYNC.nieuweIds(state, () => SYNC.nieuwId(ids, true)); // eigen id's mogen niet botsen met die van de andere toestellen
    syncAdopt(SYNC.samenvoegen(null, own, deepCopy(p.remote)));
  } else syncAdopt(deepCopy(p.remote));
  try { await syncNow(); } catch { /* staat in de status; volgende keer opnieuw */ }
}
async function syncWipe() {
  if (!syncOn()) return;
  const a = await syncServer(sync.z.server, sync.k, "DELETE");
  if (a.status !== 204 && a.status !== 404) throw new Error(`Wissen lukte niet (fout ${a.status}).`);
  await syncStop();
}

let qrPromise = null;
const qrLoad = () => qrPromise || (qrPromise = new Promise((ok, no) => {
  if (window.qrcode) return ok(window.qrcode);
  const s = document.createElement("script");
  s.src = "qrcode.js";
  s.onload = () => ok(window.qrcode);
  s.onerror = () => { qrPromise = null; no(new Error("QR-code kon niet geladen worden")); };
  document.head.appendChild(s);
}));
function syncLinkUrl() {
  return `${location.origin}${location.pathname}#koppelen=${SYNC.naarCode(SYNC.codeBytes(sync.z.code))}`;
}
const whenText = iso => {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return "net";
  if (s < 3600) return `${Math.round(s / 60)} min. geleden`;
  return d.toLocaleString("nl-BE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
const countText = c => `${c.transacties} ${c.transacties === 1 ? "transactie" : "transacties"}` + (c.geldbewegingen ? ` en ${c.geldbewegingen} ${c.geldbewegingen === 1 ? "geldbeweging" : "geldbewegingen"}` : "");

function renderSync() {
  renderStorageStatus();
  const panel = $("#sync-panel"), body = $("#sync-body");
  if (!panel || !syncAvailable()) return;
  panel.hidden = false;
  const p = sync.proposal;
  if (p) {
    const remote = SYNC.telling(p.remote), local = SYNC.telling(state), hasLocal = state.transactions.length + state.cash.length > 0;
    body.innerHTML = `<p>Op het andere toestel: ${esc(countText(remote))}. Op dit toestel: ${esc(countText(local))}.</p>
      <div class="row">
        <button class="btn primary" data-sync="replace">Gegevens van het andere toestel overnemen</button>
        ${hasLocal ? `<button class="btn" data-sync="merge">Samenvoegen (beide houden)</button>` : ""}
        <button class="btn ghost" data-sync="cancel">Annuleren</button>
      </div>
      <p class="hint">${hasLocal ? "Overnemen vervangt wat nu op dit toestel staat. Kies samenvoegen alleen als op dit toestel transacties staan die het andere toestel niet heeft: wat op beide toestellen staat (bv. dezelfde import), komt er anders dubbel in." : "Dit toestel neemt alles van het andere over."}</p>`;
    return;
  }
  if (!syncOn()) {
    body.innerHTML = `<p class="hint">Houd je transacties, activa en instellingen gelijk op je telefoon, tablet en laptop, zoals bij DuckDuckGo: zonder account of wachtwoord, met een geheime code. Alles wordt op het toestel zelf versleuteld; de server kan je gegevens niet lezen. Bewijsstukken worden niet gesynchroniseerd (zet ze over met de back-up met bewijsstukken).</p>
      <div class="row">
        <button class="btn primary" data-sync="enable">Synchronisatie aanzetten</button>
        <button class="btn" data-sync="code">Koppelen met een code</button>
      </div>
      <form id="sync-code-form" class="inline-form" ${sync.codeForm ? "" : "hidden"} style="margin-top:.6rem">
        <input name="code" placeholder="Code van het andere toestel (32 tekens)" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Koppelcode" required>
        <button class="btn primary">Verder</button>
      </form>`;
    return;
  }
  const z = sync.z;
  const status = sync.busy ? "Bezig met synchroniseren…" : z.error ? `${z.offline ? "Even niet gesynchroniseerd" : "Synchroniseren lukte niet"}: ${z.error}` : z.last ? `Aan. Laatst gesynchroniseerd: ${whenText(z.last)}.` : "Aan.";
  body.innerHTML = `<p class="${z.error && !sync.busy ? "" : "hint"}" role="status">${esc(status)}</p>
    ${sync.showCode ? `<div class="sync-code">
        <p class="small">Scan deze QR-code met de camera van je andere toestel, of typ daar bij <em>Koppelen met een code</em> deze code:</p>
        <div class="sync-qr" id="sync-qr"></div>
        <div class="sync-tekst">${esc(SYNC.codeNetjes(z.code))}</div>
        <p class="hint">Staat de app op je iPhone of iPad op het beginscherm, typ de code dan in de app zelf: de QR-code opent Safari, en dat heeft een eigen opslag.</p>
        <p class="hint">Wie deze code heeft, kan je gegevens lezen en wijzigen. Deel ze met niemand.</p>
        <button class="btn small ghost" data-sync="hide">Code verbergen</button>
      </div>` : ""}
    <div class="row">
      ${sync.showCode ? "" : `<button class="btn primary" data-sync="show">Toestel koppelen</button>`}
      <button class="btn" data-sync="now">Nu synchroniseren</button>
      <button class="btn ghost" data-sync="stop">Stoppen op dit toestel</button>
      <button class="btn small danger" data-sync="wipe">Van de server wissen</button>
    </div>`;
  if (sync.showCode) qrLoad().then(qr => {
    const el = $("#sync-qr");
    if (!el || !syncOn()) return;
    const q = qr(0, "M"); q.addData(syncLinkUrl()); q.make();
    el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }).catch(() => { const el = $("#sync-qr"); if (el) el.hidden = true; });
}

$("#sync-panel").addEventListener("click", async e => {
  const b = e.target.closest("[data-sync]");
  if (!b) return;
  const act = b.dataset.sync;
  const fail = err => toast(err && err.message ? err.message : "Dat lukte niet.", true);
  b.disabled = true;
  try {
    if (act === "enable") { toast("Synchronisatie aanzetten…"); await syncEnable(); toast("Synchronisatie staat aan. Koppel nu je andere toestel."); }
    else if (act === "code") sync.codeForm = true;
    else if (act === "replace" || act === "merge") { await syncLink(act === "merge" ? "samenvoegen" : "vervangen"); toast("Gekoppeld. Dit toestel synchroniseert nu mee."); }
    else if (act === "cancel") sync.proposal = null;
    else if (act === "show") sync.showCode = true;
    else if (act === "hide") sync.showCode = false;
    else if (act === "now") { await syncNow(); toast("Gesynchroniseerd"); }
    else if (act === "stop") {
      if (!(await confirmDialog("Synchroniseren stoppen op dit toestel? Je gegevens blijven hier staan, en op de server voor je andere toestellen."))) return;
      await syncStop(); toast("Synchronisatie gestopt op dit toestel");
    } else if (act === "wipe") {
      if (!(await confirmDialog("Je versleutelde gegevens van de server wissen? Al je gekoppelde toestellen stoppen dan met synchroniseren; de gegevens op elk toestel blijven staan."))) return;
      await syncWipe(); toast("Van de server gewist");
    }
  } catch (err) { fail(err); }
  finally {
    b.disabled = false; renderSync();
    if (act === "code") $("#sync-code-form [name=code]")?.focus();
  }
});
$("#sync-panel").addEventListener("submit", async e => {
  if (e.target.id !== "sync-code-form") return;
  e.preventDefault();
  const btn = $("button", e.target); btn.disabled = true;
  try { await syncPreview(e.target.code.value); sync.codeForm = false; renderSync(); }
  catch (err) { toast(err.message || "Dat lukte niet.", true); }
  finally { btn.disabled = false; }
});

async function initSync() {
  if (!syncAvailable()) return;
  // gescande QR-code van een ander toestel: #koppelen=<code> (altijd met de eigen server, nooit een adres uit de link)
  if (location.hash.startsWith("#koppelen=")) {
    const q = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname + location.search + "#instellingen");
    sync.hashLink = { code: q.get("koppelen") };
  }
  const z = syncLoadStored();
  if (z && z.code && z.server) { try { await syncStart(z); } catch { /* ongeldige koppeling: uit */ } }
  renderSync();
  if (sync.hashLink) {
    const l = sync.hashLink; sync.hashLink = null;
    render();
    if (syncOn() && SYNC.naarCode(SYNC.codeBytes(l.code) || []) === sync.z.code) toast("Dit toestel is al gekoppeld.");
    else if (syncOn()) toast("Dit toestel synchroniseert al met een andere code. Stop eerst de synchronisatie bij Instellingen.", true);
    else { try { await syncPreview(l.code); renderSync(); } catch (err) { toast(err.message || "Koppelen lukte niet.", true); } }
  }
  if (syncOn()) syncPlan(300);
  // opnieuw bij het openen van de app, als het internet terug is, en elke halve minuut zolang ze open staat
  document.addEventListener("visibilitychange", () => {
    if (!syncOn()) return;
    if (document.visibilityState === "visible") syncPlan(100); else if (sync.timer) syncNow().catch(() => {});
  });
  window.addEventListener("online", () => syncPlan(100));
  setInterval(() => { if (syncOn() && document.visibilityState === "visible" && !sync.timer && !sync.busy) syncNow().catch(() => {}); }, 30000);
}

function renderStorageStatus(code) {
  const el = $("#storage-status");
  const m = {
    "account": ["ok", "Privé bewaard in je Claude-account (ook op je andere toestellen)"],
    "account-laden": ["", "Je gegevens worden geladen…"],
    "account-traag": ["warn", "Je account-opslag reageert nog niet; wat je ziet kan verouderd zijn."],
    "account-fout": ["warn", "Verbinding met je account-opslag verbroken" + (code ? ` (${code})` : "") + ". Wijzigingen blijven in deze browser."],
    "browser": ["warn", "Alleen bewaard in deze browser. Maak regelmatig een back-up (Instellingen)."],
    "geheugen": ["warn", "Niet bewaard: deze browser laat geen opslag toe. Maak een back-up voor je de pagina sluit."],
  }[storage.mode] || ["", ""];
  if (storage.mode === "browser" && syncOn()) m[0] = "ok", m[1] = "Bewaard in deze browser en versleuteld gesynchroniseerd met je andere toestellen";
  el.className = `storage ${m[0]}`;
  el.textContent = m[1];
}

// ================================================================ validatie (zoals web/app.py)
class InputError extends Error {}
function dec(value, field, { required = false, positive = false, nonNegative = false } = {}) {
  if (value == null || String(value).trim() === "") { if (required) throw new InputError(`Veld '${field}' is verplicht.`); return null; }
  let d;
  try { d = D(value); } catch { throw new InputError(`Veld '${field}' is geen geldig getal: ${value}`); }
  if (positive && !d.gt(0)) throw new InputError(`Veld '${field}' moet groter dan 0 zijn.`);
  if (nonNegative && d.lt(0)) throw new InputError(`Veld '${field}' mag niet negatief zijn.`);
  return d.toString();
}
/** Wisselkoers uit het formulier (fx_dir + fx) of uit bestaande gegevens (fx_per_eur / eur_per_ccy).
 *  Wordt bewaard zoals ingegeven: 1 EUR = … munt in fx_per_eur, of 1 munt = … EUR in eur_per_ccy. */
function txFx(p) {
  const dir = p.fx_dir || (hasVal(p.eur_per_ccy) ? "EUR_PER" : "PER_EUR");
  const raw = p.fx_dir ? p.fx : (dir === "EUR_PER" ? p.eur_per_ccy : p.fx_per_eur);
  const fx = dec(hasVal(raw) ? raw : "1", "wisselkoers", { positive: true });
  return dir === "EUR_PER" ? { fx_per_eur: "1", eur_per_ccy: fx } : { fx_per_eur: fx, eur_per_ccy: null };
}
const fxLabel = t => hasVal(t.eur_per_ccy) ? `1 ${t.currency} = ${num(t.eur_per_ccy)} EUR` : `1 EUR = ${num(t.fx_per_eur)} ${t.currency}`;
function validateTx(p) {
  if (!TYPE_LABELS[p.type]) throw new InputError(`Onbekend transactietype: ${p.type}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.trade_date || "") || isNaN(Date.parse(p.trade_date))) throw new InputError("Datum moet het formaat JJJJ-MM-DD hebben.");
  const asset = String(p.asset || "").trim().toUpperCase();
  if (!asset) throw new InputError("Actief (naam) is verplicht.");
  const out = {
    owner: String(p.owner || DEFAULT_OWNER).trim(), broker: String(p.broker || "").trim(), trade_date: p.trade_date,
    type: p.type, asset, currency: String(p.currency || "EUR").trim().toUpperCase(),
    ...txFx(p),
    fees: dec(p.fees || "0", "kosten", { nonNegative: true }), taxes: dec(p.taxes || "0", "taksen", { nonNegative: true }),
    historic_proven: !!p.historic_proven, cost_known: p.cost_known !== false,
    reynders_eur: dec(p.reynders_eur || "0", "Reynders-bedrag", { nonNegative: true }),
    note: String(p.note || "").trim(), quantity: "0", price: "0", amount: "0", split_ratio: null,
  };
  if (out.currency === "EUR" && !(D(out.fx_per_eur).eq(1) && (out.eur_per_ccy == null || D(out.eur_per_ccy).eq(1))))
    throw new InputError("Voor EUR moet de wisselkoers 1 zijn.");
  if (ACQ.includes(p.type) || p.type === "SELL") {
    out.quantity = dec(p.quantity, "aantal", { required: true, positive: true });
    const price = dec(p.price, "prijs", { required: p.type === "SELL" || out.cost_known, nonNegative: true });
    out.price = price ?? "0";
  } else if (p.type === "SPLIT") out.split_ratio = dec(p.split_ratio, "split-ratio", { required: true, positive: true });
  else if (p.type === "DELISTING") {
    if (!DELIST_LABELS[p.delist_mode]) throw new InputError("Kies de soort delisting.");
    out.delist_mode = p.delist_mode;
    if (p.delist_mode === "UITKOOP") {
      out.price = dec(p.price, "uitkoopprijs", { required: true, nonNegative: true });
      out.quantity = dec(p.quantity, "aantal", { positive: true }) ?? "0";
    }
  }
  else if (p.type === "RUIL") {
    out.quantity = dec(p.quantity, "aantal oude stuks", { positive: true }) ?? "0";
    out.price = dec(p.price, "cash per oud stuk", { nonNegative: true }) ?? "0";
    const comps = (p.components || []).filter(c => [c.asset, c.ratio, c.quantity, c.value].some(v => String(v ?? "").trim() !== ""));
    if (!comps.length) throw new InputError("Vul minstens één nieuw effect in (naam en aantal per oud stuk).");
    out.components = comps.map(c => {
      const a = String(c.asset || "").trim().toUpperCase();
      if (!a) throw new InputError("Naam van het nieuwe effect ontbreekt.");
      if (a === asset) throw new InputError("Het nieuwe effect moet verschillen van het oude.");
      const value = dec(c.value, `waarde per stuk ${a}`, { nonNegative: true });
      // totaal ontvangen (bv. uit een import) of aantal per oud stuk
      if (hasVal(c.quantity)) return { asset: a, quantity: dec(c.quantity, `ontvangen stuks ${a}`, { required: true, positive: true }), value };
      return { asset: a, ratio: dec(c.ratio, `aantal ${a} per oud stuk`, { required: true, positive: true }), value };
    });
    if (new Set(out.components.map(c => c.asset)).size < out.components.length) throw new InputError("Elk nieuw effect maar één keer invullen.");
    if ((out.components.length > 1 || D(out.price).gt(0)) && out.components.some(c => c.value == null) && p.trade_date >= "2026-01-01")
      throw new InputError("Vul voor elk nieuw effect de waarde per stuk op de ruildatum in (nodig vanaf 2026 om de aanschaffingswaarde te verdelen).");
  }
  else out.amount = dec(p.amount, "bedrag", { required: true, nonNegative: true });
  if (!ACQ.includes(p.type) || p.type === "BUY") out.cost_known = true;
  if (!ACQ.includes(p.type) || p.trade_date >= "2026-01-01") out.historic_proven = false;
  return out;
}

// ================================================================ rapport
function engineInputs(method) {
  const cfg = defaultConfig();
  cfg.years = {};
  for (const [y, c] of Object.entries(state.years))
    cfg.years[y] = { rate: D(c.rate), baseExemption: D(c.base_exemption), carrySlice: D(c.carry_slice), carryValidityYears: Number(c.carry_validity_years) || 5, source: c.source };
  cfg.historicMethod = method || state.settings.historic_method;
  cfg.fifoScope = state.settings.fifo_scope;
  const refs = {};
  for (const [isin, a] of Object.entries(state.assets)) if (a.ref_value_eur != null && a.ref_value_eur !== "") refs[isin] = a.ref_value_eur;
  const withheld = {};
  for (const w of state.withheld) withheld[`${w.owner}|${w.year}`] = w.amount;
  const txs = state.transactions.slice().sort((a, b) => a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : a.id - b.id)
    .map(t => ({ ...t, source: `transactie #${t.id}` }));
  return [txs, refs, cfg, withheld];
}
function runReport(method) { return calculate(...engineInputs(method)); }
/** Zelfde berekening alsof elke aankoop van vóór 2026 met gekende prijs bewijsbaar is (gemist voordeel). */
function runReportAllProven() {
  const [txs, ...rest] = engineInputs();
  if (!txs.some(t => ACQ.includes(t.type) && t.trade_date < "2026-01-01" && t.cost_known !== false && !t.historic_proven)) return null;
  return calculate(txs.map(t => ACQ.includes(t.type) && t.trade_date < "2026-01-01" && t.cost_known !== false ? { ...t, historic_proven: true } : t), ...rest);
}

function delistedOn(isin) {
  const d = state.transactions.filter(t => t.asset === isin && t.type === "DELISTING").map(t => t.trade_date).sort();
  return d.length ? d[d.length - 1] : null;
}
let openEnd2025 = { key: null, set: new Set() };
function needsRef(isin) {
  // fotowaarde enkel nodig voor effecten die je op 31/12/2025 nog had
  const key = state.transactions.length + "|" + (state.transactions[state.transactions.length - 1]?.id ?? 0) + "|" + state.settings.fifo_scope;
  if (openEnd2025.key !== key) {
    const cfg = { ...defaultConfig(), fifoScope: state.settings.fifo_scope };
    openEnd2025 = { key, set: new Set(window.MWB.holdingsAt(state.transactions, "2025-12-31", cfg).map(h => h.asset)) };
  }
  return openEnd2025.set.has(isin);
}

function renderReport() {
  const err = $("#report-error");
  err.hidden = true;
  let r;
  try { r = runReport(); }
  catch (e) {
    err.innerHTML = `<strong>Kan niet rekenen.</strong> ${esc(e.message)}` +
      (/31\/12\/2025/.test(e.message) ? ` <a href="#activa">Vul de waarde in bij Activa.</a>` : "") +
      (/inkomstenjaar/.test(e.message) ? ` <a href="#instellingen">Voeg het jaar toe bij Instellingen.</a>` : "");
    err.hidden = false;
    $("#year-cards").innerHTML = ""; $("#sales").innerHTML = ""; $("#sales-title").hidden = true;
    $("#events").innerHTML = ""; $("#events-title").hidden = true;
    return;
  }
  $("#sales-title").hidden = false;
  const method = state.settings.historic_method, other = method === "FIFO" ? "GEMIDDELD" : "FIFO";
  let alt = null;
  try { alt = runReport(other); } catch {}
  let proven = null;
  try { proven = runReportAllProven(); } catch {}
  $("#report-settings").textContent =
    `Historische prijs: ${method === "FIFO" ? "per lot (FIFO)" : "gemiddelde"} · FIFO ${state.settings.fifo_scope === "BROKER" ? "per broker" : "over alle brokers"}`;

  const cards = $("#year-cards");
  if (!r.years.length) {
    cards.innerHTML = `<div class="empty"><p>Nog geen verkopen of inhoudingen.</p>
      <p><button class="btn primary" data-action="new-tx">+ Eerste transactie</button>
      <button class="btn ghost" data-action="load-example">Voorbeeld laden</button></p></div>`;
  } else {
    cards.innerHTML = r.years.map(y => {
      const a = alt && alt.years.find(x => x.owner === y.owner && x.year === y.year);
      const showAlt = a && !(a.net_eur.eq(y.net_eur) && a.tax_eur.eq(y.tax_eur));
      const p = proven && proven.years.find(x => x.owner === y.owner && x.year === y.year);
      const showProven = p && p.tax_eur.lt(y.tax_eur);
      const refund = y.refund_eur;
      const carries = Object.entries(y.carry_detail).map(([k, v]) => `${k}: ${eur(v.toFixed(2))}`).join(", ");
      const f = k => y[k].toFixed(2);
      return `<article class="card">
        <h4><span>${y.year}</span><span class="muted small">${esc(y.owner)} · ${y.sale_count} ${y.sale_count === 1 ? "verkoop" : "verkopen"}</span></h4>
        <dl class="kv">
          <dt>Meerwaarden</dt><dd class="pos">${eur(f("gains_eur"))}</dd>
          <dt>Minderwaarden</dt><dd class="neg">${eur(f("losses_eur"))}</dd>
          <dt class="strong">Netto meerwaarde</dt><dd class="strong">${eur(f("net_eur"))}</dd>
          ${y.lost_losses_eur.lt(0) ? `<dt>Niet verrekenbaar verlies</dt><dd class="muted">${eur(f("lost_losses_eur"))}</dd>` : ""}
          <div class="sep"></div>
          <dt>Vrijstelling beschikbaar</dt><dd>${eur(f("exemption_available_eur"))}</dd>
          <dt>· uit overdracht</dt><dd>${eur(f("carry_used_eur"))}</dd>
          <dt>· uit basis</dt><dd>${eur(f("base_used_eur"))}</dd>
          <dt>Nieuwe overdracht</dt><dd>${eur(f("carry_generated_eur"))}</dd>
          <div class="sep"></div>
          <dt class="strong">Belastbaar</dt><dd class="strong">${eur(f("taxable_eur"))}</dd>
          <dt class="strong">Belasting</dt><dd class="strong">${eur(f("tax_eur"))}</dd>
          <dt>Ingehouden door broker</dt><dd>${eur(f("withheld_eur"))}</dd>
          ${!y.dividends_eur.isZero() ? `<dt>Dividenden (info)</dt><dd class="muted">${eur(f("dividends_eur"))}</dd>` : ""}
        </dl>
        <div class="result-line"><span>${refund.gte(0) ? "Terug te vorderen" : "Bij te betalen"}</span>
          <span class="big ${refund.gt(0) ? "pos" : refund.lt(0) ? "neg" : ""}">${eur(Math.abs(Number(refund.toFixed(2))))}</span></div>
        ${carries ? `<p class="hint">Overdrachten beschikbaar na ${y.year}: ${esc(carries)}</p>` : ""}
        ${showAlt ? `<div class="alert warn small">Met de methode <strong>${other === "FIFO" ? "per lot (FIFO)" : "gemiddelde"}</strong>
          zou de netto meerwaarde ${eur(a.net_eur.toFixed(2))} zijn en de belasting ${eur(a.tax_eur.toFixed(2))}.</div>` : ""}
        ${showProven ? `<div class="alert warn small"><strong>Mogelijk voordeel:</strong> sommige aankopen van vóór 2026 hebben een hogere
          prijs dan de waarde op 31/12/2025 maar zijn niet als bewijsbaar aangeduid. Met bewijs zou de belasting
          ${eur(p.tax_eur.toFixed(2))} zijn i.p.v. ${eur(y.tax_eur.toFixed(2))} (${eur(y.tax_eur.sub(p.tax_eur).toFixed(2))} minder).
          Zie de verkopen met een uitroepteken. Bij opt-in houdt de broker in op de waarde van 31/12/2025;
          de historische prijs roep je zelf in via je aangifte.</div>` : ""}
      </article>`;
    }).join("") + cashCards();
  }

  // open verkopen blijven open na een wijziging (bv. de waarde op 31/12/2025 bewaren)
  const openSales = new Set($$("#sales details[open]").map(d => d.dataset.sale));
  $("#sales").innerHTML = r.sales.length ? r.sales.slice().reverse().map(s => `
    <details data-sale="${esc(s.source)}"${openSales.has(s.source) ? " open" : ""}><summary>
      <span>${esc(s.trade_date)}</span><strong class="grow">${esc(assetLabel(s.asset))}${s.kind === "UITKOOP" ? ` <span class="badge SELL">uitkoop</span>` : s.kind === "RUIL" ? ` <span class="badge SELL">cash bij omruiling</span>` : ""}</strong>
      <span class="muted small">${num(s.quantity.toString())} st.${s.broker ? " · " + esc(s.broker) : ""}</span>
      <span class="num ${signClass(s.result_eur.toFixed(2))}"><strong>${eur(s.result_eur.toFixed(2))}</strong></span>
      ${s.warnings.length ? `<span class="badge need" title="Waarschuwing">!</span>` : ""}
      ${boleroBadge(s)}
    </summary><div class="detail">
      ${boleroCheck(s)}
      <p class="small muted">Opbrengst ${eur(s.proceeds_eur.toFixed(2))} · kosten ${eur(s.fees_eur.toFixed(2))} (niet aftrekbaar)
        ${!s.reynders_deduction_eur.isZero() ? ` · Reynders-aftrek ${eur(s.reynders_deduction_eur.toFixed(2))}` : ""} · ${esc(s.source)}</p>
      <div class="table-wrap"><table><thead><tr><th>Lot (aankoop)</th><th class="num">Aantal</th><th class="num">Opbrengst</th>
        <th class="num">Basis</th><th>Basis volgens</th><th class="num">Resultaat</th><th>Opmerking</th></tr></thead>
      <tbody>${s.lines.map(l => `<tr><td>${esc(l.acquired || "–")}</td><td class="num">${num(l.quantity.toString())}</td>
        <td class="num">${eur(l.proceeds_eur.toFixed(2))}</td><td class="num">${eur(l.basis_eur.toFixed(2))}</td>
        <td>${esc(BASIS_LABELS[l.basis_used])}</td><td class="num ${signClass(l.result_eur.toFixed(2))}">${eur(l.result_eur.toFixed(2))}</td>
        <td class="small">${esc(l.note)}</td></tr>`).join("")}</tbody></table></div>
      ${s.warnings.map(w => `<div class="alert warn small">${esc(w)}</div>`).join("")}
      ${saleRefEditor(s)}
    </div></details>`).join("") : `<p class="empty">Nog geen verkopen vanaf 2026.</p>`;

  const ev = r.events.filter(e => e.kind !== "UITKOOP");
  $("#events-title").hidden = !ev.length;
  $("#events").innerHTML = ev.slice().reverse().map(e => `
    <div class="event"><div class="row"><span>${esc(e.trade_date)}</span><strong>${esc(assetLabel(e.asset))}</strong>
      <span class="badge">${esc(EVENT_SHORT[e.kind])}</span>
      <span class="muted small">${num(e.quantity_held.toString())} st. in bezit · ${esc(e.owner)}</span></div>
      <p class="small muted">${esc(e.note)}</p></div>`).join("");
}

/** Waarde 31/12/2025 van het verkochte effect rechtstreeks bij de verkoop aanpassen
 *  (enkel als de verkoop loten van vóór 2026 bevat; dezelfde waarde als op het tabblad Activa). */
/** Geldoverzicht per eigenaar en jaar (enkel ter info), naast de jaarkaarten van het rapport. */
function cashCards() {
  const owners = [...new Set(state.cash.map(c => c.owner))].sort();
  return owners.flatMap(owner => GELD.summary(state.cash, state.transactions, state.withheld, { owner }).rows.slice().reverse().map(y => {
    const f = v => eur(v.toFixed(2));
    return `<article class="card"><h4><span>Geldoverzicht ${esc(y.year)}</span><span class="muted small">${esc(owner)} · info</span></h4>
      <dl class="kv">
        <dt>Gestort</dt><dd class="pos">${f(y.deposits)}</dd>
        <dt>Opgenomen</dt><dd class="neg">${f(y.withdrawals)}</dd>
        <dt class="strong">Netto inbreng</dt><dd class="strong">${f(y.net)}</dd>
        <div class="sep"></div>
        <dt>Dividend (netto)</dt><dd>${f(y.dividends)}</dd>
        ${y.capital_reductions.isZero() ? "" : `<dt>Kapitaalverminderingen</dt><dd>${f(y.capital_reductions)}</dd>`}
        ${y.withheld.isZero() ? "" : `<dt>Ingehouden meerwaardebelasting</dt><dd>${f(y.withheld)}</dd>`}
      </dl>
      <p class="hint">Telt niet mee voor de belasting. <a href="#transacties" data-show-cash>Toon de geldbewegingen</a></p></article>`;
  })).join("");
}
document.addEventListener("click", e => { if (e.target.closest("[data-show-cash]")) txShow = "cash"; });

function saleRefEditor(s) {
  if (!s.lines.some(l => l.acquired && l.acquired < "2026-01-01")) return "";
  const a = state.assets[s.asset] || {}, ccy = (a.currency || "EUR").toUpperCase();
  const split = state.transactions.some(t => t.asset === s.asset && t.type === "SPLIT" && t.trade_date >= "2026-01-01");
  return `<div class="ref-edit" data-refasset="${esc(s.asset)}">
    <strong class="small">Waarde 31/12/2025 per stuk${ccy === "EUR" ? " (EUR)" : ""}</strong>
    <div class="row">${refInputs(ccy, a, ccy === "EUR" ? "slotkoers in EUR" : "")}
      <input name="ref_source" value="${esc(a.ref_source)}" placeholder="Bron, bv. Euronext slotkoers" aria-label="Bron">
      <button class="btn small primary" data-saveref>Bewaar</button></div>
    <span class="hint">Geldt voor alle verkopen van dit effect (zelfde waarde als op het tabblad Activa).${split
      ? " Let op: vul de koers van vóór de splitsing in 2026 in; de tool rekent de splitsing zelf om." : ""}</span></div>`;
}
$("#sales").addEventListener("input", e => { const box = e.target.closest("[data-refasset]"); if (box) syncRef(box); });
$("#sales").addEventListener("click", e => {
  if (!e.target.closest("[data-saveref]")) return;
  const box = e.target.closest("[data-refasset]"), id = box.dataset.refasset;
  try {
    const ref = readRef(box, assetLabel(id));
    state.assets[id] = { ...state.assets[id], ...ref, ref_source: $("[name=ref_source]", box).value.trim() };
    commit(); toast(`Waarde 31/12/2025 voor ${assetLabel(id)} bewaard`);
  } catch (err) { toast(err.message, true); }
});

/** Naam als die gekend is en verschilt van de sleutel (bv. ISIN), anders de sleutel. */
function assetLabel(id) {
  const n = state.assets[id]?.name;
  return n && n.toUpperCase() !== id ? `${n} (${id})` : id;
}
function txOfSale(s) {
  const id = Number((/#(\d+)/.exec(s.source) || [])[1]);
  return state.transactions.find(t => t.id === id);
}
function boleroBadge(s) {
  const t = txOfSale(s);
  if (!t || t.bolero_result == null) return "";
  const same = D(t.bolero_result).round(2).eq(s.result_eur.round(2));
  return same ? `<span class="badge ok" title="Zelfde resultaat als Bolero">= Bolero</span>`
              : `<span class="badge need" title="Wijkt af van Bolero">≠ Bolero</span>`;
}
function boleroCheckInfo(s) {
  const t = txOfSale(s);
  if (!t || t.bolero_result == null) return null;
  const b = D(t.bolero_result), diff = s.result_eur.sub(b).round(2);
  if (diff.isZero()) return { same: true, text: `Zelfde resultaat als Bolero berekende (${eur(b.toFixed(2))}).` };
  return { same: false, text: `Bolero berekende ${eur(b.toFixed(2))}, deze tool ${eur(s.result_eur.toFixed(2))} (verschil ${eur(diff.toFixed(2))}). ` +
    "Mogelijke oorzaken: een andere waarde op 31/12/2025, een hogere historische prijs die je zelf inroept (Bolero gebruikt die niet), " +
    "FIFO over meerdere brokers, of een ontbrekende transactie." };
}
function boleroCheck(s) {
  const c = boleroCheckInfo(s);
  return c ? `<div class="alert ${c.same ? "ok" : "warn"} small">${esc(c.text)}</div>` : "";
}

function salesCsv() {
  const r = runReport();
  const rows = [["eigenaar", "broker", "verkoopdatum", "actief", "aankoopdatum lot", "aantal", "opbrengst_eur", "basis_eur", "basis", "resultaat_eur", "opmerking"]];
  for (const s of r.sales) {
    for (const l of s.lines) rows.push([s.owner, s.broker, s.trade_date, s.asset, l.acquired || "", l.quantity.toString(),
      l.proceeds_eur.toFixed(2), l.basis_eur.toFixed(2), l.basis_used, l.result_eur.toFixed(2), l.note]);
    if (!s.reynders_deduction_eur.isZero()) rows.push([s.owner, s.broker, s.trade_date, s.asset, "", "", "", "", "REYNDERS",
      s.reynders_deduction_eur.neg().toFixed(2), "Aftrek belastbare interestcomponent"]);
  }
  return rows.map(r => r.map(c => /[;"\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(";")).join("\r\n");
}

/** Volledig rapport als PDF: overzicht per jaar, elke verkoop met de loten, gebeurtenissen en de gebruikte parameters. */
function reportPdf(now = new Date()) {
  const r = runReport();
  const method = state.settings.historic_method, other = method === "FIFO" ? "GEMIDDELD" : "FIFO";
  const methodLabel = m => m === "FIFO" ? "per lot (FIFO)" : "gemiddelde";
  let alt = null, proven = null;
  try { alt = runReport(other); } catch {}
  try { proven = runReportAllProven(); } catch {}
  const today = now.toLocaleDateString("nl-BE", { day: "numeric", month: "long", year: "numeric" });
  const m2 = v => eur(v.toFixed(2));
  const color = v => v.gt(0) ? "pos" : v.lt(0) ? "neg" : null;
  const blocks = [
    { type: "h1", text: "Meerwaardebelasting – rapport" },
    { type: "p", color: "muted", text: `Opgemaakt op ${today} · België, algemeen regime (wet van 6 april 2026)` },
    { type: "p", color: "muted", text: `Historische prijs: ${methodLabel(method)} · FIFO ${state.settings.fifo_scope === "BROKER" ? "per broker" : "over alle brokers"}` },
    { type: "note", tone: "warn", text: "Rekenhulp, geen fiscaal advies. Controleer met de FOD Financiën of een adviseur." },
    { type: "h2", text: "Overzicht per jaar" },
  ];
  if (!r.years.length) blocks.push({ type: "p", color: "muted", text: "Nog geen verkopen of inhoudingen." });
  for (const y of r.years) {
    const a = alt && alt.years.find(x => x.owner === y.owner && x.year === y.year);
    const p = proven && proven.years.find(x => x.owner === y.owner && x.year === y.year);
    const refund = y.refund_eur;
    const rows = [
      { label: "Meerwaarden", value: m2(y.gains_eur), color: "pos" },
      { label: "Minderwaarden", value: m2(y.losses_eur), color: "neg" },
      { label: "Netto meerwaarde", value: m2(y.net_eur), bold: true },
    ];
    if (y.lost_losses_eur.lt(0)) rows.push({ label: "Niet verrekenbaar verlies", value: m2(y.lost_losses_eur), color: "muted" });
    rows.push({ label: "Vrijstelling beschikbaar", value: m2(y.exemption_available_eur), sep: true },
      { label: "· uit overdracht", value: m2(y.carry_used_eur) }, { label: "· uit basis", value: m2(y.base_used_eur) },
      { label: "Nieuwe overdracht", value: m2(y.carry_generated_eur) },
      { label: "Belastbaar", value: m2(y.taxable_eur), bold: true, sep: true }, { label: "Belasting", value: m2(y.tax_eur), bold: true },
      { label: "Ingehouden door broker", value: m2(y.withheld_eur) });
    if (!y.dividends_eur.isZero()) rows.push({ label: "Dividenden (info)", value: m2(y.dividends_eur), color: "muted" });
    rows.push({ label: refund.gte(0) ? "Terug te vorderen" : "Bij te betalen", value: eur(Math.abs(Number(refund.toFixed(2)))),
      bold: true, sep: true, color: color(refund) });
    blocks.push({ type: "h3", text: `${y.year} · ${y.owner} · ${y.sale_count} ${y.sale_count === 1 ? "verkoop" : "verkopen"}` },
      { type: "kv", rows });
    const carries = Object.entries(y.carry_detail).map(([k, v]) => `${k}: ${m2(v)}`).join(", ");
    if (carries) blocks.push({ type: "p", color: "muted", size: 8.5, text: `Overdrachten beschikbaar na ${y.year}: ${carries}` });
    if (a && !(a.net_eur.eq(y.net_eur) && a.tax_eur.eq(y.tax_eur)))
      blocks.push({ type: "note", tone: "warn", text: `Met de methode ${methodLabel(other)} zou de netto meerwaarde ${m2(a.net_eur)} zijn en de belasting ${m2(a.tax_eur)}.` });
    if (p && p.tax_eur.lt(y.tax_eur))
      blocks.push({ type: "note", tone: "warn", text: `Mogelijk voordeel: sommige aankopen van vóór 2026 hebben een hogere prijs dan de waarde op 31/12/2025 ` +
        `maar zijn niet als bewijsbaar aangeduid. Met bewijs zou de belasting ${m2(p.tax_eur)} zijn i.p.v. ${m2(y.tax_eur)} ` +
        `(${m2(y.tax_eur.sub(p.tax_eur))} minder). Bij opt-in houdt de broker in op de waarde van 31/12/2025; de historische prijs roep je zelf in via je aangifte.` });
  }

  blocks.push({ type: "h2", text: `Verkopen (${r.sales.length})` });
  if (!r.sales.length) blocks.push({ type: "p", color: "muted", text: "Nog geen verkopen vanaf 2026." });
  for (const s of r.sales) {
    blocks.push({ type: "h3", text: `${s.trade_date} · ${assetLabel(s.asset)}${s.kind === "UITKOOP" ? " (uitkoop)" : s.kind === "RUIL" ? " (cash bij omruiling)" : ""} · resultaat ${m2(s.result_eur)}` });
    const info = [`${num(s.quantity.toString())} st.`, s.owner, s.broker, `opbrengst ${m2(s.proceeds_eur)}`, `kosten ${m2(s.fees_eur)} (niet aftrekbaar)`];
    if (!s.reynders_deduction_eur.isZero()) info.push(`Reynders-aftrek ${m2(s.reynders_deduction_eur)}`);
    info.push(s.source);
    blocks.push({ type: "p", color: "muted", size: 8.5, text: info.filter(Boolean).join(" · ") });
    if (s.lines.some(l => l.acquired && l.acquired < "2026-01-01")) {
      const a = state.assets[s.asset] || {};
      const ref = a.ref_value_eur != null && a.ref_value_eur !== ""
        ? `€ ${num(a.ref_value_eur)} per stuk${a.currency && a.currency.toUpperCase() !== "EUR" && a.ref_price ? ` (${num(a.ref_price)} ${a.currency.toUpperCase()})` : ""}${a.ref_source ? `, bron: ${a.ref_source}` : ""}`
        : "niet ingevuld";
      blocks.push({ type: "p", color: "muted", size: 8.5, text: `Waarde 31/12/2025: ${ref}` });
    }
    const chk = boleroCheckInfo(s);
    if (chk) blocks.push({ type: "note", tone: chk.same ? "ok" : "warn", text: chk.text });
    blocks.push({ type: "table", cols: [
      { title: "Aankoop lot", width: 0.11 }, { title: "Aantal", width: 0.08, align: "right" },
      { title: "Opbrengst", width: 0.13, align: "right" }, { title: "Basis", width: 0.12, align: "right" },
      { title: "Basis volgens", width: 0.16 }, { title: "Resultaat", width: 0.12, align: "right" }, { title: "Opmerking", width: 0.28 }],
      rows: s.lines.map(l => [l.acquired || "–", num(l.quantity.toString()), m2(l.proceeds_eur), m2(l.basis_eur),
        BASIS_LABELS[l.basis_used] || l.basis_used, { text: m2(l.result_eur), color: color(l.result_eur) }, l.note || ""]) });
    for (const w of s.warnings) blocks.push({ type: "note", tone: "warn", text: w });
  }

  const ev = r.events.filter(e => e.kind !== "UITKOOP");
  if (ev.length) {
    blocks.push({ type: "h2", text: "Gebeurtenissen zonder belastbaar moment" });
    for (const e of ev) blocks.push({ type: "p", text: `${e.trade_date} · ${assetLabel(e.asset)} · ${EVENT_SHORT[e.kind]} · ${num(e.quantity_held.toString())} st. in bezit · ${e.owner}` },
      { type: "p", color: "muted", size: 8.5, text: e.note });
  }

  const years = Object.entries(state.years).sort(([a], [b]) => a - b);
  blocks.push({ type: "h2", text: "Gebruikte fiscale parameters" },
    { type: "table", cols: [{ title: "Jaar", width: 0.08 }, { title: "Tarief", width: 0.09, align: "right" },
      { title: "Basisvrijstelling", width: 0.15, align: "right" }, { title: "Overdraagbare schijf", width: 0.16, align: "right" },
      { title: "Geldig (jaar)", width: 0.1, align: "right" }, { title: "Bron", width: 0.42 }],
    rows: years.map(([y, c]) => [y, `${num(D(c.rate).mul(D(100)).toString())}%`, eur(c.base_exemption), eur(c.carry_slice),
      String(c.carry_validity_years ?? ""), c.source || ""]) });
  if (state.withheld.length)
    blocks.push({ type: "h3", text: "Ingehouden door de broker" },
      { type: "table", cols: [{ title: "Eigenaar", width: 0.3 }, { title: "Jaar", width: 0.15 }, { title: "Per broker", width: 0.35 }, { title: "Bedrag", width: 0.2, align: "right" }],
        rows: state.withheld.slice().sort((a, b) => a.year - b.year || String(a.owner).localeCompare(b.owner))
          .map(w => [w.owner, String(w.year), w.parts ? Object.entries(w.parts).map(([k, v]) => `${k}: ${eur(v)}`).join(", ") : "zelf ingevuld", eur(w.amount)]) });

  return window.PDF.build({ title: "Meerwaardebelasting – rapport", footer: `Meerwaardebelasting – rapport · ${today} · rekenhulp, geen fiscaal advies`,
    date: now.toISOString(), blocks });
}

// ================================================================ simulatie (wat als ik verkoop?)
const simForm = $("#sim-form");
const simKey = (owner, asset) => `${owner}\u0000${asset}`;
/** Posities op de gekozen datum (per eigenaar en actief). */
function simHoldings() {
  const date = simForm.elements.trade_date.value || new Date().toISOString().slice(0, 10);
  const cfg = { ...defaultConfig(), fifoScope: state.settings.fifo_scope };
  return window.MWB.holdingsAt(state.transactions, date, cfg).filter(h => h.asset !== "");
}
function fillSelect(sel, options, keep) {
  sel.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  if (options.some(([v]) => v === keep)) sel.value = keep;
}
/** Keuzelijsten bijwerken; `changed` = naam van het veld dat de gebruiker wijzigde. */
function updateSimForm(changed) {
  const el = simForm.elements, date = el.trade_date.value || new Date().toISOString().slice(0, 10);
  const holdings = simHoldings();
  const owners = [...new Set(holdings.map(h => h.owner))].sort();
  fillSelect(el.owner, owners.map(o => [o, o]), el.owner.value || DEFAULT_OWNER);
  const assets = holdings.filter(h => h.owner === el.owner.value).sort((a, b) => a.asset.localeCompare(b.asset));
  fillSelect(el.asset, assets.map(h => [h.asset, `${assetLabel(h.asset)} (${num(h.quantity.toString())} st.)`]), el.asset.value);
  $("#sim-empty").hidden = !!assets.length;
  const perBroker = state.settings.fifo_scope === "BROKER";
  $("#sim-broker").hidden = !perBroker;
  const cfg = { ...defaultConfig(), fifoScope: state.settings.fifo_scope };
  if (perBroker) {
    const brokers = [...new Set(state.transactions.filter(t => t.owner === el.owner.value && t.asset === el.asset.value).map(t => t.broker || ""))]
      .filter(b => window.SIM.heldAt(state.transactions, date, cfg, el.owner.value, el.asset.value, b).gt(0)).sort();
    fillSelect(el.broker, brokers.map(b => [b, b || "(geen broker)"]), el.broker.value);
  } else {
    const last = state.transactions.filter(t => t.owner === el.owner.value && t.asset === el.asset.value && t.broker).pop();
    fillSelect(el.broker, [[last ? last.broker : "", ""]], "");
  }
  const held = el.asset.value ? window.SIM.heldAt(state.transactions, date, cfg, el.owner.value, el.asset.value, perBroker ? el.broker.value : undefined) : D(0);
  $("#sim-held").textContent = el.asset.value ? `In bezit op ${date}: ${num(held.toString())} st.` : "";
  if (["owner", "asset", "broker", undefined].includes(changed) || !el.quantity.value) el.quantity.value = held.gt(0) ? held.toString() : "";
  if (["owner", "asset", undefined].includes(changed)) {
    const ccy = (state.assets[el.asset.value]?.currency || "EUR").toUpperCase();
    if (el.currency.value.trim().toUpperCase() !== ccy) { el.currency.value = ccy; el.fx.value = "1"; el.fx_dir.value = "PER_EUR"; }
  }
  const c = el.currency.value.trim().toUpperCase() || "munt";
  const [perEur, eurPer] = el.fx_dir.options;
  perEur.textContent = `1 EUR = … ${c}`; eurPer.textContent = `1 ${c} = … EUR`;
}
let simInit = false;
function renderSimulation() {
  if (!simInit) { simForm.elements.trade_date.value = new Date().toISOString().slice(0, 10); simInit = true; }
  updateSimForm();
  $("#sim-result").innerHTML = ""; $("#sim-error").hidden = true; $("#sim-add-tx").hidden = true;
}
simForm.addEventListener("change", e => {
  if (["owner", "asset", "broker", "trade_date", "currency", "fx_dir"].includes(e.target.name)) updateSimForm(e.target.name);
  $("#sim-result").innerHTML = ""; $("#sim-add-tx").hidden = true;
});
simForm.elements.currency.addEventListener("input", () => { if (simForm.elements.currency.value.trim().toUpperCase() === "EUR") simForm.elements.fx.value = "1"; });
function simTx() {
  const el = simForm.elements;
  if (!el.asset.value) throw new InputError("Kies een actief in portefeuille.");
  return validateTx({ type: "SELL", trade_date: el.trade_date.value, asset: el.asset.value, owner: el.owner.value,
    broker: el.broker.value, quantity: el.quantity.value.trim(), price: el.price.value.trim(),
    currency: el.currency.value, fx_dir: el.fx_dir.value, fx: el.fx.value.trim() });
}
simForm.addEventListener("submit", e => {
  e.preventDefault();
  const err = $("#sim-error");
  err.hidden = true; $("#sim-result").innerHTML = ""; $("#sim-add-tx").hidden = true;
  let t, r;
  try {
    t = simTx();
    const [txs, refs, cfg, withheld] = engineInputs();
    r = window.SIM.simulate(txs, refs, cfg, withheld, [t]);
  } catch (ex) {
    err.innerHTML = (ex instanceof InputError ? esc(ex.message) : `<strong>Kan niet rekenen.</strong> ${esc(ex.message)}`) +
      (/31\/12\/2025/.test(ex.message) ? ` <a href="#activa">Vul de waarde in bij Activa.</a>` : "") +
      (/inkomstenjaar/.test(ex.message) ? ` <a href="#instellingen">Voeg het jaar toe bij Instellingen.</a>` : "");
    err.hidden = false;
    return;
  }
  $("#sim-result").innerHTML = simResultHtml(t, r);
  $("#sim-add-tx").hidden = false;
});
$("#sim-add-tx").addEventListener("click", () => {
  let t;
  try { t = simTx(); } catch (ex) { toast(ex.message, true); return; }
  location.hash = "transacties";
  openTxDialog({ ...t, note: "" }, { asNew: true });
});

function simResultHtml(t, r) {
  const f = v => eur(v.toFixed(2));
  const s = r.sales[0], year = Number(t.trade_date.slice(0, 4));
  const own = r.years.filter(y => y.owner === t.owner);
  const main = own.find(y => y.year === year);
  const dTax = r.tax_delta_eur;
  const head = dTax.gt(0) ? ["Extra belasting door deze verkoop", "neg"] : dTax.lt(0) ? ["Deze verkoop verlaagt je belasting met", "pos"] : ["Extra belasting door deze verkoop", ""];
  const rate = s.result_eur.gt(0) && dTax.gt(0) ? ` (${nf.format(Number(dTax.div(s.result_eur).mul(100).toFixed(2)))}% van de meerwaarde)` : "";
  const later = state.transactions.some(x => x.owner === t.owner && x.asset === t.asset && x.trade_date > t.trade_date && (x.type === "SELL" || x.type === "DELISTING"));
  const metrics = [["Netto meerwaarde", "net_eur"], ["Vrijstelling beschikbaar", "exemption_available_eur"], ["Belastbaar", "taxable_eur"],
                   ["Belasting", "tax_eur"], ["Nieuwe overdracht (naar latere jaren)", "carry_generated_eur"]];
  const yearTables = own.filter(y => y.changed).map(y => `<div class="table-wrap"><table>
      <thead><tr><th>${y.year} · ${esc(y.owner)}</th><th class="num">Zonder</th><th class="num">Met verkoop</th><th class="num">Verschil</th></tr></thead>
      <tbody>${metrics.map(([label, k]) => `<tr><td>${label}</td><td class="num">${f(y.before[k])}</td><td class="num">${f(y.after[k])}</td>
        <td class="num ${k === "tax_eur" ? signClass(y.delta[k].neg().toFixed(2)) : ""}">${y.delta[k].isZero() ? "–" : (y.delta[k].gt(0) ? "+" : "") + f(y.delta[k])}</td></tr>`).join("")}
        <tr><td>Nog belastingvrij te realiseren</td><td class="num">${f(y.room_before_eur)}</td><td class="num">${f(y.room_after_eur)}</td><td></td></tr>
      </tbody></table></div>`).join("");
  return `<article class="card">
    <div class="sim-head"><span>${head[0]}</span><span class="big ${head[1]}">${f(dTax.lt(0) ? dTax.neg() : dTax)}</span></div>
    <p class="small muted" style="margin:.3rem 0 0">${esc(t.trade_date)} · verkoop ${num(t.quantity)} st. ${esc(assetLabel(t.asset))} ·
      opbrengst ${f(s.proceeds_eur)} · ${s.result_eur.gte(0) ? "meerwaarde" : "minderwaarde"}
      <strong class="${signClass(s.result_eur.toFixed(2))}">${f(s.result_eur)}</strong>${rate}</p>
    ${main ? `<p class="small" style="margin:.4rem 0 0">Nog belastingvrij te realiseren in ${year}: ${f(main.room_before_eur)} vóór deze verkoop,
      ${f(main.room_after_eur)} erna.</p>` : ""}
  </article>
  <h3>Verkochte loten (FIFO)</h3>
  <div class="table-wrap"><table><thead><tr><th>Lot (aankoop)</th><th class="num">Aantal</th><th class="num">Opbrengst</th>
    <th class="num">Basis</th><th>Basis volgens</th><th class="num">Resultaat</th><th>Opmerking</th></tr></thead>
  <tbody>${s.lines.map(l => `<tr><td>${esc(l.acquired || "–")}</td><td class="num">${num(l.quantity.toString())}</td>
    <td class="num">${f(l.proceeds_eur)}</td><td class="num">${f(l.basis_eur)}</td><td>${esc(BASIS_LABELS[l.basis_used])}</td>
    <td class="num ${signClass(l.result_eur.toFixed(2))}">${f(l.result_eur)}</td><td class="small">${esc(l.note)}</td></tr>`).join("")}</tbody></table></div>
  ${r.warnings.map(w => `<div class="alert warn small">${esc(w)}</div>`).join("")}
  ${later ? `<div class="alert warn small">Na deze datum staan er al verkopen van dit actief. Door FIFO verschuiven de loten van die latere
    verkopen; dat zit mee in het verschil hieronder.</div>` : ""}
  <h3>Impact per jaar</h3>
  ${yearTables ? `<div class="sim-years">${yearTables}</div>` : `<p class="muted">Geen verschil in de jaaroverzichten.</p>`}
  <p class="hint">Kosten en taksen bij de verkoop zijn niet aftrekbaar en tellen hier niet mee. Een lagere nieuwe overdracht betekent
    minder extra vrijstelling in latere jaren. Bij opt-in houdt je broker de belasting meteen in (op de waarde van 31/12/2025 voor
    oudere aankopen); wat te veel ingehouden is, recupereer je via de aangifte. Rekenhulp, geen fiscaal advies.</p>`;
}

// ================================================================ transacties
let txShow = "all"; // tx | cash | all
function renderTransactions() {
  const all = state.transactions, cash = state.cash;
  fillFilter("#f-year", [...new Set([...all.map(t => t.trade_date.slice(0, 4)), ...cash.map(c => c.date.slice(0, 4))])].sort().reverse());
  fillFilter("#f-owner", [...new Set([...all.map(t => t.owner), ...cash.map(c => c.owner)])].sort());
  $("#asset-list").innerHTML = Object.keys(state.assets).map(a => `<option value="${esc(a)}">`).join("");
  $("#owner-list").innerHTML = [...new Set([DEFAULT_OWNER, ...all.map(t => t.owner)])].map(o => `<option value="${esc(o)}">`).join("");
  const showTx = txShow !== "cash", showCash = txShow !== "tx";
  const kinds = [...(showTx ? Object.keys(TYPE_LABELS).filter(k => all.some(t => t.type === k)).map(k => [k, TYPE_LABELS[k]]) : []),
    ...(showCash ? Object.keys(GELD.KINDS).filter(k => cash.some(c => c.kind === k)).map(k => ["cash:" + k, GELD.label(k)]) : [])];
  const fk = $("#f-kind"), curKind = fk.value;
  fk.innerHTML = `<option value="">Alle</option>` + kinds.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join("");
  fk.value = kinds.some(([k]) => k === curKind) ? curKind : "";
  const fy = $("#f-year").value, fo = $("#f-owner").value, fa = $("#f-asset").value.trim().toUpperCase(), fp = $("#f-proof").value, fkind = fk.value;
  const missing = new Set(window.BEWIJS.missingProof(all, heldKeys()).map(t => t.id));
  $("#proof-missing").hidden = !missing.size || fp === "zonder" || !showTx;
  $("#proof-missing").textContent = `${missing.size === 1 ? "1 transactie" : `${missing.size} transacties`} van activa in bezit of belastbare verkopen ${missing.size === 1 ? "heeft" : "hebben"} nog geen bewijsstuk. Kies 'Bewijs ontbreekt' om ze te tonen.`;
  const hasProof = t => (t.attachments || []).length > 0;
  const txRows = !showTx || fkind.startsWith("cash:") ? [] : all.filter(t => (!fy || t.trade_date.startsWith(fy)) && (!fo || t.owner === fo)
      && (!fa || t.asset.includes(fa)) && (!fkind || t.type === fkind) && (!fp || (fp === "met" ? hasProof(t) : missing.has(t.id))));
  // het bewijsfilter geldt enkel voor transacties
  const cashRows = !showCash || fp || (fkind && !fkind.startsWith("cash:")) ? [] : cash.filter(c => (!fy || c.date.startsWith(fy)) && (!fo || c.owner === fo)
      && (!fa || `${c.asset_name} ${c.description}`.toUpperCase().includes(fa)) && (!fkind || "cash:" + c.kind === fkind));
  const rows = [...txRows.map(t => ({ date: t.trade_date, id: t.id, t })), ...cashRows.map(c => ({ date: c.date, id: c.id, c }))]
    .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
  const total = (showTx ? all.length : 0) + (showCash ? cash.length : 0);
  $("#tx-empty").hidden = rows.length > 0;
  $("#tx-count").textContent = total ? `${rows.length} van ${total}` : "";
  const counts = { tx: all.length, cash: cash.length, all: all.length + cash.length };
  $$("#f-show button").forEach(b => { b.classList.toggle("on", b.dataset.show === txShow); $(".n", b).textContent = counts[b.dataset.show]; });
  $("#f-show").closest("label").hidden = !cash.length;
  $("#f-proof").closest("label").hidden = txShow === "cash";
  renderCashSummary(showCash && cash.length ? { owner: fo, year: fy } : null);
  $("#tx-table tbody").innerHTML = rows.map(({ t, c }) => t ? txRow(t, hasProof, missing) : cashRow(c)).join("");
}
function txRow(t, hasProof, missing) {
    const amt = t.type === "DIVIDEND" || t.type === "FEE";
    const value = t.type === "SPLIT" ? `${num(t.split_ratio)} : 1` : amt ? num(t.amount)
      : t.type === "DELISTING" ? (t.delist_mode === "UITKOOP" ? num(t.price) : "")
      : t.type === "RUIL" ? `<span class="small">→ ${(t.components || []).map(c => hasVal(c.quantity) ? `${num(c.quantity)} st. ${esc(c.asset)}` : `${num(c.ratio)} ${esc(c.asset)}`).join(" + ")}${D(t.price || 0).gt(0) ? ` + ${num(t.price)} cash` : ""}</span>`
      : num(t.price);
    return `<tr data-id="${t.id}" class="clickable" title="Tik om te bewerken">
      <td>${esc(t.trade_date)}</td>
      <td><span class="badge ${esc(t.type)}">${esc(TYPE_LABELS[t.type])}</span>
        ${t.historic_proven ? `<span class="badge" title="Historische prijs bewijsbaar">H</span>` : ""}
        ${!t.cost_known ? `<span class="badge need" title="Aanschaffingswaarde onbekend">?</span>` : ""}
        ${t.type === "DELISTING" ? `<span class="badge">${esc(DELIST_SHORT[t.delist_mode] || "")}</span>` : ""}
        ${hasProof(t) ? `<span class="badge ok" title="Bewijsstukken">📎 ${t.attachments.length}</span>` : missing.has(t.id) ? `<span class="badge need" title="Nog geen bewijsstuk">geen bewijs</span>` : ""}</td>
      <td>${esc(t.asset)}</td>
      <td class="num">${["SPLIT", "DIVIDEND", "FEE"].includes(t.type) || ((t.type === "DELISTING" || t.type === "RUIL") && D(t.quantity || 0).isZero()) ? "" : num(t.quantity)}</td>
      <td class="num">${value}</td>
      <td>${esc(t.currency)}${t.currency !== "EUR" ? ` <span class="muted small" title="${esc(fxLabel(t))}">@${hasVal(t.eur_per_ccy) ? `${num(t.eur_per_ccy)} EUR` : num(t.fx_per_eur)}</span>` : ""}</td>
      <td>${esc(t.owner)}</td><td>${esc(t.broker)}</td>
      <td class="actions-cell"><button class="btn small danger" data-del="${t.id}" aria-label="Verwijder">✕</button></td></tr>`;
}
function cashRow(c) {
  const v = c.amount == null || c.amount === "" ? null : D(c.amount);
  const dir = c.status === "verwerkt" || !v ? "" : v.gt(0) ? "in" : v.lt(0) ? "out" : "";
  const what = [c.asset_name, c.description && c.description !== c.asset_name ? c.description : ""].filter(Boolean).join(" – ");
  const note = c.remark ? `<span class="cash-note ${c.status === "verwerkt" ? "done" : c.warn ? "warn" : ""}">${esc(c.remark)}</span>` : "";
  return `<tr data-cash="${c.id}" class="clickable info" title="Geldbeweging (enkel ter info). Tik voor details.">
    <td>${esc(c.date)}</td><td><span class="badge cash ${dir}">${esc(GELD.label(c.kind))}</span></td>
    <td class="cash-what">${esc(what)}${note}${c.note ? `<span class="cash-note">${esc(c.note)}</span>` : ""}</td>
    <td class="num"></td><td class="num ${v && v.lt(0) ? "neg" : ""}">${v ? num(v.toString()) : "–"}</td>
    <td>${esc(c.currency || "EUR")}</td><td>${esc(c.owner)}</td><td>${esc(c.broker)}</td>
    <td class="actions-cell"><button class="btn small danger" data-delcash="${c.id}" aria-label="Verwijder">✕</button></td></tr>`;
}
function renderCashSummary(filter) {
  const box = $("#cash-summary");
  const s = filter && GELD.summary(state.cash, state.transactions, state.withheld, filter);
  box.hidden = !s || !s.rows.length;
  if (box.hidden) return;
  const cell = (v, cls = "") => `<td class="num ${cls}">${eur(v.toFixed(2))}</td>`;
  const line = r => `<tr><td>${esc(r.year)}</td>${cell(r.deposits, "pos")}${cell(r.withdrawals, "neg")}<td class="num"><strong>${eur(r.net.toFixed(2))}</strong></td>
    ${cell(r.dividends)}${cell(r.capital_reductions)}${cell(r.withheld)}</tr>`;
  $("tbody", box).innerHTML = s.rows.map(line).join("");
  $("tfoot", box).innerHTML = s.rows.length > 1 ? line(s.total) : "";
  $("#cash-summary-hint").textContent = "Netto inbreng = gestort − opgenomen, volgens de geïmporteerde exports. Dividend = netto ontvangen dividenden min terugboekingen. " +
    "Telt niet mee voor de belasting." + (s.foreign ? ` ${s.foreign} ${s.foreign === 1 ? "geldbeweging" : "geldbewegingen"} in een andere munt dan EUR ${s.foreign === 1 ? "is" : "zijn"} niet meegeteld.` : "");
}
function fillFilter(sel, values) {
  const el = $(sel), cur = el.value;
  el.innerHTML = `<option value="">Alle</option>` + values.map(v => `<option>${esc(v)}</option>`).join("");
  el.value = values.includes(cur) ? cur : "";
}

const dlg = $("#tx-dialog"), form = $("#tx-form");
let editingId = null;
form.elements.type.innerHTML = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
form.elements.delist_mode.innerHTML = Object.entries(DELIST_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");

function updateFieldVisibility() {
  const t = form.elements.type.value, acq = ACQ.includes(t), sell = t === "SELL";
  const dl = t === "DELISTING", mode = form.elements.delist_mode.value, buyout = dl && mode === "UITKOOP", ruil = t === "RUIL";
  const show = (cls, on) => $$(cls, form).forEach(el => { el.hidden = !on; });
  show(".g-qty", acq || sell || buyout || ruil); show(".g-price", acq || sell || buyout || ruil);
  show(".g-amount", t === "DIVIDEND" || t === "FEE"); show(".g-split", t === "SPLIT");
  show(".g-ccy", t !== "SPLIT" && (!dl || buyout)); show(".g-fees", acq || sell || buyout); show(".g-reynders", sell);
  show(".g-delist", dl); show(".g-ruil", ruil);
  if (ruil && !$("#ruil-rows").children.length) addRuilRow();
  $("#qty-label").firstChild.textContent = buyout ? "Aantal (leeg = volledige positie) " : ruil ? "Aantal oude stuks (leeg = volledige positie) " : "Aantal ";
  $("#price-label").firstChild.textContent = buyout ? "Uitkoopprijs per stuk " : ruil ? "Cash per oud stuk (leeg = geen) " : "Prijs per stuk ";
  $("#asset-label").firstChild.textContent = ruil ? "Oud effect (naam) " : "Actief (naam) ";
  $("#delist-hint").textContent = dl ? {
    NOTERING: "Geen belastbaar moment: je positie blijft open met dezelfde aanschaffingswaarde. Registreer een latere verkoop apart.",
    UITKOOP: "Uitkoop, openbaar bod of squeeze-out: telt als verkoop van je stuks tegen de uitkoopprijs.",
    WAARDELOOS: "Zonder overdracht boekt de tool geen minderwaarde (wettelijk niet uitgeklaard). Verkoop je de stuks voor een symbolische prijs, registreer dat dan als verkoop.",
  }[mode] : "";
  show(".g-costknown", t === "GIFT_IN" || t === "INHERIT_IN" || t === "TRANSFER_IN");
  show(".g-hist", acq && form.elements.trade_date.value && form.elements.trade_date.value < "2026-01-01");
  show(".g-gift", t === "GIFT_IN" || t === "INHERIT_IN");
  form.elements.price.disabled = acq && t !== "BUY" && !form.elements.cost_known.checked;
}
["type", "trade_date", "cost_known", "delist_mode"].forEach(n => form.elements[n].addEventListener("change", updateFieldVisibility));
/** Eén regel 'nieuw effect' bij een omruiling (namen c_* worden apart ingelezen, zie readRuilRows). */
function addRuilRow(c = {}) {
  const row = document.createElement("div");
  row.className = "ruil-row";
  row.innerHTML = `<label>Nieuw effect (naam) <input name="c_asset" autocomplete="off" autocapitalize="characters" list="asset-list" value="${esc(c.asset)}"></label>
    ${hasVal(c.quantity) ? `<label>Totaal ontvangen (st.) <input name="c_quantity" inputmode="decimal" value="${esc(c.quantity)}"></label>`
      : `<label>Aantal per oud stuk <input name="c_ratio" inputmode="decimal" placeholder="bv. 0,1598" value="${esc(c.ratio)}"></label>`}
    <label>Waarde per stuk op ruildatum <input name="c_value" inputmode="decimal" value="${esc(c.value)}"></label>
    <button type="button" class="btn small danger" data-ruil-del aria-label="Verwijder dit effect">✕</button>`;
  $("#ruil-rows").append(row);
}
const readRuilRows = () => $$(".ruil-row", form).map(r => ({ asset: $("[name=c_asset]", r).value.trim(),
  ratio: $("[name=c_ratio]", r)?.value.trim() ?? "", quantity: $("[name=c_quantity]", r)?.value.trim() ?? "", value: $("[name=c_value]", r).value.trim() }));
$("#ruil-add").addEventListener("click", () => addRuilRow());
$("#ruil-rows").addEventListener("click", e => {
  const b = e.target.closest("[data-ruil-del]");
  if (!b) return;
  $("#ruil-rows").removeChild(b.closest(".ruil-row"));
  if (!$("#ruil-rows").children.length) addRuilRow();
});
form.elements.currency.addEventListener("input", () => { if (form.elements.currency.value.trim().toUpperCase() === "EUR") form.elements.fx.value = "1"; updateFxLabels(); });
/** Toon de munt in de keuze van de koersrichting (1 EUR = … USD / 1 USD = … EUR). */
function updateFxLabels() {
  const c = form.elements.currency.value.trim().toUpperCase() || "munt";
  const [perEur, eurPer] = form.elements.fx_dir.options;
  perEur.textContent = `1 EUR = … ${c}`; eurPer.textContent = `1 ${c} = … EUR`;
}

/** tx: bestaande transactie om te bewerken, of met { asNew: true } een vooraf ingevulde nieuwe transactie. */
function openTxDialog(tx, { asNew = false } = {}) {
  form.reset();
  editingId = tx && !asNew ? tx.id : null;
  $("#tx-title").textContent = editingId ? "Transactie bewerken" : "Nieuwe transactie";
  $("#tx-error").hidden = true;
  $("#btn-delete-tx").hidden = !editingId;
  form.elements.owner.value = DEFAULT_OWNER;
  if (tx) for (const [k, v] of Object.entries(tx)) {
    const el = form.elements[k];
    if (el && el.name) { if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? ""; }
  } else form.elements.trade_date.value = new Date().toISOString().slice(0, 10);
  if (tx && (tx.type === "DELISTING" || tx.type === "RUIL") && D(tx.quantity || 0).isZero()) form.elements.quantity.value = "";
  if (tx && tx.type === "RUIL" && D(tx.price || 0).isZero()) form.elements.price.value = "";
  $("#ruil-rows").innerHTML = "";
  for (const c of tx?.type === "RUIL" ? tx.components || [] : []) addRuilRow(c);
  const inv = !!tx && hasVal(tx.eur_per_ccy);
  form.elements.fx_dir.value = inv ? "EUR_PER" : "PER_EUR";
  form.elements.fx.value = tx ? (inv ? tx.eur_per_ccy : tx.fx_per_eur ?? "1") : "1";
  updateFxLabels();
  updateFieldVisibility();
  openProofs(asNew ? null : tx);
  dlg.showModal();
}
form.addEventListener("submit", e => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.name.startsWith("c_") || el.closest("[hidden]")) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  if (data.type === "RUIL") data.components = readRuilRows();
  try {
    const t = validateTx(data);
    for (const a of [t.asset, ...(t.components || []).map(c => c.asset)])
      if (!state.assets[a]) state.assets[a] = { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
    if (proofDraft.uploading) throw new InputError("Even wachten: er wordt nog een bestand opgeslagen.");
    const attachments = proofDraft.list.slice();
    if (editingId) {
      const i = state.transactions.findIndex(x => x.id === editingId);
      if (i < 0) throw new InputError("Deze transactie bestaat niet meer (intussen verwijderd op een ander toestel?).");
      state.transactions[i] = { ...state.transactions[i], ...t, id: editingId, attachments };
    } else state.transactions.push({ id: newId(), ...t, attachments });
    proofDraft.saved = true;
    for (const a of window.BEWIJS.removedAttachments(proofDraft.before, attachments)) deleteProofFile(a);
    dlg.close(); commit();
    toast(editingId ? "Transactie bijgewerkt" : "Transactie toegevoegd");
  } catch (err) {
    $("#tx-error").textContent = err instanceof InputError ? err.message : `Fout: ${err.message}`;
    $("#tx-error").hidden = false;
  }
});
$("#btn-cancel").addEventListener("click", () => dlg.close());
$("#btn-delete-tx").addEventListener("click", async () => {
  const id = editingId;
  dlg.close();
  if (await confirmDialog(deleteQuestion(id))) deleteTx(id);
});
function deleteQuestion(id) {
  const n = (state.transactions.find(t => t.id === id)?.attachments || []).length;
  return n ? `Deze transactie en ${n === 1 ? "het bewijsstuk" : `de ${n} bewijsstukken`} verwijderen?` : "Deze transactie verwijderen?";
}
function deleteTx(id) {
  const gone = state.transactions.find(t => t.id === id);
  state.transactions = state.transactions.filter(t => t.id !== id);
  for (const a of gone?.attachments || []) deleteProofFile(a);
  commit(); toast("Transactie verwijderd");
}
$("#tx-table").addEventListener("click", async e => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); if (await confirmDialog(deleteQuestion(Number(del.dataset.del)))) deleteTx(Number(del.dataset.del)); return; }
  const delc = e.target.closest("[data-delcash]");
  if (delc) { e.stopPropagation(); if (await confirmDialog("Deze geldbeweging verwijderen?")) deleteCash(Number(delc.dataset.delcash)); return; }
  const row = e.target.closest("tr[data-id]");
  if (row) return openTxDialog(state.transactions.find(t => t.id === Number(row.dataset.id)));
  const crow = e.target.closest("tr[data-cash]");
  if (crow) openCashDialog(state.cash.find(c => c.id === Number(crow.dataset.cash)));
});
["#f-year", "#f-owner", "#f-proof", "#f-kind"].forEach(s => $(s).addEventListener("change", renderTransactions));
$("#f-show").addEventListener("click", e => {
  const b = e.target.closest("button[data-show]"); if (!b) return;
  txShow = b.dataset.show; renderTransactions();
});

// ================================================================ geldbewegingen (enkel ter info)
let editingCash = null;
function openCashDialog(c) {
  if (!c) return;
  editingCash = c.id;
  $("#cash-title").textContent = `${GELD.label(c.kind)} op ${c.date}`;
  const v = c.amount == null || c.amount === "" ? "–" : `${num(c.amount)} ${c.currency || "EUR"}`;
  const dd = (k, val) => val ? `<dt>${k}</dt><dd style="text-align:left;white-space:normal">${esc(val)}</dd>` : "";
  $("#cash-details").innerHTML = dd("Bedrag", v) + dd("Effect", c.asset_name) + dd("Omschrijving", c.description)
    + dd(c.status === "verwerkt" ? "Al verwerkt" : "Opmerking", c.remark) + dd("Eigenaar", c.owner) + dd("Broker", c.broker) + dd("Bron", c.import_source);
  $("#cash-note").value = c.note || "";
  $("#cash-dialog").showModal();
}
function deleteCash(id) {
  state.cash = state.cash.filter(c => c.id !== id);
  commit(); toast("Geldbeweging verwijderd. Een nieuwe import van dezelfde export voegt ze opnieuw toe.");
}
$("#cash-cancel").addEventListener("click", () => $("#cash-dialog").close());
$("#cash-save").addEventListener("click", () => {
  const c = state.cash.find(x => x.id === editingCash);
  if (c) { const n = $("#cash-note").value.trim(); if (n) c.note = n; else delete c.note; commit(); }
  $("#cash-dialog").close();
});
$("#cash-delete").addEventListener("click", async () => {
  const id = editingCash; $("#cash-dialog").close();
  if (await confirmDialog("Deze geldbeweging verwijderen?")) deleteCash(id);
});
$("#f-asset").addEventListener("input", renderTransactions);

// ================================================================ bewijsstukken
// claude.ai: bestanden bij de pagina zelf (capability "assets", zelfde privacy als de pagina).
// Elders (GitHub Pages, lokaal): IndexedDB in deze browser. De gewone back-up bevat enkel naam en verwijzing; "Back-up met bewijsstukken" ook de bestanden.
const proofs = { assets: null, ready: false, onClaude: !!window.claude, init: null };
const proofDraft = { list: [], before: [], saved: false, session: 0, uploading: 0, urls: [] };

async function initProofs() {
  const use = window.claude && typeof window.claude.use === "function" ? window.claude.use.bind(window.claude) : null;
  if (use) proofs.assets = await use("assets").catch(() => null);
  proofs.ready = true;
  if (dlg.open) renderProofs();
}
function proofStoreKind() {
  if (proofs.assets) return "account";
  if (!proofs.onClaude && typeof indexedDB !== "undefined") return "browser";
  return null;
}
function heldKeys() {
  const cfg = { ...defaultConfig(), fifoScope: state.settings.fifo_scope };
  const hs = window.MWB.holdingsAt(state.transactions, "9999-12-31", cfg);
  const keys = new Set(hs.map(h => `${h.owner}\u0000${h.asset}`));
  if (state.settings.fifo_scope !== "EIGENAAR") { // gedeelde pot: elke eigenaar van dat actief telt als 'in bezit'
    const assets = new Set(hs.map(h => h.asset));
    for (const t of state.transactions) if (assets.has(t.asset)) keys.add(`${t.owner}\u0000${t.asset}`);
  }
  // omgeruild effect: de oorspronkelijke aankoop blijft het bewijs voor de nieuwe effecten (laatste omruiling eerst)
  const ruil = state.transactions.filter(t => t.type === "RUIL").sort((a, b) => a.trade_date < b.trade_date ? 1 : -1);
  for (const t of ruil) if ((t.components || []).some(c => keys.has(`${t.owner}\u0000${c.asset}`))) keys.add(`${t.owner}\u0000${t.asset}`);
  return keys;
}

const idb = {
  db: null,
  open() {
    return this.db ??= new Promise((res, rej) => {
      const r = indexedDB.open("meerwaarde-bewijzen", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("files");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction("files", mode), req = fn(tx.objectStore("files"));
      tx.oncomplete = () => res(req.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  },
  put(id, blob) { return this.run("readwrite", s => s.put(blob, id)); },
  get(id) { return this.run("readonly", s => s.get(id)); },
  del(id) { return this.run("readwrite", s => s.delete(id)); },
};

async function saveProofFile(file) {
  const type = window.BEWIJS.contentType(file.name, file.type);
  const meta = { name: file.name, type, size: file.size, added: new Date().toISOString().slice(0, 10) };
  if (proofStoreKind() === "account") {
    let r;
    try { r = await proofs.assets.upload(file, { type }); }
    catch (e) {
      if (e && e.code === "store_unavailable") { await new Promise(res => setTimeout(res, 1500)); r = await proofs.assets.upload(file, { type }); }
      else throw e;
    }
    return { id: r.id, ...meta, size: r.sizeBytes ?? file.size, store: "account" };
  }
  const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await idb.put(id, new Blob([await file.arrayBuffer()], { type }));
  return { id, ...meta, store: "browser" };
}
async function deleteProofFile(a) {
  if (state.transactions.some(t => (t.attachments || []).some(x => x.id === a.id))) return; // nog in gebruik
  try {
    if (a.store === "account" && proofs.assets) await proofs.assets.delete(a.id);
    else if (a.store === "browser" && !proofs.onClaude) await idb.del(a.id);
  } catch { /* blijft als los bestand staan; geen gevolgen voor de berekening */ }
}
async function proofBlob(a) {
  if (a.store === "account") {
    const r = await fetch("/_blob/" + a.id);
    if (!r.ok) throw new Error("Bestand niet gevonden.");
    return r.blob();
  }
  const b = await idb.get(a.id);
  if (!b) throw new Error("Bestand niet gevonden in deze browser. Staat het op een ander toestel, zet het dan over met de back-up met bewijsstukken.");
  return b;
}
function proofReachable(a) {
  if (a.store === "account") return proofs.onClaude;
  return !proofs.onClaude && typeof indexedDB !== "undefined";
}
function proofErrorText(e, name) {
  const m = {
    too_large: "is te groot (max. 20 MB)", unsupported_type: "heeft een bestandstype dat niet bewaard kan worden",
    quota_or_state: "past niet meer: de opslagruimte van de pagina is vol", rate_limited: "kon niet bewaard worden: even later opnieuw proberen",
    not_granted: "kon niet bewaard worden: geen toestemming voor bestanden", QuotaExceededError: "past niet meer in de browseropslag",
  }[e && (e.code || e.name)];
  return `'${name}' ${m || "kon niet bewaard worden" + (e && e.code ? ` (${e.code})` : "")}.`;
}

function openProofs(tx) {
  proofDraft.session++;
  proofDraft.before = (tx?.attachments || []).slice();
  proofDraft.list = proofDraft.before.slice();
  proofDraft.saved = false; proofDraft.uploading = 0;
  renderProofs();
}
function renderProofs() {
  proofDraft.urls.forEach(u => URL.revokeObjectURL(u)); proofDraft.urls = [];
  const kind = proofStoreKind();
  $("#proof-add").hidden = !kind;
  $("#proof-file").accept = window.BEWIJS.ACCEPT;
  $("#proof-hint").textContent = kind === "account"
    ? "Bv. het borderel of de afrekening van je bank (PDF of foto, max. 20 MB). Privé bewaard bij deze pagina in je Claude-account; mee in de ‘Back-up met bewijsstukken’."
    : kind === "browser"
      ? "Bv. het borderel of de afrekening van je bank (PDF of foto, max. 20 MB). Bewaard in deze browser; mee in de ‘Back-up met bewijsstukken’."
      : !proofs.ready ? "Opslag voor bestanden wordt geladen…"
        : "Bestanden toevoegen kan hier niet: de pagina heeft geen toestemming voor bestanden (menu van de pagina → Toestemmingen).";
  const list = $("#proof-list");
  list.innerHTML = proofDraft.list.map((a, i) => {
    const ok = proofReachable(a);
    const where = !ok ? `<span class="muted small">${a.store === "account" ? "staat op de claude.ai-pagina" : "staat in een andere browser"}</span>` : "";
    return `<li class="${a.pending ? "busy" : ""}">
      ${ok && !a.pending ? `<a href="#" data-open="${i}" title="Openen">📄 ${esc(a.name)}</a>` : `<span class="name">📄 ${esc(a.name)}</span>`}
      <span class="muted small">${a.pending ? "bezig…" : esc(window.BEWIJS.sizeLabel(a.size))}</span>${where}
      ${ok && !a.pending ? `<button type="button" class="btn small ghost" data-save="${i}">Bewaren</button>` : ""}
      ${a.pending ? "" : `<button type="button" class="btn small danger" data-rm="${i}" aria-label="Bewijsstuk verwijderen">✕</button>`}</li>`;
  }).join("") || `<li class="muted small">Nog geen bewijsstukken.</li>`;
}
$("#proof-file").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  const session = proofDraft.session;
  for (const f of files) {
    const err = window.BEWIJS.checkFile(f.name, f.type, f.size);
    if (err) { toast(err, true); continue; }
    const placeholder = { id: "", name: f.name, size: f.size, pending: true };
    proofDraft.list.push(placeholder); proofDraft.uploading++; renderProofs();
    try {
      const a = await saveProofFile(f);
      if (session !== proofDraft.session || proofDraft.saved) { deleteProofFile(a); continue; } // venster intussen gesloten
      proofDraft.list[proofDraft.list.indexOf(placeholder)] = a;
    } catch (err2) {
      if (session === proofDraft.session) proofDraft.list.splice(proofDraft.list.indexOf(placeholder), 1);
      toast(proofErrorText(err2, f.name), true);
    } finally {
      if (session === proofDraft.session) { proofDraft.uploading--; renderProofs(); }
    }
  }
});
$("#proof-list").addEventListener("click", async e => {
  const rm = e.target.closest("[data-rm]"), sv = e.target.closest("[data-save]"), op = e.target.closest("[data-open]");
  if (rm) {
    const a = proofDraft.list[Number(rm.dataset.rm)];
    if (!(await confirmDialog(`'${a.name}' verwijderen bij deze transactie? Het wordt definitief gewist als je de transactie opslaat.`))) return;
    proofDraft.list.splice(proofDraft.list.indexOf(a), 1); renderProofs();
  } else if (sv || op) {
    e.preventDefault();
    const a = proofDraft.list[Number((sv || op).dataset.save ?? (sv || op).dataset.open)];
    try {
      const blob = await proofBlob(a), image = String(a.type || blob.type).startsWith("image/");
      if (op && (image || !proofs.onClaude)) {
        const url = URL.createObjectURL(blob); proofDraft.urls.push(url);
        if (image) {
          $("#preview-title").textContent = a.name; $("#preview-img").src = url; $("#preview-dialog").showModal(); return;
        }
        if (window.open(url, "_blank")) return;
      }
      await offerDownload(a.name, blob, "Bewijsstuk");
    } catch (err) { toast(err.message || "Openen mislukt", true); }
  }
});
dlg.addEventListener("close", () => {
  proofDraft.session++;
  if (!proofDraft.saved) // nieuw opgeladen maar niet opgeslagen: opruimen
    for (const a of window.BEWIJS.removedAttachments(proofDraft.list.filter(x => !x.pending), proofDraft.before)) deleteProofFile(a);
  proofDraft.urls.forEach(u => setTimeout(() => URL.revokeObjectURL(u), 60000)); proofDraft.urls = [];
});

// ================================================================ waarde 31/12/2025
// In EUR, of voor effecten in vreemde munt: slotkoers in die munt + wisselkoers op 31/12/2025.
// De wisselkoers wordt altijd per effect zelf ingevuld (kan per broker verschillen), nooit overgenomen.
// De koers kan in beide richtingen: 1 EUR = … munt (ref_fx_per_eur) of 1 munt = … EUR (ref_eur_per_ccy).
const hasVal = v => v != null && String(v).trim() !== "";
const refFields = a => ({ ref_value_eur: a.ref_value_eur, ref_price: a.ref_price, ref_fx_per_eur: a.ref_fx_per_eur, ref_eur_per_ccy: a.ref_eur_per_ccy });
function refInputs(ccy, a, placeholder) {
  const eur = `<input name="ref_value_eur" inputmode="decimal" class="num" value="${esc(a.ref_value_eur ?? "")}" placeholder="${esc(placeholder)}" aria-label="Waarde 31/12/2025 in EUR"`;
  if (!ccy || ccy === "EUR") return eur + ">";
  const inv = hasVal(a.ref_eur_per_ccy) && !hasVal(a.ref_fx_per_eur);
  return `<div class="ref-fx" data-ccy="${esc(ccy)}">
    <label>Slotkoers in ${esc(ccy)} <input name="ref_price" inputmode="decimal" class="num" value="${esc(a.ref_price ?? "")}" placeholder="${esc(placeholder)}"></label>
    <span class="ref-fx-rate"><select name="ref_fx_dir" aria-label="Richting wisselkoers">
        <option value="PER_EUR"${inv ? "" : " selected"}>1 EUR = … ${esc(ccy)}</option>
        <option value="EUR_PER"${inv ? " selected" : ""}>1 ${esc(ccy)} = … EUR</option></select>
      <input name="ref_fx" inputmode="decimal" class="num" value="${esc((inv ? a.ref_eur_per_ccy : a.ref_fx_per_eur) ?? "")}" placeholder="koers 31/12/2025" aria-label="Wisselkoers 31/12/2025"></span>
    <label>In EUR ${eur}${hasVal(a.ref_price) ? " readonly" : ""}></label></div>`;
}
/** Bereken de EUR-waarde live zodra slotkoers en wisselkoers ingevuld zijn. */
function syncRef(row) {
  const p = $("[name=ref_price]", row); if (!p) return;
  const eurEl = $("[name=ref_value_eur]", row), filled = hasVal(p.value);
  eurEl.readOnly = filled;
  if (!filled) return;
  try { eurEl.value = refFromFx(p.value, $("[name=ref_fx_dir]", row).value, $("[name=ref_fx]", row).value).toString(); } catch { eurEl.value = ""; }
}
function refFromFx(price, dir, rate) {
  return dir === "EUR_PER" ? window.MWB.refValueFromEurRate(price, rate) : window.MWB.refValueFromCurrency(price, rate);
}
function readRef(row, label) {
  const p = $("[name=ref_price]", row);
  const price = p ? dec(p.value, `slotkoers 31/12/2025 voor ${label}`, { nonNegative: true }) : null;
  if (price == null)
    return { ref_value_eur: dec($("[name=ref_value_eur]", row).value, `waarde 31/12/2025 voor ${label}`, { nonNegative: true }), ref_price: null, ref_fx_per_eur: null, ref_eur_per_ccy: null };
  const dir = $("[name=ref_fx_dir]", row).value;
  const fx = dec($("[name=ref_fx]", row).value, `wisselkoers 31/12/2025 voor ${label}`, { required: true, positive: true });
  return { ref_value_eur: refFromFx(price, dir, fx).toString(), ref_price: price,
    ref_fx_per_eur: dir === "EUR_PER" ? null : fx, ref_eur_per_ccy: dir === "EUR_PER" ? fx : null };
}

// ================================================================ activa
function renderAssets() {
  const all = Object.entries(state.assets).sort(([a], [b]) => a.localeCompare(b));
  const refMissing = (isin, a) => needsRef(isin) && (a.ref_value_eur == null || a.ref_value_eur === "");
  // activa die niet meer in portefeuille zitten (alles verkocht/uitgekocht) standaard verbergen,
  // behalve als er nog een waarde op 31/12/2025 ontbreekt (nodig voor de berekening van die verkoop)
  const cfg = { ...defaultConfig(), fifoScope: state.settings.fifo_scope };
  const held = new Set(window.MWB.holdingsAt(state.transactions, "9999-12-31", cfg).map(h => h.asset));
  const used = isin => state.transactions.some(t => t.asset === isin);
  const closed = ([isin, a]) => used(isin) && !held.has(isin) && !refMissing(isin, a);
  // afgesloten (en eventueel door de gebruiker uit de lijst verwijderd): enkel tonen met het vinkje,
  // zodat de waarde op 31/12/2025 achteraf nog te corrigeren blijft
  const removed = e => !!e[1].hidden && closed(e);
  const allClosed = all.filter(closed), showClosed = $("#asset-show-closed").checked;
  $("#asset-closed-toggle").hidden = !allClosed.length;
  $("#asset-closed-count").textContent = allClosed.length;
  const list = all.filter(e => showClosed || !closed(e));
  $("#asset-empty").hidden = list.length > 0;
  $("#asset-empty").textContent = all.length ? "Geen activa meer in portefeuille." : "Nog geen activa.";
  const missing = list.filter(([i, a]) => refMissing(i, a)).length;
  $("#asset-missing").hidden = !missing;
  $("#asset-missing").textContent = `${missing === 1 ? "1 effect" : `${missing} effecten`} die je op 31/12/2025 had, ${missing === 1 ? "heeft" : "hebben"} nog geen waarde op 31/12/2025. Die is nodig zodra je ze verkoopt.`;
  $("#asset-table tbody").innerHTML = list.map(([isin, a]) => {
    const need = needsRef(isin), u = used(isin), gone = closed([isin, a]), off = removed([isin, a]);
    return `<tr data-isin="${esc(isin)}"${gone ? ` class="muted"` : ""}>
      <td><strong>${esc(isin)}</strong>${a.name && isIsinCode(isin) ? `<br><span class="small muted">${esc(a.name)}</span>` : ""}${need && (a.ref_value_eur == null || a.ref_value_eur === "") ? ` <span class="badge need">waarde nodig</span>` : ""}
        ${delistedOn(isin) ? ` <span class="badge" title="Delisting geregistreerd">geschrapt ${esc(delistedOn(isin))}</span>` : ""}
        ${gone ? ` <span class="badge" title="Niet meer in portefeuille">afgesloten</span>` : ""}
        ${off ? ` <span class="badge" title="Eerder uit de lijst verwijderd">verwijderd uit de lijst</span>` : ""}</td>
      <td><input name="isin" value="${esc(a.isin || (isIsinCode(isin) ? isin : ""))}" maxlength="12" placeholder="niet in export" autocapitalize="characters" aria-label="ISIN"></td>
      <td><select name="asset_type" aria-label="Type">${ASSET_TYPES.map(t => `<option ${t === a.asset_type ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td><input name="currency" value="${esc(a.currency)}" maxlength="5" class="w-sm" aria-label="Munt"></td>
      <td>${refInputs((a.currency || "EUR").toUpperCase(), a, need ? "verplicht" : "n.v.t.")}</td>
      <td><input name="ref_source" value="${esc(a.ref_source)}" placeholder="bv. Euronext slotkoers, ECB-koers" aria-label="Bron"></td>
      <td class="actions-cell"><button class="btn small primary" data-save>Bewaar</button>
        ${off ? `<button class="btn small" data-restoreasset title="Terug in de lijst zetten">Terugzetten</button>`
          : gone ? `<button class="btn small danger" data-removeasset aria-label="Verwijder uit de lijst" title="Verwijder uit de lijst">✕</button>`
          : u ? "" : `<button class="btn small danger" data-delasset aria-label="Verwijder">✕</button>`}</td></tr>`;
  }).join("");
}
$("#asset-show-closed").addEventListener("change", renderAssets);
$("#asset-table").addEventListener("input", e => { const row = e.target.closest("tr[data-isin]"); if (row) syncRef(row); });
$("#asset-table").addEventListener("click", async e => {
  const row = e.target.closest("tr[data-isin]");
  if (!row) return;
  const isin = row.dataset.isin, label = state.assets[isin]?.name ? `${state.assets[isin].name} (${isin})` : isin;
  if (e.target.closest("[data-delasset]")) {
    if (await confirmDialog(`Actief ${label} verwijderen?`)) { delete state.assets[isin]; commit(); }
    return;
  }
  if (e.target.closest("[data-removeasset]")) {
    // de transacties en de waarde op 31/12/2025 blijven bewaard: het rapport rekent er nog mee
    if (await confirmDialog(`${label} zit niet meer in je portefeuille. Uit de lijst verwijderen? ` +
        `De transacties blijven bewaard en tellen mee in het rapport.`)) {
      state.assets[isin].hidden = true; commit(); toast(`${label} verwijderd uit de lijst`);
    }
    return;
  }
  if (e.target.closest("[data-restoreasset]")) {
    delete state.assets[isin].hidden; commit(); toast(`${label} terug in de lijst`);
    return;
  }
  if (!e.target.closest("[data-save]")) return;
  const v = {}; $$("input, select", row).forEach(el => { v[el.name] = el.value.trim(); });
  try {
    const ccy = (v.currency || "EUR").toUpperCase();
    const ref = ccy === "EUR" ? { ref_value_eur: dec(v.ref_value_eur, "waarde 31/12/2025", { nonNegative: true }), ref_price: null, ref_fx_per_eur: null, ref_eur_per_ccy: null }
      : readRef(row, isin);
    const code = v.isin.replace(/\s/g, "").toUpperCase();
    if (code && !isIsinCode(code)) throw new InputError("Een ISIN heeft 12 tekens: 2 letters, 9 letters of cijfers en een cijfer (bv. BE0003565737).");
    state.assets[isin] = { ...state.assets[isin], isin: code, asset_type: v.asset_type, currency: ccy, ...ref, ref_source: v.ref_source };
    commit(); toast(`${isin} bewaard`);
  } catch (err) { toast(err.message, true); }
});

// ================================================================ instellingen
function renderSettings() {
  $("#s-method").value = state.settings.historic_method;
  $("#s-scope").value = state.settings.fifo_scope;
  $("#year-table tbody").innerHTML = Object.keys(state.years).sort().map(y => yearRow(y, state.years[y])).join("");
  $("#withheld-table tbody").innerHTML = state.withheld.length ? state.withheld
    .slice().sort((a, b) => a.year - b.year || a.owner.localeCompare(b.owner)).map(w => `
    <tr><td>${esc(w.owner)}</td><td>${w.year}</td><td class="num">${eur(w.amount)}${w.parts && Object.keys(w.parts).length > 1
      ? `<br><span class="small muted">${Object.entries(w.parts).map(([b, v]) => `${esc(b)} ${eur(v)}`).join(" + ")}</span>` : ""}</td>
      <td class="actions-cell"><button class="btn small danger" data-delw="${esc(w.owner)}|${w.year}" aria-label="Verwijder">✕</button></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">Geen inhoudingen ingevoerd.</td></tr>`;
  $("#withheld-form").elements.owner.value ||= DEFAULT_OWNER;
}
function yearRow(year, y) {
  return `<tr data-year="${esc(year)}"><td><strong>${esc(year)}</strong></td>
    <td><input name="rate" class="num w-sm" value="${esc(y.rate)}" aria-label="Tarief"></td>
    <td><input name="base_exemption" class="num" value="${esc(y.base_exemption)}" aria-label="Basisvrijstelling"></td>
    <td><input name="carry_slice" class="num" value="${esc(y.carry_slice)}" aria-label="Overdraagbare schijf"></td>
    <td><input name="carry_validity_years" class="num w-xs" value="${esc(y.carry_validity_years)}" aria-label="Geldigheid"></td>
    <td><input name="source" value="${esc(y.source)}" placeholder="bron (KB/Staatsblad)" aria-label="Bron"></td>
    <td class="actions-cell"><button class="btn small primary" data-savey>Bewaar</button>
      <button class="btn small danger" data-dely aria-label="Verwijder">✕</button></td></tr>`;
}
$("#btn-save-settings").addEventListener("click", () => {
  state.settings = { historic_method: $("#s-method").value, fifo_scope: $("#s-scope").value };
  commit(); toast("Instellingen opgeslagen");
});
$("#btn-add-year").addEventListener("click", () => {
  const ys = Object.keys(state.years).map(Number), next = (ys.length ? Math.max(...ys) : 2025) + 1;
  $("#year-table tbody").insertAdjacentHTML("beforeend",
    yearRow(next, { rate: "0.10", base_exemption: "", carry_slice: "1000", carry_validity_years: 5, source: "" }));
});
$("#year-table").addEventListener("click", async e => {
  const row = e.target.closest("tr[data-year]"); if (!row) return;
  const year = row.dataset.year;
  if (e.target.closest("[data-savey]")) {
    const v = {}; $$("input", row).forEach(el => { v[el.name] = el.value.trim(); });
    try {
      const rate = dec(v.rate, "tarief", { required: true, nonNegative: true });
      if (D(rate).gt(1)) throw new InputError("Tarief als fractie invoeren (0.10 = 10%).");
      state.years[year] = { rate, base_exemption: dec(v.base_exemption, "basisvrijstelling", { required: true, nonNegative: true }),
        carry_slice: dec(v.carry_slice, "overdraagbare schijf", { required: true, nonNegative: true }),
        carry_validity_years: parseInt(v.carry_validity_years, 10) || 5, source: v.source };
      commit(); toast(`Parameters ${year} bewaard`);
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.closest("[data-dely]") && await confirmDialog(`Parameters voor ${year} verwijderen?`)) { delete state.years[year]; commit(); }
});
$("#withheld-form").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target, owner = f.elements.owner.value.trim() || DEFAULT_OWNER, year = parseInt(f.elements.year.value, 10);
  try {
    if (!(year >= 2026)) throw new InputError("Jaar moet vanaf 2026 zijn.");
    const amount = dec(f.elements.amount.value, "bedrag", { required: true, nonNegative: true });
    state.withheld = state.withheld.filter(w => !(w.owner === owner && w.year === year));
    state.withheld.push({ owner, year, amount });
    f.elements.amount.value = ""; commit(); toast("Inhouding bewaard");
  } catch (err) { toast(err.message, true); }
});
$("#withheld-table").addEventListener("click", e => {
  const b = e.target.closest("[data-delw]"); if (!b) return;
  const [owner, year] = [b.dataset.delw.slice(0, b.dataset.delw.lastIndexOf("|")), Number(b.dataset.delw.split("|").pop())];
  state.withheld = state.withheld.filter(w => !(w.owner === owner && w.year === year)); commit();
});

// back-up
async function offerDownload(filename, text, fallbackLabel) { // text: tekst of Blob
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  const dl = use ? await use("downloads").catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: text }); return; }
    catch (e) { if (e && /declin|cancel|reject/i.test(String(e.code || e.message))) return; }
  }
  if (!use) { // buiten claude.ai: gewoon als bestand downloaden
    try {
      const url = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type: filename.endsWith(".csv") ? "text/csv" : "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return;
    } catch {}
  }
  if (text instanceof Blob) return toast(`${fallbackLabel} kon niet bewaard worden in deze weergave.`, true);
  try { await navigator.clipboard.writeText(text); toast(`${fallbackLabel} gekopieerd naar het klembord`); }
  catch { showTextDialog(fallbackLabel, text); }
}
$("#btn-export").addEventListener("click", () => offerDownload(`meerwaarde-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 1), "Back-up"));
$("#btn-export-full").addEventListener("click", async e => {
  const btn = e.currentTarget, label = btn.textContent;
  await proofs.init;
  const list = window.BEWIJS.allAttachments(state.transactions), files = {};
  let missing = 0;
  btn.disabled = true;
  try {
    for (const [i, a] of list.entries()) {
      btn.textContent = `Bewijsstukken verzamelen… ${i + 1}/${list.length}`;
      if (!proofReachable(a)) { missing++; continue; }
      try {
        const b = await proofBlob(a);
        files[a.id] = { name: a.name, type: a.type || b.type, data: window.BEWIJS.toBase64(new Uint8Array(await b.arrayBuffer())) };
      } catch { missing++; }
    }
    const text = JSON.stringify({ ...state, proof_files: files });
    await offerDownload(`meerwaarde-backup-met-bewijzen-${new Date().toISOString().slice(0, 10)}.json`, new Blob([text], { type: "application/json" }), "Back-up");
    if (missing) toast(`${missing} ${missing === 1 ? "bewijsstuk zat" : "bewijsstukken zaten"} niet in de back-up: ${missing === 1 ? "het staat" : "ze staan"} ${proofs.onClaude ? "in een browser buiten claude.ai" : "op de claude.ai-pagina"} of ${missing === 1 ? "is" : "zijn"} niet meer te vinden.`, true);
  } catch (err) { toast("Back-up maken mislukt: " + (err.message || err), true); }
  finally { btn.disabled = false; btn.textContent = label; }
});
$("#btn-copy-backup").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(state)); toast("Back-up gekopieerd naar het klembord"); }
  catch { showTextDialog("Back-up", JSON.stringify(state)); }
});
$("#btn-csv").addEventListener("click", () => {
  try { offerDownload("verkopen.csv", "﻿" + salesCsv(), "CSV"); } catch (e) { toast(e.message, true); }
});
$("#btn-pdf").addEventListener("click", () => {
  let pdf;
  try { pdf = reportPdf(); } catch (e) { return toast("PDF maken mislukt: " + e.message, true); }
  offerDownload(`meerwaarde-rapport-${new Date().toISOString().slice(0, 10)}.pdf`, new Blob([pdf], { type: "application/pdf" }), "PDF-rapport");
});
$("#import-file").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  await importBackup(await file.text()); e.target.value = "";
});
$("#btn-import-paste").addEventListener("click", () => importBackup($("#import-text").value));
async function importBackup(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return toast("Dit is geen geldige back-up (JSON).", true); }
  const { state: s, files } = window.BEWIJS.splitBackup(parsed);
  if (!validState(s)) return toast("Dit bestand heeft niet de vorm van een back-up van deze tool.", true);
  const nf = Object.keys(files).length;
  const nc = s.cash.length;
  if (!(await confirmDialog(`Back-up met ${s.transactions.length} transacties${nc ? `, ${nc} geldbewegingen` : ""}${nf ? ` en ${nf} bewijsstukken` : ""} herstellen? Je huidige gegevens worden vervangen${syncOn() ? ", ook op je gekoppelde toestellen" : ""}.`))) return;
  const previous = window.BEWIJS.allAttachments(state.transactions);
  state = s; state.nextId = Math.max(state.nextId || 1, ...state.transactions.map(t => t.id + 1), ...state.cash.map(c => (c.id || 0) + 1));
  migrateToNames();
  $("#import-text").value = ""; commit(); toast("Back-up hersteld");
  if (nf) await restoreProofFiles(files, previous);
}
/** Bestanden uit een back-up terugzetten; wat er al staat (zelfde pagina of browser) wordt niet dubbel opgeslagen. */
async function restoreProofFiles(files, previous = []) {
  await proofs.init;
  const kind = proofStoreKind();
  if (!kind) return toast("De bewijsstukken uit de back-up konden niet teruggezet worden: deze pagina heeft geen toestemming voor bestanden.", true);
  const todo = window.BEWIJS.allAttachments(state.transactions).filter(a => files[a.id]);
  const map = new Map();
  let kept = 0, failed = 0;
  for (const [i, a] of todo.entries()) {
    toast(`Bewijsstukken terugzetten… ${i + 1}/${todo.length}`);
    if (a.store === kind && await proofExists(a)) { kept++; continue; }
    try {
      const f = files[a.id], type = window.BEWIJS.contentType(f.name || a.name, f.type || a.type);
      const bytes = window.BEWIJS.fromBase64(f.data);
      // zelfde bestand stond er al (bv. dezelfde back-up opnieuw hersteld): hergebruiken in plaats van dubbel opslaan
      const same = previous.find(p => p.store === kind && p.name === (f.name || a.name) && p.size === bytes.length);
      if (same && await proofExists(same)) { map.set(a.id, { id: same.id, store: same.store, size: same.size, type: same.type }); continue; }
      const file = new File([bytes], f.name || a.name, { type: type || "" });
      const saved = await saveProofFile(file);
      map.set(a.id, { id: saved.id, store: saved.store, size: saved.size, type: saved.type });
    } catch { failed++; }
  }
  if (map.size) { window.BEWIJS.remapAttachments(state.transactions, map); commit(); }
  toast(`${map.size + kept} van ${todo.length} bewijsstukken hersteld` + (failed ? `; ${failed} mislukt` : ""), failed > 0);
}
async function proofExists(a) {
  try {
    if (a.store === "account") return (await fetch("/_blob/" + a.id, { method: "HEAD" })).ok;
    return !!(await idb.get(a.id));
  } catch { return false; }
}
$("#btn-reset").addEventListener("click", async () => {
  const files = state.transactions.flatMap(t => t.attachments || []);
  if (await confirmDialog("Alle gegevens wissen?" + (syncOn() ? " Ze verdwijnen ook op je gekoppelde toestellen." : "") + " Maak eerst een back-up als je ze wil bewaren." + (files.length ? ` Ook de ${files.length} bewijsstukken worden verwijderd (die zitten enkel in de back-up met bewijsstukken).` : ""))) {
    state = emptyState(); commit(); toast("Alle gegevens gewist");
    for (const a of files) deleteProofFile(a);
  }
});

// ================================================================ Bolero-import
let pendingImport = null;
$("#import-bolero").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 2));
    let r;
    if (head[0] === 0x50 && head[1] === 0x4b) {
      const sheets = await window.XLSX_LITE.readXlsx(buf);
      r = window.BOLERO.parseBoleroSheets(sheets, { owner: DEFAULT_OWNER, fileName: file.name })
        || window.SAXO.parseSaxoSheets(sheets, { owner: DEFAULT_OWNER, fileName: file.name });
    } else {
      const text = new TextDecoder().decode(buf);
      if (/Datum transactie/.test(text)) r = window.BOLERO.parseBolero(text, { owner: DEFAULT_OWNER, fileName: file.name });
      else if (/Instrument ISIN/i.test(text)) {
        const first = text.split(/\r?\n/, 1)[0];
        const rows = window.BOLERO.parseCsv(text, first.split(";").length > first.split(",").length ? ";" : ",");
        r = window.SAXO.parseSaxoSheets({ csv: rows }, { owner: DEFAULT_OWNER, fileName: file.name });
      } else throw new Error("Bestand niet herkend. Gebruik de Bolero-export 'Cashbewegingen' of de Saxo-export 'Transacties' (Excel of CSV).");
    }
    r.source ??= "bolero";
    r.keyMoves = window.SAXO.keyMigrations(state.transactions, r.transactions);
    pendingImport = r;
    openImportDialog(r);
  } catch (err) { toast(err.message, true); }
});
function openImportDialog(r) {
  $("#import-dialog").classList.toggle("saxo", r.source === "saxo");
  $("#imp-title").textContent = r.source === "saxo" ? "Saxo-export importeren" : "Bolero-export importeren";
  const dl = r.delistings || [];
  $("#imp-delist-wrap").hidden = !dl.length;
  $("#imp-delist tbody").innerHTML = dl.map((d, i) => `<tr data-d="${i}">
    <td><input type="checkbox" name="add" checked aria-label="Toevoegen"></td>
    <td><strong>${esc(d.name)}</strong><br><span class="small muted">${esc(d.asset)}</span></td>
    <td>${esc(d.date)}</td><td class="num">${num(d.quantity)}</td>
    <td><select name="mode">${Object.entries(DELIST_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select></td>
    <td><input name="price" inputmode="decimal" class="num" placeholder="EUR per stuk" disabled aria-label="Uitkoopprijs"></td></tr>`).join("");
  const dupFlags = importDupFlags(r);
  const fresh = r.transactions.filter((t, i) => !dupFlags[i]);
  const cnt = type => fresh.filter(t => t.type === type).length;
  const dup = r.transactions.length - fresh.length;
  const freshCash = GELD.fresh(state.cash, r.cash), dupCash = (r.cash || []).length - freshCash.length;
  $("#imp-summary").innerHTML = `<strong>${esc(r.fileName)}</strong>: ${r.rows} regels gelezen.
    Nieuw: ${cnt("BUY")} aankopen, ${cnt("SELL")} verkopen, ${cnt("DIVIDEND")} dividenden${freshCash.length ? `, ${freshCash.length} ${freshCash.length === 1 ? "geldbeweging" : "geldbewegingen"}` : ""}.
    ${dup ? `<br>${dup} transacties waren al eerder geïmporteerd en worden overgeslagen.` : ""}
    ${dupCash ? `<br>${dupCash} ${dupCash === 1 ? "geldbeweging was" : "geldbewegingen waren"} al eerder geïmporteerd.` : ""}`;
  const groups = GELD.groups(freshCash);
  const list = gs => `<ul class="imp-list">${gs.map(g => `<li><span class="cnt">${g.count}</span><span class="grow">${esc(g.group)}${g.remark
    ? `<span class="cash-note done">${esc(g.remark)}</span>` : ""}</span></li>`).join("")}</ul>`;
  const news = groups.filter(g => g.status !== "verwerkt"), done = groups.filter(g => g.status === "verwerkt");
  $("#imp-cash").innerHTML = (news.length ? `<div class="imp-sub">Nieuw in de tool</div>${list(news)}` : "")
    + (done.length ? `<div class="imp-sub">Al verwerkt, nu ook zichtbaar als info</div>${list(done)}` : "");
  $("#imp-cash-count").textContent = freshCash.length;
  $("#imp-cash-wrap").hidden = !freshCash.length;
  $("#imp-cash-add").checked = true;
  $("#imp-skipped").innerHTML = Object.entries(r.skipped).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join("");
  $("#imp-skipped-wrap").hidden = !Object.keys(r.skipped).length;
  $("#imp-owner").value = DEFAULT_OWNER;
  r.exch = exchangeProposals(r);
  $("#imp-positions tbody").innerHTML = r.positions.map((p, i) => {
    const oldKey = [...(r.keyMoves || [])].find(([, to]) => to === p.asset)?.[0];
    const known = [state.assets[p.asset], oldKey && state.assets[oldKey]].find(a => a && hasVal(a.ref_value_eur));
    const cur = known?.ref_value_eur;
    const ccy = String(r.assets?.[p.asset]?.currency || state.assets[p.asset]?.currency || "EUR").toUpperCase();
    const val = known ? refFields(known) : { ref_value_eur: p.refHint?.value ?? "" };
    return `<tr data-i="${i}" class="${p.suspicious ? "suspicious" : ""}">
      <td><input type="checkbox" name="keep" ${p.suspicious || exchangedBefore(p.asset) ? "" : "checked"} ${exchangedBefore(p.asset) ? "disabled" : ""} aria-label="Nog in bezit"></td>
      <td><strong>${esc(p.asset)}</strong>${p.name ? `<br><span class="small muted">${esc(p.name)}</span>` : ""}<span class="exch-state small"></span>${exchangedBefore(p.asset)
        ? `<br><span class="small pos">al omgeruild (eerder bevestigd): wordt niet uitgeboekt</span>`
        : p.suspicious && !r.exch.some(e => e.x.asset === p.asset) ? `<br><span class="small neg">waarschijnlijk niet meer in bezit (overname, splitsing of naamswijziging?)</span>` : ""}</td>
      <td class="num">${num(p.quantity)}</td>
      <td class="col-div">${esc(p.lastDividend || "–")}</td>
      <td>${refInputs(ccy, val, ccy === "EUR" ? "slotkoers in EUR" : "")}
        <span class="hint need-hint" hidden></span>
        ${p.refHint && cur == null ? `<span class="hint">${esc(p.refHint.from)}</span>` : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">Geen posities op 31/12/2025 volgens deze export.</td></tr>`;
  renderExchanges();
  $("#import-dialog").showModal();
  markNeededRefs();
}

// ---------------------------------------------------------------- omruilingen bij import (voorstel, bevestigen)
/** Omruilingen die al bevestigd zijn (in de tool), per oud effect. */
const exchangedBefore = asset => state.transactions.some(t => t.type === "RUIL" && t.asset === asset);
/** Dubbels zoals voorheen, plus de 'dividenden' die bij een eerder bevestigde omruiling als cash verwerkt zijn. */
function importDupFlags(r) {
  const flags = window.BOLERO.duplicateFlags(state.transactions, r.transactions);
  const ids = new Set(), keys = new Set();
  for (const t of state.transactions) if (t.type === "RUIL") { if (t.cash_import_id) ids.add(t.cash_import_id); if (t.cash_content_key) keys.add(t.cash_content_key); }
  return r.transactions.map((t, i) => flags[i] || ids.has(t.import_id) || (t.type === "DIVIDEND" && keys.has(window.BOLERO.contentKey(t))));
}
function exchangeProposals(r) {
  return (r.exchanges || []).filter(x => !exchangedBefore(x.asset) && !state.transactions.some(t => t.import_id === x.import_id))
    .map(x => ({ x, accept: true, cashOn: !!x.cash?.checked, comps: x.components.map(c => ({ ...c, on: true })) }));
}
const exchAccepted = e => e.accept && e.comps.some(c => c.on && c.asset.trim() && hasVal(c.quantity));
/** Transactie 'Omruiling' uit een voorstel (gooit InputError bij ongeldige invoer). */
function exchangeTx(e, owner) {
  const comps = e.comps.filter(c => c.on && (c.asset.trim() || hasVal(c.quantity)));
  if (!comps.length) throw new InputError(`Omruiling ${e.x.asset}: kies minstens één nieuw effect.`);
  const cash = e.cashOn ? e.x.cash : null;
  const raw = { type: "RUIL", trade_date: e.x.date, asset: e.x.asset, owner, broker: "Bolero", quantity: "", price: cash ? cash.per_share : "0",
    currency: cash ? cash.currency : "EUR", fx_per_eur: cash ? cash.fx_per_eur : "1", eur_per_ccy: cash ? cash.eur_per_ccy : null,
    components: comps.map(c => ({ asset: c.asset, quantity: c.quantity, value: c.value })) };
  return { ...validateTx(raw), import_id: e.x.import_id, import_source: e.x.source,
    cash_import_id: cash ? cash.import_id : null, cash_content_key: cash ? window.BOLERO.contentKey(pendingDividend(cash.import_id)) : null,
    note: "Omruiling volgens de Bolero-export (voorstel bevestigd bij import)" };
}
const pendingDividend = id => (pendingImport?.transactions || []).find(t => t.import_id === id) || {};
function renderExchanges() {
  const r = pendingImport; if (!r) return;
  $("#imp-exch-wrap").hidden = !r.exch.length;
  $("#exch-assets").innerHTML = [...new Set([...(r.incomplete || []), ...Object.keys(state.assets)])].map(a => `<option value="${esc(a)}">`).join("");
  $("#imp-exch").innerHTML = r.exch.map((e, i) => `<div class="exch" data-x="${i}">
    <h4>Voorstel: ${esc(e.x.asset)} omgeruild op ${esc(e.x.date)}</h4>
    <p class="why">Waarom: ${e.x.reasons.map(esc).join(" · ")}.</p>
    <div class="comps">${e.comps.map((c, j) => exchCompHtml(e, c, j)).join("")}</div>
    <p style="margin:.45rem 0 0"><button type="button" class="btn small ghost" data-exch-add>+ Ander effect toevoegen</button></p>
    ${e.x.cash ? `<div class="exch-box"><label class="check" style="margin:0"><input type="checkbox" data-exch-cash ${e.cashOn ? "checked" : ""}>
      <span><strong>Cash bij omruiling:</strong> ${esc(e.x.cash.currency)} ${num(e.x.cash.amount)} op ${esc(e.x.cash.date)} voor ${num(e.x.quantity)} stuks
      (${num(D(e.x.cash.per_share).toString())} per oud stuk).<span class="why"><br>In de export als "${esc(e.x.cash.description)}"; ${esc(e.x.cash.hint)}.
      Aangevinkt: telt niet als dividend, maar als cash van de overname.</span></span></label></div>` : ""}
    <div class="exch-cols"><div><strong class="small">Wordt toegevoegd</strong><div class="exch-tx"></div></div>
      <div><strong class="small">Gevolg voor je loten</strong><div class="exch-lots"></div></div></div>
    <label class="check" style="margin-top:.6rem"><input type="checkbox" data-exch-accept ${e.accept ? "checked" : ""}> <strong>Omruiling toevoegen bij import</strong></label>
  </div>`).join("");
  updateExchanges();
}
function exchCompHtml(e, c, j) {
  const ratio = hasVal(c.quantity) && !D(e.x.quantity).isZero() ? (() => { try { return num(D(c.quantity).div(D(e.x.quantity)).round(6).toString()); } catch { return "–"; } })() : "–";
  return `<div class="exch-comp" data-c="${j}">
    <input type="checkbox" data-k="on" ${c.on ? "checked" : ""} aria-label="Meenemen">
    <div><span class="lbl">Nieuw effect</span>${c.manual ? `<input data-k="asset" value="${esc(c.asset)}" list="exch-assets" placeholder="naam" aria-label="Nieuw effect">` : `<strong>${esc(c.asset)}</strong>`}</div>
    <div><span class="lbl">Ontvangen · per oud stuk</span>${c.manual ? `<input data-k="quantity" value="${esc(c.quantity)}" inputmode="decimal" aria-label="Ontvangen stuks" style="width:5.5rem">`
      : `<strong>${num(c.quantity)}</strong>`} st. · <span class="ratio">${ratio}</span></div>
    <div class="val"><span class="lbl">Waarde per stuk op ruildatum</span><input data-k="value" value="${esc(c.value)}" inputmode="decimal" placeholder="leeg = niet verdelen" aria-label="Waarde per stuk">
      ${c.value_note ? `<span class="hint">${esc(c.value_note)}</span>` : ""}</div>
    <div class="via">Gevonden via: ${esc(c.via)}</div></div>`;
}
/** Voorbeeld (transactie en loten), status in de positietabel en de aandachtspunten bijwerken. */
function updateExchanges() {
  const r = pendingImport; if (!r) return;
  const owner = $("#imp-owner").value.trim() || DEFAULT_OWNER;
  const dups = r.exch.length ? importDupFlags(r) : [];
  r.exch.forEach((e, i) => {
    const box = $(`.exch[data-x="${i}"]`); if (!box) return;
    box.classList.toggle("off", !e.accept);
    let html, lots = "";
    try {
      const t = exchangeTx(e, owner);
      html = `<div class="alert ok"><strong>Omruiling (fusie/overname)</strong> · ${esc(t.trade_date)}<br>${esc(t.asset)} → ` +
        t.components.map(c => `${num(c.quantity)} ${esc(c.asset)}`).join(" + ") + (D(t.price).gt(0) ? ` + ${esc(t.currency)} ${num(D(t.price).round(6).toString())} cash per stuk` : "") +
        `<br><span class="small">Volledige positie (${num(e.x.quantity)} st.).${t.trade_date < "2026-01-01" ? " Geen belastbaar moment (vóór 2026)." : " Vanaf 2026: de cash telt als verkoop."}</span></div>`;
      const fresh = r.transactions.filter((x, k) => !dups[k] && !(e.cashOn && x.import_id === t.cash_import_id));
      const all = [...state.transactions.filter(x => x.owner === owner), ...fresh.map(x => ({ ...x, owner }))].concat([{ ...t }]);
      const cfg = { ...defaultConfig(), fifoScope: state.settings.fifo_scope };
      const got = window.MWB.lotsAt(all, {}, cfg, t.trade_date).filter(l => t.components.some(c => c.asset === l.asset) && l.acquired <= t.trade_date);
      const split = got.some(l => l.unit_cost_eur);
      lots = got.length ? `<div class="table-wrap"><table><thead><tr><th>Effect</th><th>Aankoop</th><th class="num">Aantal</th><th class="num">Hist. prijs/st.</th></tr></thead><tbody>` +
        got.map(l => `<tr><td>${esc(l.asset)}</td><td>${esc(l.acquired)}</td><td class="num">${num(l.quantity.round(6).toString())}</td>
          <td class="num">${l.unit_cost_eur ? eur(l.unit_cost_eur.toFixed(2)) : `<span class="muted">niet verdeeld</span>`}</td></tr>`).join("") + `</tbody></table></div>` +
        `<p class="hint">${split ? "De aankoopprijs is verdeeld volgens de waarde op de ruildatum (eigen interpretatie, te bevestigen)."
          : "Zonder waarde per stuk voor elk nieuw effect wordt de aankoopprijs niet verdeeld: geen hogere historische prijs mogelijk."}</p>`
        : `<p class="hint">Geen aankopen van ${esc(e.x.asset)} gevonden vóór de ruildatum.</p>`;
    } catch (err) { html = `<div class="alert warn">${esc(err.message)}</div>`; }
    $(".exch-tx", box).innerHTML = html; $(".exch-lots", box).innerHTML = lots;
    const tr = [...$$("#imp-positions tbody tr[data-i]")].find(x => r.positions[Number(x.dataset.i)].asset === e.x.asset);
    if (tr) {
      const on = exchAccepted(e), keep = $("[name=keep]", tr);
      keep.disabled = on; if (on) keep.checked = false;
      $(".exch-state", tr).innerHTML = on ? `<br><span class="pos">omgeruild op ${esc(e.x.date)}: wordt uitgeboekt (zie voorstel hieronder)</span>`
        : `<br><span class="neg">waarschijnlijk niet meer in bezit · mogelijk omgeruild (zie voorstel hieronder)</span>`;
    }
  });
  // aandachtspunten: wat een bevestigde omruiling oplost, doorstrepen
  const on = r.exch.filter(exchAccepted);
  const done = new Set(on.flatMap(e => e.x.resolves.warnings));
  const solved = new Set(on.flatMap(e => e.comps.filter(c => c.on).map(c => c.asset)));
  const short = r.incomplete?.length ? window.BOLERO.shortWarning(r.period, r.incomplete) : null;
  const left = (r.incomplete || []).filter(a => !solved.has(a));
  const items = r.warnings.map(w => w === short && left.length < r.incomplete.length
    ? (left.length ? { text: window.BOLERO.shortWarning(r.period, left), done: false } : { text: w, done: true })
    : { text: w, done: done.has(w) });
  for (const e of on) if (e.cashOn) items.push({ text: `${e.x.cash.date} ${e.x.asset}: betaling van ${e.x.cash.currency} ${num(e.x.cash.amount)} telt niet als dividend maar als cash van de omruiling.`, done: false, info: true });
  $("#imp-warnings").innerHTML = items.map(w => `<li class="${w.done ? "done" : ""}">${esc(w.text)}${w.done ? ` <span class="badge ok">opgelost</span>` : ""}</li>`).join("");
  $("#imp-warn-wrap").hidden = !items.length;
  $("#imp-warn-count").textContent = items.filter(w => !w.done && !w.info).length + (items.some(w => w.done) ? ` open, ${items.filter(w => w.done).length} opgelost` : "");
}
$("#imp-exch").addEventListener("input", e => {
  const box = e.target.closest(".exch[data-x]"); if (!box) return;
  const x = pendingImport.exch[Number(box.dataset.x)], row = e.target.closest("[data-c]");
  if (row && e.target.dataset.k && e.target.type !== "checkbox") {
    const c = x.comps[Number(row.dataset.c)]; c[e.target.dataset.k] = e.target.value.trim();
    if (e.target.dataset.k === "quantity") $(".ratio", row).textContent = (() => { try { return num(D(c.quantity).div(D(x.x.quantity)).round(6).toString()); } catch { return "–"; } })();
  }
  updateExchanges();
});
$("#imp-exch").addEventListener("change", e => {
  const box = e.target.closest(".exch[data-x]"); if (!box) return;
  const x = pendingImport.exch[Number(box.dataset.x)], row = e.target.closest("[data-c]");
  if (row && e.target.dataset.k === "on") x.comps[Number(row.dataset.c)].on = e.target.checked;
  if (e.target.matches("[data-exch-cash]")) x.cashOn = e.target.checked;
  if (e.target.matches("[data-exch-accept]")) x.accept = e.target.checked;
  updateExchanges();
});
$("#imp-exch").addEventListener("click", e => {
  if (!e.target.closest("[data-exch-add]")) return;
  const box = e.target.closest(".exch[data-x]"), x = pendingImport.exch[Number(box.dataset.x)];
  x.comps.push({ asset: "", quantity: "", value: "", value_note: "", via: "zelf toegevoegd", manual: true, on: true });
  $(".comps", box).insertAdjacentHTML("beforeend", exchCompHtml(x, x.comps[x.comps.length - 1], x.comps.length - 1));
  updateExchanges();
});
$("#imp-owner").addEventListener("input", () => updateExchanges());
$("#imp-delist").addEventListener("change", e => {
  const tr = e.target.closest("tr[data-d]"); if (!tr) return;
  const buyout = $("[name=mode]", tr).value === "UITKOOP";
  $("[name=price]", tr).disabled = !buyout || !$("[name=add]", tr).checked;
  $("[name=mode]", tr).disabled = !$("[name=add]", tr).checked;
  markNeededRefs();
});
/** Markeer posities waarvoor de waarde op 31/12/2025 nodig is: verkocht of uitgekocht in 2026+. */
function neededRefAssets() {
  const r = pendingImport; if (!r) return new Map();
  const need = new Map();
  for (const t of [...state.transactions, ...r.transactions])
    if (t.type === "SELL" && t.trade_date >= "2026-01-01") need.set(t.asset, "nodig: verkocht in 2026 of later");
  $$("#imp-delist tbody tr[data-d]").forEach(tr => {
    const d = r.delistings[Number(tr.dataset.d)];
    if ($("[name=add]", tr).checked && $("[name=mode]", tr).value === "UITKOOP") need.set(d.asset, "nodig: de uitkoop telt als verkoop");
  });
  return need;
}
function markNeededRefs() {
  const need = neededRefAssets();
  $$("#imp-positions tbody tr[data-i]").forEach(tr => {
    const p = pendingImport.positions[Number(tr.dataset.i)], why = need.get(p.asset), h = $(".need-hint", tr);
    const empty = !$("[name=ref_value_eur]", tr).value.trim();
    h.hidden = !(why && empty); h.textContent = why || ""; h.classList.toggle("neg", !!why);
  });
}
$("#imp-positions").addEventListener("input", e => { const tr = e.target.closest("tr[data-i]"); if (tr) syncRef(tr); markNeededRefs(); });
$("#imp-cancel").addEventListener("click", () => { $("#import-dialog").close(); pendingImport = null; });
$("#imp-confirm").addEventListener("click", () => {
  const r = pendingImport; if (!r) return;
  const owner = $("#imp-owner").value.trim() || DEFAULT_OWNER;
  try {
    // fotowaarden valideren vóór er iets verandert
    const decisions = $$("#imp-positions tbody tr[data-i]").map(tr => {
      const p = r.positions[Number(tr.dataset.i)];
      return { p, keep: $("[name=keep]", tr).checked, ref: readRef(tr, p.asset) };
    });
    const delists = $$("#imp-delist tbody tr[data-d]").map(tr => {
      const d = r.delistings[Number(tr.dataset.d)], mode = $("[name=mode]", tr).value;
      return { d, add: $("[name=add]", tr).checked, mode,
        price: mode === "UITKOOP" && $("[name=add]", tr).checked ? dec($("[name=price]", tr).value, `uitkoopprijs voor ${d.name}`, { required: true, nonNegative: true }) : null };
    });
    const exch = (r.exch || []).filter(exchAccepted).map(e => ({ e, t: exchangeTx(e, owner) }));
    const moved = moveAssetKeys(r.keyMoves);
    const dupFlags = importDupFlags(r);
    const absorbed = new Set(exch.map(({ t }) => t.cash_import_id).filter(Boolean));
    let added = 0;
    // omruilingen eerst: op dezelfde dag vóór de verkoop van een nieuw effect
    for (const { t } of exch) {
      state.transactions.push({ ...t, id: newId() });
      for (const c of t.components) state.assets[c.asset] ??= { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
      added++;
    }
    for (const [i, t] of r.transactions.entries()) {
      if (dupFlags[i] || absorbed.has(t.import_id)) continue;
      state.transactions.push({ ...t, owner, id: newId() });
      added++;
    }
    const kindMap = { stock: "aandeel", etf: "etf", etc: "ander", etn: "ander", bond: "obligatie", fund: "fonds" };
    for (const [isin, a] of Object.entries(r.assets)) {
      state.assets[isin] ??= { name: "", asset_type: kindMap[(a.kind || "").toLowerCase()] || "aandeel", currency: a.currency, ref_value_eur: null, ref_source: "" };
      if (!state.assets[isin].name && a.name) state.assets[isin].name = a.name;
      if (!state.assets[isin].isin && a.isin) state.assets[isin].isin = a.isin;
    }
    for (const { d, add, mode, price } of delists) {
      const id = `delist:${owner}:${d.asset}:${d.date}`;
      if (!add || state.transactions.some(t => t.import_id === id)) continue;
      const a = state.assets[d.asset] || {};
      state.transactions.push({ id: newId(), type: "DELISTING", delist_mode: mode, trade_date: d.date, asset: d.asset,
        quantity: "0", price: price ?? "0", currency: mode === "UITKOOP" ? "EUR" : (a.currency || "EUR"), fx_per_eur: "1", fees: "0", taxes: "0",
        owner, broker: r.source === "saxo" ? "Saxo" : "Bolero", historic_proven: false, cost_known: true, reynders_eur: "0", amount: "0",
        split_ratio: null, import_id: id, note: `Delisting volgens ${r.source === "saxo" ? "Saxo" : "Bolero"}-export` });
      added++;
    }
    let cashAdded = 0;
    const doneCash = new Set(exch.flatMap(({ e }) => e.x.resolves.cash));
    const extraCash = exch.filter(({ e }) => e.cashOn).map(({ e }) => ({ kind: "CA", date: e.x.cash.date, amount: e.x.cash.amount, currency: e.x.cash.currency,
      asset_name: e.x.asset, description: e.x.cash.description, status: "verwerkt", remark: "cash bij omruiling (zie de transactie Omruiling)",
      owner, broker: "Bolero", import_id: "c" + e.x.cash.import_id, import_source: e.x.cash.source }));
    if ($("#imp-cash-add").checked) for (const c of GELD.fresh(state.cash, [...r.cash, ...extraCash])) {
      const done = doneCash.has(c.import_id);
      state.cash.push({ ...c, ...(done ? { status: "verwerkt", remark: "verwerkt in de omruiling", warn: undefined } : {}), owner, id: newId() });
      cashAdded++;
    }
    for (const t of r.transactions) if (t.type === "DIVIDEND")
      state.assets[t.asset] ??= { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
    for (const { p, keep, ref } of decisions) {
      if (keep && ref.ref_value_eur != null) {
        const a = state.assets[p.asset], v = ref.ref_value_eur;
        if (a.ref_value_eur !== v) a.ref_source = p.refHint && v === D(p.refHint.value).toString() ? p.refHint.from : (a.ref_source || "ingevoerd bij import");
        Object.assign(a, ref);
      }
      const corrId = `corr:${owner}:${p.asset}`;
      if (!keep && !exch.some(({ t }) => t.asset === p.asset) && !exchangedBefore(p.asset) && !state.transactions.some(t => t.import_id === corrId)) {
        state.transactions.push({ id: newId(), type: "SELL", trade_date: "2025-12-31", asset: p.asset, quantity: p.quantity, price: "0",
          currency: "EUR", fx_per_eur: "1", fees: "0", taxes: "0", owner, broker: "Bolero", historic_proven: false, cost_known: true,
          reynders_eur: "0", amount: "0", split_ratio: null, import_id: corrId,
          note: "Correctie bij import: niet meer in bezit op 31/12/2025 (vóór 2026, dus geen belastbaar moment)" });
      }
    }
    // door de broker ingehouden meerwaardebelasting per jaar overnemen (Bolero: kolom per verkoop; Saxo: boekingen)
    const perYear = {};
    for (const t of r.transactions) if (t.bolero_tax && !D(t.bolero_tax).isZero()) {
      const y = Number(t.trade_date.slice(0, 4)); perYear[y] = (perYear[y] || D(0)).add(D(t.bolero_tax).lt(0) ? D(t.bolero_tax).neg() : D(t.bolero_tax));
    }
    for (const [y, amt] of Object.entries(r.withheld || {})) perYear[y] = (perYear[y] || D(0)).add(D(amt));
    const brokerName = r.source === "saxo" ? "Saxo" : "Bolero";
    const notMerged = Object.entries(perYear).filter(([y, amt]) => !mergeWithheld(owner, Number(y), brokerName, amt))
      .map(([y, amt]) => `${y}: ${eur(amt.toFixed(2))}`);
    const need = neededRefAssets();
    const missing = [...need.keys()].filter(a => needsRef(a) && !(state.assets[a]?.ref_value_eur));
    $("#import-dialog").close(); pendingImport = null;
    commit();
    toast(`${added} transacties` + (cashAdded ? ` en ${cashAdded} ${cashAdded === 1 ? "geldbeweging" : "geldbewegingen"}` : "") + " geïmporteerd" + (moved ? `; ${moved} ${moved === 1 ? "effect staat" : "effecten staan"} nu onder de naam` : "") + (missing.length ? `. Vul nog de waarde op 31/12/2025 in bij Activa voor: ${missing.map(a => state.assets[a]?.name || a).join(", ")}` : "")
      + (notMerged.length ? `. ${brokerName} hield meerwaardebelasting in (${notMerged.join(", ")}); je had voor dat jaar al zelf een bedrag ingevuld – pas het aan bij Instellingen als nodig` : ""),
      missing.length > 0 || notMerged.length > 0);
  } catch (err) { toast(err.message, true); }
});

/**
 * Ingehouden bedrag per broker bijhouden (parts) en optellen. Een zelf ingevuld bedrag (zonder parts) blijft staan.
 * Een export dekt soms maar een deel van het jaar: het bedrag van een broker wordt enkel verhoogd, nooit verlaagd.
 */
function mergeWithheld(owner, year, broker, amt) {
  let w = state.withheld.find(x => x.owner === owner && x.year === year);
  if (w && !w.parts) {
    if (!D(w.amount).isZero()) return false; // zelf ingevuld of door een oudere versie: niet aanraken
    w.parts = {};
  }
  if (!w) { w = { owner, year, amount: "0", parts: {} }; state.withheld.push(w); }
  if (w.parts[broker] != null && D(w.parts[broker]).gte(amt)) return true;
  w.parts[broker] = amt.toString();
  w.amount = Object.values(w.parts).reduce((s, v) => s.add(D(v)), D(0)).toString();
  return true;
}

const isIsinCode = k => /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(k || ""));
/** Oude naam -> nieuwe naam in transacties en activa (bv. Saxo-effecten die vroeger onder de ISIN stonden). */
function moveAssetKeys(plan) {
  let n = 0;
  for (const [from, to] of plan || []) {
    for (const t of state.transactions) {
      if (t.asset === from) t.asset = to;
      if (t.import_id === `corr:${t.owner}:${from}`) t.import_id = `corr:${t.owner}:${to}`;
      else if (typeof t.import_id === "string" && t.import_id.startsWith(`delist:${t.owner}:${from}:`))
        t.import_id = `delist:${t.owner}:${to}:` + t.import_id.slice(`delist:${t.owner}:${from}:`.length);
    }
    const src = state.assets[from], dst = state.assets[to];
    if (src) {
      const merged = { ...src };
      if (dst) for (const [k, v] of Object.entries(dst)) if (v != null && v !== "") merged[k] = v;
      if (!merged.isin && isIsinCode(from)) merged.isin = from;
      state.assets[to] = merged;
      delete state.assets[from];
    }
    n++;
  }
  return n;
}

/**
 * Gegevens van vroegere versies: effecten die onder een ISIN (of, bij Saxo, onder een ticker) staan,
 * verhuizen naar hun naam, zodat Actief overal de naam is. Enkel als de naam gekend is.
 */
function nameMigrationPlan() {
  const plan = new Map();
  for (const [key, a] of Object.entries(state.assets)) {
    const txs = state.transactions.filter(t => t.asset === key);
    const saxoOnly = txs.length > 0 && txs.every(t => String(t.import_id || "").startsWith("s:"));
    if (!isIsinCode(key) && !saxoOnly) continue; // Bolero en zelf ingevoerde namen blijven zoals ze zijn
    let name = String(a.name || "").trim();
    if (!name && saxoOnly) name = String(txs.find(t => t.note)?.note || "").split(";")[0].trim(); // Saxo zet de naam in de notitie
    if (!name) continue;
    let to = name.replace(/\s+/g, " ").toUpperCase();
    const isin = a.isin || (isIsinCode(key) ? key : "");
    const other = state.assets[to];
    if (other && other.isin && isin && other.isin !== isin) to = `${to} (${isin})`;
    if (to !== key) plan.set(key, to);
  }
  return plan;
}
function migrateToNames() { return moveAssetKeys(nameMigrationPlan()); }

// voorbeeld
function loadExample() {
  const ex = [
    { type: "BUY", trade_date: "2024-05-01", asset: "VOORBEELD NV", quantity: "100", price: "50", historic_proven: true, broker: "Bolero" },
    { type: "BUY", trade_date: "2025-05-01", asset: "VOORBEELD NV", quantity: "50", price: "120", historic_proven: true, broker: "Bolero" },
    { type: "BUY", trade_date: "2026-03-01", asset: "VOORBEELD NV", quantity: "50", price: "90", broker: "Bolero" },
    { type: "SELL", trade_date: "2026-09-01", asset: "VOORBEELD NV", quantity: "120", price: "110", fees: "7.50", taxes: "4.62", broker: "Bolero" },
    { type: "BUY", trade_date: "2026-02-01", asset: "VOORBEELD INC.", quantity: "20", price: "300", currency: "USD", fx_per_eur: "1.20", broker: "Saxo" },
    { type: "SELL", trade_date: "2026-11-01", asset: "VOORBEELD INC.", quantity: "20", price: "250", currency: "USD", fx_per_eur: "1.10", broker: "Saxo" },
    { type: "DIVIDEND", trade_date: "2026-05-01", asset: "VOORBEELD NV", amount: "150", broker: "Bolero" },
  ];
  for (const raw of ex) {
    const t = validateTx(raw);
    state.assets[t.asset] ??= { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
    state.transactions.push({ id: newId(), ...t });
  }
  state.assets["VOORBEELD NV"].isin = "BE0003565737";
  state.assets["VOORBEELD NV"].ref_value_eur = "80";
  state.assets["VOORBEELD NV"].ref_source = "voorbeeld";
  state.assets["VOORBEELD INC."].isin = "US0378331005";
  state.assets["VOORBEELD INC."].currency = "USD";
  state.withheld = state.withheld.filter(w => !(w.owner === DEFAULT_OWNER && w.year === 2026));
  state.withheld.push({ owner: DEFAULT_OWNER, year: 2026, amount: "360" });
  commit(); toast("Voorbeeld geladen. Je kunt het wissen via Instellingen.");
}

// ================================================================ dialogen en meldingen
function confirmDialog(message) {
  return new Promise(resolve => {
    const d = $("#confirm-dialog");
    $("#confirm-text").textContent = message;
    const done = v => { d.close(); resolve(v); };
    $("#confirm-yes").onclick = () => done(true);
    $("#confirm-no").onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}
function showTextDialog(title, text) {
  $("#text-title").textContent = title; $("#text-body").value = text; $("#text-dialog").showModal(); $("#text-body").select();
}
$("#text-close").addEventListener("click", () => $("#text-dialog").close());
$("#preview-close").addEventListener("click", () => $("#preview-dialog").close());
let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast"); t.textContent = msg; t.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "toast"; }, isError ? 5000 : 2500);
}

// ================================================================ navigatie
function currentTab() { const h = location.hash.slice(1); return TABS.includes(h) ? h : "rapport"; }
function render() {
  const tab = currentTab();
  $$(".tabs a").forEach(a => a.classList.toggle("active", a.getAttribute("href") === `#${tab}`));
  $$(".tab").forEach(s => s.classList.toggle("active", s.id === `tab-${tab}`));
  ({ rapport: renderReport, simulatie: renderSimulation, transacties: renderTransactions, activa: renderAssets, instellingen: renderSettings })[tab]();
  const missing = Object.entries(state.assets).filter(([i, a]) => needsRef(i) && (a.ref_value_eur == null || a.ref_value_eur === "")).length;
  $("#assets-dot").hidden = !missing;
}
window.addEventListener("hashchange", render);
document.addEventListener("click", e => {
  const a = e.target.closest("[data-action]"); if (!a) return;
  if (a.dataset.action === "new-tx") { if (currentTab() !== "transacties") location.hash = "transacties"; openTxDialog(null); }
  if (a.dataset.action === "load-example") loadExample();
});

/** Uitleg per browser: de installeerknop verschijnt pas als de browser dat toelaat. */
function installHint(ua, platform, touch) {
  if (/iphone|ipad|ipod/i.test(ua) || (platform === "MacIntel" && touch > 1)) return "In Safari: tik op Deel (vierkant met pijl) en kies 'Zet op beginscherm'.";
  if (/Edg\//.test(ua)) return "In Edge: klik op het icoon 'App beschikbaar' rechts in de adresbalk, of open het menu (…) → Apps → 'Deze site installeren als app'.";
  if (/Firefox\//.test(ua)) return "Firefox kan deze tool niet als app installeren. Open de link in Edge of Chrome om te installeren.";
  if (/Chrome\//.test(ua)) return "In Chrome: klik op het installeericoon rechts in de adresbalk, of open het menu (⋮) → Opslaan en delen → 'Pagina installeren als app'.";
  if (/Safari\//.test(ua) && /Mac/.test(platform)) return "In Safari op de Mac: menu Archief → 'Voeg toe aan Dock'.";
  return "Gebruik 'App installeren' in de adresbalk of het menu van je browser. Werkt daarna ook zonder internet.";
}

// ================================================================ installeerbare app (enkel op een eigen adres, niet op claude.ai)
function setupInstall() {
  const host = location.hostname;
  if (location.protocol === "file:" || /claude/i.test(host) || window.claude || !("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register("sw.js").catch(() => {});
  const panel = $("#install-panel"), hint = $("#install-hint"), btn = $("#btn-install");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  panel.hidden = false;
  if (standalone) { hint.textContent = "Geïnstalleerd: je werkt in de app. Gegevens blijven in deze browser; maak regelmatig een back-up."; return; }
  hint.textContent = installHint(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault(); deferred = e; btn.hidden = false;
    hint.textContent = "Installeer de tool als app op dit toestel. Werkt daarna ook zonder internet.";
  });
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt(); await deferred.userChoice.catch(() => null); deferred = null; btn.hidden = true;
  });
  window.addEventListener("appinstalled", () => { btn.hidden = true; hint.textContent = "Geïnstalleerd. Gegevens blijven in deze browser; maak regelmatig een back-up."; });
}
setupInstall();

initStorage();
initSync();
proofs.init = initProofs();
