/**
 * wallet-linker.ts
 *
 * Identifies connections between wallets using multiple heuristics:
 *
 * 1. SHARED FUNDING SOURCE — two wallets funded by the same parent wallet
 *    → Classic indicator of same operator running multiple wallets
 *
 * 2. DIRECT TRANSFER — Wallet A sent SOL/tokens directly to Wallet B
 *    → High-confidence link
 *
 * 3. CHANGENOW BRIDGE FLOW — Wallet interacted with a known ChangeNow
 *    deposit address on-chain. ChangeNow is a non-custodial swap aggregator;
 *    wallets that send to/from ChangeNow deposit addresses and receive
 *    similar amounts shortly after may be the same entity routing funds
 *    through to obscure the trail.
 *    NOTE: All data here is fully public on-chain. We are reading the
 *    public blockchain ledger, not any private data.
 *
 * 4. TIMING CORRELATION — Wallets that consistently transact within
 *    the same narrow time window (likely automated / same bot)
 *
 * 5. COMMON INTERMEDIARY — Both wallets sent through the same
 *    third-party wallet (one hop removed)
 */

import { WalletActivity, TransferEvent } from './transaction-analyzer';
import { config } from '../config';

export type LinkReason =
  | 'SHARED_FUNDING_SOURCE'
  | 'DIRECT_TRANSFER'
  | 'CHANGENOW_BRIDGE'
  | 'TIMING_CORRELATION'
  | 'COMMON_INTERMEDIARY';

export interface WalletLink {
  walletA: string;
  walletB: string;
  reason: LinkReason;
  confidence: number;       // 0-100
  evidence: string;
  timestamp?: number;
}

/**
 * Main entry point — given a list of wallet activity snapshots,
 * find all pairwise links.
 */
