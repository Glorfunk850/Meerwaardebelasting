"use strict";
/* Interface + opslag. Alle berekeningen via MWB (engine.js). */
const { D, Dec, calculate, defaultConfig } = window.MWB;

const TYPE_LABELS = {
  BUY: "Aankoop", SELL: "Verkoop", SPLIT: "Splitsing", DIVIDEND: "Dividend", FEE: "Kosten",
  TRANSFER_IN: "Overdracht in", GIFT_IN: "Schenking", INHERIT_IN: "Erfenis", DELISTING: "Delisting",
};
const DELIST_LABELS = { NOTERING: "Enkel schrapping notering", UITKOOP: "Uitkoop / bod tegen prijs", WAARDELOOS: "Waardeloos (faillissement/vereffening)" };
const DELIST_SHORT = { NOTERING: "schrapping", UITKOOP: "uitkoop", WAARDELOOS: "waardeloos" };
const BASIS_LABELS = { AANKOOP: "aankoopprijs", REF_31_12_2025: "waarde 31/12/2025", HISTORISCH: "historische prijs", ONBEKEND: "onbekend (0)" };
const ACQ = ["BUY", "TRANSFER_IN", "GIFT_IN", "INHERIT_IN"];
const ASSET_TYPES = ["aandeel", "etf", "obligatie", "fonds", "crypto", "valuta", "verzekering", "ander"];
const TABS = ["rapport", "transacties", "activa", "instellingen"];
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
    version: 1, nextId: 1, transactions: [], assets: {}, withheld: [],
    years: { 2026: { rate: "0.10", base_exemption: "10000", carry_slice: "1000", carry_validity_years: 5,
                     source: "Wet 6.4.2026 (BS 21.4.2026); vrijstelling 2026 = 10.000 EUR" } },
    settings: { historic_method: "FIFO", fifo_scope: "EIGENAAR" },
  };
}
let state = emptyState();

function validState(s) {
  return s && typeof s === "object" && Array.isArray(s.transactions) && s.assets && typeof s.assets === "object"
    && s.years && s.settings && Array.isArray(s.withheld);
}

// ================================================================ opslag
const LS_KEY = "meerwaarde-state-v1";
const storage = { mode: "geheugen", db: null, ref: null, base: null, writing: false, pending: null, lastJson: null };
const CHUNK = 90000; // tekens per opslagdeel (documentlimiet 256 KB, ruime marge voor escaping)

function lsGet() { try { return localStorage.getItem(LS_KEY); } catch { return null; } }
function lsSet(v) { try { localStorage.setItem(LS_KEY, v); return true; } catch { return false; } }

