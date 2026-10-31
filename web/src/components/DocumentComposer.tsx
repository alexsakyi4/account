import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { daysFromNow, formatMoney, titleCase, today, toMinor } from '../lib/format';
import { useSession } from '../lib/session';
import { Button, Field, Input, Modal, MoneyInput, Select, Textarea } from './ui';

interface Contact {
  id: string;
  name: string;
  email?: string | null;
  paymentTermsDays?: number;
  kind: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive?: boolean;
}

interface TaxCode {
  id: string;
  code: string;
  name: string;
  rate_bp: number;
  is_active?: number;
}

interface Item {
  id: string;
  sku: string;
  name: string;
  item_type: string;
  sales_price: number;
  purchase_cost: number;
  income_account_id?: string | null;
  expense_account_id?: string | null;
}

interface Line {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  taxCodeId: string;
  itemId: string;
  discountBp: string;
}

export interface DocumentComposerProps {
  kind: 'invoice' | 'credit_memo' | 'estimate' | 'bill';
  open: boolean;
  onClose: () => void;
  onSaved: (id: string, options: { posted: boolean }) => void;
}

const emptyLine = (accountId = ''): Line => ({
  key: crypto.randomUUID(),
  description: '',
  quantity: '1',
  unitPrice: '',
  accountId,
  taxCodeId: '',
  itemId: '',
  discountBp: '0',
});

const LABELS = {
  invoice: { title: 'New invoice', noun: 'invoice', contact: 'Customer', contactKind: 'customer', accountType: 'income' },
  credit_memo: { title: 'New credit memo', noun: 'credit memo', contact: 'Customer', contactKind: 'customer', accountType: 'income' },
  estimate: { title: 'New estimate', noun: 'estimate', contact: 'Customer', contactKind: 'customer', accountType: 'income' },
  bill: { title: 'New bill', noun: 'bill', contact: 'Vendor', contactKind: 'vendor', accountType: 'expense' },
} as const;

