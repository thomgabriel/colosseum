// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {BasketVault} from "../src/BasketVault.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";
import {IIndexRegistry} from "../src/interfaces/IIndexRegistry.sol";
import {IndexInfo, Limits, Weight} from "../src/interfaces/Types.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {IndexRegistryV1} from "./legacy/IndexRegistryV1.sol";

/// The second rules (gate SHARED-RULES-V2) reach a chain by replacing the registry's logic behind its proxy,
/// as the timelock does on Robinhood Chain mainnet: `upgradeToAndCall(new logic, "")`. These tests build a
/// registry on the first logic with portfolios in every state a version can be in, a vault that follows one,
/// and then upgrade it. Every word of the registry's storage is the same after, every read answers the same,
/// the vault goes on following, and only then do the new rules apply. The turnover and the delay do not move.
contract IndexRegistryUpgradeTest is KeeperFixture {
    bytes32 internal constant META = keccak256("meta");
    bytes32 internal constant REGISTRY_STORAGE = 0x0cb72df5e712c16f02df7d588d4d4376c1ac0e18f09e3767b1d21dd34bde3500;

    address internal creator = makeAddr("creator");
    IIndexRegistry internal reg;
    IndexRegistry internal next;
    bytes32[] internal ids;
    BasketVault internal follower;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    /// The factory's registry is set once, so the platform is deployed with the first logic behind it.
    function _newRegistry(VaultFactory factory_) internal override returns (IndexRegistry) {
        bytes memory init = abi.encodeCall(IndexRegistryV1.initialize, (address(factory_), PUBLISH_DELAY));
        return IndexRegistry(address(new ERC1967Proxy(address(new IndexRegistryV1()), init)));
    }

    function setUp() public {
        _deployKeeperPlatform();
        reg = IIndexRegistry(address(registry));
        next = new IndexRegistry();

        // Four portfolios: one with version 1 alone, one with a version that waits, one whose second version
        // waited and took effect, and one whose second version was taken back.
        uint256 t0 = block.timestamp;
        ids.push(_create("alone"));
        ids.push(_create("waiting"));
        ids.push(_create("matured"));
        ids.push(_create("cancelled"));
        vm.warp(t0 + PUBLISH_DELAY);
        _publish(ids[2], _weights(4500, 3000, 2500));
        _publish(ids[3], _weights(4500, 3000, 2500));
        vm.prank(creator);
        reg.cancel(ids[3]);
        vm.warp(t0 + 2 * PUBLISH_DELAY);
        _publish(ids[1], _weights(4000, 3500, 2500));
        _refresh();

        vm.prank(owner);
        follower = BasketVault(payable(factory.createVault(keccak256("follow"), new Weight[](0), ids[2], 2, true)));
    }

    function _weights(uint16 a, uint16 b, uint16 c) internal view returns (Weight[] memory list) {
        list = new Weight[](3);
        list[0] = Weight(address(stockA), a);
        list[1] = Weight(address(stockB), b);
        list[2] = Weight(address(stockC), c);
        return _sort(list);
    }

    function _create(string memory family) internal returns (bytes32) {
        vm.prank(creator);
        return reg.create(keccak256(bytes(family)), _threeStocks(), META, 0, 0);
    }

    function _publish(bytes32 id, Weight[] memory list) internal returns (uint32 version) {
        vm.prank(creator);
        (version,) = reg.publish(id, list, META);
    }

    function _upgrade() internal {
        vm.prank(admin);
        UUPS(address(reg)).upgradeToAndCall(address(next), "");
    }

    /// Every word the registry keeps: the head, the list of ids, and each portfolio with both its versions.
    function _words() internal view returns (bytes32[] memory out) {
        uint256 s = uint256(REGISTRY_STORAGE);
        out = new bytes32[](256);
        uint256 k;
        out[k++] = vm.load(address(reg), bytes32(s));
        out[k++] = vm.load(address(reg), bytes32(s + 1));
        for (uint256 i; i < ids.length; ++i) {
            out[k++] = vm.load(address(reg), bytes32(uint256(keccak256(abi.encode(s + 1))) + i));
            uint256 index = uint256(keccak256(abi.encode(ids[i], s + 2)));
            for (uint256 w; w < 8; ++w) {
                out[k++] = vm.load(address(reg), bytes32(index + w));
            }
            // Each version's components, three of them.
            for (uint256 slot; slot < 2; ++slot) {
                uint256 list = uint256(keccak256(abi.encode(index + 4 + 3 * slot)));
                for (uint256 c; c < 3; ++c) {
                    out[k++] = vm.load(address(reg), bytes32(list + c));
                }
            }
        }
        // What a later field would take, empty before and after.
        out[k++] = vm.load(address(reg), bytes32(s + 3));
    }

    /// Everything a reader can ask the registry, in one hash.
    function _reads() internal view returns (bytes32) {
        bytes memory all = abi.encode(reg.factory(), reg.publishDelay(), reg.indexCount());
        for (uint256 i; i < ids.length; ++i) {
            IndexInfo memory info = reg.indexInfo(ids[i]);
            (uint32 active, Weight[] memory components) = reg.active(ids[i]);
            (uint32 waiting, uint64 effectiveAt, Weight[] memory pendingComponents) = reg.pending(ids[i]);
            all = abi.encode(
                all,
                reg.indexAt(i),
                reg.creatorOf(ids[i]),
                info,
                active,
                components,
                waiting,
                effectiveAt,
                pendingComponents
            );
        }
        return keccak256(all);
    }

    function test_upgrade_isTheFactoryAdminsAlone() public {
        address[4] memory callers = [stranger, creator, guardian, keeper];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IIndexRegistry.NotAdmin.selector, callers[i]));
            UUPS(address(reg)).upgradeToAndCall(address(next), "");
        }
        _upgrade();
        assertEq(address(uint160(uint256(vm.load(address(reg), ERC1967Utils.IMPLEMENTATION_SLOT)))), address(next));
    }

    /// The storage is untouched and is read the same: the two logics share one layout.
    function test_upgrade_keepsEveryWordAndEveryRead() public {
        bytes32[] memory before = _words();
        bytes32 readBefore = _reads();
        assertEq(reg.indexCount(), 4);
        (uint32 waiting,,) = reg.pending(ids[1]);
        assertEq(waiting, 2, "a version waits");
        (uint32 active,) = reg.active(ids[2]);
        assertEq(active, 2, "a version took effect");
        assertEq(reg.indexInfo(ids[3]).pending.version, 0, "a version was taken back");

        _upgrade();
        assertEq(keccak256(abi.encode(_words())), keccak256(abi.encode(before)), "a word of storage moved");
        assertEq(_reads(), readBefore, "a read answers otherwise");
        assertEq(reg.rulesVersion(), 2);
    }

    /// The version that waited through the upgrade takes effect by the clock as before, the cancelled one's
    /// number is still never used again, and the vault that follows goes on following.
    function test_upgrade_versionsAndFollowersCarryOn() public {
        _upgrade();
        vm.warp(block.timestamp + PUBLISH_DELAY);
        (uint32 active,) = reg.active(ids[1]);
        assertEq(active, 2);
        uint32 version = _publish(ids[3], _weights(4000, 3000, 3000));
        assertEq(version, 3);

        (bytes32 followed, uint32 accepted, bool on) = follower.following();
        assertEq(followed, ids[2]);
        assertEq(accepted, 2);
        assertTrue(on);
        // A version under the new rules that only changes weights, with cash: the vault adopts it.
        _publish(ids[2], _weights(4000, 3000, 1500));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        follower.adoptVersion();
        Weight[] memory targets = follower.targets();
        assertEq(keccak256(abi.encode(targets)), keccak256(abi.encode(_weights(4000, 3000, 1500))));
    }

    /// The old rules are gone; the turnover and the delay are as they were.
    function test_upgrade_theNewRulesApply_theTurnoverAndTheDelayHold() public {
        Limits memory old = reg.limits();
        assertEq(old.minAssets, 3);
        assertEq(old.maxWeightBps, 5000);
        Weight[] memory one = new Weight[](1);
        one[0] = Weight(address(stockA), 10_000);
        (, uint8 reason,,,) = reg.previewPublish(keccak256(abi.encode(creator, keccak256("one"))), one);
        assertEq(reason, 3, "the first rules refuse one asset");

        _upgrade();
        Limits memory l = reg.limits();
        assertEq(l.minAssets, 1);
        assertEq(l.maxAssets, 16);
        assertEq(l.minWeightBps, 50);
        assertEq(l.maxWeightBps, 10_000);
        assertEq(l.stepBps, old.stepBps);
        assertEq(l.maxTurnoverBps, old.maxTurnoverBps);
        assertEq(l.publishDelay, old.publishDelay);
        _create("one-asset");
        vm.prank(creator);
        reg.create(keccak256("one"), one, META, 0, 0);

        // Turnover: 20% at most, cash counted. The first portfolio holds 50%, 30% and 20%.
        vm.warp(block.timestamp + PUBLISH_DELAY);
        (bytes4 err, uint8 why,,,) = reg.previewPublish(ids[0], _weights(2950, 3000, 2000));
        assertEq(err, IIndexRegistry.CreatorLimit.selector);
        assertEq(why, 13, "20.5% moved into cash");
        assertEq(_publish(ids[0], _weights(3000, 3000, 2000)), 2, "20% moved into cash");

        // The delay: the next version waits one delay, and none may follow it sooner.
        vm.warp(block.timestamp + PUBLISH_DELAY - 1);
        (, why,,,) = reg.previewPublish(ids[0], _weights(3000, 3000, 2500));
        assertEq(why, 11, "a version waits");
        vm.warp(block.timestamp + 1);
        (, why,,,) = reg.previewPublish(ids[0], _weights(3000, 3000, 2500));
        assertEq(why, 0);
    }
}

interface UUPS {
    function upgradeToAndCall(address logic, bytes calldata data) external payable;
}
