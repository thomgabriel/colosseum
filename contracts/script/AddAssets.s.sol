// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Deploy} from "./Deploy.s.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IVaultConfig} from "../src/interfaces/IVaultConfig.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {AssetConfig, Swap, Weight} from "../src/interfaces/Types.sol";
import {UniV4Calldata} from "../test/fork/UniV4Calldata.sol";

interface IAddAssetsFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IAddAssetsToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Lists more tokens on a deployed mainnet factory, through its timelock: the one batch the Safe schedules
/// and, once the delay has passed, the same batch it executes. It sends nothing and holds no key. The
/// Safe's two owners sign the two calls in the Safe app (ROBINHOOD-MAINNET-WIDER-LIST.md, outside the repo).
///
///   forge script script/AddAssets.s.sol --rpc-url <node>                   holds the file to the chain, prints both calls
///   forge script script/AddAssets.s.sol --sig "check()" --rpc-url <node>   after the execute: every token listed as
///                                                                          the file says, and a vault trades each
///                                                                          one in its pool within the bound
///
/// The file is `ADD_ASSETS_CONFIG`, by default `script/config/4663-assets-2.json`. Each asset is an entry of
/// the deploy file's shape (`script/config/4663.json`), held to the same per-asset rules (`checkMainnetAsset`);
/// beside it the file names the factory, the timelock, the Safe and the batch's salt. `run()` refuses a file
/// whose factory's admin is not that timelock, whose Safe cannot propose to and execute from it, whose
/// cash is not the factory's, or one of whose tokens is listed already, has the keeper's switch on, states no
/// largest trade or no pool.
///
/// `check()` changes a fork's state, never a real chain's: it is run without `--broadcast`, against a copy of
/// mainnet on which the batch was executed (`script/add-assets-fork.sh`). Its trades are `vm.prank`s.
contract AddAssets is Script, StdCheats {
    using stdJson for string;

    struct File {
        uint256 chainId;
        address factory;
        address timelock;
        address safe;
        address cashToken;
        bytes32 salt;
        uint256 priceBoundBps;
        Deploy.Asset[] assets;
        string[] feedDescriptions;
        uint256[] maxTradeUsd;
        UniV4Calldata.PoolKey[] pools;
    }

    /// Robinhood Chain's one router (Universal Router 2.1.2), as the deploy file names it.
    address internal constant UNIVERSAL_ROUTER = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    uint256 internal constant USD = 1e6;
    uint256 internal constant ROUND_TRIP_DEPOSIT = 1000 * USD;
    uint256 internal constant ROUND_TRIP_TRADE = 500 * USD;

    error AddAssetsRefused(string rule);

    Deploy internal helper;

    function run() external {
        vm.pauseGasMetering();
        File memory f = readFile(_path());
        checkFile(f);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = batch(f);
        TimelockController timelock = TimelockController(payable(f.timelock));
        uint256 delay = timelock.getMinDelay();
        bytes32 id = timelock.hashOperationBatch(targets, values, payloads, bytes32(0), f.salt);
        bytes memory schedule = scheduleCalldata(f, delay);
        bytes memory execute = executeCalldata(f);

        console2.log("factory:", f.factory);
        console2.log("timelock:", f.timelock, "delay (s):", delay);
        console2.log("safe:", f.safe);
        for (uint256 i; i < f.assets.length; ++i) {
            AssetConfig memory c = f.assets[i].config;
            console2.log(
                string.concat(
                    "setAsset(",
                    vm.toString(f.assets[i].token),
                    ", feed ",
                    vm.toString(c.feed),
                    " '",
                    f.feedDescriptions[i],
                    "', maxWeightBps ",
                    vm.toString(c.maxWeightBps),
                    ", session ",
                    vm.toString(c.session),
                    ", keeper off)"
                )
            );
        }
        console2.log("operation id:");
        console2.logBytes32(id);
        if (timelock.isOperationDone(id)) console2.log("state: executed");
        else if (timelock.isOperationReady(id)) console2.log("state: scheduled and ready to execute");
        else if (timelock.isOperation(id)) console2.log("state: scheduled, waiting out the delay");
        else console2.log("state: not scheduled");
        console2.log("1. the Safe calls the timelock, scheduleBatch; keccak256 of its data:");
        console2.logBytes32(keccak256(schedule));
        console2.logBytes(schedule);
        console2.log("2. after the delay, the Safe calls the timelock, executeBatch; keccak256 of its data:");
        console2.logBytes32(keccak256(execute));
        console2.logBytes(execute);
    }

    /// After the batch ran: every token of the file is listed with exactly the file's settings, and a vault
    /// on the live factory deposits $1,000, trades $500 into each token through its recorded pool and half of
    /// it back, every fill within `priceBoundBps` of the token's Chainlink price, and withdraws everything.
    function check() external {
        // Reading the file and ten round trips cost more gas than one block of this chain holds; this is a
        // check on a copy, never a transaction.
        vm.pauseGasMetering();
        File memory f = readFile(_path());
        require(block.chainid == f.chainId, AddAssetsRefused("the node is not the file's chain"));
        IVaultConfig factory = IVaultConfig(f.factory);
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = batch(f);
        bytes32 id =
            TimelockController(payable(f.timelock)).hashOperationBatch(targets, values, payloads, bytes32(0), f.salt);
        require(TimelockController(payable(f.timelock)).isOperationDone(id), AddAssetsRefused("the batch has not run"));
        for (uint256 i; i < f.assets.length; ++i) {
            address token = f.assets[i].token;
            require(factory.isAsset(token), AddAssetsRefused(string.concat(vm.toString(token), " is not listed")));
            AssetConfig memory want = f.assets[i].config;
            AssetConfig memory got = factory.asset(token);
            want.haltUntil = got.haltUntil;
            require(
                keccak256(abi.encode(got)) == keccak256(abi.encode(want)),
                AddAssetsRefused(string.concat(vm.toString(token), " is listed with other settings than the file's"))
            );
            console2.log(string.concat("listed as the file says: ", f.feedDescriptions[i]));
        }
        address person = makeAddr("add-assets person");
        for (uint256 i; i < f.assets.length; ++i) {
            roundTrip(f, i, person);
        }
        console2.log("every token listed, and each traded in its own pool within (bps):", f.priceBoundBps);
    }

    // ---- the batch

    /// One `setAsset` on the factory per token, in the file's order.
    function batch(File memory f)
        public
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        uint256 n = f.assets.length;
        targets = new address[](n);
        values = new uint256[](n);
        payloads = new bytes[](n);
        for (uint256 i; i < n; ++i) {
            targets[i] = f.factory;
            payloads[i] = abi.encodeCall(IVaultConfig.setAsset, (f.assets[i].token, f.assets[i].config));
        }
    }

    function scheduleCalldata(File memory f, uint256 delay) public pure returns (bytes memory) {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = batch(f);
        return abi.encodeCall(TimelockController.scheduleBatch, (targets, values, payloads, bytes32(0), f.salt, delay));
    }

    function executeCalldata(File memory f) public pure returns (bytes memory) {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = batch(f);
        return abi.encodeCall(TimelockController.executeBatch, (targets, values, payloads, bytes32(0), f.salt));
    }

    // ---- the file, against the chain

    /// What `run()` holds the file to before it prints a call: see the contract's comment.
    function checkFile(File memory f) public {
        require(block.chainid == f.chainId, AddAssetsRefused("the node is not the file's chain"));
        require(f.factory.code.length != 0, AddAssetsRefused("the factory has no code"));
        IVaultConfig factory = IVaultConfig(f.factory);
        require(factory.admin() == f.timelock, AddAssetsRefused("the factory's admin is not the file's timelock"));
        TimelockController timelock = TimelockController(payable(f.timelock));
        require(
            timelock.getMinDelay() >= helperDeploy().MIN_MAINNET_DELAY(),
            AddAssetsRefused("the timelock waits under 48 hours")
        );
        require(
            timelock.hasRole(timelock.PROPOSER_ROLE(), f.safe) && timelock.hasRole(timelock.EXECUTOR_ROLE(), f.safe),
            AddAssetsRefused("the Safe cannot propose to and execute from the timelock")
        );
        require(f.cashToken == factory.cashToken(), AddAssetsRefused("the file's cash is not the factory's"));
        require(f.priceBoundBps != 0 && f.priceBoundBps <= 1000, AddAssetsRefused("no priceBoundBps of 1 to 1000"));
        require(f.assets.length != 0, AddAssetsRefused("the file lists no token"));
        for (uint256 i; i < f.assets.length; ++i) {
            Deploy.Asset memory a = f.assets[i];
            string memory name = vm.toString(a.token);
            require(a.token != f.cashToken, AddAssetsRefused("the cash is listed already"));
            require(!factory.isAsset(a.token), AddAssetsRefused(string.concat(name, " is listed already")));
            for (uint256 j; j < i; ++j) {
                require(f.assets[j].token != a.token, AddAssetsRefused(string.concat(name, " is in the file twice")));
            }
            require(
                a.config.flags == 0 && a.config.averageFeed == address(0) && a.config.minPrice == 0
                    && a.config.maxPrice == 0,
                AddAssetsRefused(string.concat(name, ": the keeper is off on this mainnet, and its switch with it"))
            );
            require(
                a.config.source == 1 && a.config.feed != address(0),
                AddAssetsRefused(string.concat(name, " has no Chainlink feed: an owner's trade would have no witness"))
            );
            require(f.maxTradeUsd[i] != 0, AddAssetsRefused(string.concat(name, " states no maxTradeUsd")));
            require(f.pools[i].tickSpacing != 0, AddAssetsRefused(string.concat(name, " states no pool")));
            helperDeploy().checkMainnetAsset(a, f.feedDescriptions[i], f.cashToken);
        }
    }

    function readFile(string memory path) public returns (File memory f) {
        string memory json = vm.readFile(path);
        require(!_hasTodo(json), AddAssetsRefused("the file still holds a TODO: every value must be confirmed"));
        f.chainId = json.readUint(".chainId");
        f.factory = json.readAddress(".factory");
        f.timelock = json.readAddress(".timelock");
        f.safe = json.readAddress(".safe");
        f.cashToken = json.readAddress(".cashToken");
        f.salt = keccak256(bytes(json.readString(".salt")));
        f.priceBoundBps = json.readUint(".priceBoundBps");
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".assets[", vm.toString(n), "]"))) ++n;
        f.assets = new Deploy.Asset[](n);
        f.feedDescriptions = new string[](n);
        f.maxTradeUsd = new uint256[](n);
        f.pools = new UniV4Calldata.PoolKey[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".assets[", vm.toString(i), "]");
            (f.assets[i], f.feedDescriptions[i], f.maxTradeUsd[i]) = helperDeploy().parseAsset(json, entry);
            address token = f.assets[i].token;
            (address currency0, address currency1) = token < f.cashToken ? (token, f.cashToken) : (f.cashToken, token);
            f.pools[i] = UniV4Calldata.PoolKey(
                currency0,
                currency1,
                uint24(json.readUint(string.concat(entry, ".pool.fee"))),
                int24(int256(json.readUint(string.concat(entry, ".pool.tickSpacing")))),
                address(0)
            );
        }
    }

    // ---- one token, through a vault on the live factory

    function roundTrip(File memory f, uint256 i, address person) public {
        address token = f.assets[i].token;
        address usdg = f.cashToken;
        string memory name = f.feedDescriptions[i];
        AssetConfig memory c = f.assets[i].config;
        (, int256 answer,,,) = IAddAssetsFeed(c.feed).latestRoundData();
        require(answer > 0, AddAssetsRefused(string.concat(name, ": the feed gives no price")));
        uint256 price = uint256(answer);
        // Raw token units per raw dollar unit at the feed's price: 10^(token decimals + feed decimals - 6).
        uint256 scale = 10 ** (uint256(c.tokenDecimals) + c.feedDecimals - 6);
        uint256 bound = f.priceBoundBps;

        deal(usdg, person, ROUND_TRIP_DEPOSIT);
        Weight[] memory targets = new Weight[](1);
        targets[0] = Weight(token, 5000);
        vm.startPrank(person);
        BasketVault vault = BasketVault(
            payable(
                VaultFactory(f.factory).createVault(
                    keccak256(abi.encode("add-assets", token)), targets, bytes32(0), 0, false
                )
            )
        );
        IAddAssetsToken(usdg).approve(address(vault), ROUND_TRIP_DEPOSIT);
        vault.deposit(ROUND_TRIP_DEPOSIT);

        uint256 fair = ROUND_TRIP_TRADE * scale / price;
        uint256 minOut = fair * (10_000 - bound) / 10_000;
        vault.ownerSwap(_one(usdg, token, ROUND_TRIP_TRADE, minOut, f.pools[i]), type(uint64).max);
        uint256 bought = IAddAssetsToken(token).balanceOf(address(vault));
        require(bought >= minOut, AddAssetsRefused(string.concat(name, ": the buy filled outside the bound")));
        require(
            bought <= fair * (10_000 + bound) / 10_000,
            AddAssetsRefused(string.concat(name, ": the buy filled outside the bound, the other way"))
        );

        uint256 sold = bought / 2;
        uint256 minDollars = sold * price / scale * (10_000 - bound) / 10_000;
        vault.ownerSwap(_one(token, usdg, sold, minDollars, f.pools[i]), type(uint64).max);
        uint256 dollars = IAddAssetsToken(usdg).balanceOf(address(vault));
        require(
            dollars >= ROUND_TRIP_DEPOSIT - ROUND_TRIP_TRADE + minDollars,
            AddAssetsRefused(string.concat(name, ": the sale filled outside the bound"))
        );
        require(vault.withdrawAll().length == 0, AddAssetsRefused(string.concat(name, ": something was left behind")));
        vm.stopPrank();
        require(
            IAddAssetsToken(token).balanceOf(address(vault)) == 0
                && IAddAssetsToken(usdg).balanceOf(address(vault)) == 0,
            AddAssetsRefused(string.concat(name, ": the vault kept something"))
        );
        // Shown in the feed's units of a dollar, eight places: what a token cost bought and sold, against the feed.
        console2.log(
            string.concat(
                name,
                ": bought ",
                vm.toString(bought),
                " for $500, sold half for ",
                vm.toString(dollars - (ROUND_TRIP_DEPOSIT - ROUND_TRIP_TRADE)),
                " (6 places); feed ",
                vm.toString(price)
            )
        );
    }

    function _one(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, UniV4Calldata.PoolKey memory key)
        internal
        view
        returns (Swap[] memory list)
    {
        list = new Swap[](1);
        list[0] = Swap({
            router: UNIVERSAL_ROUTER,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOut: minOut,
            data: UniV4Calldata.exactInSingle(key, tokenIn, amountIn, minOut, address(0), block.timestamp + 300)
        });
    }

    function helperDeploy() internal returns (Deploy) {
        if (address(helper) == address(0)) helper = new Deploy();
        return helper;
    }

    function _path() internal view returns (string memory) {
        return vm.envOr("ADD_ASSETS_CONFIG", string("script/config/4663-assets-2.json"));
    }

    function _hasTodo(string memory text) private pure returns (bool) {
        bytes memory b = bytes(text);
        for (uint256 i; i + 4 <= b.length; ++i) {
            if (b[i] == "T" && b[i + 1] == "O" && b[i + 2] == "D" && b[i + 3] == "O") return true;
        }
        return false;
    }
}
