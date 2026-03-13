"""
CSV Transaction Parser for Amazon Seller Central monthly transaction reports.

Expected file format:
- First 7 rows: descriptive headers to skip
- Row 8: actual column headers
- Encoding: UTF-8 with BOM (utf-8-sig)
- Decimal separator: comma (Italian format)
- Date format: "31 dic 2025 23:31:10 UTC"
"""

import io
import re
import pandas as pd
from datetime import datetime
from typing import Optional

# Italian month abbreviations to English
ITALIAN_MONTHS = {
    "gen": "Jan", "feb": "Feb", "mar": "Mar", "apr": "Apr",
    "mag": "May", "giu": "Jun", "lug": "Jul", "ago": "Aug",
    "set": "Sep", "ott": "Oct", "nov": "Nov", "dic": "Dec",
}


def _normalize_italian_month(date_str: str) -> str:
    """Replace Italian month abbreviations with English ones."""
    if not isinstance(date_str, str):
        return date_str
    for ita, eng in ITALIAN_MONTHS.items():
        date_str = re.sub(r'\b' + ita + r'\b', eng, date_str, flags=re.IGNORECASE)
    return date_str


def _parse_italian_decimal(value) -> Optional[float]:
    """Convert Italian decimal format (comma separator) to float."""
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    s = str(value).strip()
    if s == "" or s == "-":
        return None
    # Remove thousand separators (dots) and replace decimal comma with dot
    # Italian: 1.234,56 → 1234.56
    s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _parse_date(date_str: str) -> Optional[datetime]:
    """Parse Amazon date string like '31 dic 2025 23:31:10 UTC'."""
    if not isinstance(date_str, str) or date_str.strip() == "":
        return None
    normalized = _normalize_italian_month(date_str.strip())
    # Remove UTC suffix
    normalized = normalized.replace(" UTC", "").strip()
    try:
        return datetime.strptime(normalized, "%d %b %Y %H:%M:%S")
    except ValueError:
        try:
            return datetime.strptime(normalized, "%d %b %Y")
        except ValueError:
            return None


def parse_csv_file(file_content: bytes, filename: str) -> pd.DataFrame:
    """
    Parse an Amazon Seller Central monthly transaction CSV file.

    Returns a DataFrame with normalized column names and typed values.
    """
    # Decode with BOM-aware encoding
    text = file_content.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()

    if len(lines) < 8:
        raise ValueError(f"File {filename} has fewer than 8 lines — invalid format.")

    # Row 8 (index 7) is the header, data starts at row 9 (index 8)
    header_line = lines[7]
    data_lines = lines[8:]

    csv_content = "\n".join([header_line] + data_lines)
    df = pd.read_csv(
        io.StringIO(csv_content),
        sep=",",
        quotechar='"',
        dtype=str,
        keep_default_na=False,
    )

    # Strip whitespace, quotes, and trailing colons from column names
    df.columns = [c.strip().strip('"').rstrip(':').strip() for c in df.columns]

    # Rename columns to internal normalized names
    # Multiple variants handle different Amazon locale/version formats
    column_map = {
        "Data/Ora": "data_ora",
        "Numero pagamento": "numero_pagamento",
        "Tipo": "tipo",
        "Numero ordine": "numero_ordine",
        "SKU": "sku",
        "Descrizione": "descrizione",
        "Quantità": "quantita",
        "Marketplace": "marketplace",
        "Gestione": "gestione",
        "Vendite": "vendite",
        "imposta sulle vendite dei prodotti": "imposta_vendite",
        "Imposta sulle vendite dei prodotti": "imposta_vendite",
        "Commissioni di vendita": "commissioni_vendita",
        "Costi del servizio Logistica di Amazon": "costi_fba",
        "Altri costi relativi alle transazioni": "altri_costi_transazione",
        "Altro": "altro",
        "totale": "totale",
        "Totale": "totale",
    }
    # Case-insensitive fallback: build a lowercase lookup for any remaining unmapped cols
    lower_map = {k.lower(): v for k, v in column_map.items()}
    rename_dict = {}
    for col in df.columns:
        if col in column_map:
            rename_dict[col] = column_map[col]
        elif col.lower() in lower_map and col not in rename_dict:
            rename_dict[col] = lower_map[col.lower()]
    df = df.rename(columns=rename_dict)

    # Parse dates
    if "data_ora" in df.columns:
        df["data_ora_parsed"] = df["data_ora"].apply(_parse_date)

    # Parse numeric columns
    numeric_cols = [
        "vendite", "imposta_vendite", "commissioni_vendita",
        "costi_fba", "altri_costi_transazione", "altro", "totale",
    ]
    for col in numeric_cols:
        if col in df.columns:
            df[col + "_num"] = df[col].apply(_parse_italian_decimal)

    # Store source filename
    df["_source_file"] = filename

    return df


def extract_month_year(filename: str) -> Optional[tuple]:
    """
    Try to extract (year, month) from filename like '2026JanMonthlyTransaction.csv'.
    Returns (year: int, month: int) or None.
    """
    month_map = {
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
    }
    pattern = r"(\d{4})([A-Za-z]{3})"
    match = re.search(pattern, filename)
    if match:
        year = int(match.group(1))
        month_abbr = match.group(2).lower()
        month = month_map.get(month_abbr)
        if month:
            return (year, month)
    return None
