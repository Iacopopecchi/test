/**
 * Amazon Seller Central Reconciliation — Netlify Function (Node.js)
 * POST /api/reconcile  multipart/form-data → JSON
 */

const Busboy   = require('busboy');
const { Readable } = require('stream');
const pdfParse = require('pdf-parse');

// ── Constants ────────────────────────────────────────────────────────────────

const MESI_IT = {
  gen: 1, feb: 2, mar: 3, apr: 4, mag: 5,  giu: 6,
  lug: 7, ago: 8, set: 9, ott: 10, nov: 11, dic: 12,
};
const MESI_NOMI = {
  1:'Gennaio', 2:'Febbraio', 3:'Marzo',    4:'Aprile',
  5:'Maggio',  6:'Giugno',   7:'Luglio',   8:'Agosto',
  9:'Settembre', 10:'Ottobre', 11:'Novembre', 12:'Dicembre',
};
const NUMERIC_COLS = [
  'Vendite', 'imposta sulle vendite dei prodotti',
  'Commissioni di vendita', 'Altri costi relativi alle transazioni',
  'Altro', 'totale',
];

// Alternative column names for each canonical column (case-insensitive lookup)
const COL_ALIASES = {
  'vendite': [
    'vendite', 'ricavi vendite', 'ricavi', 'ricavo',
    'ricavi prodotto', 'importo vendite', 'vendite prodotto',
    'product sales', 'sales',
  ],
  'imposta sulle vendite dei prodotti': [
    'imposta sulle vendite dei prodotti', 'imposta sulle vendite',
    'iva', 'imposta', 'tax', 'sales tax',
  ],
  'commissioni di vendita': [
    'commissioni di vendita', 'commissioni', 'commissione',
    'selling fees', 'importo commissioni',
  ],
  'altri costi relativi alle transazioni': [
    'altri costi relativi alle transazioni', 'altri costi transazione',
    'altri costi', 'other transaction fees',
  ],
  'altro': ['altro', 'altri', 'varie', 'other'],
  'totale': ['totale', 'total', 'importo totale', 'netto', 'net'],
};
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  try {
    const files = await parseMultipart(event);

    if (!files.csv_target) return errResp('CSV del mese target obbligatorio non caricato.');
    if (!files.pdf_summary) return errResp('PDF Summary obbligatorio non caricato.');

    // Parse CSV files
    const targetRows = parseAmazonCsv(files.csv_target);
    const prevRows   = files.csv_prev  ? parseAmazonCsv(files.csv_prev)  : null;
    const nextRows   = files.csv_next  ? parseAmazonCsv(files.csv_next)  : null;

    // Detect marketplaces across all loaded CSVs
    const mktSet = new Set([
      ...(targetRows._marketplaces || []),
      ...(prevRows  ? prevRows._marketplaces  || [] : []),
      ...(nextRows  ? nextRows._marketplaces  || [] : []),
    ]);
    const marketplaces = [...mktSet];

    // Parse PDFs
    const pdfSum = await parsePdfSummary(files.pdf_summary);
    if (!pdfSum) {
      return errResp(
        'Impossibile leggere il PDF Summary. ' +
        'Assicurati che sia il file scaricato da Report → Pagamenti → Archivio Report.'
      );
    }
    const pdfAdsEur = files.pdf_ads ? await parsePdfAds(files.pdf_ads) : null;

    // Compute
    const meseTarget = getMonthLabel(targetRows);
    const checks     = computeChecks(targetRows, pdfSum, pdfAdsEur);
    const periods    = computePeriods(targetRows, prevRows, nextRows);

    const ricavi  = checks.ricavi.csv;
    const spese   = checks.spese.csv;
    const trasf   = checks.trasferimenti.csv;
    const imposte = checks.imposte.csv;
    const saldo   = round2(ricavi + imposte + spese + trasf);

    const passList = [checks.ricavi.pass, checks.spese.pass, checks.imposte.pass, checks.trasferimenti.pass];
    if (checks.ads.disponibile) passList.push(checks.ads.pass);
    const statusGlobale = passList.some(p => p === false) ? 'ATTENZIONE' : 'OK';

    const openPeriods = periods.filter(p => p.transfer_amount === null);

    const warnings = [];
    if (!files.csv_prev && periods.length) {
      const first = periods[0];
      if (first.note || first.transfer_amount === null) {
        warnings.push(
          `Carica anche il CSV del mese precedente per verificare ` +
          `il settlement period ${first.periodo_id}`
        );
      }
    }

    return jsonResp({
      mese_target:    meseTarget,
      periodo_label:  getPeriodLabel(meseTarget),
      marketplaces,
      status_globale: statusGlobale,
      warnings,
      checks,
      saldo_residuo: {
        importo:       saldo,
        ricavi:        round2(ricavi),
        imposte:       round2(imposte),
        spese:         round2(spese),
        trasferimenti: round2(trasf),
        open_periods:  openPeriods.map(p => p.periodo_id),
        spiegazione:   buildSaldoExp(saldo, openPeriods),
      },
      settlement_periods: periods,
      pdf_summary_raw:    pdfSum,
    });

  } catch (err) {
    return jsonResp({ error: err.message, stack: err.stack }, 500);
  }
};

