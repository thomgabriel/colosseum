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

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface IAddAssetsFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IAddAssetsToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Lists more tokens on a deployed mainnet factory. Where the file names a timelock (the factory of
/// 2026-10-12), through it: the one batch the Safe schedules and, once the delay has passed, the same batch it
/// executes. Where it names none (the redeploy's factory, whose admin is the Safe itself, gate
/// ROBINHOOD-REDEPLOY), the Safe calls `setAsset` on the factory itself, every token in one batch it signs
/// once (`4663-assets-3.safe.json`). It sends nothing and holds no key; the Safe's two owners sign in the Safe app.
///
///   forge script script/AddAssets.s.sol --rpc-url <node>                   holds the file to the chain, prints both calls
///   forge script script/AddAssets.s.sol --sig "check()" --rpc-url <node>   after the execute: every token listed as
///                                                                          the file says, and a vault trades each
///                                                                          one in its pool within the bound
///
/// The file is `ADD_ASSETS_CONFIG`, by default `script/config/4663-assets-2.json`. Each asset is an entry of
/// the deploy file's shape (`script/config/4663.json`), held to the same per-asset rules (`checkMainnetAsset`);
/// beside it the file names the factory, the timelock if any, the Safe and the batch's salt. `run()` refuses a
/// file whose factory's admin is not that timelock (or, with none, the Safe), whose Safe cannot propose to and
/// execute from the timelock, whose
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
        /// Per token, the Uniswap v3 pool and fee it trades through instead of a v4 pool; zero for a v4 token.
        address[] v3Pools;
        uint24[] v3Fees;
        /// Per token, listed by the batch but held out of the app for now (`heldBack` in the file, with why):
        /// `check()` holds its listing to the file and does not trade it.
        bool[] heldBack;
        /// Calls after the listings in the same batch, each to its own target (the registry's upgrade).
        address[] callTargets;
        bytes[] callData;
        /// A contract one of those calls needs, deployed beforehand through the CREATE2 deployer below so its
        /// address depends only on its code: none when `create2Address` is zero.
        address create2Address;
        bytes32 create2Salt;
        string create2Artifact;
    }

    /// Arachnid's deterministic deployer, on Robinhood Chain as on most chains: calldata salt ‖ init code.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant UNISWAP_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

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
        if (f.timelock == address(0)) {
            console2.log("factory:", f.factory);
            console2.log("safe, the factory's admin itself:", f.safe);
            for (uint256 i; i < targets.length; ++i) {
                console2.log(
                    string.concat("call ", vm.toString(i + 1), " of the Safe's batch, to ", vm.toString(targets[i]))
                );
                console2.log(string.concat("  setAsset of ", f.feedDescriptions[i], "; keccak256 of its data:"));
                console2.logBytes32(keccak256(payloads[i]));
                console2.logBytes(payloads[i]);
            }
            return;
        }
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
        if (f.timelock != address(0)) {
            (address[] memory targets, uint256[] memory values, bytes[] memory payloads) = batch(f);
            bytes32 id = TimelockController(payable(f.timelock)).hashOperationBatch(
                targets, values, payloads, bytes32(0), f.salt
            );
            require(
                TimelockController(payable(f.timelock)).isOperationDone(id), AddAssetsRefused("the batch has not run")
            );
        }
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
            if (f.heldBack[i]) console2.log(string.concat("held back, not traded: ", f.feedDescriptions[i]));
            else roundTrip(f, i, person);
        }
        console2.log("every token listed, and each traded in its own pool within (bps):", f.priceBoundBps);
    }

    // ---- the batch

    /// One `setAsset` on the factory per token, in the file's order, then the file's `calls` in theirs.
    function batch(File memory f)
        public
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        uint256 n = f.assets.length;
        uint256 m = f.callTargets.length;
        targets = new address[](n + m);
        values = new uint256[](n + m);
        payloads = new bytes[](n + m);
        for (uint256 i; i < n; ++i) {
            targets[i] = f.factory;
            payloads[i] = abi.encodeCall(IVaultConfig.setAsset, (f.assets[i].token, f.assets[i].config));
        }
        for (uint256 j; j < m; ++j) {
            targets[n + j] = f.callTargets[j];
            payloads[n + j] = f.callData[j];
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
        if (f.timelock == address(0)) {
            // The redeploy's factory: the Safe is the admin itself, and the file adds tokens only.
            require(factory.admin() == f.safe, AddAssetsRefused("the factory's admin is not the file's Safe"));
            require(
                f.callTargets.length == 0 && f.create2Address == address(0),
                AddAssetsRefused("with no timelock the file lists tokens only")
            );
        } else {
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
        }
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
            if (f.v3Pools[i] == address(0)) {
                require(f.pools[i].tickSpacing != 0, AddAssetsRefused(string.concat(name, " states no pool")));
            } else {
                // A v3 route: the pool is the v3 factory's own for the token, the cash and the fee.
                (address t0, address t1) = a.token < f.cashToken ? (a.token, f.cashToken) : (f.cashToken, a.token);
                require(
                    IUniswapV3Factory(UNISWAP_V3_FACTORY).getPool(t0, t1, f.v3Fees[i]) == f.v3Pools[i],
                    AddAssetsRefused(string.concat(name, ": its v3 pool is not the v3 factory's for the pair and fee"))
                );
            }
            helperDeploy().checkMainnetAsset(a, f.feedDescriptions[i], f.cashToken);
        }
        for (uint256 j; j < f.callTargets.length; ++j) {
            require(f.callTargets[j].code.length != 0, AddAssetsRefused("a call's target has no code"));
        }
        if (f.create2Address != address(0)) {
            require(
                create2AddressOf(f) == f.create2Address,
                AddAssetsRefused("the CREATE2 address is not the one the artifact's code and the salt give")
            );
        }
    }

    /// Where the CREATE2 deployer puts the file's artifact with the file's salt, from the code built here.
    function create2AddressOf(File memory f) public view returns (address) {
        bytes32 initCodeHash = keccak256(vm.getCode(f.create2Artifact));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, f.create2Salt, initCodeHash))))
        );
    }

    /// On a copy of the chain only: deploys the file's artifact where the CREATE2 deployer puts it, as the
    /// transaction a person sends before the schedule would. Nothing when it is there already.
    function deployCreate2(File memory f) public {
        if (f.create2Address == address(0) || f.create2Address.code.length != 0) return;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(f.create2Salt, vm.getCode(f.create2Artifact)));
        require(ok && f.create2Address.code.length != 0, AddAssetsRefused("the CREATE2 deploy failed"));
    }

    function readFile(string memory path) public returns (File memory f) {
        string memory json = vm.readFile(path);
        require(!_hasTodo(json), AddAssetsRefused("the file still holds a TODO: every value must be confirmed"));
        f.chainId = json.readUint(".chainId");
        f.factory = json.readAddress(".factory");
        if (vm.keyExistsJson(json, ".timelock")) f.timelock = json.readAddress(".timelock");
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
        f.v3Pools = new address[](n);
        f.v3Fees = new uint24[](n);
        f.heldBack = new bool[](n);
        for (uint256 i; i < n; ++i) {
            string memory entry = string.concat(".assets[", vm.toString(i), "]");
            (f.assets[i], f.feedDescriptions[i], f.maxTradeUsd[i]) = helperDeploy().parseAsset(json, entry);
            address token = f.assets[i].token;
            (address currency0, address currency1) = token < f.cashToken ? (token, f.cashToken) : (f.cashToken, token);
            f.heldBack[i] = vm.keyExistsJson(json, string.concat(entry, ".heldBack"));
            bool v4 = vm.keyExistsJson(json, string.concat(entry, ".pool"));
            bool v3 = vm.keyExistsJson(json, string.concat(entry, ".v3Pool"));
            require(v4 != v3, AddAssetsRefused("a token states one route: a v4 pool or a v3 pool"));
            if (v4) {
                f.pools[i] = UniV4Calldata.PoolKey(
                    currency0,
                    currency1,
                    uint24(json.readUint(string.concat(entry, ".pool.fee"))),
                    int24(int256(json.readUint(string.concat(entry, ".pool.tickSpacing")))),
                    address(0)
                );
            } else {
                f.v3Pools[i] = json.readAddress(string.concat(entry, ".v3Pool.pool"));
                f.v3Fees[i] = uint24(json.readUint(string.concat(entry, ".v3Pool.fee")));
            }
        }
        uint256 m;
        while (vm.keyExistsJson(json, string.concat(".calls[", vm.toString(m), "]"))) ++m;
        f.callTargets = new address[](m);
        f.callData = new bytes[](m);
        for (uint256 j; j < m; ++j) {
            string memory entry = string.concat(".calls[", vm.toString(j), "]");
            f.callTargets[j] = json.readAddress(string.concat(entry, ".target"));
            f.callData[j] = json.readBytes(string.concat(entry, ".data"));
        }
        if (vm.keyExistsJson(json, ".create2")) {
            f.create2Address = json.readAddress(".create2.address");
            f.create2Salt = json.readBytes32(".create2.salt");
            f.create2Artifact = json.readString(".create2.artifact");
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
        vault.ownerSwap(_one(f, i, usdg, token, ROUND_TRIP_TRADE, minOut), type(uint64).max);
        uint256 bought = IAddAssetsToken(token).balanceOf(address(vault));
        require(bought >= minOut, AddAssetsRefused(string.concat(name, ": the buy filled outside the bound")));
        require(
            bought <= fair * (10_000 + bound) / 10_000,
            AddAssetsRefused(string.concat(name, ": the buy filled outside the bound, the other way"))
        );

        uint256 sold = bought / 2;
        uint256 minDollars = sold * price / scale * (10_000 - bound) / 10_000;
        vault.ownerSwap(_one(f, i, token, usdg, sold, minDollars), type(uint64).max);
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

    /// One trade of token `i` through its own route: its v4 pool, or its v3 pool by Universal Router's v3 command.
    function _one(File memory f, uint256 i, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (Swap[] memory list)
    {
        bytes memory data = f.v3Pools[i] == address(0)
            ? UniV4Calldata.exactInSingle(f.pools[i], tokenIn, amountIn, minOut, address(0), block.timestamp + 300)
            : UniV4Calldata.exactInV3(tokenIn, f.v3Fees[i], tokenOut, amountIn, minOut, block.timestamp + 300);
        list = new Swap[](1);
        list[0] = Swap({
            router: UNIVERSAL_ROUTER,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOut: minOut,
            data: data
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
