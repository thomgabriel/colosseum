#!/bin/zsh
# Installs the hourly Robinhood Chain asset metrics job (PLAN-ASSETS AS.6) as its own launchd agent:
#   com.colosseum.assets-robinhood   totalSupply and the ERC-4626 rates at one block, the discovery file's pool TVL,
#                                    the issuer's SGOV multiplier, yields and DefiLlama's prices of every row of
#                                    scripts/risk/assets/robinhood.json, minute 38 (outside the loop's minutes 1 to
#                                    14); the daily metrics once a day inside the same job
# Usage: install-assets-job.sh                                    the install: a person's (Rodrigo, DA9)
#        COLOSSEUM_HOME=<folder> install-assets-job.sh --no-load  a rehearsal: bundle and plist under <folder>
# Everything else, and why each step is there: scripts/risk/assets/install-metrics-job.sh.
set -euo pipefail
exec /bin/zsh "$(cd "$(dirname "$0")/../risk/assets" && pwd)/install-metrics-job.sh" robinhood "$@"