// ── Multipart parsing ────────────────────────────────────────────────────────

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const hdrs = {};
    Object.entries(event.headers || {}).forEach(([k, v]) => { hdrs[k.toLowerCase()] = v; });

    const bb = Busboy({ headers: hdrs });
    const files = {};

    bb.on('file', (name, file) => {
      const chunks = [];
      file.on('data', c => chunks.push(c));
      file.on('end',  () => { files[name] = Buffer.concat(chunks); });
    });
    bb.on('finish', () => resolve(files));
    bb.on('error',  reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'binary');

    Readable.from(body).pipe(bb);
  });
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * RFC 4180-compliant CSV field splitter.
 * Handles quoted fields (including quoted commas/decimals like "37,50").
 */
function parseCsvLine(line, sep) {
  const result = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let val = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') { val += '"'; i += 2; } // escaped ""
          else { i++; break; } // closing quote
        } else {
          val += line[i++];
        }
      }
      result.push(val);
      if (i < line.length && line[i] === sep) i++; // skip separator after closing quote
    } else {
      const end = line.indexOf(sep, i);
      if (end === -1) { result.push(line.slice(i)); break; }
      result.push(line.slice(i, end));
      i = end + 1;
    }
  }
  if (line.length > 0 && line[line.length - 1] === sep) result.push(''); // trailing separator
  return result;
}

function parseItNum(val) {
  const s = String(val ?? '').trim();
  if (!s || s === '-' || s === '—') return 0;
  return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
}

function parseItDate(s) {
  if (!s || !s.trim()) return null;
  s = s.trim();
  // "14 gen 2026"
  const parts = s.split(/\s+/);
  if (parts.length === 3) {
    const m = MESI_IT[parts[1].toLowerCase().slice(0, 3)];
    if (m) return new Date(+parts[2], m - 1, +parts[0]);
  }
  // "14/01/2026"
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return new Date(+dmy[3], +dmy[2] - 1, +dmy[1]);
  return null;
}

function fmtDate(d) {
  if (!d) return '';
  return [
    String(d.getDate()).padStart(2,'0'),
    String(d.getMonth()+1).padStart(2,'0'),
    d.getFullYear(),
  ].join('/');
}

