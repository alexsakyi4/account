/**
 * Minimal, dependency-light PDF generation for invoices, bills, statements and
 * reports. Uses PDFKit with the standard fonts, so no font assets are required.
 */
import PDFDocument from 'pdfkit';
import { fromMinor } from '../lib/money.js';

const BRAND = '#0f766e';
const INK = '#0f172a';
const MUTED = '#64748b';

export interface PdfParty {
  name: string;
  lines?: string[];
  email?: string | null;
}

export interface PdfLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface PdfDocInput {
  kind: 'Invoice' | 'Credit memo' | 'Estimate' | 'Bill' | 'Statement';
  number: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  company: PdfParty;
  party: PdfParty;
  partyLabel: string;
  lines: PdfLine[];
  subtotal: number;
  taxTotal: number;
  total: number;
  amountPaid?: number;
  balance?: number;
  memo?: string | null;
  terms?: string | null;
  accentColor?: string;
}

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(fromMinor(minor));
}

export async function renderDocumentPdf(input: PdfDocInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${input.kind} ${input.number}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const accent = input.accentColor ?? BRAND;

    doc.rect(0, 0, 595, 8).fill(accent);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(input.company.name, 50, 40);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    (input.company.lines ?? []).forEach((line) => doc.text(line));
    if (input.company.email) doc.text(input.company.email);

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text(input.kind.toUpperCase(), 400, 40, { width: 145, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(input.number, 400, 68, { width: 145, align: 'right' });

    const top = Math.max(doc.y, 110) + 18;
    doc.fillColor(MUTED).fontSize(9).text(input.partyLabel.toUpperCase(), 50, top);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(input.party.name, 50, top + 14);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    (input.party.lines ?? []).forEach((line) => doc.text(line));
    if (input.party.email) doc.text(input.party.email);

    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Issue date', 380, top, { width: 70, align: 'right' });
    doc.fillColor(INK).text(input.issueDate, 460, top, { width: 85, align: 'right' });
    if (input.dueDate) {
      doc.fillColor(MUTED).text('Due date', 380, top + 14, { width: 70, align: 'right' });
      doc.fillColor(INK).text(input.dueDate, 460, top + 14, { width: 85, align: 'right' });
    }

    let y = top + 80;
    doc.rect(50, y, 495, 22).fill('#f1f5f9');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5);
    doc.text('DESCRIPTION', 58, y + 7, { width: 250 });
    doc.text('QTY', 320, y + 7, { width: 45, align: 'right' });
    doc.text('UNIT PRICE', 380, y + 7, { width: 75, align: 'right' });
    doc.text('AMOUNT', 465, y + 7, { width: 72, align: 'right' });
    y += 30;

    doc.font('Helvetica').fontSize(9.5).fillColor(INK);
    for (const line of input.lines) {
      if (y > 680) {
        doc.addPage();
        y = 60;
      }
      doc.text(line.description, 58, y, { width: 250 });
      doc.text(String(line.quantity), 320, y, { width: 45, align: 'right' });
      doc.text(money(line.unitPrice, input.currency), 380, y, { width: 75, align: 'right' });
      doc.text(money(line.amount, input.currency), 465, y, { width: 72, align: 'right' });
      y += Math.max(18, doc.heightOfString(line.description, { width: 250 }) + 6);
    }

    doc.moveTo(50, y + 4).lineTo(545, y + 4).strokeColor('#e2e8f0').stroke();
    y += 14;
    const totalRow = (label: string, value: string, bold = false) => {
      doc.fillColor(bold ? INK : MUTED).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5);
      doc.text(label, 330, y, { width: 120, align: 'right' });
      doc.fillColor(INK).text(value, 455, y, { width: 90, align: 'right' });
      y += bold ? 20 : 16;
    };
    totalRow('Subtotal', money(input.subtotal, input.currency));
    totalRow('Tax', money(input.taxTotal, input.currency));
    totalRow('Total', money(input.total, input.currency), true);
    if (input.amountPaid) {
      totalRow('Amount paid', money(input.amountPaid, input.currency));
      totalRow('Balance due', money(input.balance ?? input.total - input.amountPaid, input.currency), true);
    }

    if (input.memo) {
      y += 10;
      doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(input.memo, 50, y, { width: 300 });
    }
    doc.fillColor(MUTED).fontSize(8).text(input.terms ?? '', 50, 760, { width: 300 });
    doc.fontSize(7.5).text('Generated by LedgerLine', 400, 775, { width: 145, align: 'right' });
    doc.end();
  });
}

export interface PdfReport {
  title: string;
  subtitle?: string;
  company: string;
  currency: string;
  sections: Array<{ label: string; total: number; lines: Array<{ label: string; amount: number }> }>;
  totals?: Array<{ label: string; amount: number }>;
  footer?: string;
}

export async function renderReportPdf(report: PdfReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, 595, 6).fill(BRAND);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(report.company, 50, 38);
    doc.fontSize(14).text(report.title, 50, 62);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(report.subtitle ?? '', 50, 82);

    let y = 112;
    for (const section of report.sections) {
      if (y > 720) {
        doc.addPage();
        y = 60;
      }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(section.label, 50, y);
      y += 16;
      doc.font('Helvetica').fontSize(9);
      for (const line of section.lines) {
        if (y > 740) {
          doc.addPage();
          y = 60;
        }
        doc.fillColor(INK).text(line.label, 60, y, { width: 380 });
        doc.text(money(line.amount, report.currency), 440, y, { width: 100, align: 'right' });
        y += 14;
      }
      doc.moveTo(60, y + 2).lineTo(540, y + 2).strokeColor('#e2e8f0').stroke();
      y += 6;
      doc.font('Helvetica-Bold').fillColor(INK).fontSize(9.5);
      doc.text(`Total ${section.label}`, 60, y, { width: 380 });
      doc.text(money(section.total, report.currency), 440, y, { width: 100, align: 'right' });
      y += 24;
      doc.font('Helvetica');
    }
    if (report.totals?.length) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Key figures', 50, y);
      y += 16;
      for (const total of report.totals) {
        doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(total.label, 60, y, { width: 380 });
        doc.fillColor(INK).text(money(total.amount, report.currency), 440, y, { width: 100, align: 'right' });
        y += 14;
      }
    }
    doc.fontSize(7.5).fillColor(MUTED).text(report.footer ?? 'Generated by LedgerLine', 50, 780, { width: 495, align: 'right' });
    doc.end();
  });
}
