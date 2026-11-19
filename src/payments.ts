/**
 * Payment interface and in-process escrow store.
 *
 * The escrow lifecycle:
 *   1. agent calls holdPayment()  → escrow created, state = 'held'
 *   2. buyer confirms receipt     → agent calls releasePayment()
 *      → state = 'released', PaymentGateway.transfer() is called
 *   3. if the buyer cancels       → agent calls refundPayment()
 *      → state = 'refunded', PaymentGateway.refund() is called
 *
 * PaymentGateway is an interface so production code can wire in
 * Wave or Orange Money without touching the escrow logic.
 */

export type PaymentProvider = 'wave' | 'orange_money';

export interface PaymentGateway {
  /**
   * Charge the buyer's wallet.
   * Returns an opaque provider reference (e.g. transaction ID).
   */
  charge(
    buyerPhone: string,
    amountFcfa: number,
    provider: PaymentProvider,
    reference: string,
  ): Promise<string>;

  /**
   * Transfer held funds to the seller.
   * `providerRef` is whatever charge() returned.
   */
  transfer(sellerPhone: string, amountFcfa: number, providerRef: string): Promise<void>;

  /**
   * Refund the buyer.
   * `providerRef` is whatever charge() returned.
   */
  refund(buyerPhone: string, amountFcfa: number, providerRef: string): Promise<void>;
}

// ── Fake implementation ──────────────────────────────────────────────────────

export class FakePaymentGateway implements PaymentGateway {
  readonly charges: Array<{ buyerPhone: string; amountFcfa: number; provider: PaymentProvider; reference: string; providerRef: string }> = [];
  readonly transfers: Array<{ sellerPhone: string; amountFcfa: number; providerRef: string }> = [];
  readonly refunds: Array<{ buyerPhone: string; amountFcfa: number; providerRef: string }> = [];

  private refCounter = 0;

  async charge(
    buyerPhone: string,
    amountFcfa: number,
    provider: PaymentProvider,
    reference: string,
  ): Promise<string> {
    const providerRef = `fake-ref-${++this.refCounter}`;
    this.charges.push({ buyerPhone, amountFcfa, provider, reference, providerRef });
    return providerRef;
  }

  async transfer(sellerPhone: string, amountFcfa: number, providerRef: string): Promise<void> {
    this.transfers.push({ sellerPhone, amountFcfa, providerRef });
  }

  async refund(buyerPhone: string, amountFcfa: number, providerRef: string): Promise<void> {
    this.refunds.push({ buyerPhone, amountFcfa, providerRef });
  }
}

// ── Escrow store ─────────────────────────────────────────────────────────────

export type EscrowState = 'held' | 'released' | 'refunded';

export type EscrowRecord = {
  id: string;
  listingId: string;
  buyerPhone: string;
  sellerPhone: string;
  amountFcfa: number;
  provider: PaymentProvider;
  providerRef: string;
  state: EscrowState;
  createdAt: Date;
  settledAt?: Date;
};

let nextEscrowId = 1;

export class EscrowStore {
  private readonly records: Map<string, EscrowRecord> = new Map();
  private readonly gateway: PaymentGateway;

  constructor(gateway: PaymentGateway) {
    this.gateway = gateway;
  }

  /**
   * Charge the buyer and park the funds in escrow.
   */
  async hold(
    listingId: string,
    buyerPhone: string,
    sellerPhone: string,
    amountFcfa: number,
    provider: PaymentProvider,
  ): Promise<EscrowRecord> {
    const id = String(nextEscrowId++);
    const providerRef = await this.gateway.charge(buyerPhone, amountFcfa, provider, id);
    const record: EscrowRecord = {
      id,
      listingId,
      buyerPhone,
      sellerPhone,
      amountFcfa,
      provider,
      providerRef,
      state: 'held',
      createdAt: new Date(),
    };
    this.records.set(id, record);
    return record;
  }

  get(id: string): EscrowRecord | undefined {
    return this.records.get(id);
  }

  /** Find the held escrow for a given listing and buyer, if any. */
  findHeld(listingId: string, buyerPhone: string): EscrowRecord | undefined {
    for (const r of this.records.values()) {
      if (r.listingId === listingId && r.buyerPhone === buyerPhone && r.state === 'held') {
        return r;
      }
    }
    return undefined;
  }

  /**
   * Buyer confirmed receipt → release funds to seller.
   */
  async release(id: string): Promise<EscrowRecord> {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`escrow_not_found:${id}`);
    if (record.state !== 'held') throw new Error(`escrow_not_held:${id}`);
    await this.gateway.transfer(record.sellerPhone, record.amountFcfa, record.providerRef);
    record.state = 'released';
    record.settledAt = new Date();
    return record;
  }

  /**
   * Buyer cancelled → refund buyer.
   */
  async refund(id: string): Promise<EscrowRecord> {
    const record = this.records.get(id);
    if (record === undefined) throw new Error(`escrow_not_found:${id}`);
    if (record.state !== 'held') throw new Error(`escrow_not_held:${id}`);
    await this.gateway.refund(record.buyerPhone, record.amountFcfa, record.providerRef);
    record.state = 'refunded';
    record.settledAt = new Date();
    return record;
  }
}
