import { z } from 'zod';

export const Profile = z.enum(['income', 'accumulation', 'high_risk']);
export type Profile = z.infer<typeof Profile>;

export const AssetKind = z.enum(['usd_yield', 'brl_stable', 'cash', 'equity']);
export type AssetKind = z.infer<typeof AssetKind>;

export const Chain = z.enum(['solana', 'evm']);
export type Chain = z.infer<typeof Chain>;

/** Where a number or an action came from. Anything not `live` must be labelled in UI and API. */
export const Provenance = z.enum(['live', 'mock', 'sandbox', 'fixture', 'prior_dataset']);
export type Provenance = z.infer<typeof Provenance>;

/** How a leg is acquired. `unavailable` renders as "integration in progress" and is never executed. */
export const MintPathKind = z.enum(['dex_swap', 'lending_deposit', 'issuer_mint', 'unavailable']);
export type MintPathKind = z.infer<typeof MintPathKind>;

export const ExecutionStatus = z.enum(['built', 'signed', 'sent', 'confirmed', 'failed']);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const ExecutionKind = z.enum([
  'swap',
  'deposit',
  'withdraw',
  'mint',
  'redeem',
  'rebalance',
  'approve',
]);
export type ExecutionKind = z.infer<typeof ExecutionKind>;

/** Decided at D2-PM (docs/GATES.md). */
export const PolicyMechanism = z.enum(['delegated', 'user_signed']);
export type PolicyMechanism = z.infer<typeof PolicyMechanism>;

export const Language = z.enum(['pt', 'en']);
export type Language = z.infer<typeof Language>;
