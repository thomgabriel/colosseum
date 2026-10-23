// Generated from packages/sdk/deployments/*.json by packages/sdk/scripts/gen-guard-tables.ts.
// Do not edit: run `pnpm --filter @colosseum/sdk tables`. tables.test.ts fails when this file and its source disagree.
import { deepFreeze } from '../strict';

/** One file per network, as committed, and frozen. `deploymentsOf` reads and checks them, and nothing else. */
export const DEPLOYMENT_FILES: Readonly<Record<string, unknown>> = deepFreeze({
  mainnet: {
    format: 'guard-deployment/1',
    network: 'mainnet',
    chains: {
      robinhood: {
        family: 'evm',
        evmChainId: 4663,
        factory: '0x7e2bbb8483eb1baa6d87210bc83b63ad7a1bb8aa',
        beacon: '0x935658c738aef037092c69fd66b1ac3295882c0d',
        routers: ['0x204FAca1764B154221e35c0d20aBb3c525710498'],
        routes: {
          '0x204FAca1764B154221e35c0d20aBb3c525710498': {
            kind: 'universal-router-v4',
            hooks: '0x0000000000000000000000000000000000000000',
          },
        },
        registry: '0x65ff89c4436a11bb87e3c7328a3f02c407c7d6f8',
        cash: 'robinhood:usdg',
        assets: {
          'robinhood:usdg': {
            address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
            decimals: 6,
          },
          'robinhood:nvda': {
            address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
            decimals: 18,
            pool: {
              fee: 100,
              tickSpacing: 1,
            },
          },
          'robinhood:spy': {
            address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:aapl': {
            address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:msft': {
            address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:googl': {
            address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:amzn': {
            address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
            decimals: 18,
            pool: {
              fee: 2400,
              tickSpacing: 24,
            },
          },
          'robinhood:meta': {
            address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:tsla': {
            address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:gld': {
            address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e',
            decimals: 18,
            pool: {
              fee: 2100,
              tickSpacing: 21,
            },
          },
          'robinhood:mstr': {
            address: '0xec262a75e413fafd0df80480274532c79d42da09',
            decimals: 18,
            pool: {
              fee: 2400,
              tickSpacing: 24,
            },
          },
          'robinhood:crcl': {
            address: '0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 30,
            },
          },
          'robinhood:uso': {
            address: '0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344',
            decimals: 18,
            pool: {
              fee: 1200,
              tickSpacing: 15,
            },
          },
          'robinhood:pltr': {
            address: '0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a',
            decimals: 18,
            pool: {
              fee: 1500,
              tickSpacing: 15,
            },
          },
          'robinhood:weth': {
            address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
            decimals: 18,
            pool: {
              fee: 200,
              tickSpacing: 4,
            },
          },
          'robinhood:cbbtc': {
            address: '0xcec185eb182c47d1ba1efc84e6959e18cd620be4',
            decimals: 8,
            pool: {
              fee: 1500,
              tickSpacing: 15,
            },
          },
          'robinhood:spcx': {
            address: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
            decimals: 18,
            pool: {
              fee: 3000,
              tickSpacing: 60,
            },
          },
          'robinhood:coin': {
            address: '0x6330d8c3178a418788df01a47479c0ce7ccf450b',
            decimals: 18,
            pool: {
              fee: 2500,
              tickSpacing: 25,
            },
          },
          'robinhood:tsm': {
            address: '0x58ffe4a942d3885baa22d7520691f611ef09e7aa',
            decimals: 18,
            pool: {
              fee: 7500,
              tickSpacing: 75,
            },
          },
          'robinhood:baba': {
            address: '0xad25ac6c84d497db898fa1e8387bf6af3532a1c4',
            decimals: 18,
            pool: {
              fee: 1000,
              tickSpacing: 10,
            },
          },
          'robinhood:qqq': {
            address: '0xd5f3879160bc7c32ebb4dc785f8a4f505888de68',
            decimals: 18,
            v3Pool: {
              pool: '0xd60a5d14db690b7afad71f76b108071d7175597d',
              fee: 500,
            },
          },
          'robinhood:mu': {
            address: '0xff080c8ce2e5feadaca0da81314ae59d232d4afd',
            decimals: 18,
            v3Pool: {
              pool: '0xd057b1bc54917855bbee58ead58647f47cab35e5',
              fee: 3000,
            },
          },
          'robinhood:amd': {
            address: '0x86923f96303d656e4aa86d9d42d1e57ad2023fdc',
            decimals: 18,
            v3Pool: {
              pool: '0x48d284a2a4d3dc1b3da08231fe44317e7e7aa51f',
              fee: 3000,
            },
          },
          'robinhood:intc': {
            address: '0xc72b96e0e48ecd4dc75e1e45396e26300bc39681',
            decimals: 18,
            v3Pool: {
              pool: '0x2e5a92f5013a64661a49312111be2e8abd33f56a',
              fee: 3000,
            },
          },
          'robinhood:slv': {
            address: '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f',
            decimals: 18,
            v3Pool: {
              pool: '0x8cb787e6c315d464775289bad00fdd67d53ecb3d',
              fee: 3000,
            },
          },
          'robinhood:gme': {
            address: '0x1b0e319c6a659f002271b69db8a7df2f911c153e',
            decimals: 18,
            v3Pool: {
              pool: '0xe2b46c905e12ab8e2f864e4821a4325884c1b126',
              fee: 500,
            },
          },
        },
      },
    },
  },
  mock: {
    format: 'guard-deployment/1',
    network: 'mock',
    chains: {
      solana: {
        family: 'mock',
        cash: 'solana:usdc',
        cashDecimals: 6,
      },
      robinhood: {
        family: 'mock',
        cash: 'robinhood:usdc',
        cashDecimals: 6,
      },
      base: {
        family: 'mock',
        cash: 'base:usdc',
        cashDecimals: 6,
      },
    },
  },
  testnet: {
    format: 'guard-deployment/1',
    network: 'testnet',
    chains: {
      solana: {
        family: 'solana',
        program: '529j92ASeopFHuLLueGdyaUy4BsZ7UWqrgoVWn2iK1QW',
        router: '2ticePjZZ6e34bNUgUXz7v3uHm3jS8jvV13gesdvKn4f',
        cash: 'solana:usdc',
        assets: {
          'solana:usdc': {
            mint: 'AEtFZt8Fq4PYzBs4d8VoMypDDhjp9XTv6qvhJZhd8BUn',
            tokenProgram: 'token',
            decimals: 6,
          },
          'solana:spyx': {
            mint: 'J5d882iVcofnjkud99LzTcVryPdS8d9BUpH7eBcypeyk',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:qqqx': {
            mint: 'HLnfGWv3cxjT3s5816Ri1Z1eB7o21Z9P5UmJatLUQUoa',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:nvdax': {
            mint: '6sgytf7j8TMxhsiW7sxuSSTp8xzusV1egyHFV5BABYVr',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:tslax': {
            mint: 'CNJDWe13sZdiF3JeN7URGf95hEndAnMNtXL55hU66uHH',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:aaplx': {
            mint: '92KZfnfaXowGwMiFdsMBkL3uunussnDRo36T3XGyF34w',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:googlx': {
            mint: '7a5idDoB2FXwbfcVRPxQDFpWdndmX75h8ZDkos2i4yfW',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:metax': {
            mint: '6KakiyUtqejgFjJp4mAmadpMmaoVho62uSgVVtMdiph6',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:mstrx': {
            mint: 'Fap4HtxGsMPKsc5aK3RmChvpkx5D2nUgkhryBr69TXxV',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:crclx': {
            mint: '3yitbppTKKnVoCpmLnwC3S6M3mTBxEs1H8AJJaqgA9fv',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:hoodx': {
            mint: '5rbr2wh5BZBUYsJCkTFRiNznu7DQDh1NPRWJW7REUHnb',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
          'solana:jlusdc': {
            mint: 'GV49vP3U5XVbHJxT8vpDNTDZZWAKUtbFm8jHjzd6LUuc',
            tokenProgram: 'token',
            decimals: 6,
          },
          'solana:syrupusdc': {
            mint: 'GWFDMf5L2mCy6Z6v7fwPaavigDKeg8nkrg9xRCha4gAe',
            tokenProgram: 'token',
            decimals: 6,
          },
          'solana:paxg': {
            mint: 'GZ2F1ryu8SgCGKhScVQLXzG5Q5Hp4NYocKd2F7ueeKh1',
            tokenProgram: 'token-2022',
            decimals: 6,
          },
          'solana:gldx': {
            mint: '32BAoiuKWNj8yzeEarBF52pdLbY3umSmreMqNFPHieiE',
            tokenProgram: 'token-2022',
            decimals: 8,
          },
        },
      },
      robinhood: {
        family: 'evm',
        evmChainId: 46630,
        factory: '0xa3309dc51b41e55fcd48b12377025cd2ba4d21a4',
        beacon: '0x4c6699623966be46a40844da3e79d7da3d8d3d96',
        routers: ['0xd290cfe0738e1ab9cea9dc138bbec024dc3bd127'],
        routes: {
          '0xd290cfe0738e1ab9cea9dc138bbec024dc3bd127': {
            kind: 'universal-router-v4',
            hooks: '0x0000000000000000000000000000000000000000',
          },
        },
        registry: '0xe73c5df15452469873f610a26dac7fec68a23b14',
        cash: 'robinhood:tusdg',
        assets: {
          'robinhood:tusdg': {
            address: '0xd3d6e7bf284d922651983468b75492be4f3f689a',
            decimals: 6,
          },
          'robinhood:tspy': {
            address: '0xb4e18cbb171bdd09e69255e69f94aaf081e943ad',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tqqq': {
            address: '0xd2589158fde964d7a6fea7918568aaa1a6b6283f',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tnvda': {
            address: '0x92c47af3a0878f360106db7b79b0ca9c32f0c4fd',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:taapl': {
            address: '0x8fdea72a9d0fb5c21364d6ac4cc8544beb84b9fc',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tmsft': {
            address: '0x5d7f0011031cdb8fa954d451c3348a96e10a23f0',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tgoogl': {
            address: '0xb4c3e6dd28c98c8c0f27b3db2f77cc4d257297d5',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tamzn': {
            address: '0x837a0b2aacedef3ed3d4bec19be3c5bc0873185b',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tmeta': {
            address: '0x872ba0c735b0c41c43d8881bce2ef1deccd6bc69',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:ttsla': {
            address: '0x9f8c39aff46ce9d06dd4b1c31107761f7f2d9796',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tgld': {
            address: '0xb3fc39f47282ef0a9e2451ba406f04074d27c425',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
          'robinhood:tsgov': {
            address: '0xb68427c11ecd92eaefa0f44ed87071f38e2ac216',
            decimals: 18,
            pool: {
              fee: 500,
              tickSpacing: 10,
            },
          },
        },
        fee: {
          maxFeeNativeRaw: '1000000000000000',
          maxGas: 5000000,
        },
      },
    },
  },
});
