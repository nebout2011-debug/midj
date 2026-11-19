/**
 * Core agent loop for Midj.
 *
 * Message routing (all matching is case-insensitive and trim()d):
 *
 *   Incoming audio  → transcribe → parseTranscript → create listing
 *                   → reply "✅ Annonce créée : <product> à <price> FCFA"
 *
 *   "cherche <query>"           → search listings → reply formatted list
 *   "commande <listingId>"      → start order dialog → ask for provider
 *   "wave <listingId>"          → hold payment via Wave
 *   "orange <listingId>"        → hold payment via Orange Money
 *   "reçu <listingId>"          → confirm receipt → release escrow
 *   "annuler <listingId>"       → cancel → refund escrow
 *
 * Unknown text → "Commandes : cherche <produit> | commande <id> | reçu <id>"
 *
 * Errors (parse failure, listing not found, escrow conflict) are
 * reported back as user-visible French messages so the conversation
 * stays coherent.
 */

import type { Transcriber } from './transcription.ts';
import { parseTranscript, ListingStore } from './listings.ts';
import type { Listing } from './listings.ts';
import { EscrowStore } from './payments.ts';
import type { PaymentProvider } from './payments.ts';

export type AgentMessage =
  | { type: 'text'; from: string; body: string }
  | { type: 'audio'; from: string; mediaId: string };

export type AgentReply = { to: string; text: string };

const HELP =
  'Commandes : cherche <produit> | commande <id> | wave <id> | orange <id> | reçu <id> | annuler <id>';

function formatListing(l: Listing): string {
  return `[${l.id}] ${l.product} – ${l.priceFcfa.toLocaleString('fr-FR')} FCFA (vendeur: ${l.sellerPhone})`;
}

export class Agent {
  private readonly transcriber: Transcriber;
  private readonly listings: ListingStore;
  private readonly escrow: EscrowStore;

  constructor(transcriber: Transcriber, listings: ListingStore, escrow: EscrowStore) {
    this.transcriber = transcriber;
    this.listings = listings;
    this.escrow = escrow;
  }

  async handle(message: AgentMessage): Promise<AgentReply> {
    if (message.type === 'audio') {
      return this.handleAudio(message.from, message.mediaId);
    }
    return this.handleText(message.from, message.body);
  }

  // ── Audio path ─────────────────────────────────────────────────────────────

  private async handleAudio(from: string, mediaId: string): Promise<AgentReply> {
    const transcript = await this.transcriber.transcribe(mediaId);
    const parsed = parseTranscript(transcript);
    if (!parsed.ok) {
      const reasons: Record<string, string> = {
        empty_transcript: "Je n'ai pas entendu votre message. Réessayez.",
        no_product_name: "Je n'ai pas compris le nom du produit. Réessayez en disant : « Tomates 500 FCFA ».",
        no_price: "Je n'ai pas trouvé le prix. Dites par exemple : « Attiéké 1500 FCFA ».",
      };
      return {
        to: from,
        text: reasons[parsed.reason] ?? "Message non compris. Réessayez.",
      };
    }
    const listing = this.listings.create(parsed.product, parsed.priceFcfa, from);
    return {
      to: from,
      text: `✅ Annonce créée : ${listing.product} à ${listing.priceFcfa.toLocaleString('fr-FR')} FCFA (réf. ${listing.id})`,
    };
  }

  // ── Text path ──────────────────────────────────────────────────────────────

