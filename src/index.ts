#!/usr/bin/env node
/**
 * index.ts — Secret Agent CLI
 *
 * Commands:
 *   sagent analyze <MINT>      Full pipeline analysis on a token
 *   sagent holders <MINT>      Just fetch and display holders
 *   sagent link <WALLET>       Analyze a single wallet's connections
 *   sagent cabal <MINT>        Just run cabal detection
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import { printBanner, printSection, printError, buildHoldersTable } from './utils/display';
import { runAgent } from './agent';
import { analyzeHolders } from './modules/holders';
import { analyzeWallet } from './modules/transaction-analyzer';
import { getWalletTokenHoldings } from './modules/cabal-detector';

const program = new Command();

program
  .name('sagent')
  .description('🕵️  $SAGENT — Solana memecoin on-chain intelligence')
  .version('1.0.0');

// ── ANALYZE ──────────────────────────────────────────────────────────────────
program
  .command('analyze <mint>')
  .description('Full pipeline: holders + wallet linking + cabal detection + ChangeNow tracking')
  .option('-n, --top <number>', 'Number of top holders to deep-analyze', '50')
  .option('-w, --wallet <pubkey>', 'Your wallet pubkey (for token gate check)')
  .option('--skip-gate', 'Skip token gate (dev mode only)')
  .option('--json', 'Output results as JSON to ./sagent-output.json')
  .option('-v, --verbose', 'Verbose output')
  .action(async (mint: string, options) => {
    printBanner();

    try {
      const result = await runAgent(mint, {
        topHolders: parseInt(options.top),
        skipTokenGate: options.skipGate,
        operatorWallet: options.wallet,
        verbose: options.verbose,
        outputJson: options.json,
      });

      if (options.json) {
        const outPath = `./sagent-${mint.slice(0, 8)}-${Date.now()}.json`;
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
        console.log(chalk.green(`\n  ✓ Results saved to ${outPath}`));
      }
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── HOLDERS ───────────────────────────────────────────────────────────────────
program
  .command('holders <mint>')
  .description('Fetch and display token holders and supply distribution')
  .option('-n, --top <number>', 'Number of holders to display', '50')
  .action(async (mint: string, options) => {
    printBanner();
    printSection('HOLDER ANALYSIS');
    const spinner = ora('Fetching holders...').start();
    try {
      const report = await analyzeHolders(mint);
      spinner.succeed(`${report.totalHolders.toLocaleString()} holders found`);
      console.log(buildHoldersTable(report.holders, parseInt(options.top)));
      console.log(chalk.dim(`\n  Gini: ${report.giniCoefficient.toFixed(4)}  |  Risk: ${report.concentrationRisk}`));
    } catch (err) {
      spinner.fail('Failed');
      printError(err instanceof Error ? err.message : String(err));
    }
  });

// ── WALLET ────────────────────────────────────────────────────────────────────
program
  .command('wallet <address>')
  .description('Analyze a single wallet: tx history, funding sources, programs used')
  .action(async (address: string) => {
    printBanner();
    printSection(`WALLET INTEL — ${address}`);
    const spinner = ora('Analyzing wallet...').start();
    try {
      const activity = await analyzeWallet(address);
      spinner.succeed('Done');

      console.log(chalk.yellow(`\n  Transactions analyzed: ${activity.signatures.length}`));
      console.log(chalk.yellow(`  Transfers found:       ${activity.transfers.length}`));
      console.log(chalk.yellow(`  Swaps found:           ${activity.swaps.length}`));

      if (activity.fundingSources.length > 0) {
        console.log(chalk.cyan('\n  Funding Sources (wallets that sent SOL here):'));
        activity.fundingSources.forEach((w) => console.log('    ' + chalk.white(w)));
      }

      if (activity.fundingTargets.length > 0) {
        console.log(chalk.cyan('\n  Funding Targets (wallets this wallet funded):'));
        activity.fundingTargets.forEach((w) => console.log('    ' + chalk.white(w)));
      }

      if (activity.programsUsed.length > 0) {
        console.log(chalk.cyan('\n  Programs Used:'));
        activity.programsUsed.forEach((p) => console.log('    ' + chalk.dim(p)));
      }

      console.log(chalk.cyan('\n  Current Token Holdings:'));
      const holdings = await getWalletTokenHoldings(address);
      holdings.forEach((mint) => console.log('    ' + chalk.white(mint)));
    } catch (err) {
      spinner.fail('Failed');
      printError(err instanceof Error ? err.message : String(err));
    }
  });

// ── CABAL ─────────────────────────────────────────────────────────────────────
program
  .command('cabal <mint>')
  .description('Run cabal detection only on top holders of a token')
  .option('-n, --top <number>', 'Number of top holders to cluster', '100')
  .option('--threshold <number>', 'Minimum Jaccard similarity (0-1)', '0.25')
  .action(async (mint: string, options) => {
    printBanner();
    printSection('CABAL DETECTION');
    const spinner = ora('Loading holders...').start();

    try {
      const { buildWalletProfiles, detectCabals } = await import('./modules/cabal-detector');
      const { analyzeHolders } = await import('./modules/holders');

      const report = await analyzeHolders(mint);
      spinner.text = 'Building wallet profiles...';

      const wallets = report.holders.slice(0, parseInt(options.top)).map((h) => h.owner);
      const profiles = await buildWalletProfiles(wallets);
      spinner.text = 'Running clustering...';

      const cabals = detectCabals(profiles, parseFloat(options.threshold));
      spinner.succeed(`Found ${cabals.length} cabal(s)`);

      for (const c of cabals) {
        console.log(`\n  ${chalk.magenta(`Cabal #${c.id}`)} — ${c.wallets.length} wallets, ${c.sharedTokens.length} shared tokens, risk: ${c.riskScore}/100`);
        c.wallets.forEach((w) => console.log('    ' + chalk.white(w)));
      }
    } catch (err) {
      spinner.fail('Failed');
      printError(err instanceof Error ? err.message : String(err));
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  printBanner();
  program.outputHelp();
}
