# Scripts that can send a mainnet transaction

Everything that can spend real money from a script lives in this folder, so it is easy to see and easy to guard. A person runs these, never an agent.

- `redeploy-robinhood.sh`: the Robinhood Chain redeploy (gate `ROBINHOOD-REDEPLOY`, `docs/vault/MAINNET-REDEPLOY.md`). Dry run by default; `--send` deploys from the deployer and writes the Safe's acceptance batch.
- `sign-and-send.ts`: signs and sends the transactions of a plan from the demo wallet. Dry run by default; `--send` sends. Run it as `pnpm sign-and-send --plan <id>`.
