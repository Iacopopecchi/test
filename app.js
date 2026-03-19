/* ═══════════════════════════════════════════════════════════════════
   Amazon Reconciliation — app.js
   Vanilla JS SPA: upload → POST → results dashboard
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── STATE ────────────────────────────────────────────────────────
const files = {
  csv_prev:    null,
  csv_target:  null,
  csv_next:    null,
  pdf_summary: null,
  pdf_ads:     null,
};

let allTransactions = [];

// ─── MONTH / YEAR SETUP ───────────────────────────────────────────
const MESI = [
  '', 'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];

function initSelectors() {
  const yearSel = document.getElementById('sel-year');
  const now = new Date();
  for (let y = now.getFullYear() + 1; y >= 2020; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === now.getFullYear()) opt.selected = true;
    yearSel.appendChild(opt);
  }

  // Default: current month
  document.getElementById('sel-month').value = now.getMonth() + 1;
  updateLabels();
}

function updateLabels() {
  const m = parseInt(document.getElementById('sel-month').value, 10);

  const prev = m === 1 ? 12 : m - 1;
  const next = m === 12 ? 1 : m + 1;

  document.getElementById('label-csv-prev').textContent   = `CSV ${MESI[prev]}`;
  document.getElementById('label-csv-target').textContent = `CSV ${MESI[m]}`;
  document.getElementById('label-csv-next').textContent   = `CSV ${MESI[next]}`;
}

// ─── DROP ZONES ───────────────────────────────────────────────────
function initDropZones() {
  const zones = [
    { zoneId: 'zone-csv-prev',    inputId: 'input-csv-prev',    field: 'csv_prev',    nameId: 'name-csv-prev' },
    { zoneId: 'zone-csv-target',  inputId: 'input-csv-target',  field: 'csv_target',  nameId: 'name-csv-target' },
    { zoneId: 'zone-csv-next',    inputId: 'input-csv-next',    field: 'csv_next',    nameId: 'name-csv-next' },
    { zoneId: 'zone-pdf-summary', inputId: 'input-pdf-summary', field: 'pdf_summary', nameId: 'name-pdf-summary' },
    { zoneId: 'zone-pdf-ads',     inputId: 'input-pdf-ads',     field: 'pdf_ads',     nameId: 'name-pdf-ads' },
  ];

  zones.forEach(({ zoneId, inputId, field, nameId }) => {
    const zone  = document.getElementById(zoneId);
    const input = document.getElementById(inputId);

    // Click → open file picker
    zone.addEventListener('click', () => input.click());

    // File selected via picker
    input.addEventListener('change', () => {
      if (input.files.length) setFile(field, input.files[0], zone, nameId);
    });

    // Drag events
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (f) setFile(field, f, zone, nameId);
    });
  });
}

function setFile(field, file, zone, nameId) {
  files[field] = file;
  zone.classList.add('has-file');
  const el = document.getElementById(nameId);
  el.textContent = `✓ ${file.name}`;
  el.style.color = 'var(--green)';
}

// ─── FORM SUBMIT ──────────────────────────────────────────────────
async function submitForm(e) {
  e.preventDefault();

  const errEl = document.getElementById('upload-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!files.csv_target) {
    showUploadError('Carica il CSV del mese target (obbligatorio).');
    return;
  }
  if (!files.pdf_summary) {
    showUploadError('Carica il PDF Summary (obbligatorio).');
    return;
  }

  setLoading(true);

  const form = new FormData();
  Object.entries(files).forEach(([key, file]) => {
    if (file) form.append(key, file);
  });

  try {
    const res = await fetch('/api/reconcile', { method: 'POST', body: form });
    const data = await res.json();

    if (data.error) {
      showUploadError(data.error + (data.traceback ? `\n\n${data.traceback}` : ''));
      return;
    }

    renderResults(data);
    showResults();
  } catch (err) {
    showUploadError(`Errore di rete: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

function showUploadError(msg) {
  const el = document.getElementById('upload-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function setLoading(on) {
  const btn  = document.getElementById('btn-submit');
  const text = document.getElementById('btn-text');
  const spin = document.getElementById('btn-spinner');
  btn.disabled = on;
  text.textContent = on ? 'Elaborazione in corso...' : '▶ Avvia Riconciliazione';
  spin.classList.toggle('hidden', !on);
}

// ─── VIEW SWITCHING ───────────────────────────────────────────────
function showResults() {
  document.getElementById('upload-view').classList.add('hidden');
  document.getElementById('results-view').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showUpload() {
  document.getElementById('results-view').classList.add('hidden');
  document.getElementById('upload-view').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── RENDER RESULTS ───────────────────────────────────────────────
function renderResults(data) {
  // Header
  document.getElementById('results-title').textContent = `Riconciliazione ${data.mese_target}`;

  const badge = document.getElementById('results-badge');
  if (data.status_globale === 'OK') {
    badge.textContent = '✅ Tutto quadra';
    badge.className = 'status-badge ok';
  } else if (data.status_globale === 'ATTENZIONE') {
    badge.textContent = '⚠️ Attenzione';
    badge.className = 'status-badge warn';
  } else {
    badge.textContent = '❌ Errore';
    badge.className = 'status-badge error';
  }

  // Warnings
  const warnBox = document.getElementById('warnings-box');
  if (data.warnings && data.warnings.length) {
    warnBox.textContent = '⚠️ ' + data.warnings.join(' | ');
    warnBox.classList.remove('hidden');
  } else {
    warnBox.classList.add('hidden');
  }

  // 4 checks
  renderCheck('ricavi',         data.checks.ricavi);
  renderCheck('spese',          data.checks.spese);
  renderCheck('trasferimenti',  data.checks.trasferimenti);
  renderCheckAds(data.checks.ads);

  // Transfer detail
  renderTransferDetail(data.checks.trasferimenti.dettaglio || []);

  // Narrative
  renderNarrative(data);

  // Saldo
  renderSaldo(data.saldo_residuo, data.pdf_summary_raw);

  // Settlement periods
  renderPeriods(data.settlement_periods || []);

  // Transactions
  allTransactions = data.transazioni || [];
  renderTransactions(allTransactions);
  populateFilters(allTransactions);

  // Debug panel
  renderDebug(data._debug);
}

function renderDebug(dbg) {
  let el = document.getElementById('debug-panel');
  if (!el) {
    el = document.createElement('details');
    el.id = 'debug-panel';
    el.style.cssText = 'margin:1rem 0;font-size:.78rem;color:#666;background:#f9f9f9;border:1px solid #ddd;border-radius:6px;padding:.75rem 1rem';
    const resultsEl = document.getElementById('results') || document.body;
    resultsEl.appendChild(el);
  }
  if (!dbg) { el.hidden = true; return; }

  const resolved = dbg.csv_col_resolved || {};
  const colRows = Object.entries(resolved).map(([canonical, actual]) =>
    `<tr><td style="color:#888;padding:1px 8px 1px 0">${canonical}</td><td style="font-weight:${actual ? 700 : 400};color:${actual ? '#1a7a1a' : '#c00'}">${actual || '❌ NON TROVATA'}</td></tr>`
  ).join('');

  el.innerHTML = `
    <summary style="cursor:pointer;font-weight:700;color:#555">🔍 Debug info (CSV + PDF)</summary>
    <div style="margin-top:.5rem">
      <b>Separatore CSV:</b> <code>${dbg.csv_separator === '\t' ? 'TAB' : dbg.csv_separator}</code>
      &nbsp;|&nbsp; <b>Righe lette:</b> ${dbg.csv_row_count}<br><br>
      <b>Intestazioni CSV trovate:</b><br>
      <code style="font-size:.72rem">${(dbg.csv_headers || []).join(' | ')}</code><br><br>
      <b>Mappatura colonne numeriche:</b><br>
      <table>${colRows}</table><br>
      ${dbg.csv_first_row ? `<b>Prima riga CSV (parsed):</b><br><code style="font-size:.72rem;word-break:break-all">${dbg.csv_first_row}</code><br><br>` : ''}
      <b>PDF – valori estratti:</b><br>
      <code>${JSON.stringify(dbg.pdf_raw_values)}</code><br><br>
      ${dbg.pdf_text_sample ? `<details style="margin-top:.5rem"><summary style="cursor:pointer;color:#888">📄 Testo grezzo PDF (prime 50 righe)</summary><pre style="font-size:.68rem;white-space:pre-wrap;max-height:300px;overflow:auto;background:#f0f0f0;padding:.5rem;margin-top:.25rem">${dbg.pdf_text_sample.replace(/</g,'&lt;')}</pre></details>` : ''}
    </div>`;
  el.hidden = false;
}

function renderCheck(key, check) {
  const card  = document.getElementById(`card-${key === 'trasferimenti' ? 'trasferimenti' : key}`);
  const icon  = document.getElementById(`icon-${key === 'trasferimenti' ? 'trasferimenti' : key}`);
  const csvEl = document.getElementById(`val-${abbr(key)}-csv`);
  const pdfEl = document.getElementById(`val-${abbr(key)}-pdf`);
  const dltEl = document.getElementById(`val-${abbr(key)}-delta`);

  const pass = check.pass;
  card.className = `check-card ${pass ? 'pass' : 'fail'}`;
  icon.textContent = pass ? '✅' : '❌';
  csvEl.textContent = fmtEur(check.csv);
  pdfEl.textContent = check.pdf !== null && check.pdf !== undefined ? fmtEur(check.pdf) : 'N/D';
  dltEl.textContent = check.differenza !== null && check.differenza !== undefined ? fmtEur(check.differenza) : '—';
}

function renderCheckAds(ads) {
  const card  = document.getElementById('card-ads');
  const icon  = document.getElementById('icon-ads');
  const csvEl = document.getElementById('val-ads-csv');
  const pdfEl = document.getElementById('val-ads-pdf');
  const dltEl = document.getElementById('val-ads-delta');

  if (!ads.disponibile) {
    card.className = 'check-card nd';
    icon.textContent = '➖';
    csvEl.textContent = fmtEur(ads.csv);
    pdfEl.textContent = 'N/D';
    dltEl.textContent = '—';
  } else {
    card.className = `check-card ${ads.pass ? 'pass' : 'fail'}`;
    icon.textContent = ads.pass ? '✅' : '❌';
    csvEl.textContent = fmtEur(ads.csv);
    pdfEl.textContent = fmtEur(ads.pdf);
    dltEl.textContent = fmtEur(ads.differenza);
  }
}

function abbr(key) {
  if (key === 'trasferimenti') return 'trasf';
  return key;
}

function renderTransferDetail(detail) {
  const el = document.getElementById('detail-trasferimenti');
  if (!detail.length) { el.innerHTML = ''; return; }

  let html = '<div style="font-size:.76rem;color:var(--text-muted);font-weight:600;margin-bottom:4px">Bonifici ricevuti:</div>';
  detail.forEach(d => {
    html += `<div class="transfer-item"><span>${d.data}</span><span style="font-weight:700;color:var(--amazon-dark)">${fmtEur(d.importo)}</span></div>`;
  });
  el.innerHTML = html;
}

function renderNarrative(data) {
  const checks  = data.checks;
  const sumRaw  = data.pdf_summary_raw;
  const saldo   = data.saldo_residuo;
  const periods = data.settlement_periods || [];

  const ricavi  = checks.ricavi.csv;
  const imposte = saldo.imposte;
  const spese   = Math.abs(checks.spese.csv);
  const trasf   = checks.trasferimenti;
  const ads     = checks.ads;

  const transferDetail = trasf.dettaglio || [];

  let html = '<h3>📋 Come leggere questi numeri</h3>';

  html += `<p>Ad ${data.mese_target} CafèNoirOfficial ha venduto per <strong>${fmtEur(ricavi)}</strong> (IVA esclusa) su Amazon.`;
  if (imposte) {
    html += ` A questi ricavi si aggiungono <strong>${fmtEur(Math.abs(imposte))} di IVA</strong> incassata dai clienti per conto dello stato.`;
  }
  html += '</p>';

  html += `<p>Amazon ha trattenuto <strong>${fmtEur(spese)} di spese</strong> (commissioni di vendita, costi vari, rimborsi).`;
  if (ads.disponibile) {
    html += ` Il costo pubblicitario ADS è stato di <strong>${fmtEur(Math.abs(ads.csv))}</strong>`;
    html += ads.pass ? ', verificato e coincidente con la fattura ADS. ✅' : ' — ⚠️ differenza con la fattura ADS.';
  }
  html += '</p>';

  if (transferDetail.length > 0) {
    html += `<p>Amazon ha effettuato <strong>${transferDetail.length} bonif${transferDetail.length === 1 ? 'ico' : 'ici'}</strong> sul conto corrente a ${data.mese_target}:</p><ul style="margin:4px 0 10px 20px">`;
    let totTrasf = 0;
    transferDetail.forEach(d => {
      html += `<li>${d.data}: <strong>${fmtEur(d.importo)}</strong></li>`;
      totTrasf += d.importo;
    });
    html += `</ul><p>Totale ricevuto: <strong>${fmtEur(totTrasf)}</strong></p>`;
  } else {
    html += '<p>Nessun bonifico registrato nel mese target.</p>';
  }

  const openPeriods = periods.filter(p => p.transfer_amount === null || p.transfer_amount === undefined);
  if (openPeriods.length > 0 && Math.abs(saldo.importo) > 0.10) {
    html += `<p>A fine ${data.mese_target} rimangono <strong>${fmtEur(saldo.importo)}</strong> ancora sul conto Amazon (non ancora trasferiti). Questo è normale:`;
    openPeriods.forEach(p => {
      html += ` il periodo di liquidazione <em>${p.periodo_id}</em> si chiude il mese successivo — il bonifico corrispondente di <strong>${fmtEur(p.tx_sum)}</strong> è atteso.`;
    });
    html += '</p>';
  }

  if (data.status_globale === 'OK') {
    html += '<p style="color:var(--green);font-weight:700">✅ Tutti i check sono stati superati: la riconciliazione è corretta.</p>';
  } else {
    html += '<p style="color:var(--red);font-weight:700">⚠️ Uno o più check non sono stati superati: verifica le differenze nelle card sopra.</p>';
  }

  document.getElementById('narrative-box').innerHTML = html;
}

function renderSaldo(saldo, raw) {
  const r = saldo.ricavi  || 0;
  const i = saldo.imposte || 0;
  const s = saldo.spese   || 0;
  const t = saldo.trasferimenti || 0;
  const tot = saldo.importo;

  const html = `
    <div class="saldo-title">💰 Saldo residuo su conto Amazon</div>
    <div class="saldo-amount">${fmtEur(tot)}</div>
    <div class="saldo-formula">
      Ricavi (${fmtSign(r)}) + IVA (${fmtSign(i)}) + Spese (${fmtSign(s)}) + Trasferimenti (${fmtSign(t)})<br>
      = <strong>${fmtEur(tot)}</strong>
    </div>
    <div class="saldo-explanation">${saldo.spiegazione || ''}</div>
  `;

  document.getElementById('saldo-box').innerHTML = html;
}

function renderPeriods(periods) {
  const tbody = document.getElementById('periods-tbody');
  if (!periods.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:var(--text-muted)">Nessun settlement period trovato</td></tr>';
    return;
  }

  tbody.innerHTML = periods.map(p => {
    const closed = p.differenza !== null && p.differenza !== undefined;
    const ok     = closed && Math.abs(p.differenza) <= 0.05;
    const badge  = closed ? (ok ? '<span class="badge-ok">✅</span>' : '<span class="badge-fail">❌</span>') : '<span class="badge-nd">–</span>';

    return `<tr>
      <td><code style="font-size:.8rem">${p.periodo_id}</code></td>
      <td>${p.data_inizio}</td>
      <td>${p.data_fine}</td>
      <td style="text-align:right">${p.n_transazioni}</td>
      <td class="num">${fmtEur(p.tx_sum)}</td>
      <td class="num">${p.transfer_amount !== null && p.transfer_amount !== undefined ? fmtEur(p.transfer_amount) : '—'}</td>
      <td>${p.transfer_date || '—'}</td>
      <td style="text-align:center">${badge}</td>
      <td style="font-size:.78rem;color:var(--text-muted)">${p.note || ''}</td>
    </tr>`;
  }).join('');
}

// ─── TRANSACTIONS TABLE ───────────────────────────────────────────
function populateFilters(txs) {
  const tipos   = [...new Set(txs.map(t => t['Tipo']).filter(Boolean))];
  const periods = [...new Set(txs.map(t => t['Numero pagamento']).filter(Boolean))];

  const tipoSel   = document.getElementById('filter-tipo');
  const periodSel = document.getElementById('filter-period');

  tipoSel.innerHTML   = '<option value="">Tutti i tipi</option>'   + tipos.map(v => `<option>${v}</option>`).join('');
  periodSel.innerHTML = '<option value="">Tutti i periodi</option>' + periods.map(v => `<option>${v}</option>`).join('');
}

function filterTransactions() {
  const tipo   = document.getElementById('filter-tipo').value;
  const period = document.getElementById('filter-period').value;
  const text   = document.getElementById('filter-text').value.toLowerCase();

  const filtered = allTransactions.filter(tx => {
    if (tipo   && tx['Tipo']              !== tipo)   return false;
    if (period && tx['Numero pagamento']  !== period) return false;
    if (text) {
      const haystack = Object.values(tx).join(' ').toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });

  renderTransactions(filtered);
}

function renderTransactions(txs) {
  const tbody = document.getElementById('transactions-tbody');

  if (!txs.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-muted)">Nessuna transazione trovata</td></tr>';
    return;
  }

  tbody.innerHTML = txs.map(tx => `<tr>
    <td>${tx['Data'] || ''}</td>
    <td>${tx['Tipo'] || ''}</td>
    <td style="font-size:.73rem;color:var(--text-muted)">${tx['Numero ordine'] || ''}</td>
    <td>${tx['Descrizione'] || ''}</td>
    <td class="num">${fmtNum(tx['Vendite'])}</td>
    <td class="num">${fmtNum(tx['Commissioni di vendita'])}</td>
    <td class="num">${fmtNum(tx['Altro'])}</td>
    <td class="num" style="font-weight:700">${fmtNum(tx['totale'])}</td>
  </tr>`).join('');
}

function toggleTransactions(btn) {
  const panel = document.getElementById('transactions-panel');
  const open  = panel.classList.toggle('hidden');
  btn.classList.toggle('open', !open);
}

// ─── NUMBER FORMATTING ────────────────────────────────────────────
function fmtEur(val) {
  if (val === null || val === undefined) return 'N/D';
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  return new Intl.NumberFormat('it-IT', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2,
  }).format(n);
}

function fmtNum(val) {
  if (val === null || val === undefined || val === '') return '';
  const n = parseFloat(val);
  if (isNaN(n) || n === 0) return '';
  return new Intl.NumberFormat('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtSign(val) {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency', currency: 'EUR',
    minimumFractionDigits: 2, signDisplay: 'always',
  }).format(val);
}

// ─── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSelectors();
  initDropZones();
});
