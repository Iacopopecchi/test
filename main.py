"""
Amazon Seller Central Payment Reconciliation Dashboard
FastAPI backend — serves the UI and exposes REST endpoints.
"""

import json
import sys
import os
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

# Allow imports from project root
sys.path.insert(0, os.path.dirname(__file__))

from reconciler.engine import (
    ReconciliationResult,
    SettlementPeriod,
    SummaryComparison,
    AdsVerification,
    reconcile,
)

app = FastAPI(
    title="Amazon Reconciliation Dashboard",
    description="Riconciliazione pagamenti Amazon Seller Central",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = os.path.join(os.path.dirname(__file__), "static")


# ─────────────────────────────────────────────────────────────────────────────
# Helper serializers
# ─────────────────────────────────────────────────────────────────────────────

def _fmt_eur(value: Optional[float]) -> Optional[str]:
    if value is None:
        return None
    sign = "+" if value >= 0 else ""
    return f"{sign}{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _dt_str(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.strftime("%d/%m/%Y")


def _serialize_period(p: SettlementPeriod) -> dict:
    return {
        "period_id": p.period_id,
        "date_start": _dt_str(p.date_start),
        "date_end": _dt_str(p.date_end),
        "transfer_amount": p.transfer_amount,
        "transfer_amount_fmt": _fmt_eur(-p.transfer_amount),
        "sum_transactions": p.sum_transactions,
        "sum_transactions_fmt": _fmt_eur(p.sum_transactions),
        "difference": p.difference,
        "difference_fmt": _fmt_eur(p.difference),
        "status": p.status,
        "belongs_to_target_month": p.belongs_to_target_month,
        "transaction_count": p.transaction_count,
        "transfer_row_count": p.transfer_row_count,
    }


def _serialize_comparison(c: SummaryComparison) -> dict:
    return {
        "label": c.label,
        "csv_value": c.csv_value,
        "csv_value_fmt": _fmt_eur(c.csv_value),
        "pdf_value": c.pdf_value,
        "pdf_value_fmt": _fmt_eur(c.pdf_value),
        "difference": c.difference,
        "difference_fmt": _fmt_eur(c.difference) if c.difference is not None else "N/D",
        "status": c.status,
    }


def _serialize_ads(ads: Optional[AdsVerification]) -> Optional[dict]:
    if ads is None:
        return None
    return {
        "csv_amount": ads.csv_amount,
        "csv_amount_fmt": _fmt_eur(ads.csv_amount),
        "invoice_amount": ads.invoice_amount,
        "invoice_amount_fmt": _fmt_eur(ads.invoice_amount),
        "difference": ads.difference,
        "difference_fmt": _fmt_eur(ads.difference) if ads.difference is not None else "N/D",
        "status": ads.status,
        "invoice_ids": ads.invoice_ids,
    }


def _serialize_transactions(result: ReconciliationResult) -> List[dict]:
    """Convert the transactions DataFrame to a JSON-serializable list."""
    if result.transactions_df is None or result.transactions_df.empty:
        return []

    df = result.transactions_df
    target_period_ids = {
        p.period_id for p in result.settlement_periods if p.belongs_to_target_month
    }

    rows = []
    for _, row in df.iterrows():
        period_id = str(row.get("numero_pagamento", "")) if row.get("numero_pagamento") else ""
        in_target = period_id in target_period_ids

        rows.append({
            "data_ora": str(row.get("data_ora", "")),
            "tipo": str(row.get("tipo", "")),
            "numero_ordine": str(row.get("numero_ordine", "")),
            "sku": str(row.get("sku", "")),
            "descrizione": str(row.get("descrizione", "")),
            "marketplace": str(row.get("marketplace", "")),
            "numero_pagamento": period_id,
            "vendite": row.get("vendite_num"),
            "commissioni": row.get("commissioni_vendita_num"),
            "costi_fba": row.get("costi_fba_num"),
            "altro": row.get("altro_num"),
            "totale": row.get("totale_num"),
            "in_target_period": in_target,
            "source_file": str(row.get("_source_file", "")),
        })
    return rows


def _build_response(result: ReconciliationResult) -> dict:
    """Build the full JSON response for the dashboard."""
    return {
        "target_month": result.target_month,
        "target_year": result.target_year,
        "target_month_name": result.target_month_name,
        "overall_status": result.overall_status,
        "errors": result.errors,
        "warnings": result.warnings,

        # Step 3: Monthly totals
        "totals": {
            "revenues": result.total_revenues,
            "revenues_fmt": _fmt_eur(result.total_revenues),
            "expenses": result.total_expenses,
            "expenses_fmt": _fmt_eur(result.total_expenses),
            "taxes": result.total_taxes,
            "taxes_fmt": _fmt_eur(result.total_taxes),
            "transfers": result.total_transfers,
            "transfers_fmt": _fmt_eur(result.total_transfers),
            "net_balance": result.net_balance,
            "net_balance_fmt": _fmt_eur(result.net_balance),
            "amazon_balance_variation": result.amazon_balance_variation,
            "amazon_balance_variation_fmt": _fmt_eur(result.amazon_balance_variation),
        },

        # Step 1-2: Settlement periods
        "settlement_periods": [_serialize_period(p) for p in result.settlement_periods],
        "settlement_periods_target": [
            _serialize_period(p) for p in result.settlement_periods
            if p.belongs_to_target_month
        ],

        # Step 4: PDF Summary comparison
        "pdf_summary_available": result.pdf_summary_available,
        "summary_comparisons": [_serialize_comparison(c) for c in result.summary_comparisons],

        # Step 5: ADS
        "ads_pdf_available": result.ads_pdf_available,
        "ads_verification": _serialize_ads(result.ads_verification),

        # Transactions
        "transactions": _serialize_transactions(result),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────


@app.post("/api/reconcile")
async def api_reconcile(
    target_year: int = Form(...),
    target_month: int = Form(...),
    csv_files: List[UploadFile] = File(default=[]),
    pdf_summary_files: List[UploadFile] = File(default=[]),
    pdf_ads_files: List[UploadFile] = File(default=[]),
):
    """
    Main reconciliation endpoint.

    Accepts multipart form data with:
    - target_year, target_month: the period to reconcile
    - csv_files: one or more Amazon monthly transaction CSVs
    - pdf_summary_files: one or more Amazon monthly summary PDFs
    - pdf_ads_files: one or more Amazon ADS billing PDFs
    """
    if not csv_files or all(f.filename == "" for f in csv_files):
        raise HTTPException(status_code=400, detail="Almeno un file CSV è obbligatorio.")

    if target_month < 1 or target_month > 12:
        raise HTTPException(status_code=400, detail="Mese non valido (1-12).")

    # Read all uploaded files
    csv_data = {}
    for f in csv_files:
        if f.filename:
            csv_data[f.filename] = await f.read()

    pdf_summary_data = {}
    for f in pdf_summary_files:
        if f.filename:
            pdf_summary_data[f.filename] = await f.read()

    pdf_ads_data = {}
    for f in pdf_ads_files:
        if f.filename:
            pdf_ads_data[f.filename] = await f.read()

    try:
        result = reconcile(
            csv_files=csv_data,
            pdf_summary_files=pdf_summary_data,
            pdf_ads_files=pdf_ads_data,
            target_year=target_year,
            target_month=target_month,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Errore interno: {str(e)}")

    return JSONResponse(content=_build_response(result))


@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


# Static files mounted LAST so API routes take priority.
# Serves /, /style.css, /app.js, /dashboard (html=True handles directory index).
app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