async function initStorage() {
  const local = lsGet();
  if (local) { try { const s = JSON.parse(local); if (validState(s)) state = s; } catch {} }
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
              if (validState(s)) { state = s; storage.lastJson = json; lsSet(json); render(); }
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
function validateTx(p) {
  if (!TYPE_LABELS[p.type]) throw new InputError(`Onbekend transactietype: ${p.type}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.trade_date || "") || isNaN(Date.parse(p.trade_date))) throw new InputError("Datum moet het formaat JJJJ-MM-DD hebben.");
  const asset = String(p.asset || "").trim().toUpperCase();
  if (!asset) throw new InputError("Actief (ISIN of ticker) is verplicht.");
  const out = {
    owner: String(p.owner || DEFAULT_OWNER).trim(), broker: String(p.broker || "").trim(), trade_date: p.trade_date,
    type: p.type, asset, currency: String(p.currency || "EUR").trim().toUpperCase(),
    fx_per_eur: dec(p.fx_per_eur || "1", "wisselkoers", { positive: true }),
    fees: dec(p.fees || "0", "kosten", { nonNegative: true }), taxes: dec(p.taxes || "0", "taksen", { nonNegative: true }),
    historic_proven: !!p.historic_proven, cost_known: p.cost_known !== false,
    reynders_eur: dec(p.reynders_eur || "0", "Reynders-bedrag", { nonNegative: true }),
    note: String(p.note || "").trim(), quantity: "0", price: "0", amount: "0", split_ratio: null,
  };
  if (out.currency === "EUR" && !D(out.fx_per_eur).eq(1)) throw new InputError("Voor EUR moet de wisselkoers 1 zijn.");
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
      </article>`;
    }).join("");
  }

  $("#sales").innerHTML = r.sales.length ? r.sales.slice().reverse().map(s => `
    <details><summary>
      <span>${esc(s.trade_date)}</span><strong class="grow">${esc(assetLabel(s.asset))}${s.kind === "UITKOOP" ? ` <span class="badge SELL">uitkoop</span>` : ""}</strong>
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
    </div></details>`).join("") : `<p class="empty">Nog geen verkopen vanaf 2026.</p>`;

  const ev = r.events.filter(e => e.kind !== "UITKOOP");
  $("#events-title").hidden = !ev.length;
  $("#events").innerHTML = ev.slice().reverse().map(e => `
    <div class="event"><div class="row"><span>${esc(e.trade_date)}</span><strong>${esc(assetLabel(e.asset))}</strong>
      <span class="badge">${esc(DELIST_SHORT[e.kind])}</span>
      <span class="muted small">${num(e.quantity_held.toString())} st. in bezit · ${esc(e.owner)}</span></div>
      <p class="small muted">${esc(e.note)}</p></div>`).join("");
}

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
function boleroCheck(s) {
  const t = txOfSale(s);
  if (!t || t.bolero_result == null) return "";
  const b = D(t.bolero_result), diff = s.result_eur.sub(b).round(2);
  if (diff.isZero()) return `<div class="alert ok small">Zelfde resultaat als Bolero berekende (${eur(b.toFixed(2))}).</div>`;
  return `<div class="alert warn small">Bolero berekende ${eur(b.toFixed(2))}, deze tool ${eur(s.result_eur.toFixed(2))} (verschil ${eur(diff.toFixed(2))}).
    Mogelijke oorzaken: een andere waarde op 31/12/2025, een hogere historische prijs die je zelf inroept (Bolero gebruikt die niet),
    FIFO over meerdere brokers, of een ontbrekende transactie.</div>`;
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

// ================================================================ transacties
function renderTransactions() {
  const all = state.transactions;
  fillFilter("#f-year", [...new Set(all.map(t => t.trade_date.slice(0, 4)))].sort().reverse());
  fillFilter("#f-owner", [...new Set(all.map(t => t.owner))].sort());
  $("#asset-list").innerHTML = Object.keys(state.assets).map(a => `<option value="${esc(a)}">`).join("");
  $("#owner-list").innerHTML = [...new Set([DEFAULT_OWNER, ...all.map(t => t.owner)])].map(o => `<option value="${esc(o)}">`).join("");
  const fy = $("#f-year").value, fo = $("#f-owner").value, fa = $("#f-asset").value.trim().toUpperCase();
  const rows = all.filter(t => (!fy || t.trade_date.startsWith(fy)) && (!fo || t.owner === fo) && (!fa || t.asset.includes(fa)))
    .sort((a, b) => a.trade_date < b.trade_date ? 1 : a.trade_date > b.trade_date ? -1 : b.id - a.id);
  $("#tx-empty").hidden = rows.length > 0;
  $("#tx-count").textContent = all.length ? `${rows.length} van ${all.length}` : "";
  $("#tx-table tbody").innerHTML = rows.map(t => {
    const amt = t.type === "DIVIDEND" || t.type === "FEE";
    const value = t.type === "SPLIT" ? `${num(t.split_ratio)} : 1` : amt ? num(t.amount)
      : t.type === "DELISTING" ? (t.delist_mode === "UITKOOP" ? num(t.price) : "")
      : num(t.price);
    return `<tr data-id="${t.id}" class="clickable" title="Tik om te bewerken">
      <td>${esc(t.trade_date)}</td>
      <td><span class="badge ${esc(t.type)}">${esc(TYPE_LABELS[t.type])}</span>
        ${t.historic_proven ? `<span class="badge" title="Historische prijs bewijsbaar">H</span>` : ""}
        ${!t.cost_known ? `<span class="badge need" title="Aanschaffingswaarde onbekend">?</span>` : ""}
        ${t.type === "DELISTING" ? `<span class="badge">${esc(DELIST_SHORT[t.delist_mode] || "")}</span>` : ""}</td>
      <td>${esc(t.asset)}</td>
      <td class="num">${["SPLIT", "DIVIDEND", "FEE"].includes(t.type) || (t.type === "DELISTING" && D(t.quantity || 0).isZero()) ? "" : num(t.quantity)}</td>
      <td class="num">${value}</td>
      <td>${esc(t.currency)}${t.currency !== "EUR" ? ` <span class="muted small">@${num(t.fx_per_eur)}</span>` : ""}</td>
      <td>${esc(t.owner)}</td><td>${esc(t.broker)}</td>
      <td class="actions-cell"><button class="btn small danger" data-del="${t.id}" aria-label="Verwijder">✕</button></td></tr>`;
  }).join("");
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
  const dl = t === "DELISTING", mode = form.elements.delist_mode.value, buyout = dl && mode === "UITKOOP";
  const show = (cls, on) => $$(cls, form).forEach(el => { el.hidden = !on; });
  show(".g-qty", acq || sell || buyout); show(".g-price", acq || sell || buyout);
  show(".g-amount", t === "DIVIDEND" || t === "FEE"); show(".g-split", t === "SPLIT");
  show(".g-ccy", t !== "SPLIT" && (!dl || buyout)); show(".g-fees", acq || sell || buyout); show(".g-reynders", sell);
  show(".g-delist", dl);
  $("#qty-label").firstChild.textContent = buyout ? "Aantal (leeg = volledige positie) " : "Aantal ";
  $("#price-label").firstChild.textContent = buyout ? "Uitkoopprijs per stuk " : "Prijs per stuk ";
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
form.elements.currency.addEventListener("input", () => { if (form.elements.currency.value.trim().toUpperCase() === "EUR") form.elements.fx_per_eur.value = "1"; });

function openTxDialog(tx) {
  form.reset();
  editingId = tx ? tx.id : null;
  $("#tx-title").textContent = tx ? "Transactie bewerken" : "Nieuwe transactie";
  $("#tx-error").hidden = true;
  $("#btn-delete-tx").hidden = !tx;
  form.elements.owner.value = DEFAULT_OWNER;
  if (tx) for (const [k, v] of Object.entries(tx)) {
    const el = form.elements[k];
    if (el && el.name) { if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? ""; }
  } else form.elements.trade_date.value = new Date().toISOString().slice(0, 10);
  if (tx && tx.type === "DELISTING" && D(tx.quantity || 0).isZero()) form.elements.quantity.value = "";
  updateFieldVisibility();
  dlg.showModal();
}
form.addEventListener("submit", e => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.closest("[hidden]")) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  try {
    const t = validateTx(data);
    if (!state.assets[t.asset]) state.assets[t.asset] = { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
    if (editingId) { const i = state.transactions.findIndex(x => x.id === editingId); state.transactions[i] = { ...state.transactions[i], ...t, id: editingId }; }
    else state.transactions.push({ id: state.nextId++, ...t });
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
  if (await confirmDialog("Deze transactie verwijderen?")) deleteTx(id);
});
function deleteTx(id) {
  state.transactions = state.transactions.filter(t => t.id !== id);
  commit(); toast("Transactie verwijderd");
}
$("#tx-table").addEventListener("click", async e => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); if (await confirmDialog("Deze transactie verwijderen?")) deleteTx(Number(del.dataset.del)); return; }
  const row = e.target.closest("tr[data-id]");
  if (row) openTxDialog(state.transactions.find(t => t.id === Number(row.dataset.id)));
});
["#f-year", "#f-owner"].forEach(s => $(s).addEventListener("change", renderTransactions));
$("#f-asset").addEventListener("input", renderTransactions);

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
  // ook verborgen: door de gebruiker uit de lijst verwijderd terwijl er nog transacties naar verwijzen
  const hidden = e => !!e[1].hidden || closed(e);
  const nHidden = all.filter(hidden).length, showHidden = $("#asset-show-closed").checked;
  $("#asset-closed-toggle").hidden = !nHidden;
  $("#asset-closed-count").textContent = nHidden;
  const list = showHidden ? all : all.filter(e => !hidden(e));
  $("#asset-empty").hidden = list.length > 0;
  $("#asset-empty").textContent = all.length ? "Geen activa meer in portefeuille." : "Nog geen activa.";
  const missingAll = all.filter(([i, a]) => refMissing(i, a)), missing = missingAll.length;
  const missingHidden = showHidden ? 0 : missingAll.filter(hidden).length;
  $("#asset-missing").hidden = !missing;
  $("#asset-missing").textContent = `${missing === 1 ? "1 effect" : `${missing} effecten`} die je op 31/12/2025 had, ${missing === 1 ? "heeft" : "hebben"} nog geen waarde op 31/12/2025. Die is nodig zodra je ze verkoopt.`
    + (missingHidden ? ` (${missingHidden} daarvan ${missingHidden === 1 ? "is" : "zijn"} verborgen: vink "Toon ook verborgen" aan.)` : "");
  $("#asset-table tbody").innerHTML = list.map(([isin, a]) => {
    const need = needsRef(isin), u = used(isin), gone = closed([isin, a]);
    return `<tr data-isin="${esc(isin)}"${hidden([isin, a]) ? ` class="muted"` : ""}>
      <td><strong>${esc(isin)}</strong>${need && (a.ref_value_eur == null || a.ref_value_eur === "") ? ` <span class="badge need">waarde nodig</span>` : ""}
        ${delistedOn(isin) ? ` <span class="badge" title="Delisting geregistreerd">geschrapt ${esc(delistedOn(isin))}</span>` : ""}
        ${gone ? ` <span class="badge" title="Niet meer in portefeuille">afgesloten</span>` : ""}
        ${a.hidden ? ` <span class="badge" title="Door jou uit de lijst verwijderd">verborgen</span>` : ""}</td>
      <td><input name="name" value="${esc(a.name)}" aria-label="Naam"></td>
      <td><select name="asset_type" aria-label="Type">${ASSET_TYPES.map(t => `<option ${t === a.asset_type ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td><input name="currency" value="${esc(a.currency)}" maxlength="5" class="w-sm" aria-label="Munt"></td>
      <td><input name="ref_value_eur" inputmode="decimal" class="num" value="${esc(a.ref_value_eur ?? "")}" placeholder="${need ? "verplicht" : "n.v.t."}" aria-label="Waarde 31/12/2025"></td>
      <td><input name="ref_source" value="${esc(a.ref_source)}" placeholder="bv. Euronext slotkoers" aria-label="Bron"></td>
      <td class="actions-cell"><button class="btn small primary" data-save>Bewaar</button>
        ${a.hidden ? `<button class="btn small" data-unhide>Terugzetten</button>`
          : gone ? "" : `<button class="btn small danger" data-delasset data-used="${u ? 1 : ""}" aria-label="Verwijder uit de lijst" title="Verwijder uit de lijst">✕</button>`}</td></tr>`;
  }).join("");
}
$("#asset-show-closed").addEventListener("change", renderAssets);
$("#asset-table").addEventListener("click", async e => {
  const row = e.target.closest("tr[data-isin]");
  if (!row) return;
  const isin = row.dataset.isin, label = state.assets[isin]?.name ? `${state.assets[isin].name} (${isin})` : isin;
  const del = e.target.closest("[data-delasset]");
  if (del) {
    if (!del.dataset.used) {
      if (await confirmDialog(`Actief ${label} verwijderen?`)) { delete state.assets[isin]; commit(); }
    } else if (await confirmDialog(`${label} uit de lijst verwijderen? Er zijn nog transacties voor dit actief: die blijven bewaard ` +
        `en tellen mee in het rapport, net als de ingevulde waarde op 31/12/2025. Terugzetten kan via "Toon ook verborgen".`)) {
      state.assets[isin].hidden = true; commit(); toast(`${label} verwijderd uit de lijst`);
    }
    return;
  }
  if (e.target.closest("[data-unhide]")) { delete state.assets[isin].hidden; commit(); toast(`${label} teruggezet`); return; }
  if (!e.target.closest("[data-save]")) return;
  const v = {}; $$("input, select", row).forEach(el => { v[el.name] = el.value.trim(); });
  try {
    const ref = dec(v.ref_value_eur, "waarde 31/12/2025", { nonNegative: true });
    state.assets[isin] = { ...state.assets[isin], name: v.name, asset_type: v.asset_type, currency: (v.currency || "EUR").toUpperCase(), ref_value_eur: ref, ref_source: v.ref_source };
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
    <tr><td>${esc(w.owner)}</td><td>${w.year}</td><td class="num">${eur(w.amount)}</td>
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
async function offerDownload(filename, text, fallbackLabel) {
  const use = window.claude && window.claude.use ? window.claude.use.bind(window.claude) : null;
  const dl = use ? await use("downloads").catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: text }); return; }
    catch (e) { if (e && /declin|cancel|reject/i.test(String(e.code || e.message))) return; }
  }
  if (!use) { // buiten claude.ai: gewoon als bestand downloaden
    try {
      const url = URL.createObjectURL(new Blob([text], { type: filename.endsWith(".csv") ? "text/csv" : "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return;
    } catch {}
  }
  try { await navigator.clipboard.writeText(text); toast(`${fallbackLabel} gekopieerd naar het klembord`); }
  catch { showTextDialog(fallbackLabel, text); }
}
$("#btn-export").addEventListener("click", () => offerDownload(`meerwaarde-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 1), "Back-up"));
$("#btn-copy-backup").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(JSON.stringify(state)); toast("Back-up gekopieerd naar het klembord"); }
  catch { showTextDialog("Back-up", JSON.stringify(state)); }
});
$("#btn-csv").addEventListener("click", () => {
  try { offerDownload("verkopen.csv", "﻿" + salesCsv(), "CSV"); } catch (e) { toast(e.message, true); }
});
$("#import-file").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  await importBackup(await file.text()); e.target.value = "";
});
$("#btn-import-paste").addEventListener("click", () => importBackup($("#import-text").value));
async function importBackup(text) {
  let s;
  try { s = JSON.parse(text); } catch { return toast("Dit is geen geldige back-up (JSON).", true); }
  if (!validState(s)) return toast("Dit bestand heeft niet de vorm van een back-up van deze tool.", true);
  if (!(await confirmDialog(`Back-up met ${s.transactions.length} transacties herstellen? Je huidige gegevens worden vervangen.`))) return;
  state = s; state.nextId = Math.max(state.nextId || 1, ...state.transactions.map(t => t.id + 1));
  $("#import-text").value = ""; commit(); toast("Back-up hersteld");
}
$("#btn-reset").addEventListener("click", async () => {
  if (await confirmDialog("Alle gegevens wissen? Maak eerst een back-up als je ze wil bewaren.")) { state = emptyState(); commit(); toast("Alle gegevens gewist"); }
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
    if (head[0] === 0x50 && head[1] === 0x4b) r = await window.SAXO.parseSaxoFile(buf, { owner: DEFAULT_OWNER, fileName: file.name });
    else {
      const text = new TextDecoder().decode(buf);
      if (/Datum transactie/.test(text)) r = window.BOLERO.parseBolero(text, { owner: DEFAULT_OWNER, fileName: file.name });
      else if (/Instrument ISIN/i.test(text)) {
        const first = text.split(/\r?\n/, 1)[0];
        const rows = window.BOLERO.parseCsv(text, first.split(";").length > first.split(",").length ? ";" : ",");
        r = window.SAXO.parseSaxoSheets({ csv: rows }, { owner: DEFAULT_OWNER, fileName: file.name });
      } else throw new Error("Bestand niet herkend. Gebruik de Bolero-export 'Cashbewegingen' (CSV) of de Saxo-export 'Trades' (Excel).");
    }
    r.source ??= "bolero";
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
  const existing = new Set(state.transactions.map(t => t.import_id).filter(Boolean));
  const fresh = r.transactions.filter(t => !existing.has(t.import_id));
  const cnt = type => fresh.filter(t => t.type === type).length;
  const dup = r.transactions.length - fresh.length;
  $("#imp-summary").innerHTML = `<strong>${esc(r.fileName)}</strong>: ${r.rows} regels gelezen.
    Nieuw: ${cnt("BUY")} aankopen, ${cnt("SELL")} verkopen, ${cnt("DIVIDEND")} dividenden.
    ${dup ? `<br>${dup} transacties waren al eerder geïmporteerd en worden overgeslagen.` : ""}`;
  $("#imp-skipped").innerHTML = Object.entries(r.skipped).map(([k, v]) => `<li>${esc(k)}: ${v}</li>`).join("");
  $("#imp-owner").value = DEFAULT_OWNER;
  $("#imp-positions tbody").innerHTML = r.positions.map((p, i) => {
    const cur = state.assets[p.asset]?.ref_value_eur;
    const val = cur ?? p.refHint?.value ?? "";
    return `<tr data-i="${i}" class="${p.suspicious ? "suspicious" : ""}">
      <td><input type="checkbox" name="keep" ${p.suspicious ? "" : "checked"} aria-label="Nog in bezit"></td>
      <td><strong>${esc(p.asset)}</strong>${p.name ? `<br><span class="small muted">${esc(p.name)}</span>` : ""}${p.suspicious ? `<br><span class="small neg">waarschijnlijk niet meer in bezit (overname, splitsing of naamswijziging?)</span>` : ""}</td>
      <td class="num">${num(p.quantity)}</td>
      <td class="col-div">${esc(p.lastDividend || "–")}</td>
      <td><input name="ref" inputmode="decimal" class="num" value="${esc(val)}" placeholder="slotkoers in EUR" aria-label="Waarde 31/12/2025">
        <span class="hint need-hint" hidden></span>
        ${p.refHint && cur == null ? `<span class="hint">${esc(p.refHint.from)}</span>` : ""}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">Geen posities op 31/12/2025 volgens deze export.</td></tr>`;
  $("#imp-warnings").innerHTML = r.warnings.map(w => `<li>${esc(w)}</li>`).join("");
  $("#imp-warn-wrap").hidden = !r.warnings.length;
  $("#imp-warn-count").textContent = r.warnings.length;
  $("#import-dialog").showModal();
  markNeededRefs();
}
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
    const empty = !$("[name=ref]", tr).value.trim();
    h.hidden = !(why && empty); h.textContent = why || ""; h.classList.toggle("neg", !!why);
  });
}
$("#imp-positions").addEventListener("input", markNeededRefs);
$("#imp-cancel").addEventListener("click", () => { $("#import-dialog").close(); pendingImport = null; });
$("#imp-confirm").addEventListener("click", () => {
  const r = pendingImport; if (!r) return;
  const owner = $("#imp-owner").value.trim() || DEFAULT_OWNER;
  try {
    // fotowaarden valideren vóór er iets verandert
    const decisions = $$("#imp-positions tbody tr[data-i]").map(tr => {
      const p = r.positions[Number(tr.dataset.i)];
      return { p, keep: $("[name=keep]", tr).checked, ref: dec($("[name=ref]", tr).value, `waarde 31/12/2025 voor ${p.asset}`, { nonNegative: true }) };
    });
    const delists = $$("#imp-delist tbody tr[data-d]").map(tr => {
      const d = r.delistings[Number(tr.dataset.d)], mode = $("[name=mode]", tr).value;
      return { d, add: $("[name=add]", tr).checked, mode,
        price: mode === "UITKOOP" && $("[name=add]", tr).checked ? dec($("[name=price]", tr).value, `uitkoopprijs voor ${d.name}`, { required: true, nonNegative: true }) : null };
    });
    const existing = new Set(state.transactions.map(t => t.import_id).filter(Boolean));
    let added = 0;
    for (const t of r.transactions) {
      if (existing.has(t.import_id)) continue;
      state.transactions.push({ ...t, owner, id: state.nextId++ });
      added++;
    }
    const kindMap = { stock: "aandeel", etf: "etf", etc: "ander", etn: "ander", bond: "obligatie", fund: "fonds" };
    for (const [isin, a] of Object.entries(r.assets)) {
      state.assets[isin] ??= { name: "", asset_type: kindMap[(a.kind || "").toLowerCase()] || "aandeel", currency: a.currency, ref_value_eur: null, ref_source: "" };
      if (!state.assets[isin].name && a.name) state.assets[isin].name = a.name;
    }
    for (const { d, add, mode, price } of delists) {
      const id = `delist:${owner}:${d.asset}:${d.date}`;
      if (!add || state.transactions.some(t => t.import_id === id)) continue;
      const a = state.assets[d.asset] || {};
      state.transactions.push({ id: state.nextId++, type: "DELISTING", delist_mode: mode, trade_date: d.date, asset: d.asset,
        quantity: "0", price: price ?? "0", currency: mode === "UITKOOP" ? "EUR" : (a.currency || "EUR"), fx_per_eur: "1", fees: "0", taxes: "0",
        owner, broker: r.source === "saxo" ? "Saxo" : "Bolero", historic_proven: false, cost_known: true, reynders_eur: "0", amount: "0",
        split_ratio: null, import_id: id, note: `Delisting volgens ${r.source === "saxo" ? "Saxo" : "Bolero"}-export` });
      added++;
    }
    for (const t of r.transactions) if (t.type === "DIVIDEND")
      state.assets[t.asset] ??= { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
    for (const { p, keep, ref } of decisions) {
      if (keep && ref != null) {
        const a = state.assets[p.asset];
        if (a.ref_value_eur !== ref) { a.ref_value_eur = ref; a.ref_source = p.refHint && ref === D(p.refHint.value).toString() ? p.refHint.from : (a.ref_source || "ingevoerd bij import"); }
      }
      const corrId = `corr:${owner}:${p.asset}`;
      if (!keep && !state.transactions.some(t => t.import_id === corrId)) {
        state.transactions.push({ id: state.nextId++, type: "SELL", trade_date: "2025-12-31", asset: p.asset, quantity: p.quantity, price: "0",
          currency: "EUR", fx_per_eur: "1", fees: "0", taxes: "0", owner, broker: "Bolero", historic_proven: false, cost_known: true,
          reynders_eur: "0", amount: "0", split_ratio: null, import_id: corrId,
          note: "Correctie bij import: niet meer in bezit op 31/12/2025 (vóór 2026, dus geen belastbaar moment)" });
      }
    }
    // door Bolero ingehouden meerwaardebelasting (kolom in de export) per jaar overnemen als er nog niets staat
    const perYear = {};
    for (const t of r.transactions) if (t.bolero_tax && !D(t.bolero_tax).isZero()) {
      const y = Number(t.trade_date.slice(0, 4)); perYear[y] = (perYear[y] || D(0)).add(D(t.bolero_tax).lt(0) ? D(t.bolero_tax).neg() : D(t.bolero_tax));
    }
    for (const [y, amt] of Object.entries(perYear))
      if (!state.withheld.some(w => w.owner === owner && w.year === Number(y))) state.withheld.push({ owner, year: Number(y), amount: amt.toString() });
    const need = neededRefAssets();
    const missing = [...need.keys()].filter(a => needsRef(a) && !(state.assets[a]?.ref_value_eur));
    $("#import-dialog").close(); pendingImport = null;
    commit();
    toast(`${added} transacties geïmporteerd` + (missing.length ? `. Vul nog de waarde op 31/12/2025 in bij Activa voor: ${missing.map(a => state.assets[a]?.name || a).join(", ")}` : ""), missing.length > 0);
  } catch (err) { toast(err.message, true); }
});

// voorbeeld
function loadExample() {
  const ex = [
    { type: "BUY", trade_date: "2024-05-01", asset: "BE0003565737", quantity: "100", price: "50", historic_proven: true, broker: "Bolero" },
    { type: "BUY", trade_date: "2025-05-01", asset: "BE0003565737", quantity: "50", price: "120", historic_proven: true, broker: "Bolero" },
    { type: "BUY", trade_date: "2026-03-01", asset: "BE0003565737", quantity: "50", price: "90", broker: "Bolero" },
    { type: "SELL", trade_date: "2026-09-01", asset: "BE0003565737", quantity: "120", price: "110", fees: "7.50", taxes: "4.62", broker: "Bolero" },
    { type: "BUY", trade_date: "2026-02-01", asset: "US0378331005", quantity: "20", price: "300", currency: "USD", fx_per_eur: "1.20", broker: "Saxo" },
    { type: "SELL", trade_date: "2026-11-01", asset: "US0378331005", quantity: "20", price: "250", currency: "USD", fx_per_eur: "1.10", broker: "Saxo" },
    { type: "DIVIDEND", trade_date: "2026-05-01", asset: "BE0003565737", amount: "150", broker: "Bolero" },
  ];
  for (const raw of ex) {
    const t = validateTx(raw);
    state.assets[t.asset] ??= { name: "", asset_type: "aandeel", currency: t.currency, ref_value_eur: null, ref_source: "" };
    state.transactions.push({ id: state.nextId++, ...t });
  }
  state.assets["BE0003565737"].name = "Voorbeeld NV";
  state.assets["BE0003565737"].ref_value_eur = "80";
  state.assets["BE0003565737"].ref_source = "voorbeeld";
  state.assets["US0378331005"].name = "Voorbeeld Inc.";
  state.assets["US0378331005"].currency = "USD";
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
  ({ rapport: renderReport, transacties: renderTransactions, activa: renderAssets, instellingen: renderSettings })[tab]();
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
