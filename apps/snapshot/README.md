# apps/snapshot

The snapshot worker (docs/vault/PROMPT-BUILD-PORTFOLIO.md, slice 1): a worker with no HTTP listener that reads every vault we know on each chain, values it on the chain's own prices, and keeps what it read as one row of `vault_snapshots`, a pass every ten minutes. The portfolio section draws its history from those rows. It reads and never signs.

```sh
CHAIN_MODE_SOLANA=readonly SOLANA_RPC_URL=<devnet node> \
  pnpm --filter @colosseum/snapshot start --once           # one pass over every chain, then exit
  ... --loop [--interval 600]                              # a pass every interval seconds (60 or more)
  ... --dry-run                                            # reads and prints; writes nothing
```

- `--once` or `--loop`, exactly one. With `--once` the exit code is 1 when a pass failed. A flag it does not know stops it: `--dryrun` is refused, not ignored.
- It reads the environment it is started with and loads no `.env` file, as the keeper.
- `DATABASE_URL` is the database it writes to. Unset, it is the local one of `pnpm db:up`.
- It opens its database through `createDb()` of `packages/db`, as the API does, and so obeys `DB_POOL_MAX` and `DB_PGBOUNCER` (`packages/db/src/pool.ts`).
- What is wrong at start (a mainnet it does not read, no chain to read, a missing node address, a node of another network, a deploy record it cannot read, a database of another network, a database that does not answer) is said on stderr and ends it with 1 before any pass. A database that is down is said by the code of the refusal, `the database did not take a query (ECONNREFUSED)`, never by the query.

## Which chains

- `SNAPSHOT_CHAINS`: a comma list of chain ids (`solana`, `robinhood`, `base`). Unset, the worker reads every chain whose `CHAIN_MODE_<CHAIN>` is `live` or `readonly`. `live` means what `readonly` means here: the worker only ever reads.
- A chain on the mock (`CHAIN_MODE_<CHAIN>=mock`, which is also the default for Solana and Robinhood Chain) is read only when `SNAPSHOT_CHAINS` names it, so nothing fills the tables with sample rows by omission.
- A named chain that is `off` is refused. So is an id that is not a chain, and so is starting with no chain at all.
- A real chain is Solana or Robinhood Chain, each from the record its deploy committed: `deployments/solana-devnet.json`, `deployments/robinhood-testnet.json`, `deployments/robinhood-mainnet.json` for `CHAIN_NETWORK_ROBINHOOD=mainnet`, and `solana-local.json` or `robinhood-local.json` for `CHAIN_NETWORK_<CHAIN>=local` where there is one. The program or the factory, the price account and the tokens come from the record. `CHAIN_ROUTER_<CHAIN>` and `CHAIN_PRICE_SOURCE_SOLANA` may repeat the record's address and never replace it.
- The node is `SOLANA_RPC_URL` or `ROBINHOOD_RPC_URL`. It is asked which network it is before the first pass, and has to answer the record's genesis or chain id: a mainnet's only for Robinhood Chain's mainnet record. A node of another network stops the worker. A node that does not answer at start (a timeout, a 403, a rate limit) does not: it is said once on stderr, that chain's passes fail and back off alone, and nothing is read from it until it has said its network. The other chains are read as usual.
- An EVM node is asked through a client that passes on reads alone (`READ_METHODS` of `packages/chain-evm`: `eth_call`, `eth_blockNumber`, `eth_chainId`, `eth_getCode`, `eth_getBalance`, `eth_getBlockByNumber`, `eth_gasPrice` and the two transaction lookups); any other method is refused before the node is asked. It sends three requests a JSON-RPC batch and two batches at a time, for every network (`EVM_NODE` in `src/chains.ts`).
- Base has no reader for a real network yet: `CHAIN_MODE_BASE=readonly` is refused by name. On the mock it is a chain like the others.
- The flags are read once, by `parseFlags`, as the API reads them. A name under `CHAIN_`, `AUTO_FOLLOW_` or `KEEPER_` that nobody reads is refused as a typo; the keeper's own names (`KEEPER_CHAIN`, `KEEPER_STATE_DIR` and the rest) are known, so one environment can serve the keeper and the worker.

## Robinhood Chain on mainnet

Gate `SNAPSHOT-WORKER-MAINNET` (Thom, Oct 13): the worker reads Robinhood Chain's mainnet (4663) beside Solana's devnet, as the hosted API serves them. It takes the API's three, all of them: the network, the committed record and the second switch in its exact words. Without the switch it stops at start and names it. Its rows are `live`; Solana's stay `sandbox`. `CHAIN_NETWORK_SOLANA=mainnet` and `CHAIN_NETWORK_BASE=mainnet` still stop it.

