"use strict";

const TYPE_LABELS = {
  BUY: "Aankoop", SELL: "Verkoop", SPLIT: "Splitsing", DIVIDEND: "Dividend", FEE: "Kosten",
  TRANSFER_IN: "Overdracht in", GIFT_IN: "Schenking", INHERIT_IN: "Erfenis",
};
const BASIS_LABELS = {
  AANKOOP: "aankoopprijs", REF_31_12_2025: "waarde 31/12/2025", HISTORISCH: "historische prijs", ONBEKEND: "onbekend (0)",
};
const ACQ = ["BUY", "TRANSFER_IN", "GIFT_IN", "INHERIT_IN"];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const nf = new Intl.NumberFormat("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function eur(v) { return v == null ? "–" : "€ " + nf.format(Number(v)); }
function num(v) {
  if (v == null) return "";
  const [i, d] = String(v).split(".");
  const intPart = Number(i).toLocaleString("nl-BE");
  const dec = d ? d.replace(/0+$/, "") : "";
  return dec ? `${intPart},${dec}` : intPart;
}
function signClass(v) { const n = Number(v); return n > 0 ? "pos" : n < 0 ? "neg" : ""; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
  return data;
}

// ------------------------------------------------------------------ tabs
function showTab(name) {
  $$(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach(t => t.classList.toggle("active", t.id === `tab-${name}`));
  ({ report: loadReport, transactions: loadTransactions, assets: loadAssets, settings: loadSettings })[name]();
  history.replaceState(null, "", `#${name}`);
}
$$(".tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ------------------------------------------------------------------ rapport
async function loadReport() {
  const err = $("#report-error");
  err.hidden = true;
  try {
    const r = await api("/api/report");
    renderReport(r);
  } catch (e) {
    err.innerHTML = `<strong>Kan niet rekenen.</strong> ${esc(e.message)}` +
      (/31\/12\/2025/.test(e.message) ? ` <a href="#assets" data-goto="assets">Vul de waarde in bij Activa.</a>` : "") +
      (/inkomstenjaar/.test(e.message) ? ` <a href="#settings" data-goto="settings">Voeg het jaar toe bij Instellingen.</a>` : "");
    err.hidden = false;
    $("#year-cards").innerHTML = ""; $("#sales").innerHTML = ""; $("#warnings").innerHTML = "";
  }
}

function renderReport(r) {
  const methodLabel = r.settings.historic_method === "FIFO" ? "per lot (FIFO)" : "gemiddelde";
  $("#report-settings").textContent =
    `Historische prijs: ${methodLabel} · FIFO ${r.settings.fifo_scope === "BROKER" ? "per broker" : "over alle brokers"}`;

  const cards = $("#year-cards");
  if (!r.years.length) {
    cards.innerHTML = `<p class="empty">Nog geen verkopen of inhoudingen. Voeg transacties toe om een rapport te zien.</p>`;
  } else {
    cards.innerHTML = r.years.map(y => {
      const refund = Number(y.refund_eur);
      const carries = Object.entries(y.carry_detail).map(([k, v]) => `${k}: ${eur(v)}`).join(", ");
      return `
      <article class="card">
        <h4><span>${esc(y.year)}</span><span class="muted small">${esc(y.owner)} · ${y.sale_count} ${y.sale_count === 1 ? "verkoop" : "verkopen"}</span></h4>
        <dl class="kv">
          <dt>Meerwaarden</dt><dd class="pos">${eur(y.gains_eur)}</dd>
          <dt>Minderwaarden</dt><dd class="neg">${eur(y.losses_eur)}</dd>
          <dt class="strong">Netto meerwaarde</dt><dd class="strong">${eur(y.net_eur)}</dd>
          ${Number(y.lost_losses_eur) < 0 ? `<dt>Niet verrekenbaar verlies</dt><dd class="muted">${eur(y.lost_losses_eur)}</dd>` : ""}
          <div class="sep"></div>
          <dt>Vrijstelling beschikbaar</dt><dd>${eur(y.exemption_available_eur)}</dd>
          <dt>· gebruikt uit overdracht</dt><dd>${eur(y.carry_used_eur)}</dd>
          <dt>· gebruikt uit basis</dt><dd>${eur(y.base_used_eur)}</dd>
          <dt>Nieuwe overdracht</dt><dd>${eur(y.carry_generated_eur)}</dd>
          <div class="sep"></div>
          <dt class="strong">Belastbaar</dt><dd class="strong">${eur(y.taxable_eur)}</dd>
          <dt class="strong">Belasting (10%)</dt><dd class="strong">${eur(y.tax_eur)}</dd>
          <dt>Ingehouden door broker</dt><dd>${eur(y.withheld_eur)}</dd>
          ${Number(y.dividends_eur) ? `<dt>Dividenden (info)</dt><dd class="muted">${eur(y.dividends_eur)}</dd>` : ""}
        </dl>
        <div class="result-line">
          <span>${refund >= 0 ? "Terug te vorderen" : "Bij te betalen"}</span>
          <span class="big ${refund > 0 ? "pos" : refund < 0 ? "neg" : ""}">${eur(Math.abs(refund))}</span>
        </div>
        ${carries ? `<p class="hint">Overdrachten beschikbaar na ${esc(y.year)}: ${esc(carries)}</p>` : ""}
        ${y.alternative ? `<div class="alert warn small">Met de methode <strong>${esc(y.alternative.method.toLowerCase())}</strong>
          zou de netto meerwaarde ${eur(y.alternative.net_eur)} zijn en de belasting ${eur(y.alternative.tax_eur)}.</div>` : ""}
      </article>`;
    }).join("");
  }

  const sales = $("#sales");
  sales.innerHTML = r.sales.length ? r.sales.slice().reverse().map(s => `
    <details>
      <summary>
        <span>${esc(s.trade_date)}</span>
        <strong class="grow">${esc(s.asset)}</strong>
        <span class="muted small">${num(s.quantity)} st. · ${esc(s.broker || s.owner)}</span>
        <span class="num ${signClass(s.result_eur)}"><strong>${eur(s.result_eur)}</strong></span>
        ${s.warnings.length ? `<span class="badge need" title="Waarschuwing">!</span>` : ""}
      </summary>
      <div class="detail">
        <p class="small muted">Opbrengst ${eur(s.proceeds_eur)} · kosten ${eur(s.fees_eur)} (niet aftrekbaar)
          ${Number(s.reynders_deduction_eur) ? ` · Reynders-aftrek ${eur(s.reynders_deduction_eur)}` : ""} · ${esc(s.source)}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Lot (aankoop)</th><th class="num">Aantal</th><th class="num">Opbrengst</th>
            <th class="num">Basis</th><th>Basis volgens</th><th class="num">Resultaat</th><th>Opmerking</th></tr></thead>
          <tbody>${s.lines.map(l => `<tr>
            <td>${esc(l.acquired || "–")}</td><td class="num">${num(l.quantity)}</td>
            <td class="num">${eur(l.proceeds_eur)}</td><td class="num">${eur(l.basis_eur)}</td>
            <td>${esc(BASIS_LABELS[l.basis_used] || l.basis_used)}</td>
            <td class="num ${signClass(l.result_eur)}">${eur(l.result_eur)}</td><td class="small">${esc(l.note)}</td>
          </tr>`).join("")}</tbody>
        </table></div>
        ${s.warnings.map(w => `<div class="alert warn small">${esc(w)}</div>`).join("")}
      </div>
    </details>`).join("") : `<p class="empty">Nog geen verkopen vanaf 2026.</p>`;

  $("#warnings").innerHTML = "";
}

// ------------------------------------------------------------------ transacties
let txCache = [];

async function loadTransactions() {
  const params = new URLSearchParams();
  ["year", "owner", "asset"].forEach(k => { const v = $(`#f-${k}`).value.trim(); if (v) params.set(k, v); });
  const [filtered, all] = await Promise.all([api(`/api/transactions?${params}`), api("/api/transactions")]);
  txCache = all;
  fillFilter("#f-year", [...new Set(all.map(t => t.trade_date.slice(0, 4)))].sort().reverse());
  fillFilter("#f-owner", [...new Set(all.map(t => t.owner))].sort());
  $("#asset-list").innerHTML = [...new Set(all.map(t => t.asset))].map(a => `<option value="${esc(a)}">`).join("");

  const tbody = $("#tx-table tbody");
  $("#tx-empty").hidden = filtered.length > 0;
  tbody.innerHTML = filtered.map(t => {
    const isAmount = t.type === "DIVIDEND" || t.type === "FEE";
    const value = t.type === "SPLIT" ? `${num(t.split_ratio)} : 1` : isAmount ? num(t.amount) : num(t.price);
    return `<tr data-id="${t.id}" class="clickable" title="Klik om te bewerken">
      <td>${esc(t.trade_date)}</td>
      <td><span class="badge ${esc(t.type)}">${esc(TYPE_LABELS[t.type] || t.type)}</span>
        ${t.historic_proven ? `<span class="badge" title="Historische prijs bewijsbaar">H</span>` : ""}
        ${!t.cost_known ? `<span class="badge need" title="Aanschaffingswaarde onbekend">?</span>` : ""}</td>
      <td>${esc(t.asset)}</td>
      <td class="num">${["SPLIT", "DIVIDEND", "FEE"].includes(t.type) ? "" : num(t.quantity)}</td>
      <td class="num">${value}</td>
      <td>${esc(t.currency)}${t.currency !== "EUR" ? ` <span class="muted small">@${num(t.fx_per_eur)}</span>` : ""}</td>
      <td>${esc(t.owner)}</td><td>${esc(t.broker)}</td>
      <td class="actions-cell">
        <button class="btn small" data-edit="${t.id}">Bewerk</button>
        <button class="btn small danger" data-del="${t.id}">Verwijder</button>
      </td></tr>`;
  }).join("");
}

function fillFilter(sel, values) {
  const el = $(sel), cur = el.value;
  el.innerHTML = `<option value="">Alle</option>` + values.map(v => `<option>${esc(v)}</option>`).join("");
  el.value = values.includes(cur) ? cur : "";
}
["#f-year", "#f-owner"].forEach(s => $(s).addEventListener("change", loadTransactions));
let assetTimer;
$("#f-asset").addEventListener("input", () => { clearTimeout(assetTimer); assetTimer = setTimeout(loadTransactions, 250); });

$("#tx-table").addEventListener("click", async e => {
  const del = e.target.closest("[data-del]");
  if (del) {
    if (confirmDelete()) {
      await api(`/api/transactions/${del.dataset.del}`, { method: "DELETE" });
      loadTransactions();
    }
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openTxDialog(txCache.find(t => t.id === Number(row.dataset.id)));
});
function confirmDelete() { return window.confirm("Deze transactie verwijderen?"); }

// dialoog
const dlg = $("#tx-dialog"), form = $("#tx-form");
let editingId = null;
form.type.innerHTML = Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");

function updateFieldVisibility() {
  const t = form.type.value;
  const acq = ACQ.includes(t), sell = t === "SELL";
  const show = (cls, on) => $$(cls, form).forEach(el => { el.hidden = !on; });
  show(".g-qty", acq || sell);
  show(".g-price", acq || sell);
  show(".g-amount", t === "DIVIDEND" || t === "FEE");
  show(".g-split", t === "SPLIT");
  show(".g-ccy", t !== "SPLIT");
  show(".g-fees", acq || sell);
  show(".g-reynders", sell);
  show(".g-costknown", t === "GIFT_IN" || t === "INHERIT_IN" || t === "TRANSFER_IN");
  show(".g-hist", acq && form.trade_date.value && form.trade_date.value < "2026-01-01");
  show(".g-gift", t === "GIFT_IN" || t === "INHERIT_IN");
  form.price.disabled = acq && !form.cost_known.checked;
}
form.type.addEventListener("change", updateFieldVisibility);
form.trade_date.addEventListener("change", updateFieldVisibility);
form.cost_known.addEventListener("change", updateFieldVisibility);
form.currency.addEventListener("input", () => {
  if (form.currency.value.trim().toUpperCase() === "EUR") form.fx_per_eur.value = "1";
});

function openTxDialog(tx) {
  form.reset();
  editingId = tx ? tx.id : null;
  $("#tx-title").textContent = tx ? "Transactie bewerken" : "Nieuwe transactie";
  $("#tx-error").hidden = true;
  if (tx) {
    for (const [k, v] of Object.entries(tx)) {
      const el = form.elements[k];
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!v; else el.value = v ?? "";
    }
  } else {
    form.trade_date.value = new Date().toISOString().slice(0, 10);
  }
  updateFieldVisibility();
  dlg.showModal();
}
$("#btn-new-tx").addEventListener("click", () => openTxDialog(null));
$("#btn-cancel").addEventListener("click", () => dlg.close());

form.addEventListener("submit", async e => {
  e.preventDefault();
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.closest("[hidden]")) continue;
    data[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
  }
  if (!ACQ.includes(data.type) || data.type === "BUY") data.cost_known = true;
  try {
    await api(editingId ? `/api/transactions/${editingId}` : "/api/transactions",
      { method: editingId ? "PUT" : "POST", body: data });
    dlg.close();
    loadTransactions();
  } catch (err) {
    $("#tx-error").textContent = err.message;
    $("#tx-error").hidden = false;
  }
});

// ------------------------------------------------------------------ activa
let assetTypes = [];

async function loadAssets() {
  const assets = await api("/api/assets");
  $("#asset-empty").hidden = assets.length > 0;
  $("#asset-table tbody").innerHTML = assets.map(a => `
    <tr data-isin="${esc(a.isin)}">
      <td><strong>${esc(a.isin)}</strong>
        ${a.needs_ref && a.ref_value_eur == null ? `<span class="badge need">waarde nodig</span>` : ""}</td>
      <td><input name="name" value="${esc(a.name)}"></td>
      <td><select name="asset_type">${assetTypes.map(t => `<option ${t === a.asset_type ? "selected" : ""}>${t}</option>`).join("")}</select></td>
      <td><input name="currency" value="${esc(a.currency)}" maxlength="5" style="min-width:60px"></td>
      <td><input name="ref_value_eur" inputmode="decimal" class="num" value="${esc(a.ref_value_eur ?? "")}"
          placeholder="${a.needs_ref ? "verplicht" : "n.v.t."}"></td>
      <td><input name="ref_source" value="${esc(a.ref_source)}" placeholder="bv. Euronext slotkoers"></td>
      <td class="actions-cell"><button class="btn small primary" data-save>Bewaar</button></td>
    </tr>`).join("");
}
$("#asset-table").addEventListener("click", async e => {
  const btn = e.target.closest("[data-save]");
  if (!btn) return;
  const row = btn.closest("tr"), body = {};
  $$("input, select", row).forEach(el => { body[el.name] = el.value.trim(); });
  if (body.ref_value_eur === "") body.ref_value_eur = null;
  try {
    await api(`/api/assets/${encodeURIComponent(row.dataset.isin)}`, { method: "PUT", body });
    btn.textContent = "✓ Bewaard";
    setTimeout(loadAssets, 700);
  } catch (err) { alert(err.message); }
});

// ------------------------------------------------------------------ instellingen
async function loadSettings() {
  const [st, years, withheld] = await Promise.all([api("/api/settings"), api("/api/years"), api("/api/withheld")]);
  $("#s-method").value = st.historic_method;
  $("#s-scope").value = st.fifo_scope;

  $("#year-table tbody").innerHTML = years.map(y => yearRow(y)).join("");
  $("#withheld-table tbody").innerHTML = withheld.length ? withheld.map(w => `
    <tr><td>${esc(w.owner)}</td><td>${esc(w.year)}</td><td class="num">${eur(w.amount)}</td>
      <td class="actions-cell"><button class="btn small danger" data-delw="${esc(w.owner)}|${w.year}">Verwijder</button></td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">Geen inhoudingen ingevoerd.</td></tr>`;
}
function yearRow(y) {
  return `<tr data-year="${esc(y.year)}">
    <td><strong>${esc(y.year)}</strong></td>
    <td><input name="rate" class="num" value="${esc(y.rate)}"></td>
    <td><input name="base_exemption" class="num" value="${esc(y.base_exemption)}"></td>
    <td><input name="carry_slice" class="num" value="${esc(y.carry_slice)}"></td>
    <td><input name="carry_validity_years" class="num" value="${esc(y.carry_validity_years)}" style="min-width:50px"></td>
    <td><input name="source" value="${esc(y.source)}" placeholder="bron (KB/Staatsblad)"></td>
    <td class="actions-cell"><button class="btn small primary" data-savey>Bewaar</button>
      <button class="btn small danger" data-dely>×</button></td></tr>`;
}
$("#btn-save-settings").addEventListener("click", async e => {
  await api("/api/settings", { method: "PUT", body: { historic_method: $("#s-method").value, fifo_scope: $("#s-scope").value } });
  e.target.textContent = "✓ Opgeslagen";
  setTimeout(() => { e.target.textContent = "Opslaan"; }, 1200);
});
$("#btn-add-year").addEventListener("click", () => {
  const rows = $$("#year-table tbody tr");
  const last = rows.length ? Number(rows[rows.length - 1].dataset.year) : 2025;
  $("#year-table tbody").insertAdjacentHTML("beforeend",
    yearRow({ year: last + 1, rate: "0.10", base_exemption: "", carry_slice: "1000", carry_validity_years: 5, source: "" }));
});
$("#year-table").addEventListener("click", async e => {
  const row = e.target.closest("tr");
  if (e.target.closest("[data-savey]")) {
    const body = {};
    $$("input", row).forEach(el => { body[el.name] = el.value.trim(); });
    try { await api(`/api/years/${row.dataset.year}`, { method: "PUT", body }); loadSettings(); }
    catch (err) { alert(err.message); }
  }
  if (e.target.closest("[data-dely]") && window.confirm(`Parameters voor ${row.dataset.year} verwijderen?`)) {
    await api(`/api/years/${row.dataset.year}`, { method: "DELETE" });
    loadSettings();
  }
});
$("#withheld-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("/api/withheld", { method: "PUT", body: { owner: f.owner.value, year: f.year.value, amount: f.amount.value } });
    f.amount.value = "";
    loadSettings();
  } catch (err) { alert(err.message); }
});
$("#withheld-table").addEventListener("click", async e => {
  const b = e.target.closest("[data-delw]");
  if (!b) return;
  const [owner, year] = b.dataset.delw.split("|");
  await api(`/api/withheld/${encodeURIComponent(owner)}/${year}`, { method: "DELETE" });
  loadSettings();
});

document.addEventListener("click", e => {
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

// ------------------------------------------------------------------ start
(async () => {
  const meta = await api("/api/meta");
  assetTypes = meta.asset_types;
  const start = location.hash.slice(1);
  showTab(["report", "transactions", "assets", "settings"].includes(start) ? start : "report");
})();
