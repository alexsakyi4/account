import { describe, expect, it } from 'vitest';
import { csvToObjects, parseCsv, toCsv } from '../../server/src/lib/csv.js';

describe('CSV', () => {
  it('parses quoted fields, embedded commas and newlines', () => {
    const rows = parseCsv('a,b\n"x, y","line\nbreak"\n"he said ""hi""",2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'line\nbreak'],
      ['he said "hi"', '2'],
    ]);
  });

  it('handles BOM and CRLF', () => {
    const rows = parseCsv('\uFEFFname,amount\r\nWidget,12.50\r\n');
    expect(rows).toEqual([
      ['name', 'amount'],
      ['Widget', '12.50'],
    ]);
  });

  it('maps rows to objects with trimmed headers', () => {
    const rows = csvToObjects('Name , Amount\n Widget , 10 ');
    expect(rows).toEqual([{ Name: 'Widget', Amount: '10' }]);
  });

  it('escapes when serialising', () => {
    const csv = toCsv([{ a: 'x,y', b: 'q"z' }]);
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"q""z"');
  });
});
