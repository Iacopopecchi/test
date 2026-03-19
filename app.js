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

    zone.addEventListener('click', () => input.click());

    input.addEventListener('change', () => {
      if (input.files.length) setFile(field, input.files[0], zone, nameId);
    });

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
    const res  = await fetch('/api/reconcile', { method: 'POST', body: form });
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
  renderDashHeader(data);
  renderWarnings(data.warnings || []);
  renderRic1(data);
  renderRic2(data);
  renderVerifica(data);
  renderLegenda(data);
}

// ─── DASHBOARD HEADER ─────────────────────────────────────────────
function renderDashHeader(data) {
  document.getElementById('dash-title').textContent =
    `☁ RICONCILIAZIONE AMAZON — ${data.mese_target}`;

  const mkts = (data.marketplaces || []).join(' · ');
  const sub  = [
    'CaféNoirOfficial',
    mkts || null,
    data.periodo_label ? `Periodo: ${data.periodo_label}` : null,
  ].filter(Boolean).join(' · ');

  document.getElementById('dash-subtitle').textContent = sub;

  const meseNome = (data.mese_target || '').split(' ')[0].toLowerCase();
  const meseEl   = document.getElementById('mese-verifica');
  if (meseEl) meseEl.textContent = meseNome;
}

// ─── WARNINGS ─────────────────────────────────────────────────────
function renderWarnings(warnings) {
  const box = document.getElementById('warnings-box');
  if (warnings.length) {
    box.textContent = '⚠️ ' + warnings.join(' | ');
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

// ─── RICONCILIAZIONE 1 ────────────────────────────────────────────
function renderRic1(data) {
  const checks = data.checks;
  const saldo  = data.saldo_residuo;
  const opens  = saldo.open_periods || [];

  // helper: build a standard comparison row
  function compRow(voce, check, boldVoce) {
    const diff = check.differenza;
    const pass = check.pass;
    const esito = pass === null
      ? '<td class="center recon-nd">—</td>'
      : pass
        ? '<td class="center recon-ok">✅ OK</td>'
        : '<td class="center recon-fail">❌</td>';

    return `<tr class="${boldVoce ? 'ric1-bold' : ''}">
      <td>${voce}</td>
      <td class="num">${fmtEurSign(check.csv)}</td>
      <td class="num">${check.pdf !== null && check.pdf !== undefined ? fmtEurSign(check.pdf) : '<span class="recon-nd">N/D</span>'}</td>
      <td class="num">${diff !== null && diff !== undefined ? (Math.abs(diff) < 0.005 ? '-' : fmtEurSign(diff)) : '-'}</td>
      ${esito}
    </tr>`;
  }

  const saldoGen  = round2(checks.ricavi.csv + checks.spese.csv + checks.imposte.csv);
  const saldoRes  = saldo.importo;

  // Open period note
  let openNote = '';
  if (opens.length) {
    const nextMese = nextMonthName(data.mese_target);
    openNote = opens.map(pid =>
      `Periodo ${pid} ancora aperto — bonifico atteso a ${nextMese}`
    ).join(' | ');
  }

  // ADS row
  const ads    = checks.ads;
  const adsDiff = ads.differenza;
  const adsEsito = !ads.disponibile
    ? '<td class="center recon-nd">N/D</td>'
    : ads.pass
      ? '<td class="center recon-ok">✅ OK</td>'
      : '<td class="center recon-fail">❌</td>';

  const adsRow = `<tr>
    <td>Costo ADS (verifica fattura)</td>
    <td class="num">${fmtEurSign(ads.csv)}</td>
    <td class="num">${ads.disponibile && ads.pdf !== null ? fmtEurSign(ads.pdf) : '<span class="recon-nd">N/D</span>'}</td>
    <td class="num">${adsDiff !== null && Math.abs(adsDiff) < 0.005 ? '-' : (adsDiff !== null ? fmtEurSign(adsDiff) : '-')}</td>
    ${adsEsito}
  </tr>`;

  document.getElementById('ric1-tbody').innerHTML = `
    ${compRow('Ricavi (imponibile vendite)',        checks.ricavi)}
    ${compRow('Spese (commissioni + costi)',        checks.spese)}
    ${compRow('Imposte nette (IVA vendite)',        checks.imposte)}
    ${compRow('Trasferimenti ricevuti',             checks.trasferimenti)}
    <tr class="ric1-computed">
      <td><strong>Saldo generato (Ricavi + Spese + Imposte)</strong></td>
      <td class="num"><strong>${fmtEurSign(saldoGen)}</strong></td>
      <td></td><td></td><td></td>
    </tr>
    <tr class="ric1-saldo-residuo">
      <td><strong>Saldo residuo su conto Amazon (fine mese)</strong></td>
      <td class="num"><strong>${fmtEur(saldoRes)}</strong></td>
      <td colspan="3" class="recon-open-note">${openNote}</td>
    </tr>
    ${adsRow}
  `;
}

// ─── RICONCILIAZIONE 2 ────────────────────────────────────────────
function renderRic2(data) {
  const periods   = data.settlement_periods || [];
  // Only paid periods where transfer was in the target month
  const paid = periods.filter(p => p.transfer_amount !== null && p.transfer_src === 'target');

  if (!paid.length) {
    document.getElementById('ric2-tbody').innerHTML =
      '<tr><td colspan="5" class="recon-nd-cell">Nessun bonifico ricevuto nel mese target</td></tr>';
    return;
  }

  const totalCash = round2(paid.reduce((s, p) => s + (p.transfer_amount || 0), 0));

  const rows = paid.map(p => {
    // Format: "26216940642 (31/12→13/01)\nBonifico +80,80 il 14/01"
    const dateRange = `${shortDate(p.data_inizio)}→${shortDate(p.data_fine)}`;
    const bonifica  = p.transfer_date
      ? `Bonifico ${fmtEurSign(p.transfer_amount)} il ${shortDate(p.transfer_date)}`
      : '';
    return `<tr>
      <td class="ric2-periodo-cell">
        <span class="ric2-periodo-id">${p.periodo_id}</span>
        <span class="ric2-periodo-range">(${dateRange})</span>
        ${bonifica ? `<span class="ric2-bonifico">${bonifica}</span>` : ''}
      </td>
      <td class="num">${fmtEurSign(p.vendite_nette)}</td>
      <td class="num">${fmtEurSign(p.iva_vendite)}</td>
      <td class="num">${fmtEurSign(p.spese_nette)}</td>
      <td class="num ric2-total">${fmtEurSign(p.transfer_amount)}</td>
    </tr>`;
  }).join('');

  const totRow = `<tr class="ric2-totale">
    <td><strong>Totale cash ricevuto a ${(data.mese_target || '').split(' ')[0].toLowerCase()}</strong></td>
    <td></td><td></td><td></td>
    <td class="num"><strong>${fmtEur(totalCash)}</strong></td>
  </tr>`;

  document.getElementById('ric2-tbody').innerHTML = rows + totRow;
}

// ─── VERIFICA CHIUSURA SETTLEMENT PERIOD ─────────────────────────
function renderVerifica(data) {
  const periods = data.settlement_periods || [];

  if (!periods.length) {
    document.getElementById('verifica-tbody').innerHTML =
      '<tr><td colspan="5" class="recon-nd-cell">Nessun settlement period trovato</td></tr>';
    return;
  }

  document.getElementById('verifica-tbody').innerHTML = periods.map(p => {
    const ta   = p.transfer_amount;
    const diff = p.differenza;

    // Icon logic
    let icon;
    if (ta === null || ta === undefined) {
      icon = '<span class="verifica-icon verifica-open">⏳</span>';
    } else if (diff !== null && Math.abs(diff) <= 0.05) {
      if (p.transfer_src === 'target') {
        icon = '<span class="verifica-icon verifica-ok">✅</span>';
      } else {
        icon = '<span class="verifica-icon verifica-next">⏳</span>';
      }
    } else {
      icon = '<span class="verifica-icon verifica-fail">❌</span>';
    }

    const dateRange = p.data_inizio && p.data_fine
      ? `${shortDate(p.data_inizio)}→${shortDate(p.data_fine)}`
      : '—';

    const diffDisplay = diff !== null
      ? (Math.abs(diff) < 0.005 ? '-' : fmtEurSign(diff))
      : '-';

    return `<tr>
      <td>${icon} <code class="periodo-code">${p.periodo_id}</code></td>
      <td class="verifica-dates">${dateRange}</td>
      <td class="num">${fmtEurSign(p.tx_sum)}</td>
      <td class="num">${ta !== null && ta !== undefined ? fmtEurSign(ta) : '—'}</td>
      <td class="num verifica-diff">${diffDisplay}</td>
    </tr>`;
  }).join('');
}

// ─── NOTE & LEGENDA ───────────────────────────────────────────────
function renderLegenda(data) {
  const checks = data.checks;
  const saldo  = data.saldo_residuo;
  const r  = saldo.ricavi || 0;
  const i  = saldo.imposte || 0;
  const s  = saldo.spese || 0;
  const tr = saldo.trasferimenti || 0;
  const sg = round2(r + i + s);

  const voci = [
    ['Ricavi',
     'Imponibile vendite al netto dei rimborsi. IVA ESCLUSA.'],
    ['Spese',
     'Commissioni + altri costi + ADS + abbonamento. IVA INCLUSA (nota PDF).'],
    ['Imposte',
     'IVA netta incassata dai clienti per conto dello stato. Non è un ricavo tuo.'],
    ['Saldo generato',
     `Ricavi + Spese + Imposte = ${fmtN(r)} + (${fmtN(s)}) + ${fmtN(i)} = <strong>${fmtEur(sg)}</strong>`],
    ['Saldo residuo',
     `Saldo generato – Trasferimenti = ${fmtN(sg)} – ${fmtN(Math.abs(tr))} = <strong>${fmtEur(saldo.importo)}</strong> ancora su Amazon.`],
    ['Settlement',
     'Ogni bonifico arriva ~15gg dopo la chiusura del periodo. Il trasferimento nel periodo N salda il periodo N-1. Tutti i periodi chiudono a zero. ✅'],
    ['ADS',
     'I costi ADS vengono dedotti direttamente dal saldo Amazon (colonna \'totale\' nel CSV). Verificati contro PDF fattura ADS Italy EUR.'],
  ];

  document.getElementById('legenda-tbody').innerHTML = voci.map(([termine, desc]) => `
    <tr>
      <td class="legenda-termine">${termine}</td>
      <td class="legenda-desc">${desc}</td>
    </tr>
  `).join('');
}

// ─── HELPERS ──────────────────────────────────────────────────────
function round2(v) { return Math.round(v * 100) / 100; }

function fmtEur(val) {
  if (val === null || val === undefined) return 'N/D';
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  return new Intl.NumberFormat('it-IT', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: 2,
  }).format(n);
}

function fmtEurSign(val) {
  if (val === null || val === undefined) return 'N/D';
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  const abs = new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Math.abs(n));
  const sign = n >= 0 ? '+' : '−';
  return `${sign}${abs} €`;
}

function fmtN(val) {
  return new Intl.NumberFormat('it-IT', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(val);
}

// Convert "DD/MM/YYYY" to short "DD/MM" or "DD/MM/YY"
function shortDate(s) {
  if (!s) return '';
  const parts = s.split('/');
  if (parts.length < 3) return s;
  // If year same as current don't show it, else show last 2 digits
  return `${parts[0]}/${parts[1]}/${parts[2].slice(2)}`;
}

function nextMonthName(meseTarget) {
  const MESI_NOMI = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                     'luglio','agosto','settembre','ottobre','novembre','dicembre'];
  const MESI_MAP  = {
    Gennaio:0, Febbraio:1, Marzo:2, Aprile:3, Maggio:4, Giugno:5,
    Luglio:6, Agosto:7, Settembre:8, Ottobre:9, Novembre:10, Dicembre:11,
  };
  const parts = (meseTarget || '').split(' ');
  const idx   = MESI_MAP[parts[0]];
  if (idx === undefined) return 'mese successivo';
  return MESI_NOMI[(idx + 1) % 12];
}

// ─── INIT ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSelectors();
  initDropZones();
});
