/**
 * Listing store – pure in-memory, no persistence yet.
 *
 * A listing is created from a seller's voice note.
 * parseTranscript() does the lightest possible NLP: it looks for a
 * price written as digits (optionally followed by "fcfa", "cfa",
 * "f", or "fr") and treats everything else as the product name.
 *
 * Examples that parse correctly (case-insensitive):
 *   "Tomates fraîches 500 FCFA"           → { product: "tomates fraîches", price: 500 }
 *   "Poulet braisé, 2500f"                → { product: "poulet braisé,", price: 2500 }
 *   "Attiéké poisson 3000 cfa le plat"    → { product: "attiéké poisson", price: 3000 }  *
 *   (* words after the price are dropped)
 */

export type Listing = {
  id: string;
  product: string;
  priceFcfa: number;
  sellerPhone: string;
  createdAt: Date;
};

/** Returned by parseTranscript when the text is too vague to list. */
export type ParseFailure = { ok: false; reason: string };
export type ParseSuccess = { ok: true; product: string; priceFcfa: number };
export type ParseResult = ParseSuccess | ParseFailure;

// Matches the first occurrence of a bare integer followed by an
// optional currency suffix. We capture everything before it as the
// product name and discard the rest.
const PRICE_RE = /^(.*?)\b(\d+)\s*(?:fcfa|cfa|francs?|fr?)\b(.*)$/i;

// Fallback: a bare integer at the end of the string with no suffix.
const BARE_NUMBER_RE = /^(.+?)\s+(\d+)\s*$/;

export function parseTranscript(transcript: string): ParseResult {
  const trimmed = transcript.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty_transcript' };
  }

  let product = '';
  let priceFcfa = 0;

  const withSuffix = PRICE_RE.exec(trimmed);
  if (withSuffix !== null) {
    product = withSuffix[1].trim().replace(/,\s*$/, '');
    priceFcfa = parseInt(withSuffix[2], 10);
  } else {
    const bare = BARE_NUMBER_RE.exec(trimmed);
    if (bare !== null) {
      product = bare[1].trim().replace(/,\s*$/, '');
      priceFcfa = parseInt(bare[2], 10);
    }
  }

  if (priceFcfa <= 0) {
    // No price was parsed. Use digit presence to pick the right reason:
    // - digits in the input but no product text extracted → no_product_name
    //   (e.g. a bare "500" where the bare-number regex needs preceding text)
    // - no digits at all, or digits present alongside text → no_price
    const hasDigit = /\d/.test(trimmed);
    if (hasDigit && product === '') {
      return { ok: false, reason: 'no_product_name' };
    }
    return { ok: false, reason: 'no_price' };
  }
  if (product === '') {
    return { ok: false, reason: 'no_product_name' };
  }

  return { ok: true, product, priceFcfa };
}

/**
 * Search relevance: a listing matches a query when every word of the
 * query appears in the product name (case-insensitive, accent-folded
 * via locale-aware lower-casing).  Simple but enough for an MVP.
 */
function normalize(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function matchesQuery(listing: Listing, query: string): boolean {
  const haystack = normalize(listing.product);
  const needles = normalize(query).split(/\s+/).filter((w) => w.length > 0);
  return needles.every((n) => haystack.includes(n));
}

let nextId = 1;

export class ListingStore {
  private readonly listings: Map<string, Listing> = new Map();

  /**
   * Create a listing from a parsed transcript.
   * Idempotency is not enforced at this layer – the agent layer
   * decides whether to deduplicate.
   */
  create(product: string, priceFcfa: number, sellerPhone: string): Listing {
    const id = String(nextId++);
    const listing: Listing = {
      id,
      product,
      priceFcfa,
      sellerPhone,
      createdAt: new Date(),
    };
    this.listings.set(id, listing);
    return listing;
  }

  get(id: string): Listing | undefined {
    return this.listings.get(id);
  }

  search(query: string): Listing[] {
    if (query.trim() === '') return [];
    const results: Listing[] = [];
    for (const listing of this.listings.values()) {
      if (matchesQuery(listing, query)) results.push(listing);
    }
    return results;
  }

  all(): Listing[] {
    return [...this.listings.values()];
  }
}