export function findWalletLinks(activities: WalletActivity[]): WalletLink[] {
  const links: WalletLink[] = [];
  const walletSet = new Set(activities.map((a) => a.wallet));

  const linkMap = new Map<string, WalletLink>();

  function addLink(link: WalletLink): void {
    const key = [link.walletA, link.walletB].sort().join('::');
    const existing = linkMap.get(key);
    if (!existing || existing.confidence < link.confidence) {
      linkMap.set(key, link);
    }
  }

  // ── 1. SHARED FUNDING SOURCE ────────────────────────────────────────────
  const fundingMap = new Map<string, string[]>(); // funder → [wallets funded]
  for (const act of activities) {
    for (const source of act.fundingSources) {
      if (!fundingMap.has(source)) fundingMap.set(source, []);
      fundingMap.get(source)!.push(act.wallet);
    }
  }

  for (const [funder, funded] of fundingMap.entries()) {
    const unique = [...new Set(funded)];
    if (unique.length < 2) continue;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        addLink({
          walletA: unique[i],
          walletB: unique[j],
          reason: 'SHARED_FUNDING_SOURCE',
          confidence: 75,
          evidence: `Both funded by ${funder}`,
        });
      }
    }
  }

  // ── 2. DIRECT TRANSFER ──────────────────────────────────────────────────
  for (const act of activities) {
    for (const transfer of act.transfers) {
      if (
        walletSet.has(transfer.from) &&
        walletSet.has(transfer.to) &&
        transfer.from !== transfer.to
      ) {
        addLink({
          walletA: transfer.from,
          walletB: transfer.to,
          reason: 'DIRECT_TRANSFER',
          confidence: 90,
          evidence: `Direct ${transfer.type} transfer of ${transfer.lamports} lamports (tx: ${transfer.sig.slice(0, 16)}...)`,
          timestamp: transfer.timestamp,
        });
      }
    }
  }

  // ── 3. CHANGENOW BRIDGE FLOW ────────────────────────────────────────────
  if (config.changeNowAddresses.length > 0) {
    const changeNowSet = new Set(config.changeNowAddresses);

    // Wallets that sent to a ChangeNow deposit address
    const changeNowSenders: Array<{ wallet: string; amount: number; timestamp: number }> = [];

    for (const act of activities) {
      for (const transfer of act.transfers) {
        if (changeNowSet.has(transfer.to) && transfer.from === act.wallet) {
          changeNowSenders.push({
            wallet: act.wallet,
            amount: transfer.lamports,
            timestamp: transfer.timestamp,
          });
        }
      }
    }

    // Group by similar amounts + close timestamps (within 2 hours)
    // This catches the classic pattern: wallet A sends 10 SOL to ChangeNow,
    // wallet B receives ~10 SOL from ChangeNow shortly after → same entity
    for (let i = 0; i < changeNowSenders.length; i++) {
      for (let j = i + 1; j < changeNowSenders.length; j++) {
        const a = changeNowSenders[i];
        const b = changeNowSenders[j];
        const amountSimilar = Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount) < 0.05;
        const timeSimilar = Math.abs(a.timestamp - b.timestamp) < 7200;
        if (amountSimilar && timeSimilar) {
          addLink({
            walletA: a.wallet,
            walletB: b.wallet,
            reason: 'CHANGENOW_BRIDGE',
            confidence: 60,
            evidence: `Both routed similar amounts (${a.amount} / ${b.amount} lamports) through ChangeNow within 2 hours`,
            timestamp: Math.min(a.timestamp, b.timestamp),
          });
        }
      }
    }
  }

  // ── 4. TIMING CORRELATION ───────────────────────────────────────────────
  const WINDOW = 60; // seconds
  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i];
      const b = activities[j];
      const timesA = a.transfers.map((t) => t.timestamp).filter(Boolean);
      const timesB = b.transfers.map((t) => t.timestamp).filter(Boolean);

      let correlated = 0;
      for (const ta of timesA) {
        if (timesB.some((tb) => Math.abs(ta - tb) <= WINDOW)) correlated++;
      }

      if (correlated >= 5) {
        addLink({
          walletA: a.wallet,
          walletB: b.wallet,
          reason: 'TIMING_CORRELATION',
          confidence: Math.min(50 + correlated * 3, 85),
          evidence: `${correlated} transactions within ${WINDOW}s of each other`,
        });
      }
    }
  }

  // ── 5. COMMON INTERMEDIARY ──────────────────────────────────────────────
  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i];
      const b = activities[j];

      const aIntermediate = new Set([
        ...a.fundingSources,
        ...a.fundingTargets,
      ]);
      const bIntermediate = new Set([
        ...b.fundingSources,
        ...b.fundingTargets,
      ]);

      const shared = [...aIntermediate].filter(
        (x) => bIntermediate.has(x) && !walletSet.has(x),
      );

      if (shared.length > 0) {
        addLink({
          walletA: a.wallet,
          walletB: b.wallet,
          reason: 'COMMON_INTERMEDIARY',
          confidence: 55 + Math.min(shared.length * 5, 25),
          evidence: `Shared ${shared.length} intermediate wallet(s): ${shared.slice(0, 2).join(', ')}`,
        });
      }
    }
  }

  return Array.from(linkMap.values()).sort((a, b) => b.confidence - a.confidence);
}

/**
 * Given a seed wallet and links, build a connected component (cluster).
 * Uses BFS to find all wallets reachable from the seed.
 */
export function buildCluster(
  seedWallet: string,
  links: WalletLink[],
  minConfidence = 50,
): string[] {
  const filtered = links.filter((l) => l.confidence >= minConfidence);
  const graph = new Map<string, Set<string>>();

  for (const link of filtered) {
    if (!graph.has(link.walletA)) graph.set(link.walletA, new Set());
    if (!graph.has(link.walletB)) graph.set(link.walletB, new Set());
    graph.get(link.walletA)!.add(link.walletB);
    graph.get(link.walletB)!.add(link.walletA);
  }

  const visited = new Set<string>();
  const queue = [seedWallet];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    const neighbors = graph.get(node) || new Set();
    for (const n of neighbors) {
      if (!visited.has(n)) queue.push(n);
    }
  }

  return Array.from(visited);
}