function parseAmazonCsv(buf) {
  let text = buf.toString('utf-8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // Remove BOM
  // Fallback: try latin-1 if utf-8 looks wrong
  if (!text.includes('\t') && !text.includes(',')) {
    text = buf.toString('latin1');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  }

  const lines = text.split(/\r?\n/);
  if (lines.length < 9) throw new Error(`CSV troppo corto (${lines.length} righe).`);

  const hLine = lines[7];
  // Detect separator: tab > semicolon > comma
  const sep = hLine.includes('\t') ? '\t'
            : hLine.includes(';')  ? ';'
            : ',';

  const rawHeaders = parseCsvLine(hLine, sep).map(h => h.trim());

  // Case-insensitive index lookup: lowercase_name -> column_index
  const hIdx = {};
  rawHeaders.forEach((h, i) => { hIdx[h.toLowerCase()] = i; });

  // Resolve column index: try canonical name first, then aliases
  function resolveIdx(name) {
    const direct = hIdx[name.toLowerCase()];
    if (direct !== undefined) return direct;
    const aliases = COL_ALIASES[name.toLowerCase()] || [];
    for (const a of aliases) {
      const idx = hIdx[a.toLowerCase()];
      if (idx !== undefined) return idx;
    }
    return undefined;
  }

  // Build final index map for NUMERIC_COLS once
  const numIdx = {};
  const colResolved = {}; // canonical -> actual header name (for debug)
  NUMERIC_COLS.forEach(c => {
    const idx = resolveIdx(c);
    numIdx[c] = idx;
    colResolved[c] = idx !== undefined ? rawHeaders[idx] : null;
  });

  // Get raw string value from a row by column name (case-insensitive + aliases)
  function col(vals, name) {
    const i = resolveIdx(name);
    return i !== undefined ? (vals[i] ?? '').trim().replace(/^"(.*)"$/, '$1') : '';
  }

  const rows = [];

  for (let i = 8; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCsvLine(lines[i], sep);

    const row = {};

    // Store all raw values by original header (for transactions table)
    rawHeaders.forEach((h, j) => { row[h] = (vals[j] ?? '').trim().replace(/^"(.*)"$/, '$1'); });

    // Parse numeric columns case-insensitively
    NUMERIC_COLS.forEach(c => { row[c] = parseItNum(col(vals, c)); });

    // Key text columns (case-insensitive lookup, stored under canonical name)
    row['Tipo']             = col(vals, 'Tipo');
    row['Descrizione']      = col(vals, 'Descrizione');
    row['Numero ordine']    = col(vals, 'Numero ordine');
    row['Numero pagamento'] = String(col(vals, 'Numero pagamento')).split('.')[0].trim();

    // Date — Amazon Italy CSV uses "Data/Ora"; fall back to plain "Data" / "Date"
    const dateVal = col(vals, 'Data/Ora') || col(vals, 'Data') || col(vals, 'Date');
    row._date    = parseItDate(dateVal);
    row._dateStr = dateVal;

    rows.push(row);
  }

  // Detect marketplaces from metadata lines (0-6, before data headers)
  const metaText = lines.slice(0, 7).join('\n');
  const mktRe    = /amazon\.(it|es|de|fr|co\.uk|nl|se|pl|be)/gi;
  const mktFound = new Set();
  let mktM;
  while ((mktM = mktRe.exec(metaText)) !== null) {
    mktFound.add('amazon.' + mktM[1].toLowerCase());
  }
  rows._marketplaces = [...mktFound];

  // Attach debug info on the array itself (useful for troubleshooting)
  rows._headers     = rawHeaders;
  rows._sep         = sep;
  rows._colResolved = colResolved; // canonical -> actual CSV header
  rows._firstRow    = rows[0] ? JSON.stringify(rows[0]).slice(0, 300) : '';

  return rows;
}

// ── PDF parsing ──────────────────────────────────────────────────────────────

async function parsePdfSummary(buf) {
  const { text } = await pdfParse(buf);
  if (!text.trim()) return null;

  const lines  = text.split('\n');
  const result = {};

  // ── Find the "Sintesi" section of the Amazon Italy "Rendiconto pagamenti" PDF.
  // The table has exactly 4 rows (pdfParse may put each row on one line or spread to 2):
  //   Ricavi        Vendite, accrediti e rimborsi          1.548,61
  //   Spese         Costi inclusivi di abbonamento ...    -1.381,55
  //   Imposte       Imposte nette da versare                 377,91
  //   Trasferimenti Versamenti e prelievi                   -177,87
  //
  // Strategy: locate the "Sintesi" header (first 30 lines), then scan the next
  // 60 lines for rows whose trimmed text starts with one of the 4 keywords.
  // Take the LAST Italian-format number (NNN.NNN,NN) on that line or the next 2.

  let startLine = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (/sintesi/i.test(lines[i])) { startLine = i; break; }
  }
  const window = lines.slice(startLine, startLine + 60);

  function lastItNum(line) {
    const nums = line.match(/[+-]?\s*[\d]+(?:\.[\d]{3})*,\d{2}/g);
    if (!nums || !nums.length) return null;
    return parseItNum(nums[nums.length - 1].replace(/\s/g, ''));
  }

  const searchConf = [
    { key: 'ricavi',        pats: [/^ricavi\b/i,        /^vendite.*accrediti/i]        },
    { key: 'spese',         pats: [/^spese\b/i,         /^costi.*inclusivi/i]          },
    { key: 'imposte',       pats: [/^imposte\b/i,       /^imposte.*nette/i]            },
    { key: 'trasferimenti', pats: [/^trasferimenti\b/i, /^versamenti.*prelievi/i]      },
  ];

  for (const { key, pats } of searchConf) {
    for (let li = 0; li < window.length; li++) {
      if (!pats.some(p => p.test(window[li].trim()))) continue;
      // Look for a number on this line or the next 2
      for (let j = li; j < Math.min(li + 3, window.length); j++) {
        const val = lastItNum(window[j]);
        if (val !== null) { result[key] = val; break; }
      }
      if (key in result) break;
    }
  }

  // ── Fallback: keyword scan across the full document (older PDF layouts).
  const fallbackConf = [
    { key: 'ricavi',        pats: [/ricavi.*vendite/i, /vendite.*accrediti.*rimborsi/i], skipNeg: true },
    { key: 'spese',         pats: [/spese totali/i, /totale.*spese/i, /costi.*inclusivi/i] },
    { key: 'imposte',       pats: [/imposte.*nette/i] },
    { key: 'trasferimenti', pats: [/versamenti.*prelievi/i, /trasferimento.*bancario/i,
                                   /bonifico.*bancario/i] },
  ];
  for (const { key, pats, skipNeg } of fallbackConf) {
    if (key in result) continue;
    for (const pat of pats) {
      for (let li = 0; li < lines.length; li++) {
        if (!pat.test(lines[li])) continue;
        for (let j = li; j < Math.min(li + 3, lines.length); j++) {
          const val = lastItNum(lines[j]);
          if (val !== null) {
            if (skipNeg && val <= 0) continue;
            result[key] = val;
            break;
          }
        }
        if (key in result) break;
      }
      if (key in result) break;
    }
  }

  const numKeys = ['ricavi', 'spese', 'imposte', 'trasferimenti'];
  numKeys.forEach(k => { result[k] ??= null; });

  result._pdfTextSample = text;

  return numKeys.every(k => result[k] === null) ? null : result;
}

