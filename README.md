# Amazon Seller Central — Dashboard di Riconciliazione Pagamenti

Web app interattiva per riconciliare i pagamenti Amazon Seller Central per un determinato mese, gestendo correttamente i settlement period a cavallo dei confini mensili.

---

## Installazione e avvio

```bash
# 1. Installa le dipendenze
pip install -r requirements.txt

# 2. Avvia il server
uvicorn main:app --reload --port 8000

# 3. Apri il browser
open http://localhost:8000
```

---

## Come scaricare i file da Amazon Seller Central

### CSV Transazioni mensili
**Percorso:** Seller Central → Report → Pagamenti → Archivio Report

1. Accedi ad [Amazon Seller Central](https://sellercentral.amazon.it)
2. Menu → **Report** → **Pagamenti**
3. Clicca su **Archivio Report**
4. Nella colonna "Tipo" seleziona **Transazione**
5. Seleziona il mese e scarica il file `.csv`
6. Ripeti per **mese X-1**, **mese X**, e **mese X+1**

> **Nome file esempio:** `2026JanMonthlyTransaction.csv`

---

### PDF Riepilogo mensile
**Percorso:** Seller Central → Report → Pagamenti → Archivio Report

1. Stessa sezione del CSV (Archivio Report)
2. Nella colonna "Tipo" seleziona **Riepilogo**
3. Scarica il PDF per il mese target

> **Nome file esempio:** `2026JanMonthlySummary.pdf`

---

### PDF Fatture ADS (Amazon Advertising)
**Percorso:** Seller Central → Amministrazione → Fatturazione → Estratto Conto

1. Menu → **Amministrazione** → **Fatturazione**
   oppure vai su [advertising.amazon.it](https://advertising.amazon.it)
2. Sezione **Estratto Conto** o **Billing**
3. Seleziona il mese e scarica il file PDF (Global Billing Statement)

> **Nome file esempio:** `monthly_statement_2026_01_Italy.pdf`

---

## Struttura del progetto

```
amazon-reconciliation/
├── main.py                    # FastAPI app + REST endpoints
├── requirements.txt
├── parser/
│   ├── __init__.py
│   ├── csv_parser.py          # Parsing CSV transazioni Amazon
│   ├── pdf_summary.py         # Parsing PDF Riepilogo mensile
│   └── pdf_ads.py             # Parsing PDF fatture ADS
├── reconciler/
│   ├── __init__.py
│   └── engine.py              # Logica di riconciliazione (5 step)
└── static/
    ├── index.html             # Pagina upload
    ├── dashboard.html         # Dashboard risultati
    ├── style.css
    └── app.js
```

---

## Logica di riconciliazione

L'app implementa 5 step:

| Step | Descrizione |
|------|-------------|
| **1** | Identificazione dei settlement period che appartengono al mese target |
| **2** | Verifica per ogni periodo: somma transazioni ≈ trasferimento |
| **3** | Calcolo totali mensili (ricavi, spese, imposte, trasferimenti) |
| **4** | Confronto con il PDF Riepilogo (se caricato) |
| **5** | Verifica costi ADS con la fattura (se caricata) |

### Perché caricare 3 mesi di CSV?

Amazon paga ogni ~15 giorni. I settlement period non coincidono con i mesi di calendario:

- Un periodo aperto a fine dicembre può chiudersi a metà gennaio → il trasferimento arriva a gennaio ma include transazioni di dicembre
- Un periodo aperto a metà gennaio può chiudersi a inizio febbraio → include transazioni di gennaio ma il trasferimento arriva a febbraio

Caricando i CSV di X-1, X e X+1 ci si assicura di avere tutte le transazioni dei periodi rilevanti.

---

## Tolleranze

| Tipo di verifica | Tolleranza |
|-----------------|------------|
| Settlement period balance | ±0,05 EUR |
| Confronto CSV vs PDF Summary | ±0,05 EUR |
| Verifica ADS (cambio USD/EUR) | ±1,00 EUR |

---

## Formato CSV supportato

- **Encoding:** UTF-8 con BOM (`utf-8-sig`)
- **Separatore decimale:** virgola (formato italiano)
- **Formato data:** `31 dic 2025 23:31:10 UTC`
- **Header:** prime 7 righe da saltare, riga 8 = intestazioni colonne
