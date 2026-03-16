# 🕵️ Secret Agent — $SAGENT

> On-chain intelligence for Solana memecoins. Wallet clustering, cabal detection, and transaction forensics — all from public blockchain data.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

---

## What is Secret Agent?

Secret Agent is an open-source CLI tool that analyzes public Solana blockchain data to surface hidden patterns in memecoin markets. It answers questions like:

- **Who actually controls this token?** (holder distribution + concentration risk)
- **Are these wallets the same person?** (wallet linking via funding sources, timing, and bridge flows)
- **Are these top holders coordinating?** (cabal detection via shared token holdings)
- **Are insiders routing funds through ChangeNow?** (bridge flow correlation)

All data analyzed is **fully public on-chain data** from the Solana blockchain ledger. No private data, no API keys beyond standard RPC access.

---

## Token Gate

> **You must hold $SAGENT to use this tool.**

Secret Agent is token-gated. Your wallet is checked on-chain for a minimum $SAGENT balance before any analysis runs. This check is local and requires no external auth server — it's a direct RPC call to Solana mainnet.

Set your wallet and the $SAGENT mint in `.env`:

```env
SAGENT_MINT=<$SAGENT token mint address>
SAGENT_MIN_BALANCE=1000000
OPERATOR_WALLET=<your Solana wallet public key>
```

**No $SAGENT? No access.** Buy it on Pump.fun or Raydium.

---

## Features

| Module | Description |
|--------|-------------|
| **Holder Analysis** | Fetches all token holders, ranks by balance, computes Gini coefficient and concentration risk |
| **Transaction Analysis** | Parses tx history per wallet: SOL transfers, token swaps, funding sources/targets |
| **Wallet Linker** | Connects wallets via shared funding, direct transfers, timing correlation, common intermediaries |
| **ChangeNow Tracker** | Detects interactions with ChangeNow deposit addresses and correlates bridge flows |
| **Cabal Detector** | Groups wallets by shared token holdings using Jaccard similarity + Union-Find clustering |

---

## Prerequisites

