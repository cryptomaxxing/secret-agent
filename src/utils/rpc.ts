import { Connection, PublicKey, ParsedTransactionWithMeta, ConfirmedSignatureInfo } from '@solana/web3.js';
import { config } from '../config';
import pLimit from 'p-limit';

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(config.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return _connection;
}

export const rpcLimit = pLimit(config.rpcConcurrency);

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch all signatures for an address up to `limit` transactions back.
 */
export async function getSignatures(
  address: string,
  limit = config.txHistoryDepth,
): Promise<ConfirmedSignatureInfo[]> {
  const conn = getConnection();
  const pubkey = new PublicKey(address);
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined = undefined;

  while (sigs.length < limit) {
    const batch = await conn.getSignaturesForAddress(pubkey, {
      limit: Math.min(1000, limit - sigs.length),
      before,
    });
    if (batch.length === 0) break;
    sigs.push(...batch);
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
    await sleep(config.rpcDelayMs);
  }

  return sigs;
}

/**
 * Fetch parsed transaction with retry logic.
 */
export async function getParsedTransaction(
  sig: string,
  retries = 3,
): Promise<ParsedTransactionWithMeta | null> {
  const conn = getConnection();
  for (let i = 0; i < retries; i++) {
    try {
      const tx = await conn.getParsedTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      return tx;
    } catch {
      if (i < retries - 1) await sleep(500 * (i + 1));
    }
  }
  return null;
}

/**
 * Fetch token accounts for a mint using Helius DAS API if available,
 * else fallback to standard RPC.
 */
export async function getTokenAccountsByMint(mintAddress: string): Promise<
  Array<{ owner: string; amount: string }>
> {
  if (config.heliusApiKey) {
    return getTokenAccountsHelius(mintAddress);
  }
  return getTokenAccountsRPC(mintAddress);
}

async function getTokenAccountsHelius(mintAddress: string): Promise<
  Array<{ owner: string; amount: string }>
> {
  const { default: axios } = await import('axios');
  const holders: Array<{ owner: string; amount: string }> = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: 'sagent',
      method: 'getTokenAccounts',
      params: { mint: mintAddress, limit: 1000, cursor },
    };

    const res = await axios.post(config.rpcUrl, body);
    const data = res.data?.result;
    if (!data || !data.token_accounts) break;

    for (const acct of data.token_accounts) {
      if (acct.amount && parseInt(acct.amount) > 0) {
        holders.push({ owner: acct.owner, amount: acct.amount });
      }
    }

    cursor = data.cursor;
    await sleep(config.rpcDelayMs);
  } while (cursor);

  return holders;
}

async function getTokenAccountsRPC(mintAddress: string): Promise<
  Array<{ owner: string; amount: string }>
> {
  const conn = getConnection();
  const mint = new PublicKey(mintAddress);
  const accounts = await conn.getParsedProgramAccounts(
    new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    {
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mint.toBase58() } },
      ],
    },
  );

  return accounts
    .map((a) => {
      const info = (a.account.data as any).parsed?.info;
      if (!info) return null;
      const amount = info.tokenAmount?.amount || '0';
      if (parseInt(amount) === 0) return null;
      return { owner: info.owner as string, amount: amount as string };
    })
    .filter((x): x is { owner: string; amount: string } => x !== null);
}
