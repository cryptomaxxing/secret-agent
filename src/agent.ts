/**
 * agent.ts
 *
 * Orchestrates all Secret Agent analysis modules into a single pipeline.
 * This is what runs when you call `sagent analyze <MINT>`.
 */

import ora from 'ora';
import chalk from 'chalk';
import { config } from './config';
import { analyzeHolders, HolderReport } from './modules/holders';
import { analyzeWallet, WalletActivity, findTimingCorrelations } from './modules/transaction-analyzer';
import { findWalletLinks, buildCluster, WalletLink } from './modules/wallet-linker';
import { buildWalletProfiles, detectCabals, Cabal, WalletTokenProfile } from './modules/cabal-detector';
import { detectChangeNowFlows, ChangeNowReport } from './modules/changenow-tracker';
import { checkTokenGate } from './token-gate';
import {
  printSection,
  printInfo,
  printSuccess,
  printWarn,
  printError,
  buildHoldersTable,
  buildCabalTable,
  buildLinkedWalletsTable,
  shortenAddress,
  formatTokenAmount,
} from './utils/display';
import pLimit from 'p-limit';

export interface AnalysisResult {
  mint: string;
  holderReport: HolderReport;
  walletActivities: WalletActivity[];
  walletLinks: WalletLink[];
  cabals: Cabal[];
  changeNowReport: ChangeNowReport;
  walletProfiles: WalletTokenProfile[];
}

export interface AgentOptions {
  topHolders?: number;         // How many top holders to deep-analyze (default 50)
  skipTokenGate?: boolean;     // For dev/testing
  operatorWallet?: string;
  verbose?: boolean;
  outputJson?: boolean;
}