- **Node.js** `>= 18.0.0`
- **npm** or **yarn**
- A Solana RPC endpoint (Helius recommended — free tier at [helius.dev](https://helius.dev))

---

## Installation

```bash
# Clone the repo
git clone https://github.com/<your-username>/secret-agent.git
cd secret-agent

# Install dependencies
npm install

# Copy environment config
cp .env.example .env
```

---

## Configuration

Edit `.env`:

```env
# Helius RPC (strongly recommended for getTokenAccounts)
HELIUS_API_KEY=your_key_here
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key_here

# Token gate
SAGENT_MINT=<$SAGENT mint address>
SAGENT_MIN_BALANCE=1000000
OPERATOR_WALLET=<your wallet pubkey>

# ChangeNow known Solana deposit addresses (comma-separated)
# Update these as new addresses are identified on-chain
CHANGENOW_KNOWN_WALLETS=addr1,addr2,addr3
```

### Why Helius?

The `getTokenAccounts` enhanced API from Helius allows paginated fetching of all token holders efficiently. Without Helius, the tool falls back to the standard RPC `getParsedProgramAccounts` endpoint, which may be rate-limited or slow for large token distributions.

Get a free Helius key at: https://helius.dev

---

## Running Locally

### Build

```bash
npm run build
```

### Full Analysis (recommended)

```bash
node dist/index.js analyze <TOKEN_MINT_ADDRESS>
```

Options:
```
-n, --top <number>     Top N holders to deep-analyze (default: 50)
-w, --wallet <pubkey>  Your wallet pubkey (overrides .env)
--skip-gate            Skip token gate check (dev/testing only)
--json                 Export results to JSON file
-v, --verbose          Verbose output
```

Example:
```bash
node dist/index.js analyze So11111111111111111111111111111111111111112 --top 100
```

### Individual Commands

**Holders only:**
```bash
node dist/index.js holders <MINT> --top 50
```

**Single wallet intel:**
```bash
node dist/index.js wallet <WALLET_ADDRESS>
```

**Cabal detection only:**
```bash
node dist/index.js cabal <MINT> --top 100 --threshold 0.25
```

### Development mode (no build step)

```bash
npm run dev -- analyze <MINT> --skip-gate
```

---

## How It Works

### 1. Holder Analysis

Fetches all SPL token accounts for a given mint, calculates each wallet's percentage of total supply, and computes:

- **Gini Coefficient**: Measures wealth inequality across holders (0 = perfectly equal, 1 = one wallet holds everything)
- **Concentration Risk**: `LOW / MEDIUM / HIGH / EXTREME` based on top-10 wallet dominance + Gini

### 2. Transaction Analysis

For each top-N holder, Secret Agent fetches up to 200 transactions and extracts:

- **SOL transfers**: Who funded this wallet? Who did this wallet fund?
- **Token swaps**: Which DEXes and programs did this wallet use? (Raydium, Jupiter, Pump.fun)
- **Timing data**: Timestamps for correlation analysis

### 3. Wallet Linking

Identifies connections using five independent heuristics:

| Method | Confidence | Description |
|--------|-----------|-------------|
| Direct Transfer | 90% | Wallet A directly sent SOL/tokens to Wallet B |
| Shared Funding Source | 75% | Both wallets were funded by the same parent wallet |
| Common Intermediary | 55–80% | Both wallets interacted with the same third-party wallet |
| Timing Correlation | 50–85% | Wallets transacted within 60s of each other, repeatedly |
| ChangeNow Bridge | 60–95% | Both wallets routed similar amounts through ChangeNow within 4 hours |

Multiple matching heuristics boost confidence. The highest-confidence link per pair is reported.

### 4. ChangeNow Bridge Detection

ChangeNow is a non-custodial swap aggregator. When users swap via ChangeNow, they send funds to a unique deposit address on-chain. This module:

1. Checks each analyzed wallet's tx history for transfers to/from known ChangeNow Solana addresses
2. Looks for outbound flows from Wallet A to ChangeNow paired with inbound flows to Wallet B of a similar amount within 4 hours
3. Flags the pair as a possible same-entity hop

> **Note**: ChangeNow addresses must be maintained in `CHANGENOW_KNOWN_WALLETS` in your `.env`. These are public on-chain addresses documented by blockchain analytics firms.

### 5. Cabal Detection

Groups wallets into coordinated clusters using:

1. **Token Profiling**: Fetches each wallet's current SPL token holdings + historical tokens from swap events
2. **Jaccard Similarity**: `|A ∩ B| / |A ∪ B|` — measures token overlap between pairs of wallets
3. **Union-Find Clustering**: Builds connected components where similarity exceeds the threshold (default: 0.25)
4. **Risk Scoring**: Composite score based on cluster size, shared token count, and average similarity

A high-risk cabal means a group of wallets holds an unusually overlapping set of obscure tokens — a strong signal of coordinated accumulation/distribution.

---

## Output

Running `analyze` produces:

```
Phase 1 — Holder Analysis
  ▸ Total Holders: 4,821
  ▸ Top 10% Supply: 67.3%
  ▸ Gini Coefficient: 0.8421
  ▸ Concentration Risk: HIGH

Phase 2 — Transaction Analysis
  Analyzing 50 wallets...

Phase 3 — Wallet Linking
  Found 12 wallet links

Phase 4 — ChangeNow Bridge Detection
  ⚠ 3 ChangeNow interactions detected

Phase 5 — Cabal Detection
  Detected 2 suspected cabal(s)
  
  Cabal #1 — 7 wallets, 14 shared tokens, risk: 78/100
  Cabal #2 — 4 wallets, 8 shared tokens, risk: 55/100
```

Use `--json` to export the full result object.

---

## Architecture

```
src/
├── index.ts                  CLI entry point (Commander.js)
├── agent.ts                  Pipeline orchestrator
├── config.ts                 Environment config
├── token-gate.ts             $SAGENT on-chain token gate
├── modules/
│   ├── holders.ts            Holder fetching + distribution metrics
│   ├── transaction-analyzer.ts  Tx history parsing + timing analysis
│   ├── wallet-linker.ts      Multi-heuristic wallet connection graph
│   ├── cabal-detector.ts     Jaccard similarity + Union-Find clustering
│   └── changenow-tracker.ts  Bridge flow correlation
└── utils/
    ├── rpc.ts                Connection + RPC helpers
    └── display.ts            CLI tables and formatting
```

---

## Limitations & Accuracy

- **RPC rate limits**: Public RPC endpoints are heavily rate-limited. Using Helius significantly improves speed and reliability.
- **Transaction depth**: Only the last 200 transactions per wallet are analyzed by default. Increase `txHistoryDepth` in `config.ts` for deeper history at the cost of speed.
- **ChangeNow accuracy**: Requires an up-to-date list of ChangeNow deposit addresses. The bridge uses different deposit wallets per swap — only well-documented hot wallets are reliably detectable.
- **Cabal false positives**: Wallets holding many of the same popular tokens (SOL, USDC, popular memecoins) may show high similarity without being coordinated. The Jaccard threshold filters most of these, but tuning `--threshold` helps.
- **Confidence ≠ certainty**: All links are probabilistic. High confidence means strong on-chain evidence of coordination, not proof of the same person.

---

## Contributing

PRs welcome. Key areas for contribution:

- Additional DEX program IDs in `KNOWN_PROGRAMS`
- Better ChangeNow deposit address discovery
- Graph visualization (D3 / Cytoscape) for wallet link maps
- Web UI wrapper
- Persistent caching of wallet activity (SQLite/Redis)

---

## Legal & Ethical Use

Secret Agent analyzes **publicly available blockchain data only**. The Solana blockchain is a public ledger — all transaction data is publicly accessible to anyone with an RPC connection.

This tool is intended for:
- Retail investors assessing token risk before buying
- Researchers studying on-chain coordination patterns
- Security researchers and blockchain analysts

**Do not use this tool to harass, dox, or target individuals.**

---

## License

MIT © Secret Agent Contributors
