/**
 * changenow-tracker.ts
 *
 * Detects interactions with ChangeNow's on-chain deposit addresses.
 *
 * ChangeNow is a non-custodial cross-chain swap aggregator. When a user
 * swaps via ChangeNow, they send funds to a unique deposit address on the
 * source chain. This address is publicly visible on-chain.
 *
 * What this module does:
 * ─────────────────────
 *  1. Checks a wallet's transaction history for transfers to/from
 *     known ChangeNow Solana deposit wallet patterns.
 *  2. Correlates outgoing → ChangeNow with incoming flows to other
 *     wallets of similar amounts within a time window.
 *  3. Flags wallets as "ChangeNow routers" and attempts to surface
 *     possible destination wallets.
 *
 * All data analyzed here is fully public blockchain data.
 * This is the same methodology used by Chainalysis, Nansen, and Arkham.
 *
 * Known ChangeNow Solana hot wallet patterns:
 * ─────────────────────────────────────────
 * ChangeNow generates unique deposit addresses per swap. However,
 * they route through a small set of consolidation hot wallets.
 * These are widely documented on-chain and by blockchain analytics firms.
 *
 * Users should update CHANGENOW_KNOWN_WALLETS in .env with any newly
 * identified ChangeNow addresses as they become known.
 */

import { WalletActivity, TransferEvent } from './transaction-analyzer';
import { config } from '../config';

export interface ChangeNowFlow {
  wallet: string;
  direction: 'OUTBOUND' | 'INBOUND';   // sent to ChangeNow or received from it
  amount: number;                        // lamports
  timestamp: number;
  sig: string;
  counterparty: string;                  // ChangeNow address involved
  possibleLinkedWallet?: string;        // wallet that may be the other end
  confidence: number;
}

export interface ChangeNowReport {
  mint: string;
  totalChangeNowInteractions: number;
  flows: ChangeNowFlow[];
  suspectedRouters: string[];           // wallets that used ChangeNow repeatedly
}

/**
 * Scan activity for ChangeNow interactions.
 */
export function detectChangeNowFlows(
  activities: WalletActivity[],
  mint: string,
): ChangeNowReport {
  const changeNowSet = new Set(config.changeNowAddresses);
  const flows: ChangeNowFlow[] = [];

  if (changeNowSet.size === 0) {
    return {
      mint,
      totalChangeNowInteractions: 0,
      flows: [],
      suspectedRouters: [],
    };
  }

  for (const act of activities) {
    for (const transfer of act.transfers) {
      // Outbound: wallet → ChangeNow
      if (transfer.from === act.wallet && changeNowSet.has(transfer.to)) {
        flows.push({
          wallet: act.wallet,
          direction: 'OUTBOUND',
          amount: transfer.lamports,
          timestamp: transfer.timestamp,
          sig: transfer.sig,
          counterparty: transfer.to,
          confidence: 85,
        });
      }

      // Inbound: ChangeNow → wallet
      if (changeNowSet.has(transfer.from) && transfer.to === act.wallet) {
        flows.push({
          wallet: act.wallet,
          direction: 'INBOUND',
          amount: transfer.lamports,
          timestamp: transfer.timestamp,
          sig: transfer.sig,
          counterparty: transfer.from,
          confidence: 85,
        });
      }
    }
  }

  // Try to pair outbound and inbound flows (same-entity hop detection)
  const outbound = flows.filter((f) => f.direction === 'OUTBOUND');
  const inbound = flows.filter((f) => f.direction === 'INBOUND');

  for (const out of outbound) {
    const WINDOW = 4 * 3600; // 4 hours
    const match = inbound.find(
      (inn) =>
        Math.abs(inn.timestamp - out.timestamp) < WINDOW &&
        Math.abs(inn.amount - out.amount) / Math.max(inn.amount, out.amount) < 0.1 &&
        inn.wallet !== out.wallet,
    );

    if (match) {
      out.possibleLinkedWallet = match.wallet;
      match.possibleLinkedWallet = out.wallet;
      // Boost confidence on both sides
      out.confidence = Math.min(out.confidence + 10, 95);
      match.confidence = Math.min(match.confidence + 10, 95);
    }
  }

  // Identify repeat routers
  const routerCount = new Map<string, number>();
  for (const flow of flows) {
    routerCount.set(flow.wallet, (routerCount.get(flow.wallet) || 0) + 1);
  }

  const suspectedRouters = [...routerCount.entries()]
    .filter(([, count]) => count >= 2)
    .map(([wallet]) => wallet);

  return {
    mint,
    totalChangeNowInteractions: flows.length,
    flows,
    suspectedRouters,
  };
}
