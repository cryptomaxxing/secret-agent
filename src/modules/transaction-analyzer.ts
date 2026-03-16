/**
 * transaction-analyzer.ts
 *
 * Parses on-chain transaction history for a set of wallets.
 * Extracts:
 *  - SOL transfer patterns (funding relationships)
 *  - Token swap events (Raydium, Jupiter, Pump.fun)
 *  - Timing correlations between wallets
 *  - Common program interactions
 */

import { ParsedInstruction, PartiallyDecodedInstruction } from '@solana/web3.js';
import { getSignatures, getParsedTransaction, sleep } from '../utils/rpc';
import { config } from '../config';

// Well-known program IDs
export const KNOWN_PROGRAMS: Record<string, string> = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter v6',
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter v4',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW': 'Pump.fun Fee',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'So11111111111111111111111111111111111111112': 'Wrapped SOL',
  '11111111111111111111111111111111': 'System Program',
};

export interface TransferEvent {
  sig: string;
  timestamp: number;
  from: string;
  to: string;
  lamports: number;
  type: 'SOL' | 'TOKEN';
  mint?: string;
}

export interface SwapEvent {
  sig: string;
  timestamp: number;
  wallet: string;
  program: string;
  programName: string;
  tokenIn?: string;
  tokenOut?: string;
}

export interface WalletActivity {
  wallet: string;
  signatures: string[];
  transfers: TransferEvent[];
  swaps: SwapEvent[];
  fundingSources: string[];   // wallets that sent SOL to this wallet
  fundingTargets: string[];   // wallets this wallet sent SOL to
  programsUsed: string[];
  firstSeen: number;
  lastSeen: number;
}

/**
 * Analyze transaction history for a single wallet.
 */
export async function analyzeWallet(walletAddress: string): Promise<WalletActivity> {
  const sigs = await getSignatures(walletAddress, config.txHistoryDepth);

  const activity: WalletActivity = {
    wallet: walletAddress,
    signatures: sigs.map((s) => s.signature),
    transfers: [],
    swaps: [],
    fundingSources: [],
    fundingTargets: [],
    programsUsed: [],
    firstSeen: sigs.length > 0 ? (sigs[sigs.length - 1].blockTime || 0) : 0,
    lastSeen: sigs.length > 0 ? (sigs[0].blockTime || 0) : 0,
  };

  const programSet = new Set<string>();
  const sourceSet = new Set<string>();
  const targetSet = new Set<string>();

  // Process transactions in batches
  const batchSize = 10;
  for (let i = 0; i < Math.min(sigs.length, config.txHistoryDepth); i += batchSize) {
    const batch = sigs.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async (sigInfo) => {
        const tx = await getParsedTransaction(sigInfo.signature);
        if (!tx || !tx.meta || tx.meta.err) return;

        const blockTime = tx.blockTime || 0;

        // Track programs used
        const accountKeys = tx.transaction.message.accountKeys;
        for (const key of accountKeys) {
          const addr = key.pubkey.toBase58();
          if (KNOWN_PROGRAMS[addr]) programSet.add(KNOWN_PROGRAMS[addr]);
        }

        // Parse instructions
        const instructions = tx.transaction.message.instructions;
        for (const ix of instructions) {
          const parsed = ix as ParsedInstruction | PartiallyDecodedInstruction;

          if ('parsed' in parsed && parsed.parsed) {
            const info = parsed.parsed?.info;
            const type = parsed.parsed?.type;

            // SOL transfer detection
            if (
              type === 'transfer' &&
              info?.source &&
              info?.destination &&
              info?.lamports
            ) {
              const ev: TransferEvent = {
                sig: sigInfo.signature,
                timestamp: blockTime,
                from: info.source as string,
                to: info.destination as string,
                lamports: info.lamports as number,
                type: 'SOL',
              };
              activity.transfers.push(ev);

              if (info.destination === walletAddress) {
                sourceSet.add(info.source as string);
              }
              if (info.source === walletAddress) {
                targetSet.add(info.destination as string);
              }
            }

            // Token transfer detection
            if (type === 'transferChecked' && info?.mint) {
              const ev: TransferEvent = {
                sig: sigInfo.signature,
                timestamp: blockTime,
                from: info.authority as string || '',
                to: info.destination as string || '',
                lamports: 0,
                type: 'TOKEN',
                mint: info.mint as string,
              };
              activity.transfers.push(ev);
            }
          }
        }

        // Detect swap events via inner instructions
        const innerIxs = tx.meta.innerInstructions || [];
        for (const inner of innerIxs) {
          for (const ix of inner.instructions) {
            const programId = accountKeys[ix.programIdIndex]?.pubkey?.toBase58();
            if (programId && KNOWN_PROGRAMS[programId]) {
              const existing = activity.swaps.find((s) => s.sig === sigInfo.signature);
              if (!existing) {
                activity.swaps.push({
                  sig: sigInfo.signature,
                  timestamp: blockTime,
                  wallet: walletAddress,
                  program: programId,
                  programName: KNOWN_PROGRAMS[programId],
                });
              }
            }
          }
        }
      }),
    );

    await sleep(config.rpcDelayMs);
  }

  activity.fundingSources = Array.from(sourceSet);
  activity.fundingTargets = Array.from(targetSet);
  activity.programsUsed = Array.from(programSet);

  return activity;
}

/**
 * Find timing correlations: wallets that transacted within a tight window
 * often indicate coordinated behavior (bots, insiders, same operator).
 */
export function findTimingCorrelations(
  activities: WalletActivity[],
  windowSeconds = 60,
): Array<{ walletA: string; walletB: string; sharedTimestamps: number }> {
  const correlations: Array<{
    walletA: string;
    walletB: string;
    sharedTimestamps: number;
  }> = [];

  for (let i = 0; i < activities.length; i++) {
    for (let j = i + 1; j < activities.length; j++) {
      const a = activities[i];
      const b = activities[j];

      const timesA = a.transfers.map((t) => t.timestamp);
      const timesB = b.transfers.map((t) => t.timestamp);

      let shared = 0;
      for (const ta of timesA) {
        if (timesB.some((tb) => Math.abs(ta - tb) <= windowSeconds)) {
          shared++;
        }
      }

      if (shared >= 3) {
        correlations.push({ walletA: a.wallet, walletB: b.wallet, sharedTimestamps: shared });
      }
    }
  }

  return correlations.sort((a, b) => b.sharedTimestamps - a.sharedTimestamps);
}