export function DocumentComposer({ kind, open, onClose, onSaved }: DocumentComposerProps): React.JSX.Element {
  const { session } = useSession();
  const config = LABELS[kind];
  const currency = session?.tenant.currency ?? 'USD';
  const { data: contacts } = useQuery<{ data: Contact[] }>(open ? `/contacts?kind=${config.contactKind}&pageSize=200` : null);
  const { data: accountData } = useQuery<{ data: Account[] }>(open ? '/accounts?pageSize=300' : null);
  const { data: taxData } = useQuery<{ data: TaxCode[] }>(open ? '/tax-codes' : null);
  const { data: itemData } = useQuery<{ data: Item[] }>(open ? '/items?pageSize=200' : null);

  const [contactId, setContactId] = useState('');
  const [number, setNumber] = useState('');
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState(daysFromNow(30));
  const [memo, setMemo] = useState('');
  const [terms, setTerms] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const defaultAccountId = useMemo(() => {
    if (kind === 'bill') {
      const expense = accountData?.data.find((account) => account.type === 'expense' && account.code === '6000');
      return expense?.id ?? accountData?.data.find((account) => account.type === 'expense')?.id ?? '';
    }
    const income = accountData?.data.find((account) => account.type === 'income' && account.code === '4000');
    return income?.id ?? accountData?.data.find((account) => account.type === 'income')?.id ?? '';
  }, [accountData, kind]);

  useEffect(() => {
    if (!open) return;
    setContactId('');
    setNumber('');
    setIssueDate(today());
    setDueDate(daysFromNow(30));
    setMemo('');
    setTerms('');
    setPoNumber('');
    setError(null);
    setTouched(false);
    setLines([emptyLine()]);
  }, [open, kind]);

  useEffect(() => {
    if (!defaultAccountId) return;
    setLines((current) => current.map((line) => (line.accountId ? line : { ...line, accountId: defaultAccountId })));
  }, [defaultAccountId]);

  const selectedContact = contacts?.data.find((contact) => contact.id === contactId);
  const taxCodes = (taxData?.data ?? []).filter((code) => code.is_active !== 0);
  const accounts = (accountData?.data ?? []).filter((account) => account.isActive !== false && account.type === config.accountType);
  const items = itemData?.data ?? [];

  const totals = useMemo(() => {
    let subtotal = 0;
    let discount = 0;
    let tax = 0;
    for (const line of lines) {
      const gross = Math.round(Number.parseFloat(line.quantity || '0') * toMinor(line.unitPrice) || 0);
      const lineDiscount = Math.round((gross * Number.parseFloat(line.discountBp || '0')) / 10_000);
      const taxable = gross - lineDiscount;
      const code = taxCodes.find((entry) => entry.id === line.taxCodeId);
      subtotal += gross;
      discount += lineDiscount;
      tax += code ? Math.round((taxable * code.rate_bp) / 10_000) : 0;
    }
    return { subtotal, discount, tax, total: subtotal - discount + tax };
  }, [lines, taxCodes]);

  const updateLine = (key: string, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const applyItem = (key: string, itemId: string) => {
    const item = items.find((entry) => entry.id === itemId);
    if (!item) {
      updateLine(key, { itemId: '' });
      return;
    }
    updateLine(key, {
      itemId,
      description: item.name,
      unitPrice: ((kind === 'bill' ? item.purchase_cost : item.sales_price) / 100).toFixed(2),
      accountId:
        (kind === 'bill' ? item.expense_account_id : item.income_account_id) ?? defaultAccountId,
    });
  };

  const submit = async (postAfter: boolean) => {
    setTouched(true);
    if (!contactId) {
      setError(`Select a ${config.contact.toLowerCase()} first.`);
      return;
    }
    const prepared = lines
      .filter((line) => line.description.trim() && Number(line.quantity) > 0)
      .map((line) => ({
        description: line.description.trim(),
        quantity: Number(line.quantity),
        unitPrice: toMinor(line.unitPrice),
        accountId: line.accountId || null,
        taxCodeId: line.taxCodeId || null,
        itemId: line.itemId || null,
        discountBp: Math.round(Number(line.discountBp || '0')),
      }));
    if (!prepared.length) {
      setError('Add at least one line with a description and quantity.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload =
        kind === 'bill'
          ? {
              vendorId: contactId,
              number: number.trim() || undefined,
              issueDate,
              dueDate,
              lines: prepared,
              memo: memo || undefined,
              status: postAfter ? 'open' : 'draft',
            }
          : {
              contactId,
              kind,
              issueDate,
              dueDate,
              lines: prepared,
              memo: memo || undefined,
              terms: terms || undefined,
              poNumber: poNumber || undefined,
              status: postAfter ? 'sent' : 'draft',
            };
      const path = kind === 'bill' ? '/bills' : kind === 'estimate' ? '/invoices' : '/invoices';
      const created = await api.post<{ id: string; number: string }>(path, payload);
      toast.success(`${titleCase(kind)} ${created.number} created`, postAfter ? 'Posted to the ledger.' : 'Saved as a draft.');
      onSaved(created.id, { posted: postAfter });
      onClose();
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      toast.error('Could not save', message);
    } finally {
      setSaving(false);
    }
  };

  const documentTitle = kind === 'estimate' ? 'Estimate' : kind === 'bill' ? 'Bill' : kind === 'credit_memo' ? 'Credit memo' : 'Invoice';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={config.title}
      description={`Amounts are in ${currency}. Draft stays out of the ledger until posted.`}
      size="xl"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void submit(false)} loading={saving} variant="secondary">
            Save draft
          </Button>
          <Button onClick={() => void submit(true)} loading={saving} variant="primary">
            {kind === 'bill' ? 'Save and post' : 'Save and send'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={config.contact} required htmlFor="doc-contact">
            <Select
              id="doc-contact"
              value={contactId}
              onChange={(event) => {
                setContactId(event.target.value);
                const contact = contacts?.data.find((entry) => entry.id === event.target.value);
                if (contact && kind !== 'credit_memo' && kind !== 'estimate') {
                  setDueDate(daysFromNow(contact.paymentTermsDays ?? 30));
                }
              }}
            >
              <option value="">Select {config.contact.toLowerCase()}…</option>
              {(contacts?.data ?? []).map((contact) => (
                <option key={contact.id} value={contact.id}>
                  {contact.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`${documentTitle} number`} htmlFor="doc-number" hint="Leave blank to use the next number in the sequence.">
            <Input
              id="doc-number"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              placeholder="Auto"
              disabled={kind === 'invoice' || kind === 'credit_memo' || kind === 'estimate'}
              readOnly={kind !== 'bill'}
            />
          </Field>
          <Field label={kind === 'estimate' ? 'Estimate date' : kind === 'bill' ? 'Bill date' : 'Invoice date'} htmlFor="doc-issue">
            <Input id="doc-issue" type="date" value={issueDate} onChange={(event) => setIssueDate(event.target.value)} />
          </Field>
          <Field label={kind === 'estimate' ? 'Expires' : 'Due date'} htmlFor="doc-due">
            <Input id="doc-due" type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </Field>
        </div>

        {selectedContact?.email && <p className="text-xs text-ink-500">Will be emailed to {selectedContact.email}</p>}

        <div className="rounded-lg border border-ink-200">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
            <h3 className="text-sm font-semibold text-ink-900">Lines</h3>
            <Button size="sm" variant="ghost" onClick={() => setLines((current) => [...current, emptyLine(defaultAccountId)])}>
              + Add line
            </Button>
          </div>
          <div className="space-y-3 p-4">
            {lines.map((line, index) => {
              const gross = Math.round(Number.parseFloat(line.quantity || '0') * toMinor(line.unitPrice) || 0);
              const discount = Math.round((gross * Number.parseFloat(line.discountBp || '0')) / 10_000);
              const code = taxCodes.find((entry) => entry.id === line.taxCodeId);
              const lineTax = code ? Math.round(((gross - discount) * code.rate_bp) / 10_000) : 0;
              return (
                <div key={line.key} className="grid gap-2 rounded-md bg-ink-50 p-3 sm:grid-cols-12">
                  <div className="sm:col-span-4">
                    <label className="label" htmlFor={`desc-${line.key}`}>
                      Description {index + 1}
                    </label>
                    <Input
                      id={`desc-${line.key}`}
                      value={line.description}
                      onChange={(event) => updateLine(line.key, { description: event.target.value })}
                      placeholder="What are you billing for?"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor={`qty-${line.key}`}>
                      Qty
                    </label>
                    <Input
                      id={`qty-${line.key}`}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                      className="text-right"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor={`price-${line.key}`}>
                      Unit price
                    </label>
                    <MoneyInput
                      id={`price-${line.key}`}
                      currency={currency}
                      value={line.unitPrice}
                      onChange={(value) => updateLine(line.key, { unitPrice: value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor={`account-${line.key}`}>
                      Account
                    </label>
                    <Select
                      id={`account-${line.key}`}
                      value={line.accountId}
                      onChange={(event) => updateLine(line.key, { accountId: event.target.value })}
                    >
                      <option value="">Auto</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} {account.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label" htmlFor={`tax-${line.key}`}>
                      Tax
                    </label>
                    <Select
                      id={`tax-${line.key}`}
                      value={line.taxCodeId}
                      onChange={(event) => updateLine(line.key, { taxCodeId: event.target.value })}
                    >
                      <option value="">None</option>
                      {taxCodes.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.code} ({(entry.rate_bp / 100).toFixed(0)}%)
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="flex items-end justify-between gap-2 sm:col-span-12">
                    <div className="flex flex-wrap items-end gap-3">
                      {items.length > 0 && (
                        <div>
                          <label className="label" htmlFor={`item-${line.key}`}>
                            Item
                          </label>
                          <Select
                            id={`item-${line.key}`}
                            value={line.itemId}
                            onChange={(event) => applyItem(line.key, event.target.value)}
                            className="max-w-56"
                          >
                            <option value="">No item</option>
                            {items.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.sku} — {item.name}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      <div>
                        <label className="label" htmlFor={`discount-${line.key}`}>
                          Discount %
                        </label>
                        <Input
                          id={`discount-${line.key}`}
                          inputMode="decimal"
                          className="w-20 text-right"
                          value={(Number.parseFloat(line.discountBp || '0') / 100).toString()}
                          onChange={(event) => updateLine(line.key, { discountBp: String(toMinor(event.target.value) / 100) })}
                        />
                      </div>
                    </div>
                    <div className="flex items-end gap-3">
                      <p className="text-sm text-ink-600">
                        Line total <span className="font-semibold text-ink-900">{formatMoney(gross - discount + lineTax, currency)}</span>
                      </p>
                      {lines.length > 1 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setLines((current) => current.filter((entry) => entry.key !== line.key))}
                          aria-label={`Remove line ${index + 1}`}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <dl className="space-y-1 border-t border-ink-100 px-4 py-3 text-sm">
            <div className="flex justify-between text-ink-600">
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(totals.subtotal, currency)}</dd>
            </div>
            {totals.discount > 0 && (
              <div className="flex justify-between text-ink-600">
                <dt>Discount</dt>
                <dd className="tabular-nums">−{formatMoney(totals.discount, currency)}</dd>
              </div>
            )}
            <div className="flex justify-between text-ink-600">
              <dt>Tax</dt>
              <dd className="tabular-nums">{formatMoney(totals.tax, currency)}</dd>
            </div>
            <div className="flex justify-between border-t border-ink-100 pt-1 text-base font-semibold text-ink-900">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(totals.total, currency)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Note to recipient" htmlFor="doc-memo">
            <Textarea id="doc-memo" value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Project reference, thanks, etc." />
          </Field>
          <div className="space-y-4">
            {kind !== 'bill' && (
              <>
                <Field label="Terms" htmlFor="doc-terms">
                  <Input id="doc-terms" value={terms} onChange={(event) => setTerms(event.target.value)} placeholder="Net 30" />
                </Field>
                <Field label="PO number" htmlFor="doc-po">
                  <Input id="doc-po" value={poNumber} onChange={(event) => setPoNumber(event.target.value)} />
                </Field>
              </>
            )}
          </div>
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
        {touched && !contactId && <p className="sr-only">A {config.contact.toLowerCase()} is required.</p>}
      </div>
    </Modal>
  );
}

export function PaymentModal({
  open,
  onClose,
  invoiceId,
  billId,
  contactId,
  balance,
  currency,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId?: string;
  billId?: string;
  contactId?: string;
  balance: number;
  currency: string;
  onPaid: () => void;
}): React.JSX.Element {
  const { data: bankData } = useQuery<{ data: Array<{ id: string; name: string; accountId: string; balance: number }> }>(open ? '/banking/accounts' : null);
  const { data: accountData } = useQuery<{ data: Array<{ id: string; code: string; name: string; type: string; subtype: string | null }> }>(
    open ? '/accounts?pageSize=300' : null,
  );
  const [amount, setAmount] = useState((balance / 100).toFixed(2));
  const [method, setMethod] = useState('bank_transfer');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const depositOptions = useMemo(() => {
    const banks = (bankData?.data ?? []).map((account) => ({ id: account.accountId, label: `${account.name} (${account.id ? 'bank' : ''})` }));
    if (banks.length) return banks;
    return (accountData?.data ?? [])
      .filter((account) => account.type === 'asset' && (account.subtype === 'bank' || account.subtype === 'cash'))
      .map((account) => ({ id: account.id, label: `${account.code} ${account.name}` }));
  }, [bankData, accountData]);

  const [depositAccountId, setDepositAccountId] = useState('');

  useEffect(() => {
    setAmount((balance / 100).toFixed(2));
    setError(null);
    setReference('');
    setMethod('bank_transfer');
    setDate(today());
  }, [balance, open]);

  useEffect(() => {
    if (!depositAccountId && depositOptions.length) setDepositAccountId(depositOptions[0].id);
  }, [depositOptions, depositAccountId]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/payments', {
        direction: invoiceId ? 'receipt' : 'disbursement',
        contactId: contactId ?? null,
        date,
        amount: toMinor(amount),
        method,
        reference: reference || undefined,
        depositAccountId: depositAccountId || null,
        applications: invoiceId ? [{ invoiceId, amount: toMinor(amount) }] : billId ? [{ billId, amount: toMinor(amount) }] : [],
      });
      toast.success('Payment recorded', `${formatMoney(toMinor(amount), currency)} applied.`);
      onPaid();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={invoiceId ? 'Record a payment received' : 'Pay a bill'}
      description={`Outstanding balance ${formatMoney(balance, currency)}`}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount" required htmlFor="pay-amount">
            <MoneyInput id="pay-amount" currency={currency} value={amount} onChange={setAmount} />
          </Field>
          <Field label="Date" htmlFor="pay-date">
            <Input id="pay-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </Field>
          <Field label="Method" htmlFor="pay-method">
            <Select id="pay-method" value={method} onChange={(event) => setMethod(event.target.value)}>
              {['bank_transfer', 'card', 'ach', 'cash', 'check', 'other'].map((option) => (
                <option key={option} value={option}>
                  {titleCase(option)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={invoiceId ? 'Deposit to' : 'Pay from'} htmlFor="pay-deposit">
            <Select id="pay-deposit" value={depositAccountId} onChange={(event) => setDepositAccountId(event.target.value)}>
              {depositOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Reference" htmlFor="pay-ref" hint="Bank reference, cheque number or provider id.">
          <Input id="pay-ref" value={reference} onChange={(event) => setReference(event.target.value)} />
        </Field>
        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
