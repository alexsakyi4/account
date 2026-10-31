import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatMoney } from '../lib/format';
import { Button, Card, ErrorState, Spinner, StatusBadge } from '../components/ui';

interface PublicInvoiceData {
  invoice: {
    id: string;
    number: string;
    issue_date: string;
    due_date: string | null;
    total: number;
    balance: number;
    currency: string;
    status: string;
    memo: string | null;
    contact_name: string;
    company_name: string;
  };
  lines: Array<{ description: string; quantity: number; unit_price: number; amount: number }>;
  paymentsEnabled: boolean;
  provider: string;
  sandbox: boolean;
}

export function PublicInvoicePage(): React.JSX.Element {
  const { token = '' } = useParams();
  const { data, loading, error, reload } = useQuery<PublicInvoiceData>(token ? `/public/invoices/${token}` : null);
  const [paying, setPaying] = useState(false);

  const pay = async () => {
    setPaying(true);
    try {
      await api.post(`/public/invoices/${token}/checkout`, {});
      toast.success('Payment submitted', 'A receipt has been emailed to you.');
      reload();
    } catch (err) {
      toast.error('Payment failed', errorMessage(err));
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-50">
        <Spinner className="h-6 w-6 text-ink-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <ErrorState message={error ?? 'This payment link is not valid.'} onRetry={reload} />
        </Card>
      </div>
    );
  }

  const { invoice, lines, sandbox } = data;
  const paid = invoice.balance <= 0;

  return (
    <div className="min-h-screen bg-ink-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-900 text-xs font-bold text-brand-300">LL</span>
            <span className="text-sm font-semibold text-ink-900">LedgerLine</span>
          </div>
          {sandbox && <span className="badge bg-violet-100 text-violet-800">Test mode</span>}
        </header>

        <Card className="overflow-hidden">
          <div className="border-b border-ink-100 px-6 py-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">{invoice.company_name}</p>
            <h1 className="mt-1 text-2xl font-semibold text-ink-900">Invoice {invoice.number}</h1>
            <p className="mt-1 text-sm text-ink-500">
              Issued {formatDate(invoice.issue_date)} · due {formatDate(invoice.due_date)} · billed to {invoice.contact_name}
            </p>
          </div>

          <div className="px-6 py-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">{paid ? 'Paid in full' : 'Amount due'}</p>
                <p className="text-3xl font-semibold text-ink-900">{formatMoney(invoice.balance, invoice.currency)}</p>
              </div>
              <StatusBadge status={paid ? 'paid' : invoice.status} />
            </div>

            <table className="w-full text-sm">
              <caption className="sr-only">Invoice lines</caption>
              <thead>
                <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
                  <th scope="col" className="py-2 text-left font-semibold">
                    Description
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index} className="border-b border-ink-50">
                    <td className="py-2">
                      {line.description}
                      <span className="ml-2 text-xs text-ink-500">
                        {line.quantity} × {formatMoney(line.unit_price, invoice.currency)}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(line.amount, invoice.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-3 flex justify-end">
              <div className="w-48 space-y-1 text-sm">
                <div className="flex justify-between text-ink-600">
                  <span>Total</span>
                  <span className="tabular-nums">{formatMoney(invoice.total, invoice.currency)}</span>
                </div>
                <div className="flex justify-between border-t border-ink-200 pt-1 font-semibold text-ink-900">
                  <span>Balance</span>
                  <span className="tabular-nums">{formatMoney(invoice.balance, invoice.currency)}</span>
                </div>
              </div>
            </div>

            {invoice.memo && <p className="mt-4 whitespace-pre-wrap text-sm text-ink-600">{invoice.memo}</p>}
          </div>

          <div className="border-t border-ink-100 bg-ink-50 px-6 py-4">
            {paid ? (
              <p className="text-sm font-medium text-brand-800">Thank you — this invoice is settled.</p>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-sm text-xs text-ink-500">
                  Card payments are processed by a PCI-compliant provider. LedgerLine never sees your card details.
                </p>
                <Button variant="primary" loading={paying} onClick={() => void pay()}>
                  Pay {formatMoney(invoice.balance, invoice.currency)}
                </Button>
              </div>
            )}
          </div>
        </Card>

        <p className="mt-6 text-center text-xs text-ink-500">
          Questions about this invoice? Reply to the email you received or contact {invoice.company_name} directly.
        </p>
      </div>
    </div>
  );
}
