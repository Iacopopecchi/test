/* ═══════════════════════════════════════════════════════════════════════════
   Amazon Reconciliation Dashboard — Frontend JS
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

// ── Utilities ──────────────────────────────────────────────────────────────

/**
 * Format a float as Italian-style EUR string with sign.
 * @param {number|null} v
 * @returns {string}
 */
function fmtEur(v) {
  if (v === null || v === undefined) return "N/D";
  const sign = v >= 0 ? "+" : "";
  return sign + v.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function fmtEurAbs(v) {
  if (v === null || v === undefined) return "N/D";
  return Math.abs(v).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function numClass(v) {
  if (v === null || v === undefined) return "neutral";
  return v > 0 ? "positive" : v < 0 ? "negative" : "neutral";
}

/** Status badge HTML */
function statusBadge(status) {
  const icons = {
    ok:      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> OK',
    warning: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> ATTENZIONE',
    error:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> ERRORE',
    missing: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> N/D',
  };
  return `<span class="badge ${status}">${icons[status] || status}</span>`;
}

// ── Upload page ─────────────────────────────────────────────────────────────

(function initUploadPage() {
  const form = document.getElementById("reconcile-form");
  if (!form) return; // not on upload page

  // Dropzone & file list setup
  setupDropzone("csv-dropzone", "csv-input", "csv-file-list");
  setupDropzone("pdf-summary-dropzone", "pdf-summary-input", "pdf-summary-file-list");
  setupDropzone("pdf-ads-dropzone", "pdf-ads-input", "pdf-ads-file-list");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const yearInput = document.getElementById("target-year");
    const monthInput = document.getElementById("target-month");
    const csvInput = document.getElementById("csv-input");
    const errorBanner = document.getElementById("error-banner");
    const errorMsg = document.getElementById("error-message");
    const overlay = document.getElementById("loading-overlay");
    const submitBtn = document.getElementById("submit-btn");

    // Validate
    errorBanner.hidden = true;
    const year = parseInt(yearInput.value, 10);
    const month = parseInt(monthInput.value, 10);

    if (!year || year < 2020 || year > 2030) {
      showError("Inserire un anno valido (2020-2030).");
      return;
    }
    if (!month) {
      showError("Selezionare un mese.");
      return;
    }
    if (!csvInput.files || csvInput.files.length === 0) {
      showError("Caricare almeno un file CSV delle transazioni.");
      return;
    }

    // Build form data
    const fd = new FormData();
    fd.append("target_year", year);
    fd.append("target_month", month);

    for (const file of csvInput.files) fd.append("csv_files", file);

    const pdfSummaryInput = document.getElementById("pdf-summary-input");
    for (const file of (pdfSummaryInput.files || [])) fd.append("pdf_summary_files", file);

    const pdfAdsInput = document.getElementById("pdf-ads-input");
    for (const file of (pdfAdsInput.files || [])) fd.append("pdf_ads_files", file);

    // Submit
    overlay.hidden = false;
    submitBtn.disabled = true;
    submitBtn.textContent = "Elaborazione…";

    try {
      const resp = await fetch("/api/reconcile", { method: "POST", body: fd });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || "Errore del server");
      }
      const data = await resp.json();
      // Store result in sessionStorage and redirect to dashboard
      sessionStorage.setItem("reconciliation_result", JSON.stringify(data));
      window.location.href = "/dashboard.html";
    } catch (err) {
      overlay.hidden = true;
      submitBtn.disabled = false;
      submitBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Avvia Riconciliazione`;
      showError(err.message);
    }

    function showError(msg) {
      errorBanner.hidden = false;
      errorMsg.textContent = msg;
      errorBanner.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
})();

function setupDropzone(dropzoneId, inputId, listId) {
  const dropzone = document.getElementById(dropzoneId);
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!dropzone || !input || !list) return;

  // Drag events
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
    addFilesToInput(input, e.dataTransfer.files);
    renderFileList(input, list);
  });

  input.addEventListener("change", () => renderFileList(input, list));
  dropzone.addEventListener("click", (e) => {
    if (e.target.tagName !== "LABEL" && e.target.tagName !== "INPUT") input.click();
  });
}

function addFilesToInput(input, newFiles) {
  const dt = new DataTransfer();
  // Keep existing
  for (const f of (input.files || [])) dt.items.add(f);
  // Add new
  for (const f of newFiles) dt.items.add(f);
  input.files = dt.files;
}

function renderFileList(input, list) {
  list.innerHTML = "";
  const files = input.files || [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const li = document.createElement("li");
    const size = f.size < 1024 ? `${f.size} B`
      : f.size < 1048576 ? `${(f.size / 1024).toFixed(1)} KB`
      : `${(f.size / 1048576).toFixed(1)} MB`;

    li.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span class="file-name">${escHtml(f.name)}</span>
      <span class="file-size">${size}</span>
      <button class="remove-file" data-index="${i}" title="Rimuovi">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;
    list.appendChild(li);
  }

  // Remove buttons
  list.querySelectorAll(".remove-file").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      const dt = new DataTransfer();
      for (let j = 0; j < input.files.length; j++) {
        if (j !== idx) dt.items.add(input.files[j]);
      }
      input.files = dt.files;
      renderFileList(input, list);
    });
  });
}

// ── Dashboard page ──────────────────────────────────────────────────────────

(function initDashboard() {
  const dashContent = document.getElementById("dashboard-content");
  if (!dashContent) return; // not on dashboard page

  const loading = document.getElementById("dashboard-loading");

  // Load data from sessionStorage
  const raw = sessionStorage.getItem("reconciliation_result");
  if (!raw) {
    loading.innerHTML = `<p style="color:var(--err)">Nessun dato trovato. <a href="/">Torna all'upload.</a></p>`;
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    loading.innerHTML = `<p style="color:var(--err)">Dati corrotti. <a href="/">Torna all'upload.</a></p>`;
    return;
  }

  // Render dashboard
  try {
    renderDashboard(data);
    loading.hidden = true;
    dashContent.hidden = false;
  } catch (err) {
    loading.innerHTML = `
      <div style="text-align:center;max-width:600px;padding:2rem">
        <p style="color:var(--err);font-size:1rem;font-weight:600;margin-bottom:.5rem">Errore nel rendering della dashboard</p>
        <pre style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:1rem;text-align:left;font-size:.78rem;overflow:auto;white-space:pre-wrap">${escHtml(err.stack || err.message || String(err))}</pre>
        <a href="/" style="display:inline-block;margin-top:1rem;color:var(--indigo)">← Torna all'upload</a>
      </div>`;
    console.error("Dashboard render error:", err);
  }
})();

