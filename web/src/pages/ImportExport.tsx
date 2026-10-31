import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { download, errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, titleCase, today } from '../lib/format';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
  Tabs,
} from '../components/ui';

interface Template {
  kind: string;
  label: string;
  description: string;
  columns: string[];
  sample: Array<Record<string, string>>;
}

interface PreviewRow {
  row: number;
  action: string;
  values?: Record<string, unknown>;
  errors?: string[];
}

interface PreviewResult {
  kind: string;
  mapping: Record<string, string>;
  detected: Record<string, string>;
  validRows: number;
  errorRows: number;
  rows: Array<PreviewRow & { errors: string[]; status: string; summary?: string }>;
  errors: Array<{ row: number; field?: string; message: string }>;
  sample?: Array<Record<string, unknown>>;
  valid?: number;
  invalid?: number;
}

const KIND_LABELS: Record<string, string> = {
  accounts: 'Chart of accounts',
  customers: 'Customers',
  vendors: 'Vendors',
  invoices: 'Invoices',
  bills: 'Bills',
  journal: 'Journal entries',
  items: 'Products & services',
  transactions: 'Bank transactions',
};

export function ImportExportPage(): React.JSX.Element {
  const [tab, setTab] = useState<'import' | 'history'>('import');
  const [kind, setKind] = useState('customers');
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: templateData } = useQuery<{ kinds: Template[] }>('/imports/templates');
  const { data: history, reload: reloadHistory } = useQuery<{ data: Array<{ id: string; kind: string; filename: string | null; status: string; total_rows: number; imported_rows: number; error_rows: number; created_at: string }> }>('/imports/history');

  const template = templateData?.kinds.find((entry) => entry.kind === kind);

  const runPreview = async () => {
    if (!csv.trim()) {
      setError('Paste or upload a CSV first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<PreviewResult>('/imports/preview', { kind, csv });
      setPreview(result);
      toast.success('Dry run complete', `${result.validRows} valid, ${result.errorRows} with problems.`);
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ imported: number; skipped: number; errors: number; jobId: string }>('/imports/execute', {
        kind,
        csv,
        filename: file ?? undefined,
      });
      toast.success('Import finished', `${result.imported} rows imported, ${result.skipped} skipped.`);
      setConfirmImport(false);
      setPreview(null);
      setCsv('');
      setFile(null);
      reloadHistory();
      setTab('history');
    } catch (err) {
      setError(errorMessage(err));
      setConfirmImport(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Import & export"
        description="Bring data in from other accounting systems, or take a complete copy with you."
        actions={
          <>
            <Button variant="secondary" onClick={() => void download('/export/all', `ledgerline-export-${today()}.csv`)}>
              Export everything
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (!template) return;
                const headers = template.columns.join(',');
                const rows = template.sample.map((row) => template.columns.map((column) => row[column] ?? '').join(','));
                const blob = new Blob([[headers, ...rows].join('\n')], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = `${kind}-template.csv`;
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download CSV template
            </Button>
          </>
        }
      />

      <div className="mb-6 border-b border-ink-200">
        <Tabs
          ariaLabel="Import or history"
          value={tab}
          onChange={(value) => setTab(value as 'import' | 'history')}
          tabs={[
            { id: 'import', label: 'Import a file' },
            { id: 'history', label: 'Import history' },
          ]}
        />
      </div>

      {tab === 'import' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Upload CSV" description="QuickBooks-style headers are detected automatically." />
            <div className="space-y-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="What are you importing?" htmlFor="import-kind">
                  <Select id="import-kind" value={kind} onChange={(event) => { setKind(event.target.value); setPreview(null); }}>
                    {(templateData?.kinds ?? []).map((entry) => (
                      <option key={entry.kind} value={entry.kind}>
                        {entry.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex items-end gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    className="sr-only"
                    onChange={async (event) => {
                      const selected = event.target.files?.[0];
                      if (!selected) return;
                      setFile(selected.name);
                      setCsv(await selected.text());
                      setPreview(null);
                    }}
                  />
                  <Button onClick={() => fileRef.current?.click()}>Choose file</Button>
                  {csv && <span className="text-xs text-ink-500">{file ?? 'Pasted CSV'}</span>}
                </div>
              </div>

              {template && (
                <div className="rounded-lg bg-ink-50 p-3 text-xs text-ink-600">
                  <p className="font-medium text-ink-800">{template.label}</p>
                  <p className="mt-0.5">{template.description}</p>
                  <p className="mt-1 font-mono text-[11px] text-ink-500">{template.columns.join(' · ')}</p>
                </div>
              )}

              <Field label="CSV content" htmlFor="import-csv" hint="Nothing is written until you review the dry run and confirm.">
                <textarea
                  id="import-csv"
                  value={csv}
                  onChange={(event) => {
                    setCsv(event.target.value);
                    setPreview(null);
                  }}
                  className="input min-h-48 font-mono text-xs"
                  placeholder={template ? template.columns.join(',') : 'Customer,Email,Terms'}
                />
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={busy} onClick={() => void runPreview()}>
                  Validate (dry run)
                </Button>
                {preview && preview.validRows > 0 && (
                  <Button variant="secondary" onClick={() => setConfirmImport(true)}>
                    Import {preview.validRows} rows
                  </Button>
                )}
              </div>
              {preview && <p className="text-xs text-ink-500">Detected mapping: {Object.entries(preview.mapping ?? {}).map(([from, to]) => `${from} → ${to}`).join(', ') || 'none'}</p>}
              {error && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                  {error}
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Review" description="Row-level validation before anything is saved." />
            <div className="p-5">
              {!preview ? (
                <EmptyState title="No dry run yet" description="Validate your file to see what will be imported." />
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-lg bg-brand-50 p-3">
                      <p className="text-lg font-semibold text-brand-900">{preview.validRows}</p>
                      <p className="text-xs text-brand-800">Ready</p>
                    </div>
                    <div className="rounded-lg bg-red-50 p-3">
                      <p className="text-lg font-semibold text-red-800">{preview.errorRows}</p>
                      <p className="text-xs text-red-700">Problems</p>
                    </div>
                  </div>
                  {preview.errors?.length > 0 && (
                    <ul className="max-h-60 space-y-1 overflow-auto rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                      {preview.errors.slice(0, 12).map((row, index) => (
                        <li key={`${row.row}-${index}`}>
                          Row {row.row}
                          {row.field ? ` · ${row.field}` : ''}: {row.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-ink-500">
                    Rows with problems are skipped; the rest import. Fix and re-run the dry run to include them.
                  </p>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === 'history' && (
        <Card className="overflow-hidden">
          <CardHeader title="Import history" description="Every batch keeps its mapping and row results." />
          {!history ? (
            <TableSkeleton rows={4} columns={5} />
          ) : (
            <Table caption="Import history">
              <THead>
                <tr>
                  <TH>Date</TH>
                  <TH>Type</TH>
                  <TH>File</TH>
                  <TH numeric>Rows</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <tbody>
                {history.data.map((job) => (
                  <TR key={job.id}>
                    <TD>{formatDate(job.created_at.slice(0, 10), 'short')}</TD>
                    <TD>{KIND_LABELS[job.kind] ?? titleCase(job.kind)}</TD>
                    <TD className="max-w-48 truncate text-xs">{job.filename ?? 'Pasted CSV'}</TD>
                    <TD numeric>
                      {job.imported_rows} / {job.total_rows}
                      {job.error_rows > 0 && <span className="ml-1 text-red-700">({job.error_rows} errors)</span>}
                    </TD>
                    <TD>
                      <StatusBadge status={job.status === 'completed' ? 'paid' : job.status} label={titleCase(job.status)} />
                    </TD>
                  </TR>
                ))}
                {!history.data.length && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-sm text-ink-500">
                      No imports yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <Card className="mt-6 p-5">
        <h2 className="text-sm font-semibold text-ink-900">Export formats</h2>
        <p className="mt-1 text-xs text-ink-500">
          CSV exports use stable column names and are suitable for spreadsheet review or migration to another system. PDFs are
          templates rendered by the API. The REST API and webhooks cover everything else.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void download('/export/all', `ledgerline-export-${today()}.csv`)}>
            Full export (CSV)
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void download('/journal-entries/export', 'journal-entries.csv')}>
            Journal entries
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void download('/reports/profit-and-loss/export?format=csv', 'profit-and-loss.csv')}>
            P&amp;L
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmImport}
        title={`Import ${preview?.validRows ?? 0} rows?`}
        description={`${preview?.errorRows ?? 0} rows with problems will be skipped. This cannot be undone automatically — you can delete imported records individually.`}
        confirmLabel="Run import"
        loading={busy}
        onConfirm={() => void runImport()}
        onClose={() => setConfirmImport(false)}
      />
    </>
  );
}
