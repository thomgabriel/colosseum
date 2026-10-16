import { existsSync, readFileSync } from 'node:fs';

// The archive's record of one table (archive-risk.ts writes it, prune-risk.ts --archived reads it). Apart from the
// archive's script so the prune's bundle does not carry the archive's entry point.

export type Manifest = {
  table: string;
  /** Every row older than this (and not exempt) is in a file. */
  cut: string | null;
  columns: string[];
  files: Record<
    string,
    { day: string; rows: number; bytes: number; from: string | null; to: string }
  >;
};

/** A table's manifest, or null when there is none (or it cannot be read). */
export function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    return m && typeof m === 'object' && m.files ? m : null;
  } catch {
    return null;
  }
}
