/** RFC 4180 CSV parsing/serialisation with Excel/BOM tolerance. No dependency. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export function csvToObjects(text: string, delimiter = ','): Record<string, string>[] {
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = (r[idx] ?? '').trim();
    });
    return obj;
  });
}

export function toCsv(rows: Array<Record<string, unknown> | unknown[]>, headers?: string[]): string {
  if (rows.length === 0) return headers ? `${headers.map(escape).join(',')}\n` : '';
  const first = rows[0];
  const cols = headers ?? (Array.isArray(first) ? first.map((_, i) => String(i)) : Object.keys(first));
  const lines = [cols.map(escape).join(',')];
  for (const row of rows) {
    const values = Array.isArray(row) ? row : cols.map((c) => (row as Record<string, unknown>)[c]);
    lines.push(values.map((v) => escape(v == null ? '' : String(v))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function escape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
