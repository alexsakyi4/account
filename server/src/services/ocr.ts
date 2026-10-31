/**
 * Receipt OCR.
 *
 * The default `local` provider performs text extraction for PDFs/plain text and
 * a deterministic field parser (vendor, date, total, tax) that is unit tested.
 * Raster images require a hosted engine: set OCR_PROVIDER=http and OCR_ENDPOINT
 * to forward the image bytes; any engine speaking `{text: string}` works
 * (Google Vision, Textract behind a lambda, Mindee, ...).
 */
import { config } from '../config.js';

export interface OcrResult {
  provider: string;
  text: string;
  confidence: number;
  fields: {
    vendor?: string;
    date?: string;
    subtotal?: number;
    tax?: number;
    total?: number;
    currency?: string;
  };
  notes?: string;
}

const MONEY = /(?<![a-z])(?:grand total|amount due|total due|total)\s*[:\-]?\s*([$€£₵]?)\s*([\d,]+\.\d{2})/i;
const TAX = /(?<![a-z])(?:tax|vat|gst)\s*[:\-]?\s*([$€£₵]?)\s*([\d,]+\.\d{2})/i;
const SUBTOTAL = /(?<![a-z])subtotal\s*[:\-]?\s*([$€£₵]?)\s*([\d,]+\.\d{2})/i;
const DATE = /(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/;

const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₵': 'GHS' };

export function parseReceiptText(text: string): OcrResult['fields'] {
  const fields: OcrResult['fields'] = {};
  const normalized = text.replace(/\r/g, '');
  const firstLine = normalized.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  if (firstLine && firstLine.length < 60) fields.vendor = firstLine.replace(/[^\w\s&.'-]/g, '').trim();

  const total = MONEY.exec(normalized);
  if (total) {
    fields.total = Math.round(Number(total[2].replace(/,/g, '')) * 100);
    fields.currency = CURRENCY_SYMBOLS[total[1]] ?? undefined;
  }
  const tax = TAX.exec(normalized);
  if (tax) fields.tax = Math.round(Number(tax[2].replace(/,/g, '')) * 100);
  const subtotal = SUBTOTAL.exec(normalized);
  if (subtotal) fields.subtotal = Math.round(Number(subtotal[2].replace(/,/g, '')) * 100);
  const date = DATE.exec(normalized);
  if (date) {
    const raw = date[1];
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) fields.date = raw;
    else {
      const parts = raw.split(/[/-]/);
      const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
      fields.date = `${year}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
  }
  return fields;
}

export async function extractReceipt(filename: string, data: Buffer, mimeType?: string): Promise<OcrResult> {
  if (config.ocrProvider === 'http' && process.env.OCR_ENDPOINT) {
    try {
      const res = await fetch(process.env.OCR_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OCR_API_KEY ?? ''}` },
        body: JSON.stringify({ filename, mimeType, image: data.toString('base64') }),
      });
      if (res.ok) {
        const payload = (await res.json()) as { text?: string; confidence?: number };
        if (payload.text) {
          return {
            provider: 'http',
            text: payload.text,
            confidence: payload.confidence ?? 0.9,
            fields: parseReceiptText(payload.text),
          };
        }
      }
    } catch {
      /* fall through to the local provider */
    }
  }

  const isText = (mimeType ?? '').startsWith('text/') || filename.toLowerCase().endsWith('.txt') || filename.toLowerCase().endsWith('.csv');
  if (isText) {
    const text = data.toString('utf8').slice(0, 20_000);
    return { provider: 'local-text', text, confidence: 0.75, fields: parseReceiptText(text) };
  }
  return {
    provider: 'local',
    text: '',
    confidence: 0,
    fields: {},
    notes:
      'No OCR engine is configured for images. Set OCR_PROVIDER=http and OCR_ENDPOINT to extract fields automatically, or enter the totals manually.',
  };
}
