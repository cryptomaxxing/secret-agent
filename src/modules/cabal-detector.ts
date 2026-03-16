/**
 * cabal-detector.ts
 *
 * Groups wallets into "cabals" — clusters of wallets that show
 * coordinated behavior based on shared token holdings and trading history.
 *
 * A "cabal" in this context is a group of wallets that:
 *  - Hold many of the same low-cap tokens (unusual overlap = coordinated)
 *  - Bought and sold the same tokens in similar time windows
 *  - Show overlapping token histories suggesting the same operator
 *    runs multiple wallets to accumulate and distribute quietly
 *
 * This is the same methodology used by Bubblemaps and Nansen for
 * identifying coordinated wallet clusters on-chain.
 */

import { getConnection, sleep } from '../utils/rpc';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config';
import pLimit from 'p-limit';

export interface WalletTokenProfile {
  wallet: string;
  currentHoldings: string[];   // mint addresses currently held
  historicalTokens: string[];  // mints bought/sold in tx history (from swap events)
}

export interface Cabal {
  id: number;
  wallets: string[];
  sharedTokens: string[];      // tokens held by all wallets in cabal
  overlapScore: number;        // Jaccard similarity score 0-1
  riskScore: number;           // 0-100 composite risk
  totalWallets: number;
}

/**
 * Fetch current SPL token holdings for a wallet.
 */
export async function getWalletTokenHoldings(wallet: string): Promise<string[]> {
  const conn = getConnection();
  try {
    const accounts = await conn.getParsedTokenAccountsByOwner(
      new PublicKey(wallet),
      { programId: TOKEN_PROGRAM_ID },
    );

    return accounts.value
      .map((a) => {
        const info = a.account.data.parsed?.info;
        if (!info) return null;
        const amount = parseInt(info.tokenAmount?.amount || '0');
        if (amount === 0) return null;
        return info.mint as string;
      })
      .filter((m): m is string => m !== null);
  } catch {
    return [];
  }
}

/**
 * Build a token profile for each wallet.
 */
export async function buildWalletProfiles(
  wallets: string[],
  historicalMintsByWallet?: Map<string, string[]>,
): Promise<WalletTokenProfile[]> {
  const limit = pLimit(config.rpcConcurrency);
  const profiles: WalletTokenProfile[] = [];

  await Promise.all(
    wallets.map((wallet) =>
      limit(async () => {
        const currentHoldings = await getWalletTokenHoldings(wallet);
        const historicalTokens = historicalMintsByWallet?.get(wallet) || [];
        profiles.push({ wallet, currentHoldings, historicalTokens });
        await sleep(config.rpcDelayMs);
      }),
    ),
  );

  return profiles;
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|
 * Used to measure token overlap between two wallets.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.length / union.size;
}

/**
 * Find shared tokens between two wallets (current + historical).
 */
function sharedTokens(p1: WalletTokenProfile, p2: WalletTokenProfile): string[] {
  const all1 = new Set([...p1.currentHoldings, ...p1.historicalTokens]);
  const all2 = new Set([...p2.currentHoldings, ...p2.historicalTokens]);
  return [...all1].filter((t) => all2.has(t));
}

/**
 * Main cabal detection algorithm.
 *
 * Builds a similarity graph, then uses single-linkage clustering
 * to group wallets that exceed the similarity threshold.
 */
export function detectCabals(
  profiles: WalletTokenProfile[],
  similarityThreshold = 0.25,   // Jaccard threshold
  minSharedTokens = config.cabалSimilarityThreshold,
): Cabal[] {
  // Build adjacency for clustering
  const edges: Array<{ a: number; b: number; score: number; shared: string[] }> = [];

  for (let i = 0; i < profiles.length; i++) {
    for (let j = i + 1; j < profiles.length; j++) {
      const p1 = profiles[i];
      const p2 = profiles[j];

      const allTokens1 = [...new Set([...p1.currentHoldings, ...p1.historicalTokens])];
      const allTokens2 = [...new Set([...p2.currentHoldings, ...p2.historicalTokens])];

      const shared = sharedTokens(p1, p2);
      const score = jaccardSimilarity(allTokens1, allTokens2);

      if (shared.length >= minSharedTokens && score >= similarityThreshold) {
        edges.push({ a: i, b: j, score, shared });
      }
    }
  }

  // Union-Find for clustering
  const parent = profiles.map((_, i) => i);
  function find(x: number): number {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x: number, y: number): void {
    parent[find(x)] = find(y);
  }

  for (const edge of edges) {
    union(edge.a, edge.b);
  }

  // Group into clusters
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < profiles.length; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  const cabals: Cabal[] = [];
  let cabalId = 1;

  for (const [, memberIndices] of clusters.entries()) {
    if (memberIndices.length < 2) continue; // Solo wallets aren't a cabal

    const memberProfiles = memberIndices.map((i) => profiles[i]);
    const memberWallets = memberProfiles.map((p) => p.wallet);

    // Find tokens shared across ALL members
    const allSets = memberProfiles.map(
      (p) => new Set([...p.currentHoldings, ...p.historicalTokens]),
    );
    const commonTokens = [...allSets[0]].filter((t) => allSets.every((s) => s.has(t)));

    // Average pairwise Jaccard for overlap score
    const relevantEdges = edges.filter(
      (e) => memberIndices.includes(e.a) && memberIndices.includes(e.b),
    );
    const avgScore =
      relevantEdges.length > 0
        ? relevantEdges.reduce((s, e) => s + e.score, 0) / relevantEdges.length
        : 0;

    const riskScore = computeCabalRisk(memberWallets.length, commonTokens.length, avgScore);

    cabals.push({
      id: cabalId++,
      wallets: memberWallets,
      sharedTokens: commonTokens,
      overlapScore: avgScore,
      riskScore,
      totalWallets: memberWallets.length,
    });
  }

  return cabals.sort((a, b) => b.riskScore - a.riskScore);
}

/**
 * Composite risk score based on:
 * - Number of wallets (more = higher coordination risk)
 * - Number of shared tokens (more obscure overlaps = suspicious)
 * - Average Jaccard similarity (higher = tighter coordination)
 */
function computeCabalRisk(walletCount: number, sharedCount: number, overlapScore: number): number {
  const walletScore = Math.min(walletCount * 5, 30);
  const tokenScore = Math.min(sharedCount * 3, 40);
  const overlapPoints = overlapScore * 30;
  return Math.min(Math.round(walletScore + tokenScore + overlapPoints), 100);
}
