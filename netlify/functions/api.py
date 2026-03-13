"""
Netlify Function — Amazon Reconciliation API
Wraps the FastAPI app with Mangum to run as an AWS Lambda / Netlify Function.

Routes exposed (called via /api/* redirect in netlify.toml):
  POST /api/reconcile   — main reconciliation endpoint
  GET  /api/health      — health check
"""

import sys
import os

# Add amazon-reconciliation root to path so parser/ and reconciler/ are importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from typing import List

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mangum import Mangum

from reconciler.engine import (
    AdsVerification,
    ReconciliationResult,
    SettlementPeriod,
    SummaryComparison,
    reconcile,
)

# ── App ───────────────────────────────────────────────────────────────────────

app = FastAPI(title="Amazon Reconciliation API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Serializers (same as main.py) ─────────────────────────────────────────────

from datetime import datetime


def _fmt_eur(value):
    if value is None:
        return None
    sign = "+" if value >= 0 else ""
    return f"{sign}{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _dt_str(dt):
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


def _serialize_ads(ads):
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


def _serialize_transactions(result: ReconciliationResult) -> list:
    if result.transactions_df is None or result.transactions_df.empty:
        return []
    target_period_ids = {
        p.period_id for p in result.settlement_periods if p.belongs_to_target_month
    }
    rows = []
    for _, row in result.transactions_df.iterrows():
        period_id = str(row.get("numero_pagamento", "")) if row.get("numero_pagamento") else ""
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
            "in_target_period": period_id in target_period_ids,
            "source_file": str(row.get("_source_file", "")),
        })
    return rows


def _build_response(result: ReconciliationResult) -> dict:
    t = result.totals if hasattr(result, "totals") else {}
    totals = {
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
    }
    return {
        "target_month": result.target_month,
        "target_year": result.target_year,
        "target_month_name": result.target_month_name,
        "overall_status": result.overall_status,
        "errors": result.errors,
        "warnings": result.warnings,
        "totals": totals,
        "settlement_periods": [_serialize_period(p) for p in result.settlement_periods],
        "settlement_periods_target": [
            _serialize_period(p) for p in result.settlement_periods
            if p.belongs_to_target_month
        ],
        "pdf_summary_available": result.pdf_summary_available,
        "summary_comparisons": [_serialize_comparison(c) for c in result.summary_comparisons],
        "ads_pdf_available": result.ads_pdf_available,
        "ads_verification": _serialize_ads(result.ads_verification),
        "transactions": _serialize_transactions(result),
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/api/reconcile")
async def api_reconcile(
    target_year: int = Form(...),
    target_month: int = Form(...),
    csv_files: List[UploadFile] = File(default=[]),
    pdf_summary_files: List[UploadFile] = File(default=[]),
    pdf_ads_files: List[UploadFile] = File(default=[]),
):
    if not csv_files or all(f.filename == "" for f in csv_files):
        raise HTTPException(status_code=400, detail="Almeno un file CSV è obbligatorio.")
    if target_month < 1 or target_month > 12:
        raise HTTPException(status_code=400, detail="Mese non valido (1-12).")

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


# ── Mangum handler (entry point for Netlify / Lambda) ─────────────────────────

handler = Mangum(app, lifespan="off")
