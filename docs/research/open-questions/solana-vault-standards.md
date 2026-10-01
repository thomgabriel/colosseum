# Solana vault standards: use them or not

Checked Oct 1, 2026. Both repos cloned and read at `solanabr/solana-vault-standard@ceb54f3` and `solana-foundation/vault@c359962`. Program existence checked by read-only RPC. The only code run was `cargo test -p svs-math -p svs-oracle` in the solanabr clone (passed). Nothing was built with Anchor, deployed or signed. Items marked **[unverified]** were not confirmed.

## Verdict

- **Neither is a base for our vault.** Both are pooled, share-token vaults with an admin who is trusted with the money. Ours is one owner per vault, no shares, and a keeper the vault does not trust. The security-critical part of our program (keeper leg, Jupiter CPI, balance-delta and oracle checks, loss budget) exists in neither repo.
- **solanabr/solana-vault-standard (SVS): borrow two crates and a few patterns, and say so in the submission.** Files listed below. It is Superteam Brazil's public good, and Thom is the repo's top committer (git author `thomga`: 91 of 253 commits, SVS-7/10/11/12 and `sdk/core`).
- **solana-foundation/vault: ignore the program, copy the tooling.** Committed IDL, Codama-generated clients, an IDL-drift CI check and LiteSVM tests are the right setup for a program that many agents build against and that outside agents should integrate with.
- **Do not conform to either interface.** Both interfaces are deposit/mint/withdraw/redeem of a share token. Without a share token there is nothing to conform to. Follow SVS naming conventions where it costs nothing (below).

## 1. solanabr/solana-vault-standard

https://github.com/solanabr/solana-vault-standard

**What it is.** A family of 12 Anchor programs, SVS-1 to SVS-12, that started as ERC-4626 on Solana (deposit, mint, withdraw, redeem, preview functions, virtual-offset inflation protection, vault-favouring rounding) and grew to cover ERC-7540 async vaults, credit vaults, tranches, streaming yield, confidential shares, a multi-asset basket (SVS-8) and a vault-of-vaults allocator (SVS-9). Plus 8 shared crates under `modules/`, a TypeScript SDK and CLI (`@stbr/solana-vault`), and Trident fuzz tests. Every variant has a Token-2022 share mint.

