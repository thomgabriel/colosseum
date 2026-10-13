#!/bin/zsh
# Installs the hourly Solana asset metrics job (PLAN-ASSETS AS.6) as its own launchd agent:
#   com.colosseum.assets-solana   supply, pool and protocol TVL, exchange rates, yields and the aggregators' prices of
#                                 every row of scripts/risk/assets/solana.json into asset_observations, minute 44; the
#                                 daily metrics once a day inside the same job
# Usage: install-job-solana.sh                                    the install: a person's (Rodrigo, DA9)
#        COLOSSEUM_HOME=<folder> install-job-solana.sh --no-load  a rehearsal: bundle and plist under <folder>
# Everything else, and why each step is there: scripts/risk/assets/install-metrics-job.sh.
set -euo pipefail
exec /bin/zsh "$(cd "$(dirname "$0")" && pwd)/install-metrics-job.sh" solana "$@"
