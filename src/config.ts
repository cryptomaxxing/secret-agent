import dotenv from 'dotenv';
dotenv.config();

export const config = {
  rpcUrl: process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  heliusApiKey: process.env.HELIUS_API_KEY || '',

  // $SAGENT token gate
  sagentMint: process.env.SAGENT_MINT || '',
  sagentMinBalance: parseInt(process.env.SAGENT_MIN_BALANCE || '1000000'),
  operatorWallet: process.env.OPERATOR_WALLET || '',

  // ChangeNow aggregator deposit addresses (public, on-chain)
  changeNowAddresses: (process.env.CHANGENOW_KNOWN_WALLETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Analysis tuning
  maxHoldersToAnalyze: 5000,
  txHistoryDepth: 200,        // Transactions to look back per wallet
  cabалSimilarityThreshold: 3, // Min shared tokens to be considered same cabal

  // Rate limiting
  rpcConcurrency: 5,
  rpcDelayMs: 100,

  birdeyeApiKey: process.env.BIRDEYE_API_KEY || '',
};
