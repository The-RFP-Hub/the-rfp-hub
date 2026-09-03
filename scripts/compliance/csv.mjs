/**
 * A small RFC 4180 CSV reader — enough to read back what `packages/api/scripts/csv.ts` writes and
 * cross-check it against the JSON export, without adding a dependency to do it.
 *
 * Handles quoted fields containing commas, doubled quotes and embedded newlines, and both LF and
 * CRLF line endings.
 */

/** Parse CSV text into `{ header, rows }`, where each row is an array of cell strings. */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endField = () => {
    record.push(field);
    field = "";
    started = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") continue; // CRLF: the \n that follows ends the record
    if (ch === "\n") {
      endRecord();
      continue;
    }
    field += ch;
    started = true;
  }
  // A trailing newline ends the last record; anything else means the file has no final newline.
  if (field.length > 0 || record.length > 0) endRecord();

  const header = records.shift() ?? [];
  // Drop a single trailing blank line artefact (one empty cell, nothing else).
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === "") records.pop();
    else break;
  }
  return { header, rows: records };
}

/**
 * Undo the exporter's spreadsheet-formula neutralization: `csvCell` prefixes a value that starts
 * with `= + - @`, tab or CR with an apostrophe so Excel/Sheets do not execute it as a formula.
 * A comparison against the JSON export has to compare the ORIGINAL value, so the guard apostrophe
 * comes back off — and only when it is actually guarding one of those characters, so a value that
 * genuinely begins with an apostrophe is left alone.
 */
export function unguardCell(value) {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Index rows by column name, applying `unguardCell`. Returns an array of plain objects. */
export function rowsAsObjects({ header, rows }) {
  return rows.map((cells) => {
    const out = {};
    header.forEach((name, i) => {
      out[name] = unguardCell(cells[i] ?? "");
    });
    return out;
  });
}
