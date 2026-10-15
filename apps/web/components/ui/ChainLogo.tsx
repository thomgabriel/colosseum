'use client';
import type { ChainId } from '@colosseum/schemas';
import { type ReactNode, useState } from 'react';
import { CHAIN_NAMES } from './chain-names';
import { cn } from './cn';

// A chain's own mark, at a fixed size, where a screen names a chain (Thom, 2026-10-09: "the logo of the
// chain on the chat"; open for Rodrigo, whose specs have no chain mark). The files and their sources are
// in public/assets/tokens/README.md. A chain with no file (Base), or whose file fails to load, has no picture:
// beside its name nothing is drawn (or the `fallback` given, such as a menu's short code), and standing
// alone the name is written. Named ChainLogo because features/account's ChainMark is the test-network mark.

const FILES: Partial<Record<ChainId, string>> = {
  // Solana's logomark, the SVG as solana.com/branding serves it.
  solana: '/assets/tokens/sol.svg',
  // Robinhood Chain's feather symbol, from its brand kit: the kit's mark for compact interface elements.
  robinhood: '/assets/chains/robinhood.png',
};

export function ChainLogo({
  chain,
  size = 16,
  decorative = false,
  fallback = null,
  className,
}: {
  chain: ChainId;
  /** The side of the square the mark sits in, in px. */
  size?: number;
  /** The chain's name is written beside it: the mark is hidden from a screen reader. */
  decorative?: boolean;
  /** Drawn in a decorative mark's place where the chain has no picture. */
  fallback?: ReactNode;
  className?: string;
}) {
  const src = FILES[chain];
  const [failed, setFailed] = useState<string | null>(null);
  if (src === undefined || failed === src)
    return decorative ? (
      fallback
    ) : (
      <span data-ui="chain-logo" data-chain={chain} className={className}>
        {CHAIN_NAMES[chain]}
      </span>
    );
  return (
    // biome-ignore lint/performance/noImgElement: a tiny local mark, already sized; no remote image service
    <img
      data-ui="chain-logo"
      data-chain={chain}
      src={src}
      alt={decorative ? '' : CHAIN_NAMES[chain]}
      aria-hidden={decorative || undefined}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn('inline-block shrink-0 object-contain', className)}
      onError={() => setFailed(src)}
    />
  );
}
