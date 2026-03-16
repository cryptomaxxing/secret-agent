/**
 * token-gate.ts
 *
 * Verifies that the operator's wallet holds the minimum required
 * $SAGENT balance before allowing any analysis to proceed.
 *
 * Token gate is enforced locally — no external auth server involved.
 * This is pure on-chain verification.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { config } from '../config';
import { getConnection } from '../utils/rpc';
import chalk from 'chalk';

export interface TokenGateResult {
  passed: boolean;
  balance: number;
  required: number;
  message: string;
}

/**
 * Check whether a wallet holds >= minBalance of the $SAGENT token.
 */
export async function checkTokenGate(
  walletAddress: string,
  overrideMint?: string,
): Promise<TokenGateResult> {
  const mint = overrideMint || config.sagentMint;

  // If mint is not configured, skip gate (dev/testing mode)
  if (!mint || mint === 'SAGENT_MINT_ADDRESS_HERE') {
    console.log(chalk.yellow('  ⚠  SAGENT_MINT not configured — running in open mode (dev)'));
    return {
      passed: true,
      balance: 0,
      required: config.sagentMinBalance,
      message: 'Token gate skipped — SAGENT_MINT not set',
    };
  }

  const conn: Connection = getConnection();
  const owner = new PublicKey(walletAddress);
  const mintPubkey = new PublicKey(mint);

  try {
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    });

    let sagentBalance = 0;

    for (const { account } of tokenAccounts.value) {
      const info = account.data.parsed?.info;
      if (!info) continue;
      if (info.mint === mintPubkey.toBase58()) {
        sagentBalance = parseInt(info.tokenAmount?.amount || '0');
        break;
      }
    }

    const passed = sagentBalance >= config.sagentMinBalance;

    return {
      passed,
      balance: sagentBalance,
      required: config.sagentMinBalance,
      message: passed
        ? `✓ Token gate passed — ${sagentBalance} $SAGENT held`
        : `✗ Insufficient $SAGENT — need ${config.sagentMinBalance}, have ${sagentBalance}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      balance: 0,
      required: config.sagentMinBalance,
      message: `Token gate check failed: ${msg}`,
    };
  }
}
