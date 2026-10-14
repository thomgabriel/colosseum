// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {BasketVault} from "../../src/BasketVault.sol";
import {IndexRegistry} from "../../src/IndexRegistry.sol";
import {IIndexRegistry} from "../../src/interfaces/IIndexRegistry.sol";
import {IVaultConfig} from "../../src/interfaces/IVaultConfig.sol";
import {AssetConfig, Limits, Snapshot, Weight} from "../../src/interfaces/Types.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {MockToken} from "../mocks/Tokens.sol";

/// The second author rules (gate SHARED-RULES-V2) reaching Robinhood Chain mainnet, on a copy of it: the new
/// registry logic is deployed where the CREATE2 deployer puts it (`script/DeployRegistryV2.s.sol`, which
/// anyone may run), the real Safe schedules the timelock batch that upgrades the registry, cannot run it
/// early, runs it 48 hours later, and then portfolios the first rules refused are published: one asset, 30%
/// cash, an asset over its ceiling, sixteen assets. The turnover and the delay still hold.
///
/// The factory lists nine tokens today. For sixteen, the same batch lists seven test tokens with no feed, as
/// the timelock would any token; nothing else is set by hand.
///
/// Opt-in, like the other fork tests: skipped unless `RH_FORK_URL` is set. It forks the chain's head, or
/// `RH_RULES_FORK_BLOCK` when that is set (the registry exists from block 86,877,019). It sends nothing.
contract RobinhoodForkSharedRulesTest is Test {
    address internal constant SAFE = 0x4568Bc6Cc821B34095059Fd46102eAA22A675Fdc;
    TimelockController internal constant TIMELOCK =
        TimelockController(payable(0x749f6aEB956b9f490e316599068Ba8a6Bd248342));
    IIndexRegistry internal constant REGISTRY = IIndexRegistry(0xEE6bAaeC7Ec5cD946dAd57E1eDB3f10C794C8aFc);
    VaultFactory internal constant FACTORY = VaultFactory(0xaE4ae2F2a5c2ee50C5A7574Cf355Cd5B068E7A80);
    /// The logic deployed by the deploy, replaced by this upgrade.
    address internal constant FIRST_LOGIC = 0x666439873b2b4121b290Dc91fb82308E1E760646;
    /// Arachnid's deterministic deployer: calldata is the salt, then the init code.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = "SHARED-RULES-V2";
    /// Where the CREATE2 deployer puts the second logic with that salt: what the batch names.
    address internal constant SECOND_LOGIC = 0x3200F7b8F56590F41D3F2fD9448F706A04bF3129;

    bytes32 internal constant META = keccak256("fork");
    address internal creator = makeAddr("creator");
    address internal owner = makeAddr("owner");
    bool internal forked;

    address internal constant SPY = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;
    address internal constant AMZN = 0x12f190a9F9d7D37a250758b26824B97CE941bF54;

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function setUp() public {
        string memory url = vm.envOr("RH_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        forked = true;
        uint256 forkBlock = vm.envOr("RH_RULES_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);
    }

    function _logic() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(REGISTRY), ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    function _one(address token, uint16 bps) internal pure returns (Weight[] memory list) {
        list = new Weight[](1);
        list[0] = Weight(token, bps);
    }

    function _sorted(Weight[] memory list) internal pure returns (Weight[] memory) {
        for (uint256 i = 1; i < list.length; ++i) {
            Weight memory w = list[i];
            uint256 j = i;
            for (; j > 0 && list[j - 1].token > w.token; --j) {
                list[j] = list[j - 1];
            }
            list[j] = w;
        }
        return list;
    }

    function _create(string memory family, Weight[] memory c) internal returns (bytes32 id) {
        vm.prank(creator);
        id = REGISTRY.create(keccak256(bytes(family)), c, META, 0, 0);
    }

    /// Seven test tokens, deployed on the copy, each listed by one `setAsset` of the batch: no feed, no
    /// keeper, a ceiling of 5%.
    function _testTokens() internal returns (bytes[] memory listings) {
        listings = new bytes[](7);
        for (uint256 i; i < 7; ++i) {
            AssetConfig memory cfg;
            cfg.tokenDecimals = 18;
            cfg.maxWeightBps = 500;
            listings[i] = abi.encodeCall(IVaultConfig.setAsset, (address(new MockToken(18)), cfg));
        }
    }

    function test_fork_theSafeUpgradesTheRegistry_andTheSecondRulesApply() public onFork {
        emit log_named_uint("fork block", block.number);
        // ---- before: the first rules, on the deploy's logic
        assertEq(_logic(), FIRST_LOGIC, "the deploy's logic");
        Limits memory old = REGISTRY.limits();
        assertEq(old.minAssets, 3);
        assertEq(old.maxAssets, 12);
        assertEq(old.minWeightBps, 200);
        assertEq(old.maxWeightBps, 5000);
        vm.expectRevert();
        REGISTRY.rulesVersion();
        uint256 count = REGISTRY.indexCount();
        (bytes4 err, uint8 reason,,,) = REGISTRY.previewPublish(keccak256("any"), _one(SPY, 10_000));
        assertEq(err, IIndexRegistry.CreatorLimit.selector);
        assertEq(reason, 3, "the first rules refuse one asset");

        // ---- the logic, where the CREATE2 deployer puts it: anyone's call, nothing to own
        bytes memory initCode = type(IndexRegistry).creationCode;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
        assertTrue(ok, "the CREATE2 deploy");
        assertEq(
            address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, keccak256(initCode)))))
            ),
            SECOND_LOGIC,
            "the address is the code's and the salt's"
        );
        assertGt(SECOND_LOGIC.code.length, 0);

        // ---- one batch, through the Safe and the timelock: seven test listings, then the upgrade
        bytes[] memory listings = _testTokens();
        address[] memory targets = new address[](8);
        uint256[] memory values = new uint256[](8);
        bytes[] memory payloads = new bytes[](8);
        for (uint256 i; i < 7; ++i) {
            targets[i] = address(FACTORY);
            payloads[i] = listings[i];
        }
        targets[7] = address(REGISTRY);
        payloads[7] = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", SECOND_LOGIC, bytes(""));
        assertEq(
            keccak256(payloads[7]),
            keccak256(
                hex"4f1ef2860000000000000000000000003200f7b8f56590f41d3f2fd9448f706a04bf312900000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000"
            ),
            "the upgrade's bytes are the ones the Safe file carries"
        );
        bytes32 salt = keccak256("shared-rules-v2 fork");
        uint256 delay = TIMELOCK.getMinDelay();
        assertEq(delay, 172_800);

        vm.prank(SAFE);
        TIMELOCK.scheduleBatch(targets, values, payloads, bytes32(0), salt, delay);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        TIMELOCK.executeBatch(targets, values, payloads, bytes32(0), salt);
        vm.warp(block.timestamp + delay - 1);
        vm.prank(SAFE);
        vm.expectRevert();
        TIMELOCK.executeBatch(targets, values, payloads, bytes32(0), salt);
        assertEq(_logic(), FIRST_LOGIC, "nothing changed before the delay");

        vm.warp(block.timestamp + 1);
        vm.prank(SAFE);
        TIMELOCK.executeBatch(targets, values, payloads, bytes32(0), salt);

        // ---- after: the second rules, the same registry, nothing else moved
        assertEq(_logic(), SECOND_LOGIC);
        assertEq(REGISTRY.rulesVersion(), 2);
        Limits memory l = REGISTRY.limits();
        assertEq(l.minAssets, 1);
        assertEq(l.maxAssets, 16);
        assertEq(l.minWeightBps, 50);
        assertEq(l.maxWeightBps, 10_000);
        assertEq(l.stepBps, old.stepBps);
        assertEq(l.maxTurnoverBps, old.maxTurnoverBps, "the turnover is unchanged");
        assertEq(l.publishDelay, old.publishDelay, "the delay is unchanged");
        assertEq(REGISTRY.indexCount(), count, "the portfolios are all there");
        assertEq(REGISTRY.factory(), address(FACTORY));
        // The logic itself cannot be initialised or upgraded by anyone.
        vm.expectRevert();
        IndexRegistry(SECOND_LOGIC).initialize(address(FACTORY), 172_800);
        vm.prank(makeAddr("stranger"));
        (ok,) =
            address(REGISTRY).call(abi.encodeWithSignature("upgradeToAndCall(address,bytes)", FIRST_LOGIC, bytes("")));
        assertFalse(ok, "the upgrade is the timelock's alone");

        // ---- portfolios the first rules refused
        // One asset, all of it.
        _create("one", _one(SPY, 10_000));
        // 30% cash: what the weights leave.
        bytes32 withCash = _create("cash", _one(SPY, 7000));
        // An asset over its ceiling: AMZN's is 0.5% on the factory.
        assertEq(FACTORY.asset(AMZN).maxWeightBps, 50);
        Weight[] memory over = new Weight[](2);
        over[0] = Weight(AMZN, 6000);
        over[1] = Weight(SPY, 4000);
        _create("over", _sorted(over));
        // Sixteen: what the factory lists besides its cash token (the nine of the deploy and the seven of the
        // batch), 6% each, 4% cash.
        address[] memory listed = _assets();
        assertGe(listed.length, 16);
        Weight[] memory sixteen = new Weight[](16);
        for (uint256 i; i < 16; ++i) {
            sixteen[i] = Weight(listed[i], 600);
        }
        _create("sixteen", _sorted(sixteen));
        // Seventeen is one too many: the count is the rule broken first, whatever the seventeenth is.
        Weight[] memory seventeen = new Weight[](17);
        for (uint256 i; i < 16; ++i) {
            seventeen[i] = Weight(listed[i], 550);
        }
        seventeen[16] = Weight(makeAddr("seventeenth"), 550);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.CreatorLimit.selector, uint8(4)));
        REGISTRY.create(keccak256("seventeen"), _sorted(seventeen), META, 0, 0);
        assertEq(REGISTRY.indexCount(), count + 4);

        // A vault that follows the 30% cash portfolio holds its weights and leaves the rest to cash.
        vm.prank(owner);
        BasketVault follower =
            BasketVault(payable(FACTORY.createVault(keccak256("fork-follow"), new Weight[](0), withCash, 1, false)));
        Weight[] memory held = follower.targets();
        assertEq(held.length, 1);
        assertEq(held[0].bps, 7000);
        Snapshot memory snap = follower.snapshot();
        assertEq(snap.tokens[1], FACTORY.cashToken());
        assertEq(snap.targetBps[1], 3000);

        // ---- the turnover and the delay hold
        vm.warp(block.timestamp + delay);
        (, reason,,,) = REGISTRY.previewPublish(withCash, _one(SPY, 4950));
        assertEq(reason, 13, "20.5% moved, cash counted");
        vm.prank(creator);
        (uint32 version, uint64 effectiveAt) = REGISTRY.publish(withCash, _one(SPY, 5000), META);
        assertEq(version, 2);
        assertEq(effectiveAt, block.timestamp + delay, "a version waits 48 hours");
        (, reason,,,) = REGISTRY.previewPublish(withCash, _one(SPY, 6000));
        assertEq(reason, 11, "none while one waits");
        vm.prank(creator);
        REGISTRY.cancel(withCash);
        (, reason,,,) = REGISTRY.previewPublish(withCash, _one(SPY, 6000));
        assertEq(reason, 12, "one version per delay, cancelled or not");
    }

    /// The factory's listed assets, its cash token left out.
    function _assets() internal view returns (address[] memory out) {
        address[] memory all = FACTORY.assets();
        address cash = FACTORY.cashToken();
        out = new address[](all.length);
        uint256 n;
        for (uint256 i; i < all.length; ++i) {
            if (all[i] != cash) out[n++] = all[i];
        }
        assembly {
            mstore(out, n)
        }
    }
}
