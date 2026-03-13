"""
Reconciliation engine for Amazon Seller Central payment reconciliation.

Implements the 5-step reconciliation logic:
1. Identify settlement periods for the target month
2. Verify each settlement period (sum of transactions ≈ transfer amount)
3. Monthly reconciliation (net balance = transfers received)
4. Cross-check with PDF Summary
5. Verify ADS costs
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple

import pandas as pd

from parser.csv_parser import parse_csv_file
from parser.pdf_summary import PdfSummaryData
from parser.pdf_ads import PdfAdsData

TOLERANCE = 0.05  # EUR tolerance for float comparisons
ADS_TOLERANCE = 1.0  # EUR tolerance for ADS verification


# ─────────────────────────────────────────────────────────────────────────────
# Data structures
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SettlementPeriod:
    period_id: str
    date_start: Optional[datetime]
    date_end: Optional[datetime]
    transfer_amount: float           # Positive value (what was received)
    sum_transactions: float          # Sum of all non-transfer rows (sign-preserved)
    difference: float                # transfer_amount + sum_transactions (should ≈ 0)
    status: str                      # "ok" | "warning" | "error"
    belongs_to_target_month: bool
    transaction_count: int = 0
    transfer_row_count: int = 0


@dataclass
class SummaryComparison:
    label: str
    csv_value: Optional[float]
    pdf_value: Optional[float]
    difference: Optional[float]
    status: str  # "ok" | "warning" | "error" | "missing"


@dataclass
class AdsVerification:
    csv_amount: Optional[float]      # Sum of "Commissione di servizio - Costo della pubblicità"
    invoice_amount: Optional[float]  # EUR total from ADS PDF
    difference: Optional[float]
    status: str
    invoice_ids: List[str] = field(default_factory=list)


@dataclass
class ReconciliationResult:
    target_year: int
    target_month: int
    target_month_name: str

    # Step 1-2: Settlement periods
    settlement_periods: List[SettlementPeriod] = field(default_factory=list)

    # Step 3: Monthly totals
    total_revenues: float = 0.0
    total_expenses: float = 0.0
    total_taxes: float = 0.0
    total_transfers: float = 0.0
    net_balance: float = 0.0
    amazon_balance_variation: float = 0.0

    # Step 4: PDF Summary comparison
    summary_comparisons: List[SummaryComparison] = field(default_factory=list)
    pdf_summary_available: bool = False

    # Step 5: ADS verification
    ads_verification: Optional[AdsVerification] = None
    ads_pdf_available: bool = False

    # Overall status
    overall_status: str = "ok"  # "ok" | "warning" | "error"
    warnings: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)

    # Transaction details (for table display)
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
    """Sum a series of optional floats, treating None/NaN as 0."""
    return float(series.fillna(0.0).sum())


# ─────────────────────────────────────────────────────────────────────────────
# Main reconciliation function
# ─────────────────────────────────────────────────────────────────────────────

def reconcile(
    csv_files: Dict[str, bytes],       # filename → raw bytes
    pdf_summary_files: Dict[str, bytes],
    pdf_ads_files: Dict[str, bytes],
    target_year: int,
    target_month: int,
) -> ReconciliationResult:
    """
    Run the full reconciliation for the given target month/year.

    Args:
        csv_files: Dict mapping filename to file bytes for CSV transaction files.
        pdf_summary_files: Dict mapping filename to bytes for PDF summaries.
        pdf_ads_files: Dict mapping filename to bytes for ADS PDFs.
        target_year: The year to reconcile.
        target_month: The month to reconcile (1-12).

    Returns:
        A ReconciliationResult with all computed data.
    """
    result = ReconciliationResult(
        target_year=target_year,
        target_month=target_month,
        target_month_name=MONTH_NAMES_IT.get(target_month, str(target_month)),
    )

    # ── Parse all CSV files ──────────────────────────────────────────────────
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

    # Drop duplicates (same row can appear in month X and X-1 CSVs)
    # Key: data_ora + numero_pagamento + tipo + totale
    dedup_cols = ["data_ora", "numero_pagamento", "tipo", "totale"]
    existing_dedup = [c for c in dedup_cols if c in combined.columns]
    if existing_dedup:
        combined = combined.drop_duplicates(subset=existing_dedup, keep="first")

    combined = combined.reset_index(drop=True)
    result.transactions_df = combined

    # ── Step 1 & 2: Settlement period analysis ───────────────────────────────
    result.settlement_periods = _analyse_settlement_periods(
        combined, target_year, target_month
    )

    # ── Step 3: Monthly totals ───────────────────────────────────────────────
    _compute_monthly_totals(combined, result, target_year, target_month)

    # ── Step 4: PDF Summary comparison ──────────────────────────────────────
    if pdf_summary_files:
        _compare_with_pdf_summary(pdf_summary_files, result, target_year, target_month)

    # ── Step 5: ADS verification ─────────────────────────────────────────────
    if pdf_ads_files:
        _verify_ads(combined, pdf_ads_files, result, target_year, target_month)

    # ── Determine overall status ─────────────────────────────────────────────
    if result.errors:
        result.overall_status = "error"
    elif result.warnings or any(
        p.status in ("warning", "error") for p in result.settlement_periods
    ):
        result.overall_status = "warning"
    else:
        result.overall_status = "ok"

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 & 2: Settlement periods
# ─────────────────────────────────────────────────────────────────────────────

def _analyse_settlement_periods(
    df: pd.DataFrame,
    target_year: int,
    target_month: int,
) -> List[SettlementPeriod]:
    """Analyse settlement periods and determine which belong to the target month."""

    if "numero_pagamento" not in df.columns:
        return []

    periods = []

    for period_id, group in df.groupby("numero_pagamento", sort=False):
        if not period_id or str(period_id).strip() == "":
            continue

        # Parse dates
        dates = pd.to_datetime(
            group["data_ora_parsed"] if "data_ora_parsed" in group.columns else pd.Series([]),
            errors="coerce"
        )
        valid_dates = dates.dropna()
        date_start = valid_dates.min() if not valid_dates.empty else None
        date_end = valid_dates.max() if not valid_dates.empty else None

        # Determine if this period belongs to the target month
        belongs = _period_belongs_to_month(group, date_start, date_end, target_year, target_month)

        # Separate transfer rows from regular transaction rows
        is_transfer = (
            group["tipo"].str.strip().str.lower() == "trasferimento"
            if "tipo" in group.columns
            else pd.Series([False] * len(group))
        )

        transfer_rows = group[is_transfer]
        transaction_rows = group[~is_transfer]

        # Sum of all transfers (the "altro_num" column holds the transfer amount, negative)
        if "altro_num" in transfer_rows.columns:
            transfer_total = _safe_sum(transfer_rows["altro_num"])
        elif "totale_num" in transfer_rows.columns:
            transfer_total = _safe_sum(transfer_rows["totale_num"])
        else:
            transfer_total = 0.0

        transfer_amount = abs(transfer_total)  # Positive: what Amazon paid out

        # Sum of all non-transfer transaction totals
        if "totale_num" in transaction_rows.columns:
            sum_transactions = _safe_sum(transaction_rows["totale_num"])
        else:
            sum_transactions = 0.0

        # Difference: sum_transactions - transfer_amount should ≈ 0
        # (the transactions generate the funds that are then transferred)
        difference = sum_transactions - transfer_amount
        st = "ok" if abs(difference) <= TOLERANCE else "warning"

        periods.append(SettlementPeriod(
            period_id=str(period_id),
            date_start=date_start.to_pydatetime() if date_start is not None else None,
            date_end=date_end.to_pydatetime() if date_end is not None else None,
            transfer_amount=transfer_amount,
            sum_transactions=sum_transactions,
            difference=difference,
            status=st,
            belongs_to_target_month=belongs,
            transaction_count=len(transaction_rows),
            transfer_row_count=len(transfer_rows),
        ))

    # Sort by date_start
    periods.sort(key=lambda p: p.date_start or datetime.min)
    return periods


def _period_belongs_to_month(
    group: pd.DataFrame,
    date_start: Optional[object],
    date_end: Optional[object],
    target_year: int,
    target_month: int,
) -> bool:
    """
    A period belongs to the target month if:
    - It contains at least one transaction dated in the target month, OR
    - Its transfer row is dated in the target month
    """
    if "data_ora_parsed" not in group.columns:
        return False

    try:
        dates = pd.to_datetime(group["data_ora_parsed"], errors="coerce")
        # Use .dt accessors (vectorised, NaT-safe) instead of .apply lambda
        in_target = (dates.dt.year == target_year) & (dates.dt.month == target_month)
        if bool(in_target.any()):
            return True
    except Exception:
        pass

    return False


# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Monthly totals
# ─────────────────────────────────────────────────────────────────────────────

def _compute_monthly_totals(
    df: pd.DataFrame,
    result: ReconciliationResult,
    target_year: int,
    target_month: int,
) -> None:
    """
    Compute revenue, expense, tax and transfer totals for the target month.
    Uses transactions from settlement periods that belong to the target month.
    """
    if "numero_pagamento" not in df.columns:
        return

    # Identify period IDs that belong to target month
    target_period_ids = {
        p.period_id for p in result.settlement_periods if p.belongs_to_target_month
    }

    if not target_period_ids:
        result.warnings.append(
            "Nessun settlement period trovato per il mese target. "
            "Assicurarsi di aver caricato i CSV corretti."
        )
        return

    # Filter to rows in target periods
    mask = df["numero_pagamento"].astype(str).isin(target_period_ids)
    target_df = df[mask]

    # Further separate types
    tipo_col = "tipo" if "tipo" in target_df.columns else None

    def tipo_mask(pattern: str) -> pd.Series:
        if tipo_col is None:
            return pd.Series([False] * len(target_df), index=target_df.index)
        return target_df[tipo_col].str.strip().str.lower().str.contains(pattern, na=False)

    is_transfer = tipo_mask("trasferimento")
    is_order = tipo_mask("ordine")
    is_refund = tipo_mask("rimborso")
    is_service_fee = tipo_mask("commissione di servizio")
    is_shipping = tipo_mask("servizi di spedizione")

    # ── Revenues ──────────────────────────────────────────────────────────────
    revenue_rows = target_df[is_order | is_refund]
    if "vendite_num" in revenue_rows.columns:
        result.total_revenues = round(_safe_sum(revenue_rows["vendite_num"]), 2)

    # ── Expenses ──────────────────────────────────────────────────────────────
    expense_cols = ["commissioni_vendita_num", "costi_fba_num", "altri_costi_transazione_num"]
    expense_rows = target_df[~is_transfer]
    total_expenses = 0.0
    for col in expense_cols:
        if col in expense_rows.columns:
            total_expenses += _safe_sum(expense_rows[col])
    # Service fees and shipping costs
    service_rows = target_df[is_service_fee | is_shipping]
    if "altro_num" in service_rows.columns:
        total_expenses += _safe_sum(service_rows["altro_num"])
    result.total_expenses = round(total_expenses, 2)

    # ── Taxes ─────────────────────────────────────────────────────────────────
    if "imposta_vendite_num" in target_df.columns:
        result.total_taxes = round(_safe_sum(target_df[~is_transfer]["imposta_vendite_num"]), 2)

    # ── Transfers ─────────────────────────────────────────────────────────────
    transfer_rows = target_df[is_transfer]
    if "altro_num" in transfer_rows.columns:
        result.total_transfers = round(_safe_sum(transfer_rows["altro_num"]), 2)
    elif "totale_num" in transfer_rows.columns:
        result.total_transfers = round(_safe_sum(transfer_rows["totale_num"]), 2)

    # ── Net balance ───────────────────────────────────────────────────────────
    # Sum of all non-transfer rows' totals
    if "totale_num" in target_df.columns:
        non_transfer_total = _safe_sum(target_df[~is_transfer]["totale_num"])
        result.net_balance = round(non_transfer_total, 2)

    # Amazon balance variation = net_balance + transfers (should be small residual)
    result.amazon_balance_variation = round(result.net_balance + abs(result.total_transfers), 2)


# ─────────────────────────────────────────────────────────────────────────────
# Step 4: PDF Summary comparison
# ─────────────────────────────────────────────────────────────────────────────

def _compare_with_pdf_summary(
    pdf_summary_files: Dict[str, bytes],
    result: ReconciliationResult,
    target_year: int,
    target_month: int,
) -> None:
    """Parse PDF summaries and compare with CSV-derived totals."""
    from parser.pdf_summary import parse_pdf_summary

    # Find the summary for the target month
    target_summary = None
    for filename, content in pdf_summary_files.items():
        # Prefer the file that matches the target month by name
        summary = parse_pdf_summary(content, filename)
        if summary.parse_errors:
            for e in summary.parse_errors:
                result.warnings.append(f"PDF Summary '{filename}': {e}")
        if target_summary is None or _filename_matches_month(filename, target_year, target_month):
            target_summary = summary

    if target_summary is None:
        return

    result.pdf_summary_available = True

    comparisons = [
        SummaryComparison(
            label="Ricavi totali",
            csv_value=result.total_revenues,
            pdf_value=target_summary.ricavi,
            difference=(
                round(result.total_revenues - target_summary.ricavi, 2)
                if target_summary.ricavi is not None else None
            ),
            status=_status(
                result.total_revenues - target_summary.ricavi
                if target_summary.ricavi is not None else None
            ),
        ),
        SummaryComparison(
            label="Spese totali",
            csv_value=result.total_expenses,
            pdf_value=target_summary.spese,
            difference=(
                round(result.total_expenses - target_summary.spese, 2)
                if target_summary.spese is not None else None
            ),
            status=_status(
                result.total_expenses - target_summary.spese
                if target_summary.spese is not None else None
            ),
        ),
        SummaryComparison(
            label="Imposte nette",
            csv_value=result.total_taxes,
            pdf_value=target_summary.imposte,
            difference=(
                round(result.total_taxes - target_summary.imposte, 2)
                if target_summary.imposte is not None else None
            ),
            status=_status(
                result.total_taxes - target_summary.imposte
                if target_summary.imposte is not None else None
            ),
        ),
        SummaryComparison(
            label="Trasferimenti",
            csv_value=result.total_transfers,
            pdf_value=target_summary.trasferimenti,
            difference=(
                round(result.total_transfers - target_summary.trasferimenti, 2)
                if target_summary.trasferimenti is not None else None
            ),
            status=_status(
                result.total_transfers - target_summary.trasferimenti
                if target_summary.trasferimenti is not None else None
            ),
        ),
    ]

    result.summary_comparisons = comparisons

    # Add warnings for mismatches
    for comp in comparisons:
        if comp.status == "warning":
            result.warnings.append(
                f"Discrepanza {comp.label}: CSV={comp.csv_value}, "
                f"PDF={comp.pdf_value}, diff={comp.difference}"
            )
        elif comp.status == "missing":
            result.warnings.append(
                f"{comp.label}: dato non disponibile nel PDF Summary"
            )


def _filename_matches_month(filename: str, year: int, month: int) -> bool:
    """Check if a filename corresponds to the given year/month."""
    from parser.csv_parser import extract_month_year
    ym = extract_month_year(filename)
    return ym is not None and ym == (year, month)


# ─────────────────────────────────────────────────────────────────────────────
# Step 5: ADS verification
# ─────────────────────────────────────────────────────────────────────────────

def _verify_ads(
    df: pd.DataFrame,
    pdf_ads_files: Dict[str, bytes],
    result: ReconciliationResult,
    target_year: int,
    target_month: int,
) -> None:
    """Compare ADS costs in CSV with the ADS billing PDF."""
    from parser.pdf_ads import parse_pdf_ads

    # Sum ADS costs from CSV: tipo="Commissione di servizio", descrizione contains "pubblicità"
    ads_csv_amount: Optional[float] = None

    if "tipo" in df.columns and "descrizione" in df.columns:
        is_service_fee = df["tipo"].str.strip().str.lower() == "commissione di servizio"
        is_ads = df["descrizione"].str.lower().str.contains("pubblicità|pubblicita|advertising", na=False)

        # Filter to target periods
        target_period_ids = {
            p.period_id for p in result.settlement_periods if p.belongs_to_target_month
        }
        in_target = df["numero_pagamento"].astype(str).isin(target_period_ids)

        ads_rows = df[is_service_fee & is_ads & in_target]
        if "altro_num" in ads_rows.columns:
            ads_csv_amount = round(_safe_sum(ads_rows["altro_num"]), 2)

    # Parse ADS PDFs
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

    if ads_csv_amount is not None or total_ads_eur is not None:
        diff: Optional[float] = None
        if ads_csv_amount is not None and total_ads_eur is not None:
            diff = round(abs(ads_csv_amount) - total_ads_eur, 2)

        result.ads_verification = AdsVerification(
            csv_amount=ads_csv_amount,
            invoice_amount=(-total_ads_eur if total_ads_eur is not None else None),
            difference=diff,
            status=_status(diff, ADS_TOLERANCE),
            invoice_ids=all_invoice_ids,
        )

        if result.ads_verification.status == "warning" and diff is not None:
            result.warnings.append(
                f"Discrepanza ADS: CSV={ads_csv_amount}, Fattura={total_ads_eur}, diff={diff}"
            )
