"""
Reconciliation engine for Amazon Seller Central payment reconciliation.

Implements 4 checks:
1. RICAVI   — sum of ALL "Vendite" rows in CSV vs PDF Summary
2. SPESE    — sum of commissioni + altri_costi + altro (non-transfer rows) vs PDF Summary
3. PAGAMENTI — sum of totale for Tipo=Trasferimento rows vs PDF Summary
4. ADS      — sum of totale for Tipo=Commissione di servizio + Desc=pubblicità vs ADS PDF
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional

import pandas as pd

from parser.csv_parser import parse_csv_file

TOLERANCE = 0.05      # EUR tolerance for checks 1-3
ADS_TOLERANCE = 1.0   # EUR tolerance for ADS check


# ─────────────────────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SettlementPeriod:
    period_id: str
    date_start: Optional[datetime]
    date_end: Optional[datetime]
    sum_transactions: float          # Sum of non-transfer rows' totale_num
    transaction_count: int = 0
    transfer_amount: float = 0.0     # Sum of transfer rows' totale_num in this period
    transfer_date: Optional[datetime] = None
    note: str = ""
    belongs_to_target_month: bool = False


@dataclass
class SummaryComparison:
    label: str
    csv_value: Optional[float]
    pdf_value: Optional[float]
    difference: Optional[float]
    status: str  # "ok" | "warning" | "error" | "missing"


@dataclass
class AdsVerification:
    csv_amount: Optional[float]
    invoice_amount: Optional[float]
    difference: Optional[float]
    status: str
    invoice_ids: List[str] = field(default_factory=list)


@dataclass
class ReconciliationResult:
    target_year: int
    target_month: int
    target_month_name: str

    settlement_periods: List[SettlementPeriod] = field(default_factory=list)
    transfer_details: List[dict] = field(default_factory=list)  # [{date, amount}]

    # CSV-derived totals (used by checks)
    total_revenues: float = 0.0
    total_expenses: float = 0.0
    total_transfers: float = 0.0

    # The 4 checks (populated after PDFs are parsed)
    checks: List[SummaryComparison] = field(default_factory=list)

    pdf_summary_available: bool = False
    ads_verification: Optional[AdsVerification] = None
    ads_pdf_available: bool = False

    overall_status: str = "ok"
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    transactions_df: Optional[pd.DataFrame] = None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

MONTH_NAMES_IT = {
    1: "Gennaio", 2: "Febbraio", 3: "Marzo", 4: "Aprile",
    5: "Maggio", 6: "Giugno", 7: "Luglio", 8: "Agosto",
    9: "Settembre", 10: "Ottobre", 11: "Novembre", 12: "Dicembre",
}


def _status(diff: Optional[float], tolerance: float = TOLERANCE) -> str:
    if diff is None:
        return "missing"
    return "ok" if abs(diff) <= tolerance else "warning"


def _safe_sum(series: pd.Series) -> float:
    return float(series.fillna(0.0).sum())


# ─────────────────────────────────────────────────────────────────────────────
# Main reconciliation entry point
# ─────────────────────────────────────────────────────────────────────────────

def reconcile(
    csv_files: Dict[str, bytes],
    pdf_summary_files: Dict[str, bytes],
    pdf_ads_files: Dict[str, bytes],
    target_year: int,
    target_month: int,
) -> ReconciliationResult:
    result = ReconciliationResult(
        target_year=target_year,
        target_month=target_month,
        target_month_name=MONTH_NAMES_IT.get(target_month, str(target_month)),
    )

    # ── Parse CSV files ──────────────────────────────────────────────────────
    all_dfs = []
    for filename, content in csv_files.items():
        try:
            df = parse_csv_file(content, filename)
            all_dfs.append(df)
        except Exception as e:
            result.errors.append(f"Errore parsing CSV '{filename}': {e}")

    if not all_dfs:
        result.errors.append("Nessun file CSV valido caricato.")
        result.overall_status = "error"
        return result

    combined = pd.concat(all_dfs, ignore_index=True)

    # Deduplicate (same row can appear in overlapping CSVs)
    dedup_cols = ["data_ora", "numero_pagamento", "tipo", "totale"]
    existing_dedup = [c for c in dedup_cols if c in combined.columns]
    if existing_dedup:
        combined = combined.drop_duplicates(subset=existing_dedup, keep="first")
    combined = combined.reset_index(drop=True)
    result.transactions_df = combined

    # ── Settlement periods (informational only) ──────────────────────────────
    result.settlement_periods = _analyse_settlement_periods(combined, target_year, target_month)

    # ── CSV totals for the 4 checks ──────────────────────────────────────────
    _compute_monthly_totals(combined, result)

    # ── Check 1-3: compare with PDF Summary ──────────────────────────────────
    if pdf_summary_files:
        _compare_with_pdf_summary(pdf_summary_files, result, target_year, target_month)

    # ── Check 4: ADS ─────────────────────────────────────────────────────────
    _verify_ads(combined, pdf_ads_files or {}, result)

    # ── Overall status ───────────────────────────────────────────────────────
    if result.errors:
        result.overall_status = "error"
    elif result.warnings or any(c.status in ("warning", "error") for c in result.checks):
        result.overall_status = "warning"
    else:
        result.overall_status = "ok"

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Settlement period analysis (informational, no pass/fail)
# ─────────────────────────────────────────────────────────────────────────────

def _analyse_settlement_periods(
    df: pd.DataFrame,
    target_year: int,
    target_month: int,
) -> List[SettlementPeriod]:
    """
    Group rows by numero_pagamento and collect informational data per period.
    No transfer-matching logic — just show what's in each period.
    """
    if "numero_pagamento" not in df.columns:
        return []

    target_month_start = datetime(target_year, target_month, 1)

    periods: List[SettlementPeriod] = []

    for period_id, group in df.groupby("numero_pagamento", sort=False):
        pid = str(period_id).strip()
        if not pid or pid == "nan":
            continue

        # Split transfer vs non-transfer rows within this period
        if "tipo" in group.columns:
            is_transfer = group["tipo"].str.strip().str.lower() == "trasferimento"
        else:
            is_transfer = pd.Series([False] * len(group), index=group.index)

        non_transfer = group[~is_transfer]
        transfer_rows = group[is_transfer]

        # Non-transfer: dates and sum
        dates = pd.Series([], dtype="object")
        if "data_ora_parsed" in non_transfer.columns:
            dates = pd.to_datetime(non_transfer["data_ora_parsed"], errors="coerce").dropna()

        sum_tx = _safe_sum(non_transfer["totale_num"]) if "totale_num" in non_transfer.columns else 0.0
        tx_count = len(non_transfer)
        date_start = dates.min().to_pydatetime() if not dates.empty else None
        date_end = dates.max().to_pydatetime() if not dates.empty else None

        # Transfer rows in this period
        transfer_amount = 0.0
        transfer_date = None
        if not transfer_rows.empty:
            if "totale_num" in transfer_rows.columns:
                transfer_amount = round(_safe_sum(transfer_rows["totale_num"]), 2)
            if "data_ora_parsed" in transfer_rows.columns:
                t_dates = pd.to_datetime(transfer_rows["data_ora_parsed"], errors="coerce").dropna()
                if not t_dates.empty:
                    transfer_date = t_dates.min().to_pydatetime()

        # belongs_to_target_month: any non-transfer tx date falls in target month
        belongs = False
        if not dates.empty:
            in_target = (dates.dt.year == target_year) & (dates.dt.month == target_month)
            belongs = bool(in_target.any())
        # Also consider transfer date as belonging to target month
        if not belongs and transfer_date is not None:
            belongs = (transfer_date.year == target_year and transfer_date.month == target_month)

        # Note
        note = ""
        if date_start is not None and date_start < target_month_start:
            note = "Aperto nel mese precedente"
        elif transfer_amount == 0.0:
            note = "Chiusura nel mese successivo"

        periods.append(SettlementPeriod(
            period_id=pid,
            date_start=date_start,
            date_end=date_end,
            sum_transactions=round(sum_tx, 2),
            transaction_count=tx_count,
            transfer_amount=transfer_amount,
            transfer_date=transfer_date,
            note=note,
            belongs_to_target_month=belongs,
        ))

    periods.sort(key=lambda p: p.date_start or datetime.min)
    return periods


# ─────────────────────────────────────────────────────────────────────────────
# CSV totals for the 4 checks
# ─────────────────────────────────────────────────────────────────────────────

def _compute_monthly_totals(df: pd.DataFrame, result: ReconciliationResult) -> None:
    """
    Compute the three CSV-side values used in checks 1-3.
    Uses ALL rows in the combined DataFrame (entire uploaded CSV).
    """
    is_transfer = pd.Series([False] * len(df), index=df.index)
    if "tipo" in df.columns:
        is_transfer = df["tipo"].str.strip().str.lower() == "trasferimento"

    # CHECK 1: RICAVI = sum of ALL vendite_num (includes refunds with negative values)
    if "vendite_num" in df.columns:
        result.total_revenues = round(_safe_sum(df["vendite_num"]), 2)

    # CHECK 2: SPESE = commissioni_vendita + altri_costi_transazione + altro
    #          for all rows that are NOT Tipo=Trasferimento
    non_transfer = df[~is_transfer]
    total_expenses = 0.0
    for col in ["commissioni_vendita_num", "altri_costi_transazione_num", "altro_num"]:
        if col in non_transfer.columns:
            total_expenses += _safe_sum(non_transfer[col])
    result.total_expenses = round(total_expenses, 2)

    # CHECK 3: PAGAMENTI = sum of totale_num for Tipo=Trasferimento rows
    transfer_df = df[is_transfer]
    if "totale_num" in transfer_df.columns:
        result.total_transfers = round(_safe_sum(transfer_df["totale_num"]), 2)

    # Collect individual transfer details for the UI
    if not transfer_df.empty:
        for _, row in transfer_df.iterrows():
            amount = row.get("totale_num")
            date = row.get("data_ora_parsed")
            if amount is not None and not (isinstance(amount, float) and pd.isna(amount)):
                result.transfer_details.append({
                    "date": date,
                    "amount": float(amount),
                })


# ─────────────────────────────────────────────────────────────────────────────
# Check 1-3: PDF Summary comparison
# ─────────────────────────────────────────────────────────────────────────────

def _compare_with_pdf_summary(
    pdf_summary_files: Dict[str, bytes],
    result: ReconciliationResult,
    target_year: int,
    target_month: int,
) -> None:
    from parser.pdf_summary import parse_pdf_summary

    target_summary = None
    for filename, content in pdf_summary_files.items():
        summary = parse_pdf_summary(content, filename)
        if summary.parse_errors:
            for e in summary.parse_errors:
                result.warnings.append(f"PDF Summary '{filename}': {e}")
        if target_summary is None or _filename_matches_month(filename, target_year, target_month):
            target_summary = summary

    if target_summary is None:
        return

    result.pdf_summary_available = True

    def _make_check(label: str, csv_val: float, pdf_val: Optional[float]) -> SummaryComparison:
        diff = round(csv_val - pdf_val, 2) if pdf_val is not None else None
        st = _status(diff)
        if st == "warning":
            result.warnings.append(
                f"Discrepanza {label}: CSV={csv_val}, PDF={pdf_val}, diff={diff}"
            )
        return SummaryComparison(label=label, csv_value=csv_val, pdf_value=pdf_val,
                                 difference=diff, status=st)

    result.checks.append(_make_check("Ricavi",    result.total_revenues,  target_summary.ricavi))
    result.checks.append(_make_check("Spese",     result.total_expenses,  target_summary.spese))
    result.checks.append(_make_check("Pagamenti", result.total_transfers, target_summary.trasferimenti))


def _filename_matches_month(filename: str, year: int, month: int) -> bool:
    from parser.csv_parser import extract_month_year
    ym = extract_month_year(filename)
    return ym is not None and ym == (year, month)


# ─────────────────────────────────────────────────────────────────────────────
# Check 4: ADS verification
# ─────────────────────────────────────────────────────────────────────────────

def _verify_ads(
    df: pd.DataFrame,
    pdf_ads_files: Dict[str, bytes],
    result: ReconciliationResult,
) -> None:
    """
    Check 4: sum totale_num for rows with Tipo=Commissione di servizio
    AND Descrizione contains 'pubblicità'. No period filter — use ALL rows.
    """
    from parser.pdf_ads import parse_pdf_ads

    # CSV side
    ads_csv_amount: Optional[float] = None
    if "tipo" in df.columns and "descrizione" in df.columns:
        is_service_fee = df["tipo"].str.strip().str.lower() == "commissione di servizio"
        is_ads = df["descrizione"].str.lower().str.contains(
            "pubblicità|pubblicita|advertising", na=False
        )
        ads_rows = df[is_service_fee & is_ads]
        if "totale_num" in ads_rows.columns:
            ads_csv_amount = round(_safe_sum(ads_rows["totale_num"]), 2)

    # PDF side
    total_ads_eur: Optional[float] = None
    all_invoice_ids: List[str] = []
    for filename, content in pdf_ads_files.items():
        ads_data = parse_pdf_ads(content, filename)
        if ads_data.parse_errors:
            for e in ads_data.parse_errors:
                result.warnings.append(e)
        if ads_data.total_eur is not None:
            total_ads_eur = (total_ads_eur or 0.0) + ads_data.total_eur
        all_invoice_ids.extend(ads_data.invoice_ids)

    result.ads_pdf_available = total_ads_eur is not None

    diff: Optional[float] = None
    if ads_csv_amount is not None and total_ads_eur is not None:
        diff = round(abs(ads_csv_amount) - total_ads_eur, 2)

    st = _status(diff, ADS_TOLERANCE)

    if ads_csv_amount is not None or total_ads_eur is not None:
        result.ads_verification = AdsVerification(
            csv_amount=ads_csv_amount,
            invoice_amount=(-total_ads_eur if total_ads_eur is not None else None),
            difference=diff,
            status=st,
            invoice_ids=all_invoice_ids,
        )
        if st == "warning" and diff is not None:
            result.warnings.append(
                f"Discrepanza ADS: CSV={ads_csv_amount}, Fattura={total_ads_eur}, diff={diff}"
            )

    # Always add ADS check (even if no PDF — shows CSV value with missing status for PDF)
    result.checks.append(SummaryComparison(
        label="ADS",
        csv_value=ads_csv_amount,
        pdf_value=(-total_ads_eur if total_ads_eur is not None else None),
        difference=diff,
        status=st,
    ))
