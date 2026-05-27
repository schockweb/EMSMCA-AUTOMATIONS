"""
Run this from the backend directory to inspect the exact row/column structure
of the GEMS tariff Excel file.

Usage:
  python debug_excel.py <path_to_xlsx>

Example:
  python debug_excel.py "uploads/TRF007_GEMS_2025_Contracted Emergency Medical Services_V1.xlsx"
"""
import sys
import openpyxl

path = sys.argv[1] if len(sys.argv) > 1 else None
if not path:
    print("Usage: python debug_excel.py <path_to_xlsx>")
    sys.exit(1)

wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
ws = wb.active  # type: ignore
raw_rows = list(ws.iter_rows(values_only=True))

print(f"\nTotal rows: {len(raw_rows)}")
print(f"Columns per row: {len(raw_rows[0]) if raw_rows else 0}\n")
print("=" * 120)

for i, row in enumerate(raw_rows[:15]):   # show first 15 rows
    cells = [str(c)[:30] if c is not None else "<<None>>" for c in row]
    non_null = [(j, str(c)[:60]) for j, c in enumerate(row) if c is not None]
    print(f"Row {i:02d}:  [{', '.join(cells[:8])}{'...' if len(cells) > 8 else ''}]")
    print(f"         Non-null cols: {non_null}")
    print()

print("=" * 120)
print("\nAll column headers in row 0:", [str(c)[:60] for c in raw_rows[0]])
if len(raw_rows) > 1:
    print("All column headers in row 1:", [str(c)[:60] for c in raw_rows[1]])
if len(raw_rows) > 2:
    print("All column headers in row 2:", [str(c)[:60] for c in raw_rows[2]])
if len(raw_rows) > 3:
    print("All column headers in row 3:", [str(c)[:60] for c in raw_rows[3]])
