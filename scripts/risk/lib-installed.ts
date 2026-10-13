import { existsSync, readFileSync } from 'node:fs';

/**
 * A warning when the installed collector registry holds the shelf's pools (`set: 'shelf'`, PLAN-ASSETS AS.12), which
 * retier.ts and build-registry.ts are about to replace with the stock registry alone; null otherwise. Reads only.
 */
export function shelfReplacedWarning(installed: string): string | null {
  if (!existsSync(installed)) return null;
  try {
    const pools = (
      JSON.parse(readFileSync(installed, 'utf8')) as { pools?: Array<{ set?: string }> }
    ).pools;
    const shelf = (pools ?? []).filter((p) => p.set === 'shelf').length;
    return shelf
      ? `WARNING: ${installed} holds ${shelf} shelf pools (a merged registry, PLAN-ASSETS AS.12); this writes the stock registry alone over it, so the collector stops measuring the shelf. Merge and install again: pnpm risk:registry-merge, then scripts/risk/collector/install.sh registry <file>`
      : null;
  } catch {
    return null;
  }
}
