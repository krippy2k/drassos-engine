export interface Customer {
  id: string;
  name: string;
  email: string;
  tier: "standard" | "gold";
}

export interface Order {
  id: string;
  customerId: string;
  total: number;
  createdAt: string;
}

export interface RefundRecord {
  id: string;
  customerId: string;
  amount: number;
  reason: string;
  issuedAt: string;
  idempotencyKey: string;
}

const customers: Record<string, Customer> = {
  cust_100: {
    id: "cust_100",
    name: "Amelia Chen",
    email: "amelia@example.com",
    tier: "gold",
  },
  cust_200: {
    id: "cust_200",
    name: "Jonah Hale",
    email: "jonah@example.com",
    tier: "standard",
  },
};

const orders: Order[] = [
  { id: "ord_1", customerId: "cust_100", total: 180, createdAt: "2026-08-01T12:00:00.000Z" },
  { id: "ord_2", customerId: "cust_100", total: 45, createdAt: "2026-08-20T12:00:00.000Z" },
  { id: "ord_3", customerId: "cust_200", total: 60, createdAt: "2026-09-01T12:00:00.000Z" },
];

const refundHistory: RefundRecord[] = [
  {
    id: "ref_old_1",
    customerId: "cust_100",
    amount: 20,
    reason: "missing item",
    issuedAt: "2026-07-01T12:00:00.000Z",
    idempotencyKey: "seed",
  },
];

const issuedByKey = new Map<string, RefundRecord>();
export const counters = {
  loadCustomer: 0,
  issueRefund: 0,
  lookupOrders: 0,
  lookupRefundHistory: 0,
};

export function resetDemoData(): void {
  issuedByKey.clear();
  counters.loadCustomer = 0;
  counters.issueRefund = 0;
  counters.lookupOrders = 0;
  counters.lookupRefundHistory = 0;
}

export async function loadCustomer(customerId: string): Promise<Customer> {
  counters.loadCustomer += 1;
  const customer = customers[customerId];
  if (!customer) {
    throw new Error(`Customer not found: ${customerId}`);
  }
  return customer;
}

export async function lookupOrders(customerId: string): Promise<Order[]> {
  counters.lookupOrders += 1;
  return orders.filter((order) => order.customerId === customerId);
}

export async function lookupRefundHistory(customerId: string): Promise<RefundRecord[]> {
  counters.lookupRefundHistory += 1;
  return [
    ...refundHistory.filter((item) => item.customerId === customerId),
    ...[...issuedByKey.values()].filter((item) => item.customerId === customerId),
  ];
}

export async function issueRefund(input: {
  customerId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
}): Promise<RefundRecord> {
  const existing = issuedByKey.get(input.idempotencyKey);
  if (existing) {
    return existing;
  }
  counters.issueRefund += 1;
  const record: RefundRecord = {
    id: `ref_${issuedByKey.size + 1}`,
    customerId: input.customerId,
    amount: input.amount,
    reason: input.reason,
    issuedAt: new Date().toISOString(),
    idempotencyKey: input.idempotencyKey,
  };
  issuedByKey.set(input.idempotencyKey, record);
  return record;
}
