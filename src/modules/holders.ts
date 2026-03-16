/**
 * holders.ts
 *
 * Fetches all token holders for a given SPL token mint,
 * calculates supply distribution, and flags suspicious
 * concentration patterns (top-N wallet domination, etc).
 */

import { getTokenAccountsByMint } from '../utils/rpc';

export interface Holder {
  owner: string;
  amount: string;          // raw on-chain units
  amountNum: number;
  pct: number;             // percentage of total supply
  rank: number;
}

export interface HolderReport {
  mint: string;
  totalHolders: number;
  totalSupply: number;
  holders: Holder[];
  top10Pct: number;        // % held by top 10 wallets
  top25Pct: number;
  giniCoefficient: number; // 0 = perfect equality, 1 = total concentration
  concentrationRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
}

/**
 * Fetch holders, rank them, and compute distribution metrics.
 */
export async function analyzeHolders(mintAddress: string): Promise<HolderReport> {
  const raw = await getTokenAccountsByMint(mintAddress);

  const sorted = raw
    .map((h) => ({ owner: h.owner, amount: h.amount, amountNum: parseInt(h.amount) }))
    .filter((h) => h.amountNum > 0)
    .sort((a, b) => b.amountNum - a.amountNum);

  const totalSupply = sorted.reduce((sum, h) => sum + h.amountNum, 0);

  const holders: Holder[] = sorted.map((h, i) => ({
    ...h,
    pct: totalSupply > 0 ? (h.amountNum / totalSupply) * 100 : 0,
    rank: i + 1,
  }));

  const top10Pct = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const top25Pct = holders.slice(0, 25).reduce((s, h) => s + h.pct, 0);
  const giniCoefficient = computeGini(holders.map((h) => h.amountNum));
  const concentrationRisk = classifyConcentration(top10Pct, giniCoefficient);

  return {
    mint: mintAddress,
    totalHolders: holders.length,
    totalSupply,
    holders,
    top10Pct,
    top25Pct,
    giniCoefficient,
    concentrationRisk,
  };
}

/**
 * Compute the Gini coefficient from an array of balances.
 * Classic measure of wealth inequality.
 */
function computeGini(balances: number[]): number {
  if (balances.length === 0) return 0;
  const sorted = [...balances].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let numerator = 0;
  for (let i = 0; i < n; i++) {
    numerator += (2 * (i + 1) - n - 1) * sorted[i];
  }
  return numerator / (n * sum);
}

function classifyConcentration(
  top10Pct: number,
  gini: number,
): HolderReport['concentrationRisk'] {
  if (top10Pct > 80 || gini > 0.9) return 'EXTREME';
  if (top10Pct > 60 || gini > 0.75) return 'HIGH';
  if (top10Pct > 40 || gini > 0.5) return 'MEDIUM';
  return 'LOW';
}