| | |
|---|---|
| License | MIT (`LICENSE`, Superteam Brazil 2026). The `modules/*` `Cargo.toml` files say Apache-2.0. Either allows vendoring with attribution |
| Activity | 253 commits, Jan 27 to Apr 10, 2026; 214 of them in March. Nothing pushed since Apr 10. Tags v0.2.0 to v0.3.0 and v2.0.0 (Apr 4). 24 stars, 35 forks, 1 open PR (SVS-11, Jun 2) |
| Origin | Superteam Brasil bounty "Extend the Solana Vault Standard programs & SDK", 4,000 USDG, 12 entries, winners announced April 2026 (https://superteam.fun/earn/listing/extend-the-solana-vault-standard-programs-and-sdk/) |
| Versions | Anchor 0.31.1 (same as our installed CLI), `spl-token-2022` 6.0.0, no pinned Solana version. `docs/TODO.md` lists the Anchor 1.0 / Solana 3.x migration as not started |
| Tests | About 720 ts-mocha cases across `tests/*.ts` (19 for SVS-8), Trident fuzz targets including `trident-tests/fuzz_svs8`, proptest in the math crates. I ran only the two pure crates: 32 unit + 7 doc tests pass |
| Audit | None by a firm. `docs/SECURITY.md` says "NOT AUDITED". `audit/agent_audit_03-26.md` is ten rounds of automated agent review |
| Deployments | Devnet only. SVS-1 and SVS-8 program accounts exist on devnet and return null on mainnet-beta (RPC, today) |

**SVS-8, the closest variant** (`programs/svs-8`, 2,502 lines, mostly written by `xinaids`):

- One pooled basket per `vault_id` (seeds `["multi_vault", vault_id]`), run by an `authority`. Not per user.
- Up to **8** assets (`MAX_ASSETS`, a compute and account-count limit). Each asset has an `AssetEntry` PDA (`["asset_entry", vault, mint]`: mint, token account, oracle, `target_weight_bps`, decimals) and an `OraclePrice` PDA.
- The oracle is a price the **authority pushes** into a program-owned account (`update_oracle.rs`), 1e9 scale, 60-second staleness. It is not Pyth, despite the comment in `state.rs`.
- Deposits: `deposit_single` (one asset, shares priced off total portfolio value) and `deposit_proportional`. Withdrawals: `redeem_single` and `redeem_proportional` (pro-rata slice of every asset). Shares use the 4626 virtual-offset maths from `svs-math`.
- **Every redeem path fails when the vault is paused or any asset's price is older than 60 seconds.** That is the opposite of our rule that in-kind withdrawal depends on nothing.
- **No swap or rebalance instruction.** `update_weights` only changes target numbers; `docs/SVS-8.md` says "rebalance swaps are separate transactions" and leaves them to the authority. There is no Jupiter code anywhere in the repo's programs.
- Token-2022: assets go through `token_interface`, and the redeem loop takes a per-asset token program so classic and Token-2022 mints mix. No extension checks on asset mints. Transfers are a hand-built `transfer_checked` with five accounts, so a mint with an active transfer hook would fail.
- Fees, caps, locks and allow-lists are optional modules (`--features modules`) found by scanning trailing `remaining_accounts`. **If the caller leaves the module account out, the check is skipped** (`modules/svs-module-hooks/src/hooks.rs`). Fine for opt-in fees; never copy that shape for a safety check.

**Fit with our vault.**

| Our requirement | SVS-8 |
|---|---|
| One vault per user per basket | One pooled vault, admin-run |
| No share token | Share mint is the core of every instruction |
| Up to 15 mints | 8 |
| Owner-only deposit, in-kind withdraw that nothing can block | Anyone deposits; redeem blocked by pause and by a stale price |
| Keeper-only swap leg through Jupiter with balance-delta and oracle checks | Absent |
| Recipe versions, accepted-version, auto-follow flag, loss budget | Absent |

Starting from SVS-8 means deleting the share logic (about half the program) and writing everything that matters from scratch, on a layout (3 to 6 accounts per asset per instruction) that is wrong for us: our binding limit is 64 accounts per transaction and a Jupiter leg already takes 23 to 48. Keep recipe mints in the vault or recipe account as a fixed array, not one PDA per asset.

**Borrow these.**

| File | Use |
|---|---|
| `modules/svs-math/` (`mul_div.rs`, `rounding.rs`) | Pure Rust, no dependencies, overflow-checked `mul_div` with explicit rounding. Take as a path dependency or copy. All weight, value and tolerance maths goes through it |
| `modules/svs-oracle/src/functions.rs` | `validate_freshness` (rejects future timestamps), `validate_price`, `validate_deviation` in bps. Pure Rust. Use for rule 7 and for the cross-check between two feeds |
| `programs/svs-8/src/math.rs` | `total_portfolio_value` and `oracle_value_for_amount`: decimals-normalised u128 valuation, the core of rule 4 (value after ≥ value before − tolerance). `read_token_balance`: reads `amount` at bytes 64..72 for either token program, handy for before/after snapshots on accounts that arrive as `remaining_accounts` |
| `programs/svs-8/src/instructions/redeem_proportional.rs` | The per-asset tuple validation for the in-kind withdraw loop: owner check before deserialising, token account matched to stored key, token program derived from the mint's owner, per-asset token program. Drop the oracle and pause parts |
| `programs/svs-8/src/instructions/admin.rs` | Two-step authority transfer (`request_transfer_authority` / `accept_authority`) for the guardian and keeper keys |
| `programs/svs-9/src/state.rs` and `instructions/rebalance.rs` | `authority` vs `curator` split: the closest thing in the repo to our owner vs keeper roles |
| `programs/svs-1/src/instructions/view.rs` | Read-only instructions that answer through `set_return_data`. See section 4 |
| `trident-tests/fuzz_svs8/`, `docs/ERRORS.md`, `docs/EVENTS.md` | Shape for the adversarial fuzz target and for published error and event tables |

**Conventions worth matching at no cost:** `vault_id: u64` in seeds, `target_weight_bps` summing to 10,000, `pause` / `unpause`, one event per state change, 1e9 price scale (`PRICE_SCALE`). Then the README can truthfully say "uses `svs-math` and `svs-oracle`, follows SVS conventions, a shareless single-owner basket variant". Whether to offer it upstream as a new SVS number after the hackathon is Thom's call.

## 2. solana-foundation/vault

https://github.com/solana-foundation/vault

**What it is.** One Anchor program, `async_vault`, inspired by ERC-7540: a single-asset vault where deposits and redemptions are requests that an authority approves at a NAV the authority sets. It targets RWA issuers and off-chain strategies. Built by Exo Technologies for the Solana Foundation. The README calls it a "reference implementation" and a template to fork.

| | |
|---|---|
| License | MIT (Solana Foundation 2026) |
| Activity | 95 commits since Jan 23, 2026. Last commit today, but recent commits are dependency bumps; program code last changed Jun 8. 17 stars, 7 forks, no tags or releases |
| Versions | Anchor 1.0.3 (CLI 1.0.2), Solana 3.1.14, Rust 1.89, LiteSVM 0.12, Codama clients, `@solana/kit`. Does not build with our installed anchor-cli 0.31.1 |
| Tests | 206 Rust test functions (unit + LiteSVM integration). Not run by me |
| Audit | Cantina "APEX" scan, Jun 22, 2026 (`audits/apex-scan-june-22-2026.pdf`), baseline commit `ce2b548`; program changes after it are small (145 lines added, 70 removed: audit fixes and a program-id change). The README still says "not audited for mainnet use". **[unverified]** what an APEX scan covers; I did not read the PDF |
| Deployments | Devnet only (`vaLtx8Su…`; exists on devnet, null on mainnet-beta) |

**How it works.** `create_deposit_request` moves assets to a shared `pending_vault`; the authority calls `update_nav` then `approve_request`, which snapshots NAV into the request; the user `claim`s minted shares. Redemption burns shares at request time and pays assets after approval. The authority can `withdraw_assets` to any token account of that mint to run a strategy elsewhere; `total_asset_balance` is a virtual number that keeps the books straight. Share mint is brought by the issuer, mint authority moves to the vault PDA. No ATAs are created or required.

**Extension points.** Eight opt-in TLV extensions appended to the vault account and frozen at `initialize_vault`: deposit fee, withdrawal fee, pausable subscriptions, pausable redemptions, FIFO subscription queue, FIFO redemption queue, minimum subscription, minimum redemption. Roles beyond one authority are delegated to an external program.

**Token-2022.** `token_interface` for both programs. Asset mints with a nonzero transfer fee are rejected; share mints with `ConfidentialMintBurn` are rejected. Permanent delegate, freeze and mint-close authority are documented as "vet yourself".

**Fit with our vault: none.** Single asset, async, share-based, authority-set NAV, and the authority can move the assets out. Its own `DESIGN_DECISIONS.md` rules out our two core features: multi-asset holdings ("unlikely to be needed") and swap-and-deposit ("excluded").

**Borrow these.**

| File | Use |
|---|---|
| `programs/async_vault/src/utils.rs` → `validate_asset_mint_extensions_from_acct_info` | Token-2022 extension check when a mint enters a recipe or the platform list. Extend it: reject nonzero transfer fee; reject a transfer hook with a non-null program; record permanent delegate, pausable and freeze for the risk sheet |
| README "Token-2022 Considerations" | Template for our own disclosure of issuer powers |
| `idl/async_vault.json`, `scripts/generate-clients.ts`, `.github/workflows/idl-check.yml` | Committed IDL, Codama Rust and TypeScript clients, CI that fails when the IDL drifts. This is what makes the program easy for other agents |
| `integration-tests/` (LiteSVM) and `.github/workflows/benchmark.yml` | Fast Rust-side tests and a compute-unit check per instruction. LiteSVM works with Anchor 0.31.1 too **[unverified at the pinned 0.12 version]** |
| `audits/AUDIT_STATUS.md` | Honest format for "what was reviewed, at which commit" |

Code from this repo needs back-porting from Anchor 1.0 syntax to 0.31.1 (for example `CpiContext::new` takes a program key there). Small, but do not paste blindly.

## 3. Making the vault easy for agents

The same borrowed pieces serve the "agents can use and integrate" goal:

- **Published IDL and generated clients** (SF repo pattern). An agent needs the IDL, a typed client and the error table, nothing else.
- **View instructions with return data** (SVS-1 `view.rs` pattern): for example `preview_keeper_leg` and `vault_status` that an agent simulates without signing to learn whether a leg would pass and how much loss budget is left.
- **One event per state change and stable error codes**, one code per vault rule, so an agent can tell "stale feed" from "outside recipe" from "loss cap reached".
- **The keeper slot is the agent interface.** The vault already checks every keeper trade. If the keeper is stored per vault (a pubkey the owner sets) rather than one global key, an owner can hand the rebalance-only role to their own agent under the same checks. This is a design choice for section 5 of the technical design, not something either repo provides.

## Sources

- https://github.com/solanabr/solana-vault-standard (README, `docs/SVS-8.md`, `docs/SVS-9.md`, `docs/SECURITY.md`, `docs/TODO.md`, `CHANGELOG.md`, `audit/agent_audit_03-26.md`, `programs/svs-8/src/**`, `modules/**`)
- https://github.com/solana-foundation/vault (README, `DESIGN_DECISIONS.md`, `audits/AUDIT_STATUS.md`, `programs/async_vault/src/**`, `Cargo.toml`, `Anchor.toml`)
- GitHub API for stars, forks, releases and open PRs, Oct 1, 2026
- https://superteam.fun/earn/listing/extend-the-solana-vault-standard-programs-and-sdk/
- RPC `getAccountInfo` on `api.devnet.solana.com` and `api.mainnet-beta.solana.com` for `HnZ9N8Y1…` (SVS-8), `CzZyssz2…` (SVS-1), `vaLtx8Su…` (async_vault)