function renderDashboard(data) {
  // ── Header ────────────────────────────────────────────────────────────────
  const monthNames = ["", "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
    "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
  const monthName = data.target_month_name || monthNames[data.target_month] || "—";
  const title = `Riconciliazione ${monthName} ${data.target_year}`;
  document.title = title + " — Amazon Reconciliation";
  document.getElementById("dash-title").textContent = title;

  const periodCount = (data.settlement_periods_target || []).length;
  document.getElementById("dash-subtitle").textContent =
    `${periodCount} settlement period nel mese target · ${(data.transactions || []).length} transazioni totali`;

  // Overall badge
  const badge = document.getElementById("overall-badge");
  const statusLabels = { ok: "✅ Tutto quadra", warning: "⚠️ Attenzione", error: "❌ Errore" };
  badge.className = "overall-badge " + data.overall_status;
  badge.textContent = statusLabels[data.overall_status] || data.overall_status;

  // ── Section 1: KPI cards ──────────────────────────────────────────────────
  const kpiGrid = document.getElementById("kpi-grid");
  const totals = data.totals || {};
  const kpis = [
    { label: "Ricavi totali", value: totals.revenues, formatted: totals.revenues_fmt },
    { label: "Spese totali",  value: totals.expenses,  formatted: totals.expenses_fmt },
    { label: "Imposte nette", value: totals.taxes,     formatted: totals.taxes_fmt },
    { label: "Trasferimenti", value: totals.transfers,  formatted: totals.transfers_fmt },
    { label: "Saldo netto",   value: totals.net_balance, formatted: totals.net_balance_fmt },
    { label: "Variazione saldo Amazon", value: totals.amazon_balance_variation, formatted: totals.amazon_balance_variation_fmt },
  ];
  kpiGrid.innerHTML = kpis.map(k => `
    <div class="kpi-card">
      <span class="kpi-label">${escHtml(k.label)}</span>
      <span class="kpi-value ${numClass(k.value)}">${k.formatted || fmtEur(k.value)}</span>
    </div>`).join("");

  // ── Section 1: PDF Summary comparison ────────────────────────────────────
  if (data.pdf_summary_available && data.summary_comparisons && data.summary_comparisons.length) {
    document.getElementById("pdf-comparison-wrapper").hidden = false;
    const tbody = document.getElementById("pdf-comparison-body");
    tbody.innerHTML = data.summary_comparisons.map(c => `
      <tr>
        <td>${escHtml(c.label)}</td>
        <td class="num-col">${c.csv_value_fmt || fmtEur(c.csv_value)}</td>
        <td class="num-col">${c.pdf_value !== null ? (c.pdf_value_fmt || fmtEur(c.pdf_value)) : "<em>N/D</em>"}</td>
        <td class="num-col">${c.difference_fmt || fmtEur(c.difference)}</td>
        <td class="center-col">${statusBadge(c.status)}</td>
      </tr>`).join("");
  }

  // ── Section 2: Settlement periods ────────────────────────────────────────
  const targetPeriods = data.settlement_periods_target || [];
  const allPeriods = data.settlement_periods || [];

  document.getElementById("periods-body").innerHTML = targetPeriods.map(p => periodRow(p, false)).join("") ||
    '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Nessun periodo trovato per il mese target</td></tr>';

  document.getElementById("total-periods-count").textContent = allPeriods.length;
  document.getElementById("all-periods-body").innerHTML = allPeriods.map(p => periodRow(p, true)).join("") || "";

  // ── Section 3: ADS verification ───────────────────────────────────────────
  const adsContent = document.getElementById("ads-content");
  if (data.ads_verification) {
    const ads = data.ads_verification;
    adsContent.innerHTML = `
      <div class="ads-card">
        <div class="ads-row">
          <div class="ads-item">
            <span class="ads-item-label">Costo ADS (CSV)</span>
            <span class="ads-item-value ${numClass(ads.csv_amount)}">${ads.csv_amount_fmt || fmtEur(ads.csv_amount)}</span>
          </div>
          <div class="ads-item">
            <span class="ads-item-label">Totale Fattura ADS (EUR)</span>
            <span class="ads-item-value">${ads.invoice_amount_fmt || fmtEur(ads.invoice_amount)}</span>
          </div>
          <div class="ads-item">
            <span class="ads-item-label">Differenza</span>
            <span class="ads-item-value">${ads.difference_fmt || fmtEur(ads.difference)}</span>
          </div>
          <div class="ads-item">
            <span class="ads-item-label">Status</span>
            ${statusBadge(ads.status)}
          </div>
        </div>
        ${ads.invoice_ids && ads.invoice_ids.length ? `
        <div style="font-size:.82rem;color:var(--text-secondary)">
          Fatture: ${ads.invoice_ids.map(id => `<code style="font-family:var(--mono)">${escHtml(id)}</code>`).join(" · ")}
        </div>` : ""}
      </div>`;
  } else if (!data.ads_pdf_available) {
    adsContent.innerHTML = `<p style="color:var(--text-muted);font-size:.88rem">Nessun file PDF ADS caricato. Il confronto con le fatture pubblicitarie non è disponibile.</p>`;
  }

  // ── Section 4: Transactions ───────────────────────────────────────────────
  const transactions = data.transactions || [];
  renderTransactions(transactions, data.settlement_periods_target || []);

  // ── Section 5: Anomalies ─────────────────────────────────────────────────
  const allIssues = [...(data.errors || []).map(e => ({ msg: e, isError: true })),
                     ...(data.warnings || []).map(w => ({ msg: w, isError: false }))];

  if (allIssues.length) {
    document.getElementById("section-anomalies").hidden = false;
    const anomalyList = document.getElementById("anomaly-list");
    anomalyList.innerHTML = allIssues.map(issue => `
      <li class="${issue.isError ? "error-item" : ""}">
        <span class="anomaly-icon">
          ${issue.isError
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'}
        </span>
        ${escHtml(issue.msg)}
      </li>`).join("");
  }
}

function periodRow(p, showBelongs) {
  const diff = p.difference;
  const diffFmt = diff !== null && diff !== undefined
    ? (diff >= 0 ? "+" : "") + diff.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
    : "N/D";
  const sumFmt = p.sum_transactions !== null && p.sum_transactions !== undefined
    ? (p.sum_transactions >= 0 ? "+" : "") + Math.abs(p.sum_transactions).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
    : "N/D";

  return `<tr>
    <td><code style="font-family:var(--mono);font-size:.8rem">${escHtml(p.period_id)}</code></td>
    <td>${p.date_start || "—"}</td>
    <td>${p.date_end || "—"}</td>
    <td class="num-col">${fmtEurAbs(p.transfer_amount)}</td>
    <td class="num-col">${sumFmt}</td>
    <td class="num-col" style="color:${Math.abs(diff || 0) <= 0.05 ? 'var(--ok)' : 'var(--warn)'}">${diffFmt}</td>
    <td class="num-col">${p.transaction_count ?? "—"}</td>
    ${showBelongs ? `<td class="center-col">${p.belongs_to_target_month
      ? '<span class="badge ok">Sì</span>'
      : '<span class="badge missing">No</span>'}</td>` : ""}
    <td class="center-col">${statusBadge(p.status)}</td>
  </tr>`;
}

// ── Transaction table with DataTables ──────────────────────────────────────

let dtInstance = null;
let allTransactions = [];
let targetPeriodIds = new Set();

function renderTransactions(transactions, targetPeriods) {
  allTransactions = transactions;
  targetPeriodIds = new Set((targetPeriods || []).map(p => p.period_id));

  // Populate filter dropdowns
  const tipos = [...new Set(transactions.map(t => t.tipo).filter(Boolean))].sort();
  const periods = [...new Set(transactions.map(t => t.numero_pagamento).filter(Boolean))].sort();
  const marketplaces = [...new Set(transactions.map(t => t.marketplace).filter(Boolean))].sort();

  fillSelect("filter-tipo", tipos);
  fillSelect("filter-period", periods);
  fillSelect("filter-marketplace", marketplaces);

  // Render table body
  const tbody = document.getElementById("transactions-body");
  tbody.innerHTML = transactions.map(t => {
    const inTarget = targetPeriodIds.has(t.numero_pagamento);
    return `<tr class="${inTarget ? "" : "not-target"}" data-tipo="${escHtml(t.tipo || "")}" data-period="${escHtml(t.numero_pagamento || "")}" data-marketplace="${escHtml(t.marketplace || "")}" data-target="${inTarget ? "1" : "0"}">
      <td style="white-space:nowrap;font-size:.8rem">${escHtml((t.data_ora || "").substring(0, 20))}</td>
      <td><span class="badge ${tipoClass(t.tipo)}">${escHtml(t.tipo || "")}</span></td>
      <td style="font-size:.78rem;font-family:var(--mono)">${escHtml(t.numero_ordine || "")}</td>
      <td style="font-size:.78rem;font-family:var(--mono)">${escHtml(t.sku || "")}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.descrizione || "")}">${escHtml(t.descrizione || "")}</td>
      <td>${escHtml(t.marketplace || "")}</td>
      <td style="font-size:.78rem;font-family:var(--mono)">${escHtml(t.numero_pagamento || "")}</td>
      <td class="num-col">${numCell(t.vendite)}</td>
      <td class="num-col">${numCell(t.commissioni)}</td>
      <td class="num-col">${numCell(t.costi_fba)}</td>
      <td class="num-col">${numCell(t.altro)}</td>
      <td class="num-col" style="font-weight:600">${numCell(t.totale)}</td>
    </tr>`;
  }).join("");

  // Init DataTables
  if (typeof $ !== "undefined" && $.fn.DataTable) {
    if (dtInstance) { dtInstance.destroy(); }
    dtInstance = $("#transactions-table").DataTable({
      pageLength: 25,
      order: [[0, "desc"]],
      language: {
        search: "Cerca:",
        lengthMenu: "Mostra _MENU_ righe",
        info: "Da _START_ a _END_ di _TOTAL_ transazioni",
        infoEmpty: "Nessuna transazione",
        paginate: { first: "«", last: "»", next: "›", previous: "‹" },
        zeroRecords: "Nessuna transazione trovata",
      },
      columnDefs: [
        { orderable: false, targets: [2, 3, 4] },
      ],
    });

    // Wire up custom filters
    wireFilters();
  }
}

function wireFilters() {
  const filterTipo = document.getElementById("filter-tipo");
  const filterPeriod = document.getElementById("filter-period");
  const filterMarketplace = document.getElementById("filter-marketplace");
  const filterTargetOnly = document.getElementById("filter-target-only");
  const resetBtn = document.getElementById("reset-filters");

  function applyFilters() {
    const tipo = filterTipo.value;
    const period = filterPeriod.value;
    const marketplace = filterMarketplace.value;
    const targetOnly = filterTargetOnly.checked;

    // Use DataTables API to filter rows via draw callback
    $.fn.dataTable.ext.search = [];
    $.fn.dataTable.ext.search.push(function(settings, data, dataIndex) {
      if (settings.nTable.id !== "transactions-table") return true;
      const row = document.querySelectorAll("#transactions-body tr")[dataIndex];
      if (!row) return true;
      if (tipo && row.dataset.tipo !== tipo) return false;
      if (period && row.dataset.period !== period) return false;
      if (marketplace && row.dataset.marketplace !== marketplace) return false;
      if (targetOnly && row.dataset.target !== "1") return false;
      return true;
    });

    if (dtInstance) dtInstance.draw();
  }

  filterTipo.addEventListener("change", applyFilters);
  filterPeriod.addEventListener("change", applyFilters);
  filterMarketplace.addEventListener("change", applyFilters);
  filterTargetOnly.addEventListener("change", applyFilters);
  resetBtn.addEventListener("click", () => {
    filterTipo.value = "";
    filterPeriod.value = "";
    filterMarketplace.value = "";
    filterTargetOnly.checked = false;
    $.fn.dataTable.ext.search = [];
    if (dtInstance) dtInstance.draw();
  });
}

function fillSelect(id, values) {
  const sel = document.getElementById(id);
  if (!sel) return;
  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  });
}

function numCell(v) {
  if (v === null || v === undefined || v === "") return `<span style="color:var(--text-muted)">—</span>`;
  const n = parseFloat(v);
  const color = n > 0 ? "var(--ok)" : n < 0 ? "var(--err)" : "inherit";
  const fmt = n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span style="color:${color}">${fmt}</span>`;
}

function tipoClass(tipo) {
  if (!tipo) return "missing";
  const t = tipo.toLowerCase();
  if (t === "ordine") return "ok";
  if (t === "rimborso") return "warning";
  if (t === "trasferimento") return "missing";
  return "missing";
}

// ── Shared utils ──────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
