# Robinhood Chain mainnet: the redeploy (gate ROBINHOOD-REDEPLOY)

New contracts on Robinhood Chain mainnet (4663), deployed on 2026-10-15 (below), held by the team's 2-of-2 Safe `0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc` directly, with no timelock. The registry runs the second rules (`SHARED-RULES-V2`) from its first block, and the tokens of `WIDER-LIST-B`, USDG and 25 others, are listed at deploy (SGOV dropped Oct 15: pool paid ~25% of feed for $500 at block 89,240,446). Every step that sends a transaction is a person's. The contracts of 2026-10-12 ([`MAINNET-DEPLOY.md`](MAINNET-DEPLOY.md)) are not touched.

## The deploy of 2026-10-15

Sent by Thom from the deployer `0x04957C813932B659a9DA3B7eA2E320c1073A8938`, commit `220e820f`: 53 transactions, every one with status 1, blocks 89,266,650 to 89,268,029. The Safe took both keys in one transaction executed by its second owner, [`0x5eb2c0b768f6345154b53f113c19c4595a5ec0c303c3936fca9dc36ff602cf6f`](https://robin.etherscan.io/tx/0x5eb2c0b768f6345154b53f113c19c4595a5ec0c303c3936fca9dc36ff602cf6f) (block 89,276,636: `AdminChanged` on the factory, `OwnershipTransferred` on the beacon). All six contracts are verified on Etherscan and both proxies are linked to their logic. `pnpm ops:authority-check` against the record answers `VERDICT: OK`. The record is `deployments/robinhood-mainnet.json`.

| Contract | Address |
|---|---|
| Vault factory (proxy) | [`0x7e2bbb8483eb1baa6d87210bc83b63ad7a1bb8aa`](https://robin.etherscan.io/address/0x7e2bbb8483eb1baa6d87210bc83b63ad7a1bb8aa) |
| Shared-portfolio registry (proxy) | [`0x65ff89c4436a11bb87e3c7328a3f02c407c7d6f8`](https://robin.etherscan.io/address/0x65ff89c4436a11bb87e3c7328a3f02c407c7d6f8) |
| Vault beacon | [`0x935658c738aef037092c69fd66b1ac3295882c0d`](https://robin.etherscan.io/address/0x935658c738aef037092c69fd66b1ac3295882c0d) |
| Vault logic | [`0x17806f355dc5e81be3eb4d62f1392a63126e48a8`](https://robin.etherscan.io/address/0x17806f355dc5e81be3eb4d62f1392a63126e48a8) |
| Factory logic | [`0x1a3ddce0ae9a0f3c8dcf6455d1c6c65749d007c7`](https://robin.etherscan.io/address/0x1a3ddce0ae9a0f3c8dcf6455d1c6c65749d007c7) |
| Registry logic | [`0xb47ec016a09752a7a104ad5e9ea77fbba147468e`](https://robin.etherscan.io/address/0xb47ec016a09752a7a104ad5e9ea77fbba147468e) |
| Admin of the factory, owner of the beacon: the Safe, 2 of 2 | [`0x4568bc6cc821b34095059fd46102eaa22a675fdc`](https://robin.etherscan.io/address/0x4568bc6cc821b34095059fd46102eaa22a675fdc) |
| Guardian | [`0x0a1c3312c808b23d019bf241028f6b5624f4cc98`](https://robin.etherscan.io/address/0x0a1c3312c808b23d019bf241028f6b5624f4cc98) |

| # | Block | Transaction | What |
|---|---|---|---|
| 1 | 89,266,650 | [`0x79b41e57f665bef6462d440815e265a9c4ea6174d6f8a1eea064c8baade7b425`](https://robin.etherscan.io/tx/0x79b41e57f665bef6462d440815e265a9c4ea6174d6f8a1eea064c8baade7b425) | create BasketVault |
| 2 | 89,266,677 | [`0xae9a4c701d4b8b37d60d7df6dff179ce685aaa300d065ac4e0562e9022f9ac45`](https://robin.etherscan.io/tx/0xae9a4c701d4b8b37d60d7df6dff179ce685aaa300d065ac4e0562e9022f9ac45) | create VaultBeacon |
| 3 | 89,266,704 | [`0x5d6ee003a35c303cfa1a943cfc59fc26ae52a1ea8c1ed1940c62aa9d213d7786`](https://robin.etherscan.io/tx/0x5d6ee003a35c303cfa1a943cfc59fc26ae52a1ea8c1ed1940c62aa9d213d7786) | create VaultFactory |
| 4 | 89,266,730 | [`0x327cb30454ad6e2389aca382927429dd5db14959038500f1bb6d8d22645352c4`](https://robin.etherscan.io/tx/0x327cb30454ad6e2389aca382927429dd5db14959038500f1bb6d8d22645352c4) | create ERC1967Proxy |
| 5 | 89,266,755 | [`0x96482b812dc11e2ea4aafe68892bb2d1538a950f204002f532518de7b2c57c5b`](https://robin.etherscan.io/tx/0x96482b812dc11e2ea4aafe68892bb2d1538a950f204002f532518de7b2c57c5b) | create IndexRegistry |
| 6 | 89,266,782 | [`0xb9c3f962e97e3e04c00e7710a34449eebb02c7c9a09e157a27960278322be620`](https://robin.etherscan.io/tx/0xb9c3f962e97e3e04c00e7710a34449eebb02c7c9a09e157a27960278322be620) | create ERC1967Proxy |
| 7 | 89,266,808 | [`0x5f3997b7d9556313dc2ec6bfdbaf20aa3a4e9072cef463208bd3d2983f52f8bf`](https://robin.etherscan.io/tx/0x5f3997b7d9556313dc2ec6bfdbaf20aa3a4e9072cef463208bd3d2983f52f8bf) | setRegistry on the factory |
| 8 | 89,266,834 | [`0x9071cd78d54ea6c383376250b3c93d19816ad23dda2e9aebf318850d5fec7e26`](https://robin.etherscan.io/tx/0x9071cd78d54ea6c383376250b3c93d19816ad23dda2e9aebf318850d5fec7e26) | setGuardian on the factory |
| 9 | 89,266,860 | [`0x85086359a12d49a06af915cb750790854dc423bcdd6b666165bde3204b5a5138`](https://robin.etherscan.io/tx/0x85086359a12d49a06af915cb750790854dc423bcdd6b666165bde3204b5a5138) | setKeeper on the factory |
| 10 | 89,266,886 | [`0x9cfbfa13bf2ba4d8d8b40798591886481fa32dc40f00b4cec4a4f422bda720a3`](https://robin.etherscan.io/tx/0x9cfbfa13bf2ba4d8d8b40798591886481fa32dc40f00b4cec4a4f422bda720a3) | setPriceDevBps on the factory |
| 11 | 89,266,912 | [`0x7c923be5c9c336d8b773eb2f9a0efc8abcd49c2a24f67bda807f05272b2d8749`](https://robin.etherscan.io/tx/0x7c923be5c9c336d8b773eb2f9a0efc8abcd49c2a24f67bda807f05272b2d8749) | setSessionPriceAge on the factory |
| 12 | 89,266,948 | [`0x15a5657974e2262ca07205fa7f9d481d3b201beef993bdacbecbde55a554ec31`](https://robin.etherscan.io/tx/0x15a5657974e2262ca07205fa7f9d481d3b201beef993bdacbecbde55a554ec31) | setAsset on the factory |
| 13 | 89,266,962 | [`0x26cf73e45a7f1b83dfe054573af8d75352bd061420792ccd39b67245d1d0792c`](https://robin.etherscan.io/tx/0x26cf73e45a7f1b83dfe054573af8d75352bd061420792ccd39b67245d1d0792c) | setAsset on the factory |
| 14 | 89,266,990 | [`0x47d084fc1294b2c4170e729a55776fe6a45f516002628b8c6085d3bb5493e3a8`](https://robin.etherscan.io/tx/0x47d084fc1294b2c4170e729a55776fe6a45f516002628b8c6085d3bb5493e3a8) | setAsset on the factory |
| 15 | 89,267,017 | [`0x2bfbb705d5c3d9e47ad270eea42fb00e47dcec4400f51f26876c5c2668fba6c8`](https://robin.etherscan.io/tx/0x2bfbb705d5c3d9e47ad270eea42fb00e47dcec4400f51f26876c5c2668fba6c8) | setAsset on the factory |
| 16 | 89,267,046 | [`0x058e45df387e7860944b192c96af17e3b356b65371f51c6b111c377e4a91a6b5`](https://robin.etherscan.io/tx/0x058e45df387e7860944b192c96af17e3b356b65371f51c6b111c377e4a91a6b5) | setAsset on the factory |
| 17 | 89,267,074 | [`0x8ed29327b33091a62585d5d04dc3147e1eb2faf3d0bd4ec3e50e6f7105185788`](https://robin.etherscan.io/tx/0x8ed29327b33091a62585d5d04dc3147e1eb2faf3d0bd4ec3e50e6f7105185788) | setAsset on the factory |
| 18 | 89,267,100 | [`0x4e50d380ec904dc99e3af9b15048a2e0360c91c519dbe4f9fd0c3e16bc1b8918`](https://robin.etherscan.io/tx/0x4e50d380ec904dc99e3af9b15048a2e0360c91c519dbe4f9fd0c3e16bc1b8918) | setAsset on the factory |
| 19 | 89,267,126 | [`0x39f9951d20d4a1caf57947b0eba5df8511617f48c9f225da9d7915558e54f079`](https://robin.etherscan.io/tx/0x39f9951d20d4a1caf57947b0eba5df8511617f48c9f225da9d7915558e54f079) | setAsset on the factory |
| 20 | 89,267,153 | [`0x37c3563f99e3406551abcf7f217f5cbc6cdfba63e5d5a9a5dd67b75b9489aee5`](https://robin.etherscan.io/tx/0x37c3563f99e3406551abcf7f217f5cbc6cdfba63e5d5a9a5dd67b75b9489aee5) | setAsset on the factory |
| 21 | 89,267,179 | [`0x24c552db7c1923cde495407b00f2ff44b2a14c2af38287fd738bde6c3a8d295b`](https://robin.etherscan.io/tx/0x24c552db7c1923cde495407b00f2ff44b2a14c2af38287fd738bde6c3a8d295b) | setAsset on the factory |
| 22 | 89,267,205 | [`0xdfc9ceb91b339e2dcd3e34f11b4d267bfd4709a101a4b53fb40f2d3bc9b01351`](https://robin.etherscan.io/tx/0xdfc9ceb91b339e2dcd3e34f11b4d267bfd4709a101a4b53fb40f2d3bc9b01351) | setAsset on the factory |
| 23 | 89,267,231 | [`0xf9f3b65a9f95128a3832c64945d19b70854dd3398cf7c1a39a472f30e1cd8dd7`](https://robin.etherscan.io/tx/0xf9f3b65a9f95128a3832c64945d19b70854dd3398cf7c1a39a472f30e1cd8dd7) | setAsset on the factory |
| 24 | 89,267,257 | [`0x4434547e19df14d1afbc6ba3f11e14bd538f49c39265503c15f375a86864855e`](https://robin.etherscan.io/tx/0x4434547e19df14d1afbc6ba3f11e14bd538f49c39265503c15f375a86864855e) | setAsset on the factory |
| 25 | 89,267,286 | [`0x792e619ffa8f32324ad43287df11983146bc554d34ba93236be5aac959e8a413`](https://robin.etherscan.io/tx/0x792e619ffa8f32324ad43287df11983146bc554d34ba93236be5aac959e8a413) | setAsset on the factory |
| 26 | 89,267,312 | [`0xa2292b8e03285b93efcfe2ac89a40e9dee006d3c315adea742137b316a2e2164`](https://robin.etherscan.io/tx/0xa2292b8e03285b93efcfe2ac89a40e9dee006d3c315adea742137b316a2e2164) | setAsset on the factory |
| 27 | 89,267,339 | [`0xaec8017537eaad8ceb3fa4fcbb83c9c8ac9cd75ef3de38b6a7283424a151cc9e`](https://robin.etherscan.io/tx/0xaec8017537eaad8ceb3fa4fcbb83c9c8ac9cd75ef3de38b6a7283424a151cc9e) | setAsset on the factory |
| 28 | 89,267,369 | [`0x3a4ec2c3886d497727b307213fc83da4ba7404605272b709b574abdf113bdc41`](https://robin.etherscan.io/tx/0x3a4ec2c3886d497727b307213fc83da4ba7404605272b709b574abdf113bdc41) | setAsset on the factory |
| 29 | 89,267,395 | [`0x49e3b50311d27246b6b755ef0901783aa8348ca190a354b2c7c94e5048f5469f`](https://robin.etherscan.io/tx/0x49e3b50311d27246b6b755ef0901783aa8348ca190a354b2c7c94e5048f5469f) | setAsset on the factory |
| 30 | 89,267,421 | [`0xf8381079580b63071e75c8c9c86f5e9ddea5214c2990f4514a7d53d30ac11385`](https://robin.etherscan.io/tx/0xf8381079580b63071e75c8c9c86f5e9ddea5214c2990f4514a7d53d30ac11385) | setAsset on the factory |
| 31 | 89,267,447 | [`0xb0f9234bb5c081ce40216dde50ad7d0a4c11e6119dfaa185c9f56f704c271bf0`](https://robin.etherscan.io/tx/0xb0f9234bb5c081ce40216dde50ad7d0a4c11e6119dfaa185c9f56f704c271bf0) | setAsset on the factory |
| 32 | 89,267,474 | [`0xe64eaf4c84b62528e88beeb17e18e085f2c1961c22b58c985c67676311c10a3a`](https://robin.etherscan.io/tx/0xe64eaf4c84b62528e88beeb17e18e085f2c1961c22b58c985c67676311c10a3a) | setAsset on the factory |
| 33 | 89,267,500 | [`0x33eeb8fcb0cc35639ea1e213575c35d281558cc8a44191ba6e7bd3866f4d9c99`](https://robin.etherscan.io/tx/0x33eeb8fcb0cc35639ea1e213575c35d281558cc8a44191ba6e7bd3866f4d9c99) | setAsset on the factory |
| 34 | 89,267,527 | [`0x93775d9f1946b9af71cd26f9d0c8aeeb5a503c46f6c642c3e99e476d2ab4d1cc`](https://robin.etherscan.io/tx/0x93775d9f1946b9af71cd26f9d0c8aeeb5a503c46f6c642c3e99e476d2ab4d1cc) | setAsset on the factory |
| 35 | 89,267,557 | [`0x5842b7308ef042cd04a3f62a9c833f8e1b38e55f7073810c4709934db16ff690`](https://robin.etherscan.io/tx/0x5842b7308ef042cd04a3f62a9c833f8e1b38e55f7073810c4709934db16ff690) | setAsset on the factory |
| 36 | 89,267,583 | [`0xdb0a79aaf8f74891611201ee10a8d292b601dd9ca464df1649a74e0f6aeae0fb`](https://robin.etherscan.io/tx/0xdb0a79aaf8f74891611201ee10a8d292b601dd9ca464df1649a74e0f6aeae0fb) | setAsset on the factory |
| 37 | 89,267,609 | [`0x2d4f2f3d5988f95c068fa0709ae719970732f746f1ef2b3a4625ead22c6982f6`](https://robin.etherscan.io/tx/0x2d4f2f3d5988f95c068fa0709ae719970732f746f1ef2b3a4625ead22c6982f6) | setAsset on the factory |
| 38 | 89,267,635 | [`0x4b651aab3c192ccb97ff4f33051dc31edb3571dcd1f6a88d2b6c83ebc9d388dd`](https://robin.etherscan.io/tx/0x4b651aab3c192ccb97ff4f33051dc31edb3571dcd1f6a88d2b6c83ebc9d388dd) | setCashToken on the factory |
| 39 | 89,267,663 | [`0x310ae63b79d75b2739848565b75e6529b386ad170ff8db2638502a10b4806347`](https://robin.etherscan.io/tx/0x310ae63b79d75b2739848565b75e6529b386ad170ff8db2638502a10b4806347) | setRouter on the factory |
| 40 | 89,267,689 | [`0x47b8b43b28035cb0489872b32f4e6b3c819da87112df569ec694a4fd2711b4e8`](https://robin.etherscan.io/tx/0x47b8b43b28035cb0489872b32f4e6b3c819da87112df569ec694a4fd2711b4e8) | setClosedDay on the factory |
| 41 | 89,267,715 | [`0xf6397506d3f662893c32a0a5a04e6903b57cfe0027172d4d659c11f2b6ccf0af`](https://robin.etherscan.io/tx/0xf6397506d3f662893c32a0a5a04e6903b57cfe0027172d4d659c11f2b6ccf0af) | setClosedDay on the factory |
| 42 | 89,267,741 | [`0xf54e5e98edcdf751be27701a276777e8294f928ed2858d56a6f99fe096a1de4f`](https://robin.etherscan.io/tx/0xf54e5e98edcdf751be27701a276777e8294f928ed2858d56a6f99fe096a1de4f) | setClosedDay on the factory |
| 43 | 89,267,767 | [`0x22116458cd79e9eedcfe2fbc5d236a0d90a4492a29d5565c4db1645b4340dd01`](https://robin.etherscan.io/tx/0x22116458cd79e9eedcfe2fbc5d236a0d90a4492a29d5565c4db1645b4340dd01) | setClosedDay on the factory |
| 44 | 89,267,793 | [`0xea241ba1daeaba285bfb0a97736bdec1e19d6b73eebfa1212be6f6ff1fd706ec`](https://robin.etherscan.io/tx/0xea241ba1daeaba285bfb0a97736bdec1e19d6b73eebfa1212be6f6ff1fd706ec) | setClosedDay on the factory |
| 45 | 89,267,819 | [`0x8fe5534a65d9cdef17310f75240431926713cf22d189c80c5c45c5495031ac3b`](https://robin.etherscan.io/tx/0x8fe5534a65d9cdef17310f75240431926713cf22d189c80c5c45c5495031ac3b) | setClosedDay on the factory |
| 46 | 89,267,845 | [`0x1d4c1ab0621e821fe20431bd19783cbe5d8f34f44b4a037fae67c6851440eb5a`](https://robin.etherscan.io/tx/0x1d4c1ab0621e821fe20431bd19783cbe5d8f34f44b4a037fae67c6851440eb5a) | setClosedDay on the factory |
| 47 | 89,267,871 | [`0x23899620fe3143479d1ccc56bb2a2edf88360737591e278fedc895f4426d29a9`](https://robin.etherscan.io/tx/0x23899620fe3143479d1ccc56bb2a2edf88360737591e278fedc895f4426d29a9) | setClosedDay on the factory |
| 48 | 89,267,897 | [`0x0a367835b5a0c619ecdb291b72f1aae59ca48e5b3095c67b36ed79d8b4744a42`](https://robin.etherscan.io/tx/0x0a367835b5a0c619ecdb291b72f1aae59ca48e5b3095c67b36ed79d8b4744a42) | setClosedDay on the factory |
| 49 | 89,267,923 | [`0xdbfc4ad0af1eaed825c7fc38a5ed897e1b59f046e4faafb57f936d7403d06daf`](https://robin.etherscan.io/tx/0xdbfc4ad0af1eaed825c7fc38a5ed897e1b59f046e4faafb57f936d7403d06daf) | setClosedDay on the factory |
| 50 | 89,267,949 | [`0xffbbe70443055f55c296456f360eb147c0a43c898885544dfcb4411f137ee4e4`](https://robin.etherscan.io/tx/0xffbbe70443055f55c296456f360eb147c0a43c898885544dfcb4411f137ee4e4) | setClosedDay on the factory |
| 51 | 89,267,975 | [`0x3d59eb3386adcd090ccc8acc406f9331942fd5bc2a00f41ba602ae8c16ceeb79`](https://robin.etherscan.io/tx/0x3d59eb3386adcd090ccc8acc406f9331942fd5bc2a00f41ba602ae8c16ceeb79) | setClosedDay on the factory |
| 52 | 89,268,003 | [`0xd6048683bf7a14e27d1c338ac036ca763d53fa3c61c23050c2962c90a1e00c53`](https://robin.etherscan.io/tx/0xd6048683bf7a14e27d1c338ac036ca763d53fa3c61c23050c2962c90a1e00c53) | proposeAdmin on the factory |
| 53 | 89,268,029 | [`0x0ad24e4673b95f5944d7afa29d98bcdc9b19245134eb1357c346dcb8877b1e85`](https://robin.etherscan.io/tx/0x0ad24e4673b95f5944d7afa29d98bcdc9b19245134eb1357c346dcb8877b1e85) | transferOwnership on the beacon |
| Safe | 89,276,636 | [`0x5eb2c0b768f6345154b53f113c19c4595a5ec0c303c3936fca9dc36ff602cf6f`](https://robin.etherscan.io/tx/0x5eb2c0b768f6345154b53f113c19c4595a5ec0c303c3936fca9dc36ff602cf6f) | the Safe's batch: `acceptAdmin()` on the factory, `acceptOwnership()` on the beacon |

The two vaults on the factory of 2026-10-12, both of one owner, were emptied by him before the switch (read at block 89,256,400: every listed token at 0).

More tokens after the deploy are listed by the Safe with one batch of `setAsset` on the factory: [`MAINNET-LIST-13.md`](MAINNET-LIST-13.md) (2026-10-23, GME).

## What is deployed

`contracts/script/config/4663.json` as committed:

- the vault logic, the beacon, the factory and the registry (both UUPS proxies), as on 2026-10-12;
- the cash token USDG and 25 tokens: the nine of 2026-10-12 with their confirmed values, eleven of the twelve of `WIDER-LIST` (SGOV dropped), and QQQ, MU, AMD, INTC and SLV with a Uniswap v3 pool (`v3Pool`);
- the guardian `0x0a1c…4cc98`, no keeper, no deposit cap, the Universal Router, the publish delay of 48 hours;
- the Safe proposed for the factory's admin and the beacon's owner. No `TimelockController`.

The app showed 19 of the 25 tokens at the redeploy. DELL is listed and held back until its pool meets the bar again; the v3 five waited for the app to build a v3 route. Since 2026-10-23 (gate `V3-ROUTE`) the app shows 24: the five are under `assets` with their `v3Pool`, and the guard's file lists them with it. The record keeps DELL under `hidden`, with the reason, and the guard's file does not list it. SGOV dropped Oct 15: pool paid ~25% of feed for $500 at block 89,240,446: a listed token whose pool pays a quarter of its feed is not one to have on chain, even hidden (the orchestrator, under Thom's authority).

## The steps

Every command runs from the repository root, with `ROBINHOOD_RPC_URL` set to a Robinhood Chain mainnet node. The scripts never print it.

1. **Dry run.** `scripts/mainnet/redeploy-robinhood.sh`. It simulates all 53 transactions from the deployer `0x0495…8A938`, prints the Safe's owners and threshold as the chain answers them (compare them with the people who hold them) and sends nothing. On 2026-10-14: about 23.4M gas, 0.001 ETH at 0.043 gwei.
2. **Thom confirms the new tokens' values** (done 2026-10-15: "overall follow the recommendations", relayed by the orchestrator; the notes say "Confirmed by Thom, 2026-10-15"). The dry run ends with one table of the tokens whose values are still Proposed (the twelve of `WIDER-LIST` and the v3 five, 17 when Thom confirmed them; 16 once SGOV was dropped): each one's ceiling, largest trade, feed, pool, average pool and whether the app shows it (`pnpm ops:redeploy --proposed` prints it again). A send is refused while any value is Proposed (`checkMainnet`); a dry run is not. Thom confirms them in chat, and the agent then runs `pnpm ops:redeploy --confirm Thom --on <date>`, which turns each note into "Confirmed by Thom, <date>, as proposed <date>" and changes no value, formats the file with biome, and commits it on its own. Then the dry run again: no table, and no "NOT CONFIRMED" line.
3. **Deploy.** `scripts/mainnet/redeploy-robinhood.sh --send` (add `--account <keystore>` to sign from a cast keystore; without it forge asks for the key once). Type `deploy` to go on. The script keeps the first deploy's broadcast as `run-before-redeploy.json`, then writes `ROBINHOOD-REDEPLOY.safe-accept.json`.
4. **The Safe takes both keys, the same hour.** Load `ROBINHOOD-REDEPLOY.safe-accept.json` in the Safe's Transaction Builder: two calls, `acceptAdmin()` on the factory and `acceptOwnership()` on the beacon. Both owners sign. Until then the deployer still holds the admin.
5. **Read it back.** `pnpm ops:redeploy --status --rpc-env ROBINHOOD_RPC_URL` says the Safe holds both. `FACTORY=<factory> forge script script/Deploy.s.sol --sig "check()" --rpc-url $ROBINHOOD_RPC_URL` (from `contracts/`) checks the registry, the roles and every asset against the file.
6. **Write the records.** `pnpm ops:mainnet-records --safe 2:0x0a1c3312c808b23D019bF241028f6B5624f4cc98,0xAC3cBBCd6e51dBFAf4e79d5E8Cf54a1622D71e0e` writes `deployments/robinhood-mainnet.json` and `packages/sdk/deployments/mainnet.json` from the broadcast and regenerates the guard's tables. In the same commit set `TRUST_STATUS.mainnet.robinhood.delayHours` to 0 and a new `textVersion` in `packages/schemas/src/trust.ts`: `trust.test.ts` fails until both are done, so the notice says the Safe changes things at once.
7. **Authority check.** `pnpm ops:authority-check --record deployments/robinhood-mainnet.json --rpc-env ROBINHOOD_RPC_URL` must end `VERDICT: OK`.
8. **Verify the sources on Etherscan** (below), then merge the records commit into `staging`, fill the hosted `basket_assets` with the tokens the record shows, and deploy the API (Render `tenonfi-api`, a person's click). The API and the snapshot worker read the addresses from the record; no environment variable names them. `basket_assets` is what the API lists a chain's tokens from: `pnpm exec tsx scripts/robinhood/basket-assets.ts deployments/robinhood-mainnet.json` with the hosted `DATABASE_URL`, or, where no one holds that, the same rows as SQL written by the script on a copy of the hosted table (on 2026-10-15: ten `INSERT … ON CONFLICT DO NOTHING`, for MSTR, CRCL, USO, PLTR, WETH, cbBTC, SPCX, COIN, TSM and BABA; the script left the ten rows already there as they were). A person applies it. **Fill `basket_assets`, then deploy:** the API reads the rows once, at start, so rows written after it started are not listed until the next deploy (on 2026-10-15 the chat listed the old ten until the deploy of #322). A token the record shows with no row does not stop the start; it is listed nowhere, the start logs an error `basket_assets_missing` naming each one, and `GET /v1/config` lists them under the chain's `missingAssets`. After each deploy, `curl -s https://tenonfi-api.onrender.com/v1/config` must show `"missingAssets":[]` for `robinhood` (and `solana`). A row that does not match the record (another network's, a moved price entry) stops the start, with every such row named.

## A send that stops halfway

The deploy is 53 transactions, sent one after another (`--slow`). If the run stops before the last (the node drops, the terminal closes, a transaction is not mined), never run `--send` again: it would deploy a second set of contracts, and the first would stay with the deployer as its admin. The script refuses a second `--send` from the same checkout once one has broadcast a transaction (a send refused before it broadcast, for a Proposed value, leaves no mark and may be run again). Run `scripts/mainnet/redeploy-robinhood.sh --resume` (with the same `--account`): forge reads its record of the run (`contracts/broadcast/Deploy.s.sol/4663/run-latest.json`) and sends only the transactions not yet on chain, from the same nonces, in the same order. `--resume` itself refuses a record older than this send (the deploy of 2026-10-12's) and one in which a transaction reverted. A transaction that reverted is never sent again as it was: stop, read why (`cast run <hash>`), and decide with the team before anything else is sent. The record of the deploy of 2026-10-12 is kept as `run-before-redeploy.json` beside it, written once and never over.

## Verifying the sources

From `contracts/`, with an Etherscan API key in `ETHERSCAN_API_KEY` (never in a file) and the addresses from the record:

```
forge verify-contract <vaultLogic>    src/BasketVault.sol:BasketVault     --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --watch
forge verify-contract <beacon>        src/VaultBeacon.sol:VaultBeacon     --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --guess-constructor-args --watch
forge verify-contract <factoryLogic>  src/VaultFactory.sol:VaultFactory   --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --watch
forge verify-contract <registryLogic> src/IndexRegistry.sol:IndexRegistry --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --watch
forge verify-contract <factory>  node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --guess-constructor-args --watch
forge verify-contract <registry> node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy --chain 4663 --verifier etherscan --verifier-url https://api.etherscan.io/v2/api?chainid=4663 --guess-constructor-args --watch
```

Then mark each proxy as a proxy on https://robin.etherscan.io ("Is this a proxy?"), so its page reads through to the logic.

## The contracts of 2026-10-12

They stay deployed, held by their timelock. Their factory lists two vaults, both owned by `0xAC3c…1e0e`, about $15 between them on 2026-10-14 (5 USDG and four stocks in one, SPY in the other); the registry has no portfolio. Before the records change, their owner withdraws through the app (Withdraw on each vault). After it, the app no longer lists them, and `withdrawAll()` on each vault's page on Etherscan does the same: it reads no feed and calls neither the factory nor the timelock, so nothing on the old contracts can stop it.

## When the timelock comes back

Gate `ROBINHOOD-REDEPLOY` names the condition: the four portfolios of `PRODUCTS-MAINNET-ONLY` are published, a week of trading with the keeper off has run without an incident, and Thom says so. Then the Safe hands the factory's admin and the beacon to a new `TimelockController` of 48 hours, `delayHours` goes back to 48 with a new `textVersion`, and the record names the timelock again.

## Rehearsal

`ROBINHOOD_RPC_URL=<node> contracts/script/redeploy-fork.sh [out dir]` runs steps 3 to 7 on an anvil copy of mainnet, as the impersonated deployer and Safe. It first sends the committed file and expects the refusal for its Proposed values with nothing sent, then deploys a copy whose values read as confirmed (`script/config/.rehearsal/`, removed when it ends). It fails on a `check()` revert and on any verdict but OK. Last run, 2026-10-15 at block 89,250,926, with SGOV dropped and every value confirmed: 53 transactions with receipts; the Safe's two calls; the Safe holds both; `Deploy.check()` passes on 26 assets; both records written; `authority-check` `VERDICT: OK`. (Earlier runs, with SGOV: 54 transactions and 27 assets, at blocks 88,777,239 and 88,817,888.) `RH_FORK_URL=<node> forge test --match-path test/fork/RobinhoodForkDeploy.t.sol` deploys the same file on a fork and buys and sells back each of the 24 tokens the app will trade (the 19 shown and the v3 five) through the real router, within 2% of the feed; DELL, held back, is checked as listed only. At block 89,252,201 (2026-10-15, SGOV dropped) it passes 9 of 9.
