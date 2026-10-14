# Scripts that can send a mainnet transaction

Everything that can spend real money from a script lives in this folder, so it is easy to see and easy to guard. A person runs these, never an agent.

- `sign-and-send.ts`: signs and sends the transactions of a plan from the demo wallet. Dry run by default; `--send` sends. Run it as `pnpm sign-and-send --plan <id>`.
- `deploy-registry-v2.sh`: deploys the registry's second logic (gate `SHARED-RULES-V2`) on Robinhood Chain mainnet through the CREATE2 deployer, at the address the Safe's upgrade batch names. Dry run by default; `--send` sends, signed by a keystore account (`ACCOUNT`, default `deployer-rh`).
