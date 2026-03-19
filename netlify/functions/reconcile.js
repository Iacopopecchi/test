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
    const imposte = pdfSum.imposte || 0;
    const saldo   = round2(ricavi + imposte + spese + trasf);

    const passList = [checks.ricavi.pass, checks.spese.pass, checks.trasferimenti.pass];
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

    const txCols = [
      '_dateStr','Tipo','Numero pagamento','Numero ordine','Descrizione',
      'Vendite','Commissioni di vendita','Altri costi relativi alle transazioni','Altro','totale',
    ];
    const transazioni = targetRows.map(row => {
      const rec = {};
      txCols.forEach(c => { rec[c === '_dateStr' ? 'Data' : c] = row[c] ?? ''; });
      return rec;
    });

    return jsonResp({
      mese_target:    meseTarget,
      status_globale: statusGlobale,
      warnings,
      _debug: {
        csv_headers:      targetRows._headers     || [],
        csv_separator:    targetRows._sep         || '?',
        csv_row_count:    targetRows.length,
        csv_col_resolved: targetRows._colResolved || {},
        csv_first_row:    targetRows._firstRow    || '',
        pdf_keys_found:   Object.entries(pdfSum).filter(([k,v]) => !k.startsWith('_') && v !== null).map(([k]) => k),
        pdf_raw_values:   { ricavi: pdfSum.ricavi, spese: pdfSum.spese, imposte: pdfSum.imposte, trasferimenti: pdfSum.trasferimenti },
        pdf_text_sample:  pdfSum._pdfTextSample || '',
      },
      checks,
      saldo_residuo: {
        importo:       saldo,
        ricavi:        round2(ricavi),
        imposte:       round2(imposte),
        spese:         round2(spese),
        trasferimenti: round2(trasf),
        spiegazione:   buildSaldoExp(saldo, openPeriods),
      },
      settlement_periods: periods,
      pdf_summary_raw:    pdfSum,
      transazioni,
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

  const result = {};
  const lines  = text.split('\n');

  // ── Strategy 1: look for the Amazon Italy "Rendiconto" summary table.
  // pdfParse often linearises the 4-column table as a run of numbers on one line,
  // preceded by a label like "Totale" or found after "Sintesi".
  // Pattern we look for in the full text: positive_big  0_or_more  negative
  // Capture the first large positive (= gross ricavi) and last value (= net transfer).
  const summaryRe = /([\d]{1,3}(?:\.\d{3})*,\d{2})\s+(?:[\d.,]+\s+){0,3}(-[\d]{1,3}(?:\.\d{3})*,\d{2})/;
  const summaryMatch = text.match(summaryRe);
  if (summaryMatch) {
    const r = parseItNum(summaryMatch[1]);
    const t = parseItNum(summaryMatch[2]);
    if (r > 0)  result.ricavi        = r;
    if (t < 0)  result.trasferimenti = t;
  }

  // ── Strategy 2: keyword-based line search for remaining fields.
  const keywords = {
    ricavi:        ['ricavi totali', 'ricavi delle vendite', 'ricavi', 'vendite.*accrediti'],
    spese:         ['spese totali', 'totale spese', 'totale addebiti', 'spese', 'costi.*inclusivi'],
    imposte:       ['imposte.*nette', 'imposte'],
    trasferimenti: ['trasferimento bancario', 'bonifico bancario', 'trasferimento totale',
                    'versamenti.*prelievi', 'trasferimenti'],
  };

  // Lines to skip for each key (false-positive guards)
  const skipLine = {
    ricavi:        [/rimborsi?\s+per/i, /accrediti\s+per/i, /credito/i],
    spese:         [],
    imposte:       [],
    trasferimenti: [/non\s+riusciti/i, /mancati/i],
  };

  function extractFromWindow(startIdx, key) {
    let best = null;
    const skip = skipLine[key] || [];
    for (let j = startIdx; j < Math.min(startIdx + 3, lines.length); j++) {
      if (skip.some(p => p.test(lines[j]))) continue;
      const nums = lines[j].match(/[+-]?\s*[\d.,]+/g) || [];
      for (let k = nums.length - 1; k >= 0; k--) {
        const n = nums[k].replace(/\s/g, '');
        if (n.includes(',') || n.length > 3) {
          const val = parseItNum(n);
          if (best === null || Math.abs(val) > Math.abs(best)) best = val;
          break;
        }
      }
    }
    // Ricavi must be positive (they are credits, not charges)
    if (key === 'ricavi' && best !== null && best <= 0) return null;
    return best;
  }

  for (const [key, kwList] of Object.entries(keywords)) {
    if (key in result) continue; // already set by strategy 1
    for (const kw of kwList) {
      const re   = new RegExp(kw, 'i');
      const skip = skipLine[key] || [];
      for (let li = 0; li < lines.length; li++) {
        if (!re.test(lines[li])) continue;
        if (skip.some(p => p.test(lines[li]))) continue;
        const val = extractFromWindow(li, key);
        if (val !== null) { result[key] = val; break; }
      }
      if (key in result) break;
    }
  }

  const numKeys = ['ricavi','spese','imposte','trasferimenti'];
  numKeys.forEach(k => { result[k] ??= null; });

  // Full text for debug (helps diagnose PDF format issues)
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
  const nonTr = rows.filter(r => r['Tipo'] !== 'Trasferimento');
  const trRows = rows.filter(r => r['Tipo'] === 'Trasferimento');

  const ricaviCsv = round2(sumCol(rows, 'Vendite'));
  const speseCsv  = round2(
    sumCol(rows,  'Commissioni di vendita') +
    sumCol(rows,  'Altri costi relativi alle transazioni') +
    sumCol(nonTr, 'Altro')
  );
  const trasfCsv  = round2(sumCol(trRows, 'totale'));
  const adsRows   = rows.filter(r => String(r['Descrizione']||'').trim() === 'Costo della pubblicità');
  const adsCsv    = round2(sumCol(adsRows, 'totale'));

  const d1 = null; // Ricavi PDF non confrontabile (PDF mostra lordo, CSV netto)
  const d2 = null; // Spese PDF non estraibili da questo formato PDF
  const d3 = pdfSum.trasferimenti !== null ? round2(trasfCsv  - pdfSum.trasferimenti) : null;
  const d4 = pdfAdsEur            !== null ? round2(adsCsv    - pdfAdsEur)            : null;

  return {
    ricavi:        { csv: ricaviCsv, pdf: null, differenza: null, pass: null },
    spese:         { csv: speseCsv,  pdf: null, differenza: null, pass: null },
    trasferimenti: {
      csv: trasfCsv, pdf: pdfSum.trasferimenti, differenza: d3,
      pass: d3 !== null ? Math.abs(d3) <= 0.05 : false,
      dettaglio: trRows.map(r => ({ data: r._dateStr || '', importo: round2(r.totale || 0) })),
    },
    ads: {
      csv: adsCsv, pdf: pdfAdsEur, differenza: d4,
      pass: d4 !== null ? Math.abs(d4) <= 1.00 : null,
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
      map[pid] = { periodo_id: pid, dates: [], tx_sum: 0, transfer_amount: null, transfer_date: null, n_transazioni: 0, first_src: row._src };
    }
    if (row._date) map[pid].dates.push(row._date);
    if (isTr) { map[pid].transfer_amount = round2(row.totale || 0); map[pid].transfer_date = row._date; }
    else       { map[pid].tx_sum = round2(map[pid].tx_sum + (row.totale || 0)); map[pid].n_transazioni++; }
  }

  return Object.values(map)
    .sort((a, b) => {
      const aMin = a.dates.length ? Math.min(...a.dates.map(d => d.getTime())) : Infinity;
      const bMin = b.dates.length ? Math.min(...b.dates.map(d => d.getTime())) : Infinity;
      return aMin - bMin;
    })
    .map(p => {
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
        transfer_amount: ta,
        transfer_date:   ta !== null && p.transfer_date ? fmtDate(p.transfer_date) : '',
        differenza:      ta !== null ? round2(tx + ta) : null,
        note:            p.first_src === 'prev' ? 'Aperto nel mese precedente' : ta === null ? 'Si chiude nel mese successivo' : '',
      };
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sumCol(rows, col) { return rows.reduce((acc, r) => acc + (r[col] || 0), 0); }
function round2(v)         { return Math.round(v * 100) / 100; }

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