  private async handleText(from: string, rawBody: string): Promise<AgentReply> {
    const body = rawBody.trim();
    const lower = body.toLowerCase();

    // cherche <query>
    if (lower.startsWith('cherche ')) {
      return this.handleSearch(from, body.slice('cherche '.length).trim());
    }

    // commande <id>
    if (lower.startsWith('commande ')) {
      return this.handleOrder(from, body.slice('commande '.length).trim());
    }

    // wave <id>  or  orange <id>
    if (lower.startsWith('wave ')) {
      return this.handlePay(from, body.slice('wave '.length).trim(), 'wave');
    }
    if (lower.startsWith('orange ')) {
      return this.handlePay(from, body.slice('orange '.length).trim(), 'orange_money');
    }

    // reçu <id>
    if (lower.startsWith('reçu ') || lower.startsWith('recu ')) {
      const id = body.includes(' ') ? body.slice(body.indexOf(' ') + 1).trim() : '';
      return this.handleConfirm(from, id);
    }

    // annuler <id>
    if (lower.startsWith('annuler ')) {
      return this.handleCancel(from, body.slice('annuler '.length).trim());
    }

    return { to: from, text: HELP };
  }

  private handleSearch(from: string, query: string): AgentReply {
    if (query === '') {
      return { to: from, text: 'Usage : cherche <produit>' };
    }
    const results = this.listings.search(query);
    if (results.length === 0) {
      return { to: from, text: `Aucun résultat pour « ${query} ».` };
    }
    const lines = results.map(formatListing);
    return { to: from, text: lines.join('\n') };
  }

  private handleOrder(from: string, listingId: string): AgentReply {
    if (listingId === '') {
      return { to: from, text: 'Usage : commande <id>' };
    }
    const listing = this.listings.get(listingId);
    if (listing === undefined) {
      return { to: from, text: `Annonce ${listingId} introuvable.` };
    }
    return {
      to: from,
      text:
        `Commande : ${listing.product} – ${listing.priceFcfa.toLocaleString('fr-FR')} FCFA.\n` +
        `Choisissez votre moyen de paiement :\n` +
        `  wave ${listing.id}\n` +
        `  orange ${listing.id}`,
    };
  }

  private async handlePay(
    from: string,
    listingId: string,
    provider: PaymentProvider,
  ): Promise<AgentReply> {
    if (listingId === '') {
      return { to: from, text: `Usage : ${provider === 'wave' ? 'wave' : 'orange'} <id>` };
    }
    const listing = this.listings.get(listingId);
    if (listing === undefined) {
      return { to: from, text: `Annonce ${listingId} introuvable.` };
    }
    // Prevent double-payment for the same order.
    const existing = this.escrow.findHeld(listingId, from);
    if (existing !== undefined) {
      return {
        to: from,
        text: `Vous avez déjà une commande en cours pour cette annonce (réf. escrow ${existing.id}). Envoyez « reçu ${listingId} » pour confirmer la réception.`,
      };
    }
    const record = await this.escrow.hold(listingId, from, listing.sellerPhone, listing.priceFcfa, provider);
    const providerLabel = provider === 'wave' ? 'Wave' : 'Orange Money';
    return {
      to: from,
      text:
        `💳 Paiement de ${listing.priceFcfa.toLocaleString('fr-FR')} FCFA retenu via ${providerLabel}.\n` +
        `Envoyez « reçu ${listing.id} » dès que vous avez reçu votre commande.`,
    };
  }

  private async handleConfirm(from: string, listingId: string): Promise<AgentReply> {
    if (listingId === '') {
      return { to: from, text: 'Usage : reçu <id>' };
    }
    const record = this.escrow.findHeld(listingId, from);
    if (record === undefined) {
      return { to: from, text: `Aucune commande active pour l'annonce ${listingId}.` };
    }
    await this.escrow.release(record.id);
    return {
      to: from,
      text: `✅ Réception confirmée. Le paiement a été envoyé au vendeur.`,
    };
  }

  private async handleCancel(from: string, listingId: string): Promise<AgentReply> {
    if (listingId === '') {
      return { to: from, text: 'Usage : annuler <id>' };
    }
    const record = this.escrow.findHeld(listingId, from);
    if (record === undefined) {
      return { to: from, text: `Aucune commande active pour l'annonce ${listingId}.` };
    }
    await this.escrow.refund(record.id);
    return {
      to: from,
      text: `↩️ Commande annulée. Votre paiement vous sera remboursé.`,
    };
  }
}
