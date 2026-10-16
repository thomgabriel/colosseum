# scripts/ops

Scripts a person runs against the hosted systems. Each one says at its top what it reads, what it writes and what it refuses.

| Command | What it does |
|---|---|
| `pnpm ops:prune-risk [--dry-run]` | Deletes the rows of the risk tables older than their window (`risk-retention.ts`), in batches, then vacuums. `DATABASE_URL`. Run daily by `com.colosseum.risk-prune`. |
| `pnpm ops:archive-risk --out <dir> [--dry-run] [--at <time>]` | Writes those older rows to `<dir>/<table>/<day>.csv.gz`, deleting nothing. `SOURCE_DATABASE_URL`. |
| `pnpm ops:move-db [--dry-run] [--at <time>] [--grants-only]` | Copies the app's schemas to another server, the risk tables cut to their window, and checks every table's rows. `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL`. |
| `pnpm ops:install-prune [--importers] [--dry-run-now]` | Bundles the prune into `~/.colosseum/hosted-risk` and loads its launchd job (daily, 05:30). `--importers` rebuilds the loop's lending and Robinhood Chain importers, which skip rows older than the window. |

The windows and the reasons for them are in `docs/risk/STATE-RISK.md`, "Retention of the hosted tables". None of these scripts prints a database address.

## Moving the database from Supabase to Neon

About an hour, most of it the copy. The Neon project is `small-wildflower-45388591` (aws-us-west-2, Postgres 18, 1 GB a branch).

**Before.** Install the client tools (pg_dump and psql 18) and fetch the code:

```sh
brew install libpq
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
cd <a checkout of staging with this change> && pnpm install
```

Copy the Neon owner role's connection string from the Neon console, with the direct host (without `-pooler`).

**1. Stop what writes.** The hosted collectors and the snapshot worker; the API stays up and only reads during the move.

```sh
~/.colosseum/hosted-risk/stop.sh
pkill -f 'colosseum/snapshot/run'      # the snapshot worker's loop first, so it does not start it again
pkill -f '@colosseum/snapshot start'   # then the worker
```

**2. The two addresses**, typed and never echoed: Supabase's `postgres` login through the session pooler (port 5432), and Neon's owner:

```sh
read -rs "SOURCE_DATABASE_URL?Supabase address: " && export SOURCE_DATABASE_URL; echo
read -rs "TARGET_DATABASE_URL?Neon owner address: " && export TARGET_DATABASE_URL; echo
export AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # one time for the archive and the move, so nothing falls between them
```

Then the two logins the API and the snapshot worker use, so the move gives them the grants they have on Supabase. Made with SQL they hold only those grants (a role made in the Neon console also joins `neon_superuser`); `\password` asks for each password without showing it (a long random one: Neon refuses a weak password):

```sh
psql "$TARGET_DATABASE_URL"
  create role tenonfi_api login;
  \password tenonfi_api
  create role snapshot_worker login;
  \password snapshot_worker
  \q
```

Their addresses are the owner's with the user and password replaced.

**3. Archive what the move leaves behind**: every row older than its window, from Oct 6 on (about 420 MB as it sits in the database; the dry run says how much as files). The archive and the move together read the database about once, some 0.9 GB of Supabase egress.

```sh
pnpm ops:archive-risk --out ~/tenonfi-archive --at $AT --dry-run
pnpm ops:archive-risk --out ~/tenonfi-archive --at $AT
```

It can be run again after a stop; finished days are not written twice. A file goes back with
`gunzip -c <file> | psql "$TARGET_DATABASE_URL" -c "\copy public.<table> from stdin with (format csv, header)"`.

**4. Move.** The dry run prints every table, what is copied of it and the size it leaves (about 520 MB, near 650 MB just before each daily prune):

```sh
pnpm ops:move-db --dry-run --at $AT
pnpm ops:move-db --at $AT
```

The last line must read `every table and sequence matches the source snapshot`. If it stops part way, reset the Neon branch (or drop its `drizzle`, `archive_rh_testnet` and `public` schemas) and run it again: it refuses a target that already holds tables. If a role was missing, create it and run `pnpm ops:move-db --grants-only`.

**5. Point everything at Neon.**

- Render, service `tenonfi-api`: set `DATABASE_URL` to the `tenonfi_api` address. Leave `DB_PGBOUNCER` unset (or `session`): the direct host is no transaction pooler. Saving deploys `staging`'s head.
- `~/.colosseum/hosted-risk/env`: the `DATABASE_URL` line, to the `tenonfi_api` address (the prune deletes rows, which `tenonfi_api` may; only the owner may vacuum, so with `tenonfi_api` the prune logs that it left the vacuum to autovacuum).
- `~/.colosseum/snapshot/db-url` (read by `run.sh` and `run-mainnet.sh` beside it): the `snapshot_worker` address.

Edit each file in an editor; nothing here prints them.

**6. The prune and the importers**, before the loop starts again: the loop's lending and Robinhood Chain importers, as built on Oct 6, would put every older day back.

```sh
zsh scripts/ops/install-prune.sh --importers --dry-run-now
```

It keeps the old bundles as `*.before-<stamp>.mjs`, loads `com.colosseum.risk-prune` (daily 05:30, log `~/.colosseum/hosted-risk/risk-prune.log`) and ends with a dry run against the new database, which should find next to nothing to delete.

**7. Start again**: `~/.colosseum/hosted-risk/start.sh`, and the snapshot worker as before (`zsh -i ~/.colosseum/snapshot/run-mainnet.sh --loop`).

**8. Check.**

```sh
API=https://tenonfi-api.onrender.com
curl -s $API/v1/config | jq '[.chains[] | {id, missingAssets}]'     # missingAssets null on every chain
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' $API/v1/shelf   # 200
curl -s "$API/v1/shelf?chain=robinhood" | jq '.families | length'      # the shared portfolios, as many as before
tail -5 ~/Library/Logs/tenonfi/hosted-risk.log                          # the loop's runs end without an error
psql "$TARGET_DATABASE_URL" -c "select max(fetched_at) from risk_pool_snapshots"   # within the last 15 minutes once pools has run
psql "$TARGET_DATABASE_URL" -c "select max(observed_at) from risk_lending_snapshots"  # after the next hourly import (minute 12 on)
psql "$TARGET_DATABASE_URL" -c "select max(fetched_at) from vault_snapshots"   # the snapshot worker, within ten minutes
psql "$TARGET_DATABASE_URL" -c "select pg_size_pretty(pg_database_size(current_database()))"
```

The next morning, `tail ~/.colosseum/hosted-risk/risk-prune.log` shows the first prune: each table's cut and the rows deleted, then `"ok":true`.

Leave the Supabase project as it is until the checks pass for a day; it is the way back (step 5 with the old addresses).