async function parsePdfAds(buf) {
  const { text } = await pdfParse(buf);
  const patterns = [
    /Italy\s+Subtotal[^\n]*?[\d,]*\.?\d+\s+USD\s*\/\s*([\d,]+\.?\d*)\s+EUR/i,
    /Italy[^\n]*Total[^\n]*?[\d,]*\.?\d+\s+USD\s*\/\s*([\d,]+\.?\d*)\s+EUR/i,
    /Total\s+Invoice\s+Amount[^\n]*?([\d,]+\.?\d*)\s+EUR/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) { const v = parseFloat(m[1].replace(/,/g,'')); if (!isNaN(v)) return -Math.abs(v); }
  }
  return null;
}

// ── 4 Checks ─────────────────────────────────────────────────────────────────

function computeChecks(rows, pdfSum, pdfAdsEur) {
  const nonTr  = rows.filter(r => r['Tipo'] !== 'Trasferimento');
  const trRows = rows.filter(r => r['Tipo'] === 'Trasferimento');

  const ricaviCsv  = round2(sumCol(rows, 'Vendite'));
  const imposteCsv = round2(sumCol(rows, 'imposta sulle vendite dei prodotti'));
  const speseCsv   = round2(
    sumCol(rows,  'Commissioni di vendita') +
    sumCol(rows,  'Altri costi relativi alle transazioni') +
    sumCol(nonTr, 'Altro')
  );
  const trasfCsv = round2(sumCol(trRows, 'totale'));
  const adsRows  = rows.filter(r => String(r['Descrizione']||'').trim() === 'Costo della pubblicità');
  const adsCsv   = round2(sumCol(adsRows, 'totale'));

  const d1 = pdfSum.ricavi         !== null ? round2(ricaviCsv  - pdfSum.ricavi)         : null;
  const d2 = pdfSum.spese          !== null ? round2(speseCsv   - pdfSum.spese)          : null;
  const d3 = pdfSum.imposte        !== null ? round2(imposteCsv - pdfSum.imposte)        : null;
  const d4 = pdfSum.trasferimenti  !== null ? round2(trasfCsv   - pdfSum.trasferimenti)  : null;
  const d5 = pdfAdsEur             !== null ? round2(adsCsv     - pdfAdsEur)             : null;

  return {
    ricavi:        { csv: ricaviCsv,  pdf: pdfSum.ricavi,        differenza: d1, pass: d1 !== null ? Math.abs(d1) <= 0.05 : null },
    spese:         { csv: speseCsv,   pdf: pdfSum.spese,         differenza: d2, pass: d2 !== null ? Math.abs(d2) <= 0.05 : null },
    imposte:       { csv: imposteCsv, pdf: pdfSum.imposte,       differenza: d3, pass: d3 !== null ? Math.abs(d3) <= 0.05 : null },
    trasferimenti: {
      csv: trasfCsv, pdf: pdfSum.trasferimenti, differenza: d4,
      pass: d4 !== null ? Math.abs(d4) <= 0.05 : false,
      dettaglio: trRows.map(r => ({ data: r._dateStr || '', importo: round2(r.totale || 0) })),
    },
    ads: {
      csv: adsCsv, pdf: pdfAdsEur, differenza: d5,
      pass: d5 !== null ? Math.abs(d5) <= 1.00 : null,
      disponibile: pdfAdsEur !== null,
    },
  };
}

