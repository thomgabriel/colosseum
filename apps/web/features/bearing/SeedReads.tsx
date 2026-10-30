'use client';
import { useState } from 'react';
import { useBearing } from './BearingProvider';
import type { SeedAnswer } from './data';

// The answers the server read for this page (server-seed.ts), kept by the section's reader as the page
// first renders, before any of its reads go out: the page then shows them once it hydrates and asks the
// risk API only for the rest. Kept once; an address the reader already has keeps its own.

export function SeedReads({ answers }: { answers: readonly SeedAnswer[] }) {
  const { reader } = useBearing();
  useState(() => reader.seed?.(answers));
  return null;
}