export async function runAgent(
  mintAddress: string,
  opts: AgentOptions = {},
): Promise<AnalysisResult> {
  const topN = opts.topHolders ?? 50;

  // ── TOKEN GATE ─────────────────────────────────────────────────────────
  if (!opts.skipTokenGate) {
    const wallet = opts.operatorWallet || config.operatorWallet;

    if (!wallet) {
      printError('No OPERATOR_WALLET set. Set it in .env or pass --wallet <pubkey>');
      process.exit(1);
    }

    const gateSpinner = ora('Checking $SAGENT token gate...').start();
    const gateResult = await checkTokenGate(wallet);

    if (gateResult.passed) {
      gateSpinner.succeed(chalk.green(gateResult.message));
    } else {
      gateSpinner.fail(chalk.red(gateResult.message));
      printError(`You need at least ${gateResult.required} $SAGENT to run Secret Agent.`);
      printError(`Buy $SAGENT on Pump.fun or Raydium and try again.`);
      process.exit(1);
    }
  }

  // ── PHASE 1: HOLDER ANALYSIS ───────────────────────────────────────────
  printSection('PHASE 1 — Holder Analysis');
  const holderSpinner = ora(`Fetching all holders for ${mintAddress}...`).start();

  let holderReport: HolderReport;
  try {
    holderReport = await analyzeHolders(mintAddress);
    holderSpinner.succeed(`Found ${holderReport.totalHolders.toLocaleString()} holders`);
  } catch (err) {
    holderSpinner.fail('Failed to fetch holders');
    throw err;
  }

  printInfo('Total Holders', holderReport.totalHolders.toLocaleString());
  printInfo('Top 10% Supply', holderReport.top10Pct.toFixed(2) + '%');
  printInfo('Top 25% Supply', holderReport.top25Pct.toFixed(2) + '%');
  printInfo('Gini Coefficient', holderReport.giniCoefficient.toFixed(4));
  printInfo('Concentration Risk', holderReport.concentrationRisk);

  console.log('\n' + buildHoldersTable(holderReport.holders, Math.min(topN, 20)));

  // ── PHASE 2: TRANSACTION ANALYSIS ─────────────────────────────────────
  printSection('PHASE 2 — Transaction Analysis');

  const walletsToAnalyze = holderReport.holders
    .slice(0, topN)
    .map((h) => h.owner);

  console.log(chalk.dim(`  Analyzing top ${walletsToAnalyze.length} wallets...\n`));

  const txSpinner = ora('Fetching transaction histories...').start();
  const limit = pLimit(config.rpcConcurrency);
  let analyzed = 0;

  const walletActivities = await Promise.all(
    walletsToAnalyze.map((wallet) =>
      limit(async () => {
        const activity = await analyzeWallet(wallet);
        analyzed++;
        txSpinner.text = `Analyzing transactions... (${analyzed}/${walletsToAnalyze.length})`;
        return activity;
      }),
    ),
  );

  txSpinner.succeed(`Transaction analysis complete for ${walletActivities.length} wallets`);

  const timingCorrelations = findTimingCorrelations(walletActivities);
  if (timingCorrelations.length > 0) {
    printWarn(
      `Found ${timingCorrelations.length} timing-correlated wallet pairs (likely bots/same operator)`,
    );
  }

  // ── PHASE 3: WALLET LINKING ────────────────────────────────────────────
  printSection('PHASE 3 — Wallet Linking');
  const linkSpinner = ora('Finding wallet connections...').start();

  const walletLinks = findWalletLinks(walletActivities);
  linkSpinner.succeed(`Found ${walletLinks.length} wallet links`);

  if (walletLinks.length > 0) {
    console.log('\n' + buildLinkedWalletsTable(
      walletLinks.slice(0, 20).map((l) => ({
        wallet: l.walletA,
        linkedTo: l.walletB,
        reason: l.reason.replace(/_/g, ' '),
        confidence: l.confidence,
      })),
    ));
  } else {
    printSuccess('No high-confidence wallet links detected');
  }

  // ── PHASE 4: CHANGENOW DETECTION ──────────────────────────────────────
  printSection('PHASE 4 — ChangeNow Bridge Detection');
  const changeNowReport = detectChangeNowFlows(walletActivities, mintAddress);

  if (config.changeNowAddresses.length === 0) {
    printWarn('No ChangeNow addresses configured in CHANGENOW_KNOWN_WALLETS — skipping');
  } else if (changeNowReport.totalChangeNowInteractions === 0) {
    printSuccess('No ChangeNow bridge activity detected in top holders');
  } else {
    printWarn(
      `Detected ${changeNowReport.totalChangeNowInteractions} ChangeNow interactions across ${changeNowReport.suspectedRouters.length} wallets`,
    );
    for (const flow of changeNowReport.flows.slice(0, 10)) {
      printInfo(
        `${flow.direction} flow`,
        `${shortenAddress(flow.wallet)} → ${flow.amount} lamports` +
          (flow.possibleLinkedWallet
            ? chalk.red(` → possible link: ${shortenAddress(flow.possibleLinkedWallet)}`)
            : ''),
      );
    }
  }

  // ── PHASE 5: CABAL DETECTION ───────────────────────────────────────────
  printSection('PHASE 5 — Cabal Detection');
  const cabalSpinner = ora('Building wallet token profiles...').start();

  // Build historical token map from swap events
  const historicalMints = new Map<string, string[]>();
  for (const act of walletActivities) {
    const mints = act.swaps
      .map((s) => s.tokenIn || s.tokenOut)
      .filter((m): m is string => !!m);
    historicalMints.set(act.wallet, [...new Set(mints)]);
  }

  const walletProfiles = await buildWalletProfiles(walletsToAnalyze, historicalMints);
  cabalSpinner.text = 'Running cabal clustering algorithm...';

  const cabals = detectCabals(walletProfiles);
  cabalSpinner.succeed(
    cabals.length > 0
      ? `Detected ${cabals.length} suspected cabal(s)`
      : 'No cabals detected',
  );

  if (cabals.length > 0) {
    console.log('\n' + buildCabalTable(cabals));

    for (const cabal of cabals.slice(0, 3)) {
      console.log(
        `\n  ${chalk.magenta(`Cabal #${cabal.id}`)} — ${chalk.yellow(cabal.wallets.length)} wallets, ` +
          `${chalk.cyan(cabal.sharedTokens.length)} shared tokens, ` +
          `risk score: ${chalk.red(String(cabal.riskScore))}/100`,
      );
      console.log(chalk.dim('  Wallets:'));
      for (const w of cabal.wallets.slice(0, 5)) {
        console.log(`    ${chalk.white(w)}`);
      }
      if (cabal.wallets.length > 5) {
        console.log(chalk.dim(`    ... and ${cabal.wallets.length - 5} more`));
      }
    }
  }

  // ── SUMMARY ────────────────────────────────────────────────────────────
  printSection('MISSION COMPLETE — Summary');
  printInfo('Token Mint', mintAddress);
  printInfo('Total Holders', holderReport.totalHolders.toLocaleString());
  printInfo('Wallets Analyzed', walletActivities.length.toLocaleString());
  printInfo('Wallet Links Found', walletLinks.length.toLocaleString());
  printInfo('Cabals Detected', cabals.length.toLocaleString());
  printInfo('ChangeNow Flows', changeNowReport.totalChangeNowInteractions.toLocaleString());
  printInfo('Concentration Risk', holderReport.concentrationRisk);

  return {
    mint: mintAddress,
    holderReport,
    walletActivities,
    walletLinks,
    cabals,
    changeNowReport,
    walletProfiles,
  };
}
