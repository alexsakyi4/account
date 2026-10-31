import { useState } from 'react';
import { api } from '../lib/api';
import { errorMessage, toast, useQuery } from '../lib/data';
import { formatDate, formatMoney, formatNumber, titleCase, today, toMinor } from '../lib/format';
import { useSession } from '../lib/session';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  Money,
  PageHeader,
  Select,
  StatCard,
  StatusBadge,
  Table,
  TableSkeleton,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  Textarea,
} from '../components/ui';

interface Item {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  item_type: string;
  sales_price: number;
  purchase_cost: number;
  income_account_id: string | null;
  quantity_on_hand: number;
  reorder_point: number | null;
  is_active: number;
}

interface Movement {
  id: string;
  item_id: string;
  movement_type: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  reference: string | null;
  created_at: string;
  item_name: string;
  sku: string;
}

export function InventoryPage(): React.JSX.Element {
  const { session, can } = useSession();
  const currency = session?.tenant.currency ?? 'USD';
  const [view, setView] = useState<'items' | 'movements'>('items');
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<Item | null>(null);

  const { data, loading, error, reload } = useQuery<{ data: Item[] }>('/items', { pageSize: 200 });
  const { data: valuation, reload: reloadValuation } = useQuery<{ rows: Array<{ sku: string; name: string; quantity_on_hand: number; purchase_cost: number; value: number }>; totalValue: number }>(
    '/inventory/valuation',
  );
  const { data: movements, loading: movementsLoading } = useQuery<{ data: Movement[] }>(view === 'movements' ? '/inventory/movements' : null, { pageSize: 100 });

  const items = data?.data ?? [];
  const stockValue = valuation?.totalValue ?? items.reduce((sum, item) => sum + item.quantity_on_hand * item.purchase_cost, 0);
  const lowStock = items.filter((item) => item.reorder_point !== null && item.quantity_on_hand <= (item.reorder_point ?? 0));

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Track stock, cost of goods sold and adjustments. Posting an invoice consumes stock automatically."
        actions={
          can('inventory:manage') ? (
            <Button variant="primary" onClick={() => setEditing('new')}>
              + New item
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Stock value" value={<Money amount={stockValue} currency={currency} />} hint="At weighted purchase cost" />
        <StatCard label="Active items" value={String(items.filter((item) => item.is_active).length)} hint={`${items.length} total`} />
        <StatCard label="Low stock" value={String(lowStock.length)} tone={lowStock.length ? 'warning' : 'default'} hint="At or below reorder point" />
        <StatCard
          label="Units on hand"
          value={formatNumber(items.reduce((sum, item) => sum + item.quantity_on_hand, 0), 0)}
          hint="Across all inventory items"
        />
      </div>

      {lowStock.length > 0 && (
        <Card className="mt-4 border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Reorder soon</p>
          <p className="mt-1 text-xs text-amber-800">
            {lowStock.map((item) => `${item.name} (${formatNumber(item.quantity_on_hand, 0)} left)`).join(' · ')}
          </p>
        </Card>
      )}

      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-ink-200 px-4 pt-3">
          <Tabs
            ariaLabel="Inventory views"
            value={view}
            onChange={(value) => setView(value as 'items' | 'movements')}
            tabs={[
              { id: 'items', label: 'Items' },
              { id: 'movements', label: 'Stock movements' },
            ]}
          />
        </div>

        {view === 'items' ? (
          loading && !data ? (
            <TableSkeleton rows={5} columns={5} />
          ) : error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : items.length === 0 ? (
            <EmptyState title="No items yet" description="Add inventory items to track stock and cost of goods sold." />
          ) : (
            <Table caption="Items">
              <THead>
                <tr>
                  <TH>SKU</TH>
                  <TH>Item</TH>
                  <TH>Type</TH>
                  <TH numeric>On hand</TH>
                  <TH numeric>Cost</TH>
                  <TH numeric>Price</TH>
                  <TH numeric>Value</TH>
                  <TH>Actions</TH>
                </tr>
              </THead>
              <tbody>
                {items.map((item) => (
                  <TR key={item.id}>
                    <TD className="font-mono text-xs">{item.sku}</TD>
                    <TD>
                      <p className="font-medium text-ink-900">{item.name}</p>
                      {item.description && <p className="text-xs text-ink-500">{item.description}</p>}
                    </TD>
                    <TD className="text-xs capitalize">{titleCase(item.item_type)}</TD>
                    <TD numeric>{formatNumber(item.quantity_on_hand, 2)}</TD>
                    <TD numeric>{formatMoney(item.purchase_cost, currency)}</TD>
                    <TD numeric>{formatMoney(item.sales_price, currency)}</TD>
                    <TD numeric>{formatMoney(item.quantity_on_hand * item.purchase_cost, currency)}</TD>
                    <TD>
                      {can('inventory:manage') && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(item)}>
                            Edit
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setAdjusting(item)}>
                            Adjust
                          </Button>
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          )
        ) : movementsLoading ? (
          <TableSkeleton rows={5} columns={4} />
        ) : (
          <Table caption="Stock movements">
            <THead>
              <tr>
                <TH>Date</TH>
                <TH>Item</TH>
                <TH>Type</TH>
                <TH numeric>Quantity</TH>
                <TH numeric>Value</TH>
                <TH>Reference</TH>
              </tr>
            </THead>
            <tbody>
              {(movements?.data ?? []).map((movement) => (
                <TR key={movement.id}>
                  <TD>{formatDate(movement.created_at.slice(0, 10), 'short')}</TD>
                  <TD>
                    {movement.sku} — {movement.item_name}
                  </TD>
                  <TD>
                    <StatusBadge
                      status={movement.movement_type === 'sale' ? 'sent' : movement.movement_type === 'adjustment' ? 'partial' : 'paid'}
                      label={titleCase(movement.movement_type)}
                    />
                  </TD>
                  <TD numeric>{formatNumber(movement.quantity, 2)}</TD>
                  <TD numeric>{formatMoney(movement.total_cost, currency)}</TD>
                  <TD className="text-xs text-ink-500">{movement.reference ?? '—'}</TD>
                </TR>
              ))}
              {!(movements?.data ?? []).length && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-ink-500">
                    No stock movements yet.
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <ItemForm
        key={editing === 'new' ? 'new' : (editing?.id ?? 'none')}
        open={editing !== null}
        item={editing === 'new' ? null : editing}
        currency={currency}
        onClose={() => setEditing(null)}
        onSaved={() => {
          reload();
          reloadValuation();
        }}
      />

      <AdjustModal
        item={adjusting}
        onClose={() => setAdjusting(null)}
        onSaved={() => {
          reload();
          reloadValuation();
        }}
      />
    </>
  );
}

function ItemForm({
  open,
  item,
  currency,
  onClose,
  onSaved,
}: {
  open: boolean;
  item: Item | null;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sku, setSku] = useState(item?.sku ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [itemType, setItemType] = useState(item?.item_type ?? 'inventory');
  const [salesPrice, setSalesPrice] = useState(item ? (item.sales_price / 100).toFixed(2) : '');
  const [purchaseCost, setPurchaseCost] = useState(item ? (item.purchase_cost / 100).toFixed(2) : '');
  const [openingQty, setOpeningQty] = useState('0');
  const [reorderPoint, setReorderPoint] = useState(item?.reorder_point ? String(item.reorder_point) : '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        sku,
        name,
        itemType,
        salesPrice: toMinor(salesPrice),
        purchaseCost: toMinor(purchaseCost),
        reorderPoint: reorderPoint ? Number(reorderPoint) : null,
        description: description || undefined,
        ...(item ? {} : { quantityOnHand: Number(openingQty) || 0 }),
      };
      if (item) await api.patch(`/items/${item.id}`, payload);
      else await api.post('/items', payload);
      toast.success(item ? 'Item updated' : 'Item created');
      onSaved();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item ? `Edit ${item.name}` : 'New item'}
      description="Inventory items post COGS when invoiced and reclass purchases to stock when received."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Save item
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SKU" required htmlFor="item-sku">
          <Input id="item-sku" value={sku} onChange={(event) => setSku(event.target.value)} />
        </Field>
        <Field label="Name" required htmlFor="item-name">
          <Input id="item-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Type" htmlFor="item-type">
          <Select id="item-type" value={itemType} onChange={(event) => setItemType(event.target.value)}>
            <option value="inventory">Inventory</option>
            <option value="service">Service</option>
            <option value="non_inventory">Non-inventory</option>
          </Select>
        </Field>
        <Field label="Reorder point" htmlFor="item-reorder">
          <Input id="item-reorder" inputMode="numeric" value={reorderPoint} onChange={(event) => setReorderPoint(event.target.value)} placeholder="10" />
        </Field>
        <Field label={`Sales price (${currency})`} htmlFor="item-price">
          <Input id="item-price" inputMode="decimal" className="text-right" value={salesPrice} onChange={(event) => setSalesPrice(event.target.value)} />
        </Field>
        <Field label={`Purchase cost (${currency})`} htmlFor="item-cost">
          <Input id="item-cost" inputMode="decimal" className="text-right" value={purchaseCost} onChange={(event) => setPurchaseCost(event.target.value)} />
        </Field>
        {!item && (
          <Field label="Opening quantity" htmlFor="item-qty">
            <Input id="item-qty" inputMode="decimal" value={openingQty} onChange={(event) => setOpeningQty(event.target.value)} />
          </Field>
        )}
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor="item-description">
            <Textarea id="item-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
        </div>
        {error && (
          <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function AdjustModal({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: () => void }) {
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('Count adjustment');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/items/${item.id}/adjust`, { date: today(), quantity: Number(quantity), reason });
      toast.success('Stock adjusted', 'An inventory movement and journal entry were recorded.');
      onSaved();
      onClose();
      setQuantity('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(item)}
      onClose={onClose}
      title={item ? `Adjust ${item.name}` : 'Adjust stock'}
      description={item ? `Currently ${formatNumber(item.quantity_on_hand, 2)} on hand.` : undefined}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Post adjustment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Quantity change" htmlFor="adjust-qty" hint="Use a negative number to reduce stock (damage, shrinkage).">
          <Input id="adjust-qty" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} placeholder="-2" />
        </Field>
        <Field label="Reason" htmlFor="adjust-reason">
          <Select id="adjust-reason" value={reason} onChange={(event) => setReason(event.target.value)}>
            {['Count adjustment', 'Damage', 'Shrinkage', 'Return to supplier', 'Opening stock'].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
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
