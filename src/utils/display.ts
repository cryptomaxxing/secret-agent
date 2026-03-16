import chalk from 'chalk';
import Table from 'cli-table3';
import figlet from 'figlet';

export function printBanner(): void {
  console.log(
    chalk.cyan(
      figlet.textSync('SECRET AGENT', { font: 'ANSI Shadow', horizontalLayout: 'full' }),
    ),
  );
  console.log(chalk.gray('  $SAGENT — On-chain intelligence for Solana memecoins\n'));
  console.log(chalk.dim('  ▸ Wallet clustering  ▸ Cabal detection  ▸ Transaction forensics\n'));
}

export function printSection(title: string): void {
  console.log('\n' + chalk.bgCyan.black(` ${title} `) + '\n');
}

export function printInfo(label: string, value: string): void {
  console.log(`  ${chalk.dim('▸')} ${chalk.yellow(label)}: ${chalk.white(value)}`);
}

export function printSuccess(msg: string): void {
  console.log(chalk.green(`  ✓ ${msg}`));
}

export function printWarn(msg: string): void {
  console.log(chalk.yellow(`  ⚠ ${msg}`));
}

export function printError(msg: string): void {
  console.log(chalk.red(`  ✗ ${msg}`));
}

export function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function buildHoldersTable(
  holders: Array<{ owner: string; amount: string; pct: number }>,
  top = 20,
): string {
  const table = new Table({
    head: [
      chalk.cyan('#'),
      chalk.cyan('Wallet'),
      chalk.cyan('Balance'),
      chalk.cyan('% Supply'),
    ],
    style: { head: [], border: ['gray'] },
  });

  holders.slice(0, top).forEach((h, i) => {
    table.push([
      chalk.dim(String(i + 1)),
      chalk.white(h.owner),
      chalk.yellow(formatTokenAmount(h.amount)),
      chalk.green(h.pct.toFixed(2) + '%'),
    ]);
  });

  return table.toString();
}

export function buildCabalTable(
  cabals: Array<{
    id: number;
    wallets: string[];
    sharedTokens: string[];
    totalHolding: string;
    riskScore: number;
  }>,
): string {
  const table = new Table({
    head: [
      chalk.cyan('Cabal #'),
      chalk.cyan('Wallets'),
      chalk.cyan('Shared Tokens'),
      chalk.cyan('Risk Score'),
    ],
    style: { head: [], border: ['gray'] },
  });

  cabals.forEach((c) => {
    table.push([
      chalk.magenta(`#${c.id}`),
      chalk.white(String(c.wallets.length)),
      chalk.yellow(String(c.sharedTokens.length)),
      riskColor(c.riskScore)(`${c.riskScore}/100`),
    ]);
  });

  return table.toString();
}

export function buildLinkedWalletsTable(
  links: Array<{ wallet: string; linkedTo: string; reason: string; confidence: number }>,
): string {
  const table = new Table({
    head: [
      chalk.cyan('Wallet'),
      chalk.cyan('Linked To'),
      chalk.cyan('Reason'),
      chalk.cyan('Confidence'),
    ],
    style: { head: [], border: ['gray'] },
  });

  links.forEach((l) => {
    table.push([
      chalk.white(shortenAddress(l.wallet)),
      chalk.yellow(shortenAddress(l.linkedTo)),
      chalk.dim(l.reason),
      riskColor(l.confidence)(`${l.confidence}%`),
    ]);
  });

  return table.toString();
}

function riskColor(score: number): chalk.Chalk {
  if (score >= 70) return chalk.red;
  if (score >= 40) return chalk.yellow;
  return chalk.green;
}

export function formatTokenAmount(amount: string, decimals = 6): string {
  const n = parseInt(amount) / Math.pow(10, decimals);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return n.toFixed(2);
}
