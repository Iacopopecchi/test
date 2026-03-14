/* ═══════════════════════════════════════════════════════════════════════════
   Amazon Reconciliation Dashboard — Frontend JS
   ═══════════════════════════════════════════════════════════════════════════ */

"use strict";

// Module-level state (must be declared before any IIFE runs)
let dtInstance = null;
let allTransactions = [];
let targetPeriodIds = new Set();

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
    info:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg> INFO',
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

  const checks = data.checks || [];
  const allPass = checks.length > 0 && checks.every(c => c.status === "ok");
  const hasChecks = checks.length > 0;
  document.getElementById("dash-subtitle").textContent =
    `${(data.transactions || []).length} transazioni · ${(data.settlement_periods || []).length} settlement period`;

  // Overall badge
  const badge = document.getElementById("overall-badge");
  if (hasChecks) {
    const statusLabels = { ok: "✅ Tutto quadra", warning: "⚠️ Attenzione", error: "❌ Errore" };
    badge.className = "overall-badge " + data.overall_status;
    badge.textContent = statusLabels[data.overall_status] || data.overall_status;
  } else {
    badge.hidden = true;
  }

  // ── Section 1: 4 Check Cards ──────────────────────────────────────────────
  const checksGrid = document.getElementById("checks-grid");

  // Expected labels in display order
  const checkDefs = [
    { label: "Ricavi",    key: "Ricavi" },
    { label: "Spese",     key: "Spese" },
    { label: "Pagamenti", key: "Pagamenti" },
    { label: "ADS",       key: "ADS" },
  ];

  const checksByLabel = {};
  for (const c of checks) checksByLabel[c.label] = c;

  // Transfer details for Pagamenti card
  const transferDetails = data.transfer_details || [];

  checksGrid.innerHTML = checkDefs.map(def => {
    const c = checksByLabel[def.key];
    const noPdf = !c || c.pdf_value === null || c.pdf_value === undefined;
    const st = c ? c.status : "missing";
    const icon = st === "ok" ? "✅" : st === "warning" ? "⚠️" : st === "missing" ? "—" : "❌";
    const csvFmt = c ? (c.csv_value_fmt || fmtEur(c.csv_value)) : "N/D";
    const pdfFmt = noPdf ? "<em style='color:var(--text-muted)'>PDF non caricato</em>"
                         : (c.pdf_value_fmt || fmtEur(c.pdf_value));
    const diffFmt = (!c || c.difference === null || c.difference === undefined)
                  ? "<em style='color:var(--text-muted)'>—</em>"
                  : (c.difference_fmt || fmtEur(c.difference));

    // Transfer breakdown under Pagamenti
    let extraHtml = "";
    if (def.key === "Pagamenti" && transferDetails.length > 0) {
      extraHtml = `<div class="check-transfers">
        ${transferDetails.map(t =>
          `<div class="check-transfer-row">
            <span>${t.date || "—"}</span>
            <span style="color:var(--err)">${t.amount_fmt || fmtEur(t.amount)}</span>
          </div>`
        ).join("")}
      </div>`;
    }

    // ADS invoice IDs
    if (def.key === "ADS" && data.ads_verification && data.ads_verification.invoice_ids && data.ads_verification.invoice_ids.length) {
      extraHtml = `<div class="check-transfers" style="font-size:.75rem;color:var(--text-muted);margin-top:.5rem">
        ${data.ads_verification.invoice_ids.map(id => `<div>${escHtml(id)}</div>`).join("")}
      </div>`;
    }

    return `<div class="check-card check-card--${st}">
      <div class="check-card-header">
        <span class="check-card-label">${escHtml(def.label)}</span>
        <span class="check-card-icon">${icon}</span>
      </div>
      <div class="check-card-row">
        <span class="check-card-key">CSV</span>
        <span class="check-card-val">${csvFmt}</span>
      </div>
      <div class="check-card-row">
        <span class="check-card-key">PDF</span>
        <span class="check-card-val">${pdfFmt}</span>
      </div>
      <div class="check-card-row check-card-delta">
        <span class="check-card-key">Δ</span>
        <span class="check-card-val">${diffFmt}</span>
      </div>
      ${extraHtml}
    </div>`;
  }).join("");

  // ── Section 2: Settlement periods (informational) ─────────────────────────
  const allPeriods = data.settlement_periods || [];
  document.getElementById("periods-body").innerHTML = allPeriods.map(p => settlementRow(p)).join("") ||
    '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">Nessun periodo trovato</td></tr>';

  // ── Section 3: Transactions ───────────────────────────────────────────────
  const transactions = data.transactions || [];
  renderTransactions(transactions, data.settlement_periods_target || []);

  // ── Section 4: Anomalies ──────────────────────────────────────────────────
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

function settlementRow(p) {
  const sumFmt = p.sum_transactions !== null && p.sum_transactions !== undefined
    ? (p.sum_transactions >= 0 ? "+" : "") +
      p.sum_transactions.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
    : "N/D";

  let transferCell;
  if (p.transfer_amount && p.transfer_amount !== 0) {
    const tFmt = p.transfer_amount.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    transferCell = `<span style="color:var(--err)">${tFmt} €</span>`
      + (p.transfer_date ? `<br><small style="color:var(--text-muted)">${p.transfer_date}</small>` : "");
  } else {
    transferCell = `<span style="color:var(--text-muted)">—</span>`;
  }

  const noteStyle = p.note ? "color:var(--text-secondary);font-size:.8rem" : "";
  return `<tr>
    <td><code style="font-family:var(--mono);font-size:.8rem">${escHtml(p.period_id)}</code></td>
    <td>${p.date_start || "—"}</td>
    <td>${p.date_end || "—"}</td>
    <td class="num-col">${p.transaction_count ?? "—"}</td>
    <td class="num-col">${sumFmt}</td>
    <td class="num-col">${transferCell}</td>
    <td style="${noteStyle}">${escHtml(p.note || "")}</td>
  </tr>`;
}

// ── Transaction table with DataTables ──────────────────────────────────────

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