The names it reads for the hosted run (values are the operator's; none is committed):

```sh
DATABASE_URL=<the hosted database>          # and DB_POOL_MAX, DB_PGBOUNCER as the API's
CHAIN_MODE_SOLANA=readonly                  # or live: the worker only reads
CHAIN_NETWORK_SOLANA=testnet
SOLANA_RPC_URL=<a devnet node>
CHAIN_MODE_ROBINHOOD=readonly               # or live
CHAIN_NETWORK_ROBINHOOD=mainnet
CHAIN_MAINNET_ROBINHOOD=real-money
ROBINHOOD_RPC_URL=<a mainnet node>
SNAPSHOT_PING_URL=<healthchecks.io check>   # optional
  pnpm --filter @colosseum/snapshot start --loop
```

The node for `ROBINHOOD_RPC_URL`: a paid one (Alchemy's) answers the worker's batches; `https://robinhood.drpc.org` (free) takes them, since they are three at most; `rpc.mainnet.chain.robinhood.com` answers bursts from cloud hosts with 403 and is not one to run from a server. A URL with a key in it is never printed (`src/hide.ts`).

Checked on Oct 13 against the deployed factory `0xaE4ae2F2a5c2ee50C5A7574Cf355Cd5B068E7A80` through `robinhood.drpc.org`, reads only: the node check, the height, the rules (not paused, loss cap 100 bps, band 50 bps), ten assets labelled `live`, an owner with no vault (an empty list, not a failure), an address with no vault (`skipped`), and two Chainlink prices labelled `live`; 62 calls in 26 requests, the largest batch three, every answer 200.

## Inside the API

Gate `SNAPSHOT-IN-API` (Thom, Oct 18; amended Oct 19): the hosted API runs this loop in its own process, so no other machine has to. It is off unless `SNAPSHOT_IN_API=1`, and nothing changes for tests or a local API without it.

```sh
SNAPSHOT_IN_API=1            # on; unset or 0 is off
SNAPSHOT_INTERVAL_S=1800     # optional, default shown; seconds between passes, 60 or more
SNAPSHOT_AT_MINUTE=15        # optional; a pass at this minute of each UTC hour, 0 to 59. Needs SNAPSHOT_INTERVAL_S=3600 (or unset)
```

Hosted, it runs `SNAPSHOT_INTERVAL_S=3600` and `SNAPSHOT_AT_MINUTE=15`.

Beside the passes, the API reads one vault at once when it stores an order on that vault as done (amended Oct 30, Thom): `snapshotVault` of `src/pass.ts` on the loop's own sources, the same row a pass writes and no run, about 2 s after the order is done (`apps/api/src/orders/after-done.ts`). A read that fails is logged and the vault waits for the next pass.

- It is this worker's own start (`start` of `src/main.ts`), called from `apps/api/src/snapshot-in-api.ts`: the same chain flags, mainnet refusals, node checks, passes, back-off and run rows. The database is the API's one pool (`sharedDb` of `packages/db`), which the loop never ends, and the chain rows are held as the worker holds them.
- The nodes are the API's own: the worker and the API both read `SOLANA_RPC_URL` and `ROBINHOOD_RPC_URL`, so the hosted API needs no new secret. `SNAPSHOT_CHAINS` and `SNAPSHOT_PING_URL` work as they do for the worker.
- Once an hour, at a fixed minute: each pass wakes the hosted database (Neon's free compute sleeps after five minutes without a query, and its compute hours are the limit that binds), so the passes run at a minute when the hourly market-data import already has it awake (about :10 to :25 UTC). With `SNAPSHOT_AT_MINUTE` set the interval must be the hour; any other is refused at start with `SNAPSHOT_AT_MINUTE: needs SNAPSHOT_INTERVAL_S=3600, one pass an hour`. Without it the passes run on a grid of the interval from the first pass, half an hour by default. Either way every chain wakes on one schedule, so their passes reach the database together and wake it once.
- A snapshot is stale after two hours (`SNAPSHOT_STALE_AFTER_SECONDS` of `packages/schemas`): with one pass an hour, a pass that is late or fails once leaves the vaults fresh, and `/v1/stats` keeps its value.
- The first pass comes 30 s after the API listens, so a deploy shows fresh values at once; with a minute set, the next one waits for that minute. A chain's next pass waits for its last to end, so passes never overlap; a pass that runs past the minute, or longer than the interval, waits for the next one. After a failed pass the back-off is the worker's (15 s doubling to 5 min), then the schedule again.
- Owner discovery (above) counts a pass up to a minute short of the hour as the hour, so passes on the minute of each hour ask every owner each time rather than every other.
- What the worker would refuse at start (a mainnet it does not read, no chain, a missing node address, a node of another network) is logged as `snapshot loop not started` with its reason and asked again each interval, or at the next minute when one is set (a node behind a load balancer can lag once); the API keeps serving meanwhile. A database that does not answer at start is logged and tried again the same way. The worker's warn lines pass through `hide`, as they do standalone. Each line the worker prints is an API log line, `{ snapshot: <the line> }`: `warn` for a line with `alert: true` (a failed or skipped pass), `info` for the rest.
- Keep-awake: Render's free plan sleeps a service after 15 minutes without a request from outside, which would stop the loop. Once the loop runs and `RENDER_EXTERNAL_URL` is set (Render sets it), the API asks its own `/health` through that address every ten minutes. `/health` answers from memory and asks the database nothing, so the database still sleeps between passes.
- One worker a database: with the loop on in the API, stop the worker anywhere else. A start closes every run left open on its chains, another worker's included.

## The local run

```sh
pnpm db:up && pnpm db:migrate

# Solana devnet
CHAIN_MODE_SOLANA=readonly CHAIN_NETWORK_SOLANA=testnet SOLANA_RPC_URL=<devnet node> \
  pnpm --filter @colosseum/snapshot start --once

# Robinhood Chain's test network (46630)
CHAIN_MODE_ROBINHOOD=readonly CHAIN_NETWORK_ROBINHOOD=testnet ROBINHOOD_RPC_URL=<46630 node> \
  pnpm --filter @colosseum/snapshot start --once

# both, every ten minutes
CHAIN_MODE_SOLANA=readonly SOLANA_RPC_URL=<devnet node> \
CHAIN_MODE_ROBINHOOD=readonly ROBINHOOD_RPC_URL=<46630 node> \
  pnpm --filter @colosseum/snapshot start --loop

# no node at all: the mock
SNAPSHOT_CHAINS=solana CHAIN_MODE_SOLANA=mock pnpm --filter @colosseum/snapshot start --loop
```

`CHAIN_NETWORK_<CHAIN>` is `testnet` when unset. Every row read from Robinhood Chain's mainnet is labelled `live`, every row read from a test network or a local copy `sandbox`, and every row read from the mock `mock`.

At start the worker holds the database to the networks of its environment, as the API does at its start: it writes the rows of `chains` (`seedChains`), which every `chain_id` points at, and refuses a database whose row names another network. Devnet and a local validator are both `sandbox`, and a snapshot row does not say which, so one database serves one network a chain: Solana on devnet beside Robinhood Chain on mainnet is one database, as the hosted API has it. A dry run writes nothing and makes the same check on the rows it reads.

## The mock's sample world

`packages/chain-mock` is a chain in memory, one per process. The worker's mock is not the one the API's mock holds, so a vault a person opened through an API on the mock does not exist on the worker's chain until the worker makes it again. Before each pass (`src/mock-world.ts`):

1. The mock's clock goes to the time of the pass, and each price that is not cash to where it stands in this ten minutes.
2. Every vault the `vaults` table names under the label `mock`, and that the worker's chain does not hold yet, is made: the same owner and plan number (the mock derives a vault's address from the two, so the address is the row's), a deposit of what the row was last worth (a hundred dollars where the row has no value), and purchases at the row's targets. A target the mock's shelf does not list is dropped and its share stays in cash. A row the mock cannot make is said once on stderr and skipped; the rest are made.
3. With no row at all, one sample vault is made for a sample owner: a thousand dollars, four tenths in the mock's SPY, three in its dollar-yield token, two in its gold, one in cash.

What it is: sample owners, sample deposits and sample prices, so the portfolio section can be built with no node. Every row carries `provenance: mock` and `source: chain-mock`.

What it is not:

- It is not the API's chain. What a person does through the API after a vault was first made here (a deposit, a rebalance, a withdrawal) does not reach the worker's copy, and the worker's value of a vault differs from the API's.
- Its prices are not market prices. Each is the shelf's round number moved by the sum of the last day's steps, one step every ten minutes, each step at most 20 bps and taken from a hash of the asset and the ten minutes. A price depends on the time alone, so a worker started again, or run with `--once` from time to time, goes on with the same history. No price moves more than 40 bps in ten minutes or stands further than 28.8% from its round number.
- The mock has a band and no other rule: `loss_cap_bps` and `paused` are null on its rows, and `loss_used_bps` is always 0.
- A worker started again makes its vaults again from the cache as it is then, in cash and then bought at the targets: the amounts start over, the addresses do not.
- The sample vault of step 3 belongs to nobody: no person's portfolio shows it. It is there so that a mock run on an empty database still writes rows. Once the `vaults` table names a vault on the chain, the sample is no longer made, and a worker started then does not read it.

## Which vaults it reads

Only our people's vaults, never every vault the program or the factory holds.

- By address, at every pass: the vaults the `vaults` table names for the chain under the worker's label, and every address the worker has snapshotted or found before.
- By owner, the heavy read (`getProgramAccounts` on Solana, `vaultsOf` and a read of each vault on EVM): for every owner at the first pass after start and once an hour, and at once for an owner the worker has not asked before. The owners are the wallets in `user_wallets`, whoever an order with a confirmed step on the chain belongs to, and the owners the `vaults` rows name. A vault opened outside the app is found within the hour.
- An address with no vault is a `skipped` line and is not asked again until every owner is.

## What it never does

- It holds no key. It loads no signing entry (`@colosseum/chain-*/server`), makes a reader of each real chain and never an adapter, and names no builder, relay, signer or send: `tests/snapshot/reads-only.test.ts` reads the source of this folder and fails on any of them. The one file that builds and lands a transaction is `src/mock-world.ts`, on the chain in memory only, and it may import no real chain.
- It reads no mainnet but Robinhood Chain's. `CHAIN_NETWORK_SOLANA=mainnet` or `CHAIN_NETWORK_BASE=mainnet` stops it at start, read or not and whatever its mode, with a sentence that names the variable, before a node or the database is asked anything; so does `CHAIN_NETWORK_ROBINHOOD=mainnet` without `CHAIN_MAINNET_ROBINHOOD=real-money`. The Solana node check refuses mainnet's genesis, and the EVM one a mainnet's chain id under any record but that mainnet's own.
- It sends nothing to an EVM node but reads: its client refuses any other JSON-RPC method before the node is asked (`packages/chain-evm/test/rpc.test.ts`, and the mainnet path in `src/chains.test.ts`).
- A row is `live` only from Robinhood Chain's mainnet record under the switch, and that record must say `live` itself. A test network or a local copy is `sandbox` and the mock is `mock`.
- It writes two tables, `vault_snapshots` and `snapshot_runs`, and at start the rows of `chains`. `vaults`, `orders`, `legs` and `user_wallets` are the API's and are only read.
- It prints no node address, no database address and no ping address: every reason goes through `src/hide.ts` first (each `*_RPC_URL`, `DATABASE_URL` and `SNAPSHOT_PING_URL` by its setting's name, any other `URL: ...` cut), and only an error's code and message are ever said, never its cause or its stack; of a query the database did not take, only the code of the refusal, at start as in a pass.

## The lines it prints

One JSON object a line on stdout, each with `at`, `chain` and `name` ("Solana devnet", "Robinhood Chain testnet", "Solana (mock)"):

- a vault: `vault` and `outcome`, one of `read` (with `observedAt`, `valueUsd` cut to cents, `blockOrSlot`, `provenance`), `failed` or `skipped`, each with its `reason`;
- an owner whose vaults could not be asked for: `owner`, `outcome: failed`, `reason`. The owner is asked again at the next pass;
- the pass: `pass: done` with `read`, `failed`, `skipped` and `dryRun`, or `pass: skipped` with `alert: true` when another worker's run is open on the chain;
- a failed pass: `outcome: round-failed`, its `reason`, `alert: true`, `failures` in a row and, with `--loop`, `retryInS`.

A pass fails when the chain does not answer (its rules or its asset list cannot be read, no vault at all could be read, or no price at all), when no vault was read and at least one failed, whatever the reason (`no vault was read: 3 failed`), when the mock's sample world cannot be brought up to date, or when the database does not answer. One vault that cannot be read, valued or written beside one that was is a `failed` line for that vault and the others go on. A pass with nothing to read, because no vault is known or none is at the addresses asked, is a good pass. The chain's height (a slot, a block, the mock's second) is read at the start of the pass and kept on every row as `block_or_slot`; a chain that cannot say it within ten seconds gives null, not a failed pass.

Each chain has a loop of its own (`src/loop.ts`, a copy of the keeper's, held equal by `tests/snapshot/loop.test.ts`): after a failed pass the next comes after 15 s, doubled after each failure in a row up to 5 minutes, and the interval returns once a pass goes through. A chain that fails backs off alone while the others keep their interval.

Each pass is one row of `snapshot_runs` per chain, with what it read, what failed and, when the pass failed, why (a dry run opens none). One run is open per chain at a time, and a pass that finds another open is skipped. A worker that was killed in the middle of a pass left its run open. The next start closes it and says so in the row. A worker that is already running closes it at the first pass that finds it older than any pass can be (two intervals, and 30 minutes at least; 30 minutes with `--once`), says so in the row, and reads; until then that chain's passes are skipped.

Run one worker a database. A start closes every open run on its chains, a live worker's included, since a row does not say who opened it.

Stopped by SIGINT or SIGTERM, the worker closes its database client and exits with 130 or 143.

## The health check

`SNAPSHOT_PING_URL` (healthchecks.io), optional: a POST after a pass when no chain's newest pass failed or was skipped, and to its `/fail` after a pass that failed, with ten seconds to answer. A skipped pass sends neither, so a chain that is kept from starting lets the check run out. The URL is never printed. A post that fails is said on stderr in words of its own (`the health check answered 500`, `the health check could not be reached`) and never stops a pass.

## What a pass costs

Reads go one vault a call today, at most four in flight a chain:

- Solana: about 2 to 3 `getMultipleAccounts` a vault a pass, one more for the prices, one for the rules and one `getSlot`. The hourly read by owner adds one `getProgramAccounts` an owner.
- Robinhood Chain: about 40 `eth_call`s a vault a pass, sent as JSON-RPC batches of three, two batches at a time, about two a priced asset for the prices, about 13 for the rules and one `eth_blockNumber`. The settings and the multipliers are read again for every vault. A pass with no vault costs about 60 calls.

A read of many vaults by address in one call is not built on either reader. The Solana reader already reads many internally and the EVM reader could share one block and one read of the settings; neither is public yet, and the EVM reads do not go through Multicall3. With many vaults this is the first thing to build, before the interval is shortened.

## For later

- A batched read by address on both readers.
- A run script and a unit for the worker's machine, as `scripts/keeper/` has for the keeper.
- Base on a real network, when it has a reader.

## Tests

- `src/args.test.ts`: `--once` or `--loop` and exactly one, the interval and its floor, the dry run, a flag it does not know.
- `src/hide.test.ts`: every configured address named by its setting, the longer taken out whole, any other `URL: ...` cut.
- `src/chains.test.ts`, with no connection opened: mainnet refused for Solana and Base for each mode with the variable named, before anything else, and for Robinhood Chain without its switch; Robinhood Chain's mainnet read beside Solana's devnet, `live` beside `sandbox`, from its own record, its node held to 4663, through a client that asks for reads only, three a batch and two at a time; a node that does not answer at start keeping its own chain from reading and not the other; the selection (the default, the list, a mock chain only when named, an off chain, an id it does not know, no chain); Base refused on a real network; a missing node said by its variable before any node is asked; the record missing, unreadable or another network's; an address in the environment that is not the record's; a height that cannot be read as null; the keeper's names known.
- `src/mock-world.test.ts`, on `packages/chain-mock`: a vault made at the address another process gave it, with weights near its targets; the approval on an EVM chain; a target the mock does not list dropped; a row the mock cannot make skipped and said once; one sample vault and no second one; the prices moving every ten minutes inside their bound, the same on any worker.
- `src/main.test.ts`: a bad command line, mainnet and no chain each stopping the worker before the database is opened; the chain rows held before the first pass and only checked in a dry run; the database closed after a failed pass; the health check.
- `tests/snapshot/start.test.ts` starts the worker as a process: a mainnet it may not read stops it with the sentence, a code that is not 0 and no line of a pass, for a chain it reads, one it does not, and Robinhood Chain without its switch.
- `tests/snapshot/reads-only.test.ts`: the source of this folder names nothing that builds, signs, relays or sends, and takes from a real chain only what reads.
- `tests/boundaries.test.ts`: the worker's row, and nothing `src/main.ts` loads at start reaching a signing entry.
- `apps/api/src/snapshot-in-api.test.ts`: the loop inside the API off without its flag, the interval and its floor, the worker run on the API's pool after the first-pass delay, no two passes of a chain at once when a pass outlasts the interval, the chains on one grid, a failing chain logged and backing off alone, a mainnet refusal logged and asked again each interval with no signal handler installed, a database that does not answer retried, and the keep-awake only with the flag, `RENDER_EXTERNAL_URL` and a running loop.
- `src/pipeline.test.ts`, `src/pass.test.ts`, `src/discover.test.ts` and `tests/snapshot/loop.test.ts`: the passes on the mock with the database, the lines and the rows, the discovery by owner, and the loop held to the keeper's. `src/pipeline.test.ts` needs the database (`pnpm db:up`).