// ── Settlement periods ────────────────────────────────────────────────────────

function computePeriods(targetRows, prevRows, nextRows) {
  const all = [
    ...(prevRows  || []).map(r => ({ ...r, _src: 'prev'   })),
    ...targetRows.map(r => ({ ...r, _src: 'target' })),
    ...(nextRows  || []).map(r => ({ ...r, _src: 'next'   })),
  ];

  if (!all.length || !('Numero pagamento' in all[0])) return [];

  const map = {};
  for (const row of all) {
    const pid = String(row['Numero pagamento'] || '').trim();
    if (!pid || pid === 'nan' || pid === '0') continue;

    const isTr = String(row['Tipo'] || '').trim() === 'Trasferimento';
    if (!map[pid]) {
      map[pid] = {
        periodo_id: pid, dates: [],
        tx_sum: 0, vendite: 0, iva: 0, commissioni: 0, altri_costi: 0, altro_sum: 0,
        transfer_amount: null, transfer_date: null, transfer_src: null,
        n_transazioni: 0, first_src: row._src,
      };
    }
    if (row._date) map[pid].dates.push(row._date);
    if (isTr) {
      map[pid].transfer_amount = round2(row.totale || 0);
      map[pid].transfer_date   = row._date;
      map[pid].transfer_src    = row._src;
    } else {
      map[pid].tx_sum      = round2(map[pid].tx_sum      + (row.totale || 0));
      map[pid].vendite     += (row['Vendite'] || 0);
      map[pid].iva         += (row['imposta sulle vendite dei prodotti'] || 0);
      map[pid].commissioni += (row['Commissioni di vendita'] || 0);
      map[pid].altri_costi += (row['Altri costi relativi alle transazioni'] || 0);
      map[pid].altro_sum   += (row['Altro'] || 0);
      map[pid].n_transazioni++;
    }
  }

  // ── Reassign transfers to the period they actually CLOSE.
  // A "Trasferimento" row is recorded in period[i] but it closes period[i-1].
  // Example: transfer in period 26305968902 → closes period 26216940642 (the previous one).
  const sorted = Object.values(map).sort((a, b) => {
    const aMin = a.dates.length ? Math.min(...a.dates.map(d => d.getTime())) : Infinity;
    const bMin = b.dates.length ? Math.min(...b.dates.map(d => d.getTime())) : Infinity;
    return aMin - bMin;
  });

  // Snapshot original transfer values before any mutation
  const origTransfers = sorted.map(p => ({
    amount: p.transfer_amount,
    date:   p.transfer_date,
    src:    p.transfer_src,
  }));

  // Reset all transfers, then reassign: transfer[i] → closes sorted[i-1]
  sorted.forEach(p => { p.transfer_amount = null; p.transfer_date = null; p.transfer_src = null; });
  for (let i = 1; i < sorted.length; i++) {
    if (origTransfers[i].amount !== null) {
      sorted[i - 1].transfer_amount = origTransfers[i].amount;
      sorted[i - 1].transfer_date   = origTransfers[i].date;
      sorted[i - 1].transfer_src    = origTransfers[i].src;
    }
  }

  return sorted.map(p => {
      const ds   = p.dates;
      const dMin = ds.length ? new Date(Math.min(...ds.map(d => d.getTime()))) : null;
      const dMax = ds.length ? new Date(Math.max(...ds.map(d => d.getTime()))) : null;
      const tx   = round2(p.tx_sum);
      const ta   = p.transfer_amount;
      return {
        periodo_id:      p.periodo_id,
        data_inizio:     fmtDate(dMin),
        data_fine:       fmtDate(dMax),
        n_transazioni:   p.n_transazioni,
        tx_sum:          tx,
        vendite_nette:   round2(p.vendite),
        iva_vendite:     round2(p.iva),
        spese_nette:     round2(p.commissioni + p.altri_costi + p.altro_sum),
        transfer_amount: ta,
        transfer_date:   ta !== null && p.transfer_date ? fmtDate(p.transfer_date) : '',
        transfer_src:    p.transfer_src,
        differenza:      ta !== null ? round2(tx + ta) : null,
        note:            p.first_src === 'prev' ? 'Aperto nel mese precedente' : ta === null ? 'Si chiude nel mese successivo' : '',
      };
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sumCol(rows, col) { return rows.reduce((acc, r) => acc + (r[col] || 0), 0); }
function round2(v)         { return Math.round(v * 100) / 100; }

function getPeriodLabel(meseTarget) {
  const MESI_NUMS = {
    Gennaio:1, Febbraio:2, Marzo:3, Aprile:4, Maggio:5, Giugno:6,
    Luglio:7, Agosto:8, Settembre:9, Ottobre:10, Novembre:11, Dicembre:12,
  };
  const parts = meseTarget.split(' ');
  if (parts.length < 2) return meseTarget;
  const m = MESI_NUMS[parts[0]];
  const y = parseInt(parts[1]);
  if (!m || !y) return meseTarget;
  const lastDay = new Date(y, m, 0).getDate();
  const pad = n => String(n).padStart(2, '0');
  return `${pad(1)}/${pad(m)}/${y} – ${pad(lastDay)}/${pad(m)}/${y}`;
}

function getMonthLabel(rows) {
  const counts = {};
  for (const r of rows) {
    if (r._date) { const k = `${r._date.getFullYear()}-${r._date.getMonth()+1}`; counts[k] = (counts[k]||0)+1; }
  }
  if (!Object.keys(counts).length) return 'Mese target';
  const [year, month] = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0].split('-').map(Number);
  return `${MESI_NOMI[month]} ${year}`;
}

function buildSaldoExp(saldo, open) {
  if (Math.abs(saldo) < 0.10) return 'Saldo su conto Amazon sostanzialmente zero: tutti i pagamenti del mese sono stati trasferiti.';
  let s = `A fine mese rimangono ${saldo.toFixed(2)}€ ancora sul conto Amazon (non ancora trasferiti). Questo è normale.`;
  for (const p of open) s += ` Il periodo ${p.periodo_id} si chiude il mese successivo: il bonifico di ${p.tx_sum.toFixed(2)}€ è atteso.`;
  return s;
}

function jsonResp(data, status = 200) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(data) };
}
function errResp(msg, status = 400) { return jsonResp({ error: msg }, status); }
