# EVM feasibility: per-user vault with a restricted rebalancer (Base + Robinhood Chain)

Researched 2026-10-01 (Thursday, 08:50-09:00 ET, US pre-market). Read-only: docs, the `base/base-std` repo, and `eth_call` / `eth_getLogs` / `eth_getCode` against the public RPCs (`https://mainnet.base.org`, `https://rpc.mainnet.chain.robinhood.com`). Nothing was signed or sent.

Labels: **[onchain]** = I read it from the chain today. **[doc]** = primary documentation. **[inference]** = my reasoning. **[unverified]** = not confirmed.

## TL;DR

- **A contract vault can hold both families of stock token.** On Base the three transfer scopes of NVDAc, AAPLc and TSLAc all point at policy 5, and policy 5 authorizes arbitrary addresses, so it is a deny-list, not an allowlist [onchain]. On Robinhood Chain the token ABI has no per-address gate at all [onchain selector scan]. DEX pools hold both today.
- **Non-US eligibility is not enforced on-chain on either chain.** It lives at mint/redeem (KYC'd Authorized Participants) and in front-ends. Our app has to geofence itself.
- **Issuer powers are the residual risk.** Base: pause, seize, and the admin can rebind any transfer scope to an allowlist with no enforced delay. Robinhood: `pause()`, `adminBurn(address,uint256)`, upgradeable beacon. All fail closed for a vault (swaps revert); none let a keeper steal.
- **A Chainlink min-out check is workable but loose.** Feeds are 8-decimal, total-return (multiplier already included), 0.5% deviation / 24h heartbeat, and were 4.7h (Base NVDA) and 5.5h (RH NVDA) old during a live 24/5 session. They freeze on weekends and during corporate actions. Tolerance has to be about 1-2%, and the keeper path must be closed when the market is.
- **Robinhood Chain has Chainlink feeds for about 36 of 195 Stock Tokens** (Chainlink reference directory, fetched today). Auto-follow with an on-chain price bound only works for those. Base has feeds for all 10.
- **Gas is not a constraint.** A 5-leg rebalance is about 1.4M gas on Base (about $0.02 at the 0.006 gwei base fee) and about 0.95M gas on Robinhood Chain (about $0.05 at 0.02 gwei) [computed from sampled receipts].
- **Write a small custom vault.** Safe + Zodiac Roles, Kernel and the 4337 EntryPoints are deployed on both chains, but none of them can express "value after >= value before minus x%, priced by Chainlink" without a custom contract anyway.
- **Biggest build risk: Base stock tokens are precompiles (`eth_getCode` returns `0xef`), so a stock Anvil fork probably cannot execute them** [inference, verify day 1]. Robinhood tokens are ordinary beacon proxies and there is a testnet faucet.

## (a) Base: Coinbase tokenized stocks (B20)

### Token facts

| Item | Value | Source |
|---|---|---|
| Tokens | AAPLc `0xb200…C2e324d24d7eEcd1fb`, AMZNc `0xb200…d9192b6B456483C2E8`, GOOGLc `0xb200…2D0BA3164cc74f58B7`, METAc `0xb200…8bC8786B856E61707C`, MSFTc `0xB200…Ab99cFa739E253872B`, MSTRc `0xb200…4884b426556b92883d`, NVDAc `0xb20000000000000000000078ee7ce2fE4908108C`, SNDKc `0xb200…397293Cb8cda9a10c5`, SPCXc `0xb200…7b9fcbd005511aCBd5`, TSLAc `0xb2000000000000000000001e800a7f5189430cD0` (full addresses in the docs page) | [doc] docs.base.org tokenized stocks |
| Code | `eth_getCode(NVDAc)` = `0xef`: a protocol precompile, not deployed bytecode | [onchain] |
| Decimals | **8** (NVDAc, AAPLc, TSLAc), not 18 | [onchain] |
| Multiplier | `uiMultiplier()` = 1e18 on NVDAc and AAPLc today | [onchain] |
| Supply | NVDAc `totalSupply` = 20,166.9 tokens, about $4.6M | [onchain] |
| Events | Standard ERC-20 `Transfer` and `Approval` topics | [onchain] |
| Pause state | `pausedFeatures()` returns an empty array on NVDAc (nothing paused) | [onchain] |
| Precompiles | B20 factory `0xB20f000000000000000000000000000000000000`, Policy Registry `0x8453000000000000000000000000000000000002`, Activation Registry `0x8453000000000000000000000000000000000001` | [doc] base-std `StdPrecompiles.sol` |
| Onchain registry | `0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD` (token list, pause flag for feeds) | [doc] |

### Transfer-policy model

From `base/base-std` docs (`concepts/policies.md`, `guides/restricting-transfer-initiators.md`, `reference/constants.md`):

- Every `transfer` / `transferFrom` (and memo variants) checks three independent scopes: `TRANSFER_SENDER_POLICY` on `from`, `TRANSFER_RECEIVER_POLICY` on `to`, `TRANSFER_EXECUTOR_POLICY` on `msg.sender`. A failed check reverts `PolicyForbids(scope, policyId)`.
- A scope bound to policy id `0` means always allow. Policies are `ALLOWLIST`, `BLOCKLIST`, or composites (`UNION`, `INTERSECT`), stored once in the Policy Registry and shared across tokens.
- The executor scope matters for us: when a router or pool pulls tokens with `transferFrom`, the router or pool is the executor and must be authorized. There is no carve-out for the holder.
- `approve()` is not policy-gated. An allowance says nothing about whether the later transfer will pass. [doc] docs.base.org
- Read path: `token.policyId(bytes32 scope) -> uint64`, then `PolicyRegistry.isAuthorized(uint64 policyId, address) -> bool` (never reverts).
- The token admin (`DEFAULT_ADMIN_ROLE`) can call `updatePolicy(scope, newId)`. Announcements are "not an enforced delay" [doc], so a scope can be switched to an allowlist without notice.

What is actually bound today [onchain]:

| Scope | NVDAc | AAPLc | TSLAc |
|---|---|---|---|
| `TRANSFER_SENDER_POLICY` | 5 | 5 | 5 |
| `TRANSFER_RECEIVER_POLICY` | 5 | 5 | 5 |
| `TRANSFER_EXECUTOR_POLICY` | 5 | 5 | 5 |
| `MINT_RECEIVER_POLICY` | 5 | | |
| `SEIZE_RECEIVER_POLICY` | 0 | | |
| `SEIZE_EXEMPT_POLICY` | 0 | | |

- `isAuthorized(5, x)` returns `true` for `0x…dEaD`, `0x1111…1111`, Permit2, the Uniswap v4 PoolManager, the Universal Router and the Aerodrome pool. An allowlist would return `false` for unknown addresses, so **policy 5 is a deny-list (sanctions-style)**. Policy admin: `0xEC0F05C174e54FBf0Fe16ad930a8AFEbCe612812`.
- Contracts do hold the tokens: the Aerodrome Slipstream NVDAc/USDC pool `0x853f5f1b92b16714fe6cda67caad0856b83c7ab9` holds 4,306 NVDAc plus $1.34M USDC, and the Uniswap v4 PoolManager holds 1,788 NVDAc.
- Mint receiver is also policy 5, so the mint restriction to APs is by `MINT_ROLE`, not by policy.
- Docs mismatch: the docs name `SEIZE_HOLDER_POLICY`, but `policyId(keccak("SEIZE_HOLDER_POLICY"))` reverts `UnsupportedPolicyType` on NVDAc. The deployed name is `SEIZE_EXEMPT_POLICY` (as in `B20Constants.sol`).

### Eligibility for self-custody DEX buyers

- Docs: "only available to persons in eligible jurisdictions outside of the U.S." and "Holding and trading on the secondary market is permissionless." [doc]
- The B20 post: mint and redeem "remain restricted to KYC-onboarded Authorized Participants", and "some operational controls sit above the token and are not enforced by B20". [doc] blog.base.dev
- Combined with the deny-list finding: **the non-US rule is contractual and front-end enforced, not on-chain.** A US wallet can buy on Aerodrome. Our app carries that obligation (geofence, attestation at onboarding). [inference]

### Issuer powers that touch a vault

- **Pause** per feature (`TRANSFER | MINT | BURN | SEIZE`), `PAUSE_ROLE` / `UNPAUSE_ROLE`. A paused transfer makes every swap revert.
- **Seize**: "An administrator with the seize role moves tokens from a policy-flagged address to an authorized destination, with a memo recorded." A vault that lands on the deny-list can be emptied by the issuer. [doc]
- **Policy rebind** with no enforced timelock (above).
- **Multiplier**: `updateUIMultiplier` is scheduled; a deprecated instant `updateMultiplier` still exists for emergencies. [doc]

## (b) Robinhood Chain Stock Tokens

All [onchain] unless marked. Sample token: NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` (address from `https://api.robinhood.com/rhj/assets`).

- **Beacon proxy.** Beacon slot points to `0xe10b6f6b275de231345c20d14ab812db62151b00`, whose `implementation()` is `0xb35490d6f9163de4f80d88dc75c3516eb64c5ae2`. The token's `ACCESS_CONTROLLED_REGISTRY()` returns the same `0xe10b…1b00`, so one contract is both beacon and role registry. Robinhood can upgrade every Stock Token at once. [inference from the shared beacon]
- **Decimals 18**, `uiMultiplier()` = 1.000775e18 on NVDA. USDG has **6** decimals.
- **Implementation selectors** (36 total, resolved with 4byte): ERC-20 + EIP-2612 `permit`; `pause()`, `unpause()`, `paused()`, `tokenPaused()`; `pauseOracle()`, `unpauseOracle()`, `oraclePaused()`; `mint`, `burn`, **`adminBurn(address,uint256)`**; `updateMultiplier(uint256)` and `updateMultiplier(uint256,uint256)`; `uiMultiplier`, `newUIMultiplier`, `effectiveAt`, `balanceOfUI`, `totalSupplyUI`; `setMetadata`, `terms`, `uid`.
- **No blocklist or allowlist function is exposed** (no `isBlocked`, `freeze`, `setAllowed`, or similar). I could not read verified source (Blockscout is behind a Cloudflare challenge), so a transfer-time check against the registry cannot be ruled out. [unverified]
- **Contracts hold them**: the Uniswap v4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951` holds about 26,640 NVDA (about $6.1M). NVDA `paused()` is false.
- **Each transfer emits two logs**: `Transfer` and `TransferWithScaledUI(address,address,uint256,uint256)`.
- **Screening**: Robinhood's docs list no token-level restriction ("standard ERC-20 tokens … can be held or transferred in any compatible wallet") [doc]. The earlier note found ArbOS Elara lets the chain owner filter transactions at the sequencer, which is the likely enforcement point [inference]. A filtered keeper transaction would simply not land.
- **Eligibility**: non-US, enforced off-chain, same as Base. Primary mint/burn is KYB-only. [doc]
- **Multiplier handling for a vault**: hold and account in raw units; raw balances never change on a corporate action. Chainlink prices already include the multiplier, so value = `rawBalance * price / 1e18` with no extra multiplier step. Robinhood REST `/prices` is not multiplier-adjusted, so never mix the two. [doc]

## (c) Swap execution from a contract

### Addresses

Presence confirmed by `eth_getCode` on both chains today unless noted.

| Contract | Base (8453) | Robinhood Chain (4663) | Source for the address |
|---|---|---|---|
| Uniswap v4 PoolManager | `0x498581ff718922c3f8e6a244956af099b2652b2b` | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | Uniswap v4 deployments |
| Universal Router 2.1.2 | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` | `0x204FAca1764B154221e35c0d20aBb3c525710498` | Uniswap v4 deployments |
| Universal Router (older) | `0x6ff5693b99212da76ad316178a184ab56d299b43` | `0x8876789976decbfcbbbe364623c63652db8c0904` | Uniswap v4 deployments |
| v4 Quoter | `0x0d5e0f971ed27fbff6c2837bf31316121532048d` | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | Uniswap v4 deployments |
| v4 StateView | `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | Uniswap v4 deployments |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | same | Uniswap |
| 0x AllowanceHolder | `0x0000000000001fF3684f28c67538d4D072C22734` | same address has code | canonical address from memory; confirm in 0x docs |
| 1inch Aggregation Router v6 | `0x111111125421cA6dc452d289314280a0f8842A65` | same address has code | canonical address from memory; confirm in 1inch docs |
| Aerodrome Slipstream NVDAc/USDC pool | `0x853f5f1b92b16714fe6cda67caad0856b83c7ab9` (tick spacing 10, fee 0.05%, factory `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`) | n/a | [onchain] |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same | [onchain] |

Notes:
- A search snippet (Uniswap docs PR #1161) says support for Universal Router 2.0 and 2.1.1 ends 2026-10-21. I did not see that on the deployments page [unverified]. Use 2.1.2.
- The Aerodrome stock pools come from factory `0xf8f2…61Ef`, not the original Slipstream factory. I did not confirm which swap router serves that factory [unverified]. The classic router `0xcF77…4E43` and Slipstream router `0xBE6D…18a5` have code on Base.
- 0x API and Uniswap Trading API coverage of chain 4663 is not confirmed from their docs [unverified]. Robinhood's docs name "0x RFQ, 1inch Fusion, LiFi aggregators" and Uniswap as venues [doc].

### Where the liquidity is

- **Base**: sampled NVDAc transactions mostly touched the Aerodrome Slipstream pool; none of the 18 samples went through the Uniswap v4 PoolManager. Activity was 782 token logs in the last 2,000 blocks (67 min, pre-market) and over 4,500 per 2,000 blocks during yesterday's US session. Roughly $1M of each side in the main pool: fine for retail-size legs, visible impact at $50k+. [onchain]
- **Robinhood Chain**: 735 NVDA transfers in 3,000 blocks (about 5 min). Venues in the samples: Uniswap v4 (NVDA/WETH), several USDG pools, and multi-venue aggregator routes. [onchain]

### How the vault should call and verify

1. The keeper gets calldata off-chain from an aggregator with `taker = vault`.
2. The vault approves the exact `amountIn` to an allowlisted spender (0x AllowanceHolder, 1inch router, or Permit2), calls an allowlisted target, then sets the allowance back to 0.
3. The vault checks **balance deltas, not return values**: `tokenIn` fell by at most `amountIn`, `tokenOut` rose by at least `minOut`, and no other recipe token fell. This makes opaque aggregator calldata safe to accept.
4. With 0x, only ever approve AllowanceHolder, never the Settler contract (it is redeployed and can execute arbitrary calls). [doc, 0x guidance from memory; confirm]
5. On Base, preflight `isAuthorized(token.policyId(scope), addr)` for the vault (sender and receiver) so a policy change surfaces as a clear error instead of a failed swap.

Both token families are plain non-rebasing ERC-20 for transfers, so balance-delta accounting is exact. Mind the decimals: 8 (Base stocks), 6 (USDC, USDG), 18 (Robinhood stocks).

## (d) Price reference for an on-chain minimum-output check

### Feeds

- **Base**: one Chainlink feed per stock, 8 decimals, total-return (multiplier baked in). NVDA `0x04689a41629776563E6822F76f2e57D148d28513` (`description()` = "Coinbase NVDA"), AAPL `0x787f13dEa48Db0897CbCDD985de77809D837F988`, TSLA `0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4`, others in the docs page. ETH/USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`. [doc + onchain]
- **Robinhood Chain**: Chainlink's reference directory (`reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`) lists 58 feeds: 35 tagged `us_equities_24/5` plus GLD, the rest crypto and stablecoins. NVDA `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15`, SPY `0x319724394D3A0e3669269846abE664Cd621f9f6A`, QQQ `0x80901d846d5D7B030F26B480776EE3b29374C2ae`, AAPL `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0`, TSLA `0x4A1166a659A55625345e9515b32adECea5547C38`, GLD `0x470A51258068043bd43dC0a56245625C9fE86eB0`, SGOV `0xa0DF4ee0fFf975306345875E3548Fcc519577A11`, USDG/USD `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`, ETH/USD `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9`. All 0.5% deviation, 86,400s heartbeat, 8 decimals.
  - Covered equities and ETFs: AAPL, AMD, AMZN, ASML, BABA, CLSK, COIN, CRCL, CRWV, DELL, EWY, GME, GOOGL, INTC, IONQ, META, MSFT, MSTR, MU, NBIS, NVDA, ORCL, PLTR, QQQ, RGTI, RKLB, SGOV, SLV, SNDK, SPCX, SPY, TSLA, TSM, USAR, USO, GLD.
  - **159 of 195 Stock Tokens have no push feed in that directory.** Chainlink Data Streams may cover more [unverified].

### Observed behaviour (Thu 2026-10-01, about 08:55 ET, inside the 24/5 window)

| Feed | Price | Age of `updatedAt` |
|---|---|---|
| Base NVDA | 229.904 | 4.7 h |
| RH NVDA | 230.423 (equity x 1.000775) | 5.5 h |
| RH GLD | 382.034 | 9.0 h |
| RH ETH/USD | 2,707.49 | 1.0 h |
| Base ETH/USD | 2,697.03 | under 1 min |

So even when the market is "open" a feed can be hours old and up to 0.5% off. A staleness bound tighter than the 24h heartbeat rejects valid prices.

### When markets are closed

- Base: "the feed stops publishing and holds the last known good value … `updatedAt` stops advancing while the contract stays callable." During a corporate action "the feed freezes (the registry pause flag is set)". "never settle or liquidate against a frozen feed." [doc]
- Robinhood: "the feed may hold the last published price even though the contract remains callable … These feeds do not have heartbeats during off-hours." Corporate actions call `pauseOracle()` and freeze the feed. [doc] The token exposes `oraclePaused()` [onchain].
- DEX pools trade through all of it, so pool price and feed price diverge every weekend.

### Check design [inference]

- Prefer one **portfolio-value invariant** over per-leg min-outs: value of all recipe assets at Chainlink prices after the rebalance >= value before x (1 - `maxLossBps`). It covers multi-leg routes and stock-to-stock swaps with one rule.
- `maxLossBps` around 100-150 per rebalance: 2 x 0.5% feed error + pool fee (0.05% on the Aerodrome pool) + impact.
- Keeper path is closed when: any used feed is older than about 25h, the timestamp falls in the weekend window (Fri 20:00 ET to Sun 20:00 ET, computed from `block.timestamp`), `oraclePaused()` is true (RH), or the Base registry pause flag is set. A staleness bound alone is not enough: at 25h the vault would still accept Friday's close on Saturday afternoon.
- The reference dapp's `maxPriceAge` of 4 days is unsafe for a keeper-permissioned vault.
- Add a cumulative cap (loss and turnover per 24h) so a keeper cannot grind the tolerance repeatedly.
- Tokens without a feed cannot be in an auto-follow recipe on-chain. Owner-signed trades can still buy them with a user-chosen slippage.

## (e) Smart-account infrastructure versus a custom vault

Code present at the canonical addresses on **both** chains [onchain]: Safe 1.4.1 singleton `0x41675C099F32341bf84BFc5382aF534df5C7461a`, SafeL2 1.4.1 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, Safe proxy factory `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, Safe 4337 module `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226`, Zodiac Roles v2 mastercopy `0x9646fDAD06d3e24444381f44362a3B0eB343D337`, Zodiac ModuleProxyFactory `0x000000000000aDdB49795b0f9bA5BC298cDda236`, EntryPoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` and v0.8 `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`, Kernel v3.1 `0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D`, Coinbase Smart Wallet factory `0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a`. (Safe, Zodiac and Kernel addresses are from memory; code exists there, but confirm against each project's deployment registry.)

Robinhood docs: EntryPoint v0.6/v0.7/v0.8, EIP-7702 supported, bundlers and paymasters from Alchemy and ZeroDev, Privy and Dynamic for wallets. [doc] Base has the same plus CDP Paymaster (earlier note). Pimlico on 4663 [unverified].

| Option | Fit for "keeper may swap among recipe assets, never withdraw" | Cost in 11 days |
|---|---|---|
| **Custom vault (minimal clones + factory)** | Exact. Withdraw is `onlyOwner`; `rebalance` is keeper-only with token/target allowlists, balance-delta checks and the oracle value invariant. Same bytecode on both chains. | About 250 lines of Solidity plus tests. No audit. |
| Safe + Zodiac Roles v2 | Roles scopes targets, selectors and parameters and has rate-limit allowances. It cannot do post-trade balance checks or oracle pricing without a custom condition contract, and opaque aggregator calldata cannot be scoped. | Safe + module deploy per vault, custom condition anyway, Safe UI/tx-service support on 4663 [unverified]. More moving parts than the custom vault. |
| ERC-4337 account + session keys (ZeroDev Kernel, Alchemy) | Session-key policies are calldata filters and spend caps. Same gap: no post-condition, no oracle bound. | Bundler and paymaster keys per chain, plus a custom policy contract. |
| EIP-7702 on the user's EOA | Gives the delegate code full control of the EOA, with no per-basket isolation. Passkey MPC provider must sign 7702 authorizations [unverified per provider]. | Avoid for custody; useful only for batching. |

Recommendation [inference]: custom vault for custody and policy. Use 4337/7702 or a paymaster only for UX (gasless, one-click create + deposit). Both stock-token families and USDC support `permit` (B20 has a `permit` test suite in base-std; RH implementation has selector `0xd505accf`), so deposit can be a single transaction without account abstraction.

## (f) Gas cost per multi-leg rebalance

Sampled receipts [onchain], ETH at about $2,700 (Chainlink).

| | Base | Robinhood Chain |
|---|---|---|
| Single stock swap | 250,138 / 253,964 / 255,825 / 260,475 gas (USDC to NVDAc on Aerodrome Slipstream) | 142,280 / 158,550 / 166,353 / 211,248 gas (NVDA vs WETH or USDG; two via Uniswap v4) |
| Aggregated or multi-hop | 440k to 1.1M | 440k to 560k |
| Gas price | base fee about 0.005-0.006 gwei; some senders paid 0.09-0.105 gwei | flat about 0.020 gwei (first-come sequencing, no priority auction) |
| L1 data fee | 1.4e-9 to 1.4e-8 ETH per tx (negligible) | `gasUsedForL1` = 0 in all samples |
| `approve` | 46,040 gas on NVDAc | not sampled |

Estimates (legs x swap gas + about 100-150k for oracle reads and vault checks):

| Rebalance | Base gas | Base cost at 0.006 gwei | Base cost at 0.1 gwei | RH gas | RH cost at 0.02 gwei |
|---|---|---|---|---|---|
| 5 legs | about 1.4M | about $0.02 | about $0.38 | about 0.95M | about $0.05 |
| 10 legs | about 2.8M | about $0.05 | about $0.76 | about 1.8M | about $0.10 |

A keeper rebalancing 1,000 follower vaults on a 5-leg update spends about $20-25 on Base and about $50 on Robinhood Chain. Per-vault execution cost does not argue for a shared pool.

## What this means for the design questions

**Q1 (own vault vs shared pool).** Own vaults are feasible on both EVM chains and cheap to operate. They also contain issuer risk: on Base a deny-listed address can be frozen and seized, so one flagged shared pool would freeze every follower, while own vaults isolate it. A shared pool of non-US-only securities also makes us the party mixing eligible and ineligible holders. [inference]

**Q2 (auto-follow permission).** Sound, if the vault enforces these on-chain:
1. Withdraw and deposit are owner-only; the keeper has no path that sends tokens anywhere but an allowlisted swap target.
2. Token allowlist = current recipe assets plus the cash token, set by the owner (or accepted by the owner when the recipe version changes), never by the keeper.
3. Target/spender allowlist fixed at deploy (AllowanceHolder, 1inch router, Universal Router/Permit2); exact approvals, zeroed after each call.
4. Balance-delta checks plus the Chainlink portfolio-value invariant with `maxLossBps`.
5. Closed when feeds are stale, paused, or it is the weekend; closed for any asset without a feed.
6. Cumulative loss and turnover caps per 24h; reentrancy guard; owner can revoke the keeper in one call.
7. Recipe changes take effect after a delay so followers can opt out before a keeper acts on a malicious update.

Exploit paths this closes or bounds: keeper routing through its own pool (bounded by 4 and 6), stale-feed arbitrage on weekends and corporate actions (5), leftover approvals (3), a creator adding an illiquid or feedless token (2, 5, 7). What it does not close: issuer pause, seize, policy rebind, or token upgrade. Those fail closed.

**Q3 (nesting).** With own vaults a nested index needs no new contract: the recipe stores component references, the keeper flattens them to leaf weights off-chain, and the vault holds only leaf tokens and checks invariants, not weights. Nesting only works within one chain. With shared pools the parent would hold pool shares and need a NAV oracle for them. [inference]

**Q4 (11-day MVP).**
- One Solidity vault + factory, identical on both chains, parameterized by cash token and feed map.
- Robinhood Chain is the easier EVM target: ordinary proxy tokens (fork tests work), a testnet (46630) with a Stock Token faucet, cheaper swaps in gas terms, deep v4 liquidity. Limit recipes to the 36 feed-covered tickers.
- Base second: all 10 tokens have feeds, but there is no testnet and the tokens are precompiles. Test with base-std's `MockB20Asset` and a small real-money mainnet run.
- Skip Safe/Zodiac and session-key stacks for custody.

## Open risks and things to verify

1. Anvil/Foundry fork behaviour for B20 precompiles (`0xef` code). If forks cannot execute them, Base testing is mocks plus mainnet only. Check on day 1.
2. Robinhood token source is unread (Blockscout blocked). A transfer-time registry check or sequencer filter could block a contract holder. Test with a real vault deploy and a small transfer.
3. Which Aerodrome router serves factory `0xf8f2…61Ef`; whether 0x, 1inch and the Uniswap Trading API quote for `taker = contract` on chain 4663.
4. Coinbase can rebind transfer scopes to an allowlist with no enforced delay; vault tokens would become stuck until the vault address is listed.
5. Chainlink coverage on Robinhood Chain (36 of 195) is from the reference directory; confirm on docs.chain.link and check Data Streams.
6. Feed tolerance of 1-1.5% is real money on every rebalance if a keeper is hostile; the caps in Q2 bound it but do not remove it.
7. The public Robinhood RPC rate-limits hard (Cloudflare 403/429 after about 30 calls). A keeper needs Alchemy or another paid endpoint.
8. Universal Router version support dates (2.1.1 end date is from a search snippet only).
9. Non-US gating is ours to enforce on both chains.

## Sources

- Base tokenized stocks docs: https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base
- B20 post: https://blog.base.dev/b20-tokenized-stocks-on-base
- B20 spec index: https://docs.base.org/base-chain/specs/reference/b20
- base-std repo (policies, constants, executor-policy guide, `StdPrecompiles.sol`, `IPolicyRegistry.sol`): https://github.com/base/base-std , https://github.com/base/base-std/blob/main/docs/concepts/policies.md , https://github.com/base/base-std/blob/main/docs/reference/constants.md , https://github.com/base/base-std/blob/main/docs/guides/restricting-transfer-initiators.md
- Robinhood Chain docs: https://docs.robinhood.com/chain/building-with-stock-tokens/ , https://docs.robinhood.com/chain/contracts/ , https://docs.robinhood.com/chain/account-abstraction/ , https://docs.robinhood.com/chain/oracles-and-price-feeds
- Robinhood asset registry API: https://api.robinhood.com/rhj/assets
- Chainlink Robinhood equity feeds: https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
- Chainlink reference directory (feed addresses, heartbeat, deviation): https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
- Uniswap v4 deployments: https://developers.uniswap.org/docs/protocols/v4/deployments (also https://docs.uniswap.org/contracts/v4/deployments)
- Universal Router address change for Robinhood Chain: https://github.com/Uniswap/docs/pull/1161
- On-chain reads: `https://mainnet.base.org` (block about 52,034,980) and `https://rpc.mainnet.chain.robinhood.com` (block about 77,391,270), 2026-10-01 about 12:52-13:05 UTC
- Earlier notes: internal team notes
