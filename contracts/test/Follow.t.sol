// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {BasketVault} from "../src/BasketVault.sol";
import {IBasketVault} from "../src/interfaces/IBasketVault.sol";
import {Snapshot, Swap, Weight} from "../src/interfaces/Types.sol";
import {KeeperFixture} from "./helpers/KeeperFixture.sol";
import {BackdoorToken} from "./mocks/Tokens.sol";

/// Following a shared portfolio: the owner's accept, the auto-follow switch, and the adopt anyone may call
/// for a vault that follows (DESIGN-VAULT.md sections 3.7 and 5, "New versions"). A14 and A18.
contract FollowTest is KeeperFixture {
    bytes32 internal constant FAMILY = keccak256("family");
    bytes32 internal constant META = keccak256("meta");
    address internal creator = makeAddr("creator");
    bytes32 internal id;

    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function setUp() public {
        _deployKeeperPlatform();
        vm.prank(creator);
        id = registry.create(FAMILY, _threeStocks(), META, 0, 0);
        // One version per publish delay: the next may be published from here.
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _refresh();
    }

    /// Three weights over the three stocks, sorted by token.
    function _weights(uint16 a, uint16 b, uint16 c) internal view returns (Weight[] memory list) {
        list = new Weight[](3);
        list[0] = Weight(address(stockA), a);
        list[1] = Weight(address(stockB), b);
        list[2] = Weight(address(stockC), c);
        return _sort(list);
    }

    function _publish(Weight[] memory next) internal returns (uint32 version) {
        vm.prank(creator);
        (version,) = registry.publish(id, next, META);
    }

    function _accept(uint32 version) internal {
        vm.prank(owner);
        vault.acceptVersion(id, version);
    }

    /// The vault's target for `token`, and whether it has one.
    function _targetOf(address token) internal view returns (bool found, uint16 bps) {
        Weight[] memory list = vault.targets();
        for (uint256 i; i < list.length; ++i) {
            if (list[i].token == token) return (true, list[i].bps);
        }
    }

    function _assertTargets(Weight[] memory expected) internal view {
        Weight[] memory list = vault.targets();
        assertEq(list.length, expected.length, "how many targets");
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].token, expected[i].token, "the token of a target");
            assertEq(list[i].bps, expected[i].bps, "the weight of a target");
        }
    }

    function _ownerBuys(address token, uint256 cashAmount) internal {
        Swap memory s = _swap(direct, address(cash), token, cashAmount, _amountFor(token, cashAmount));
        vm.prank(owner);
        vault.ownerSwap(_swaps(s), LATER);
    }

    // ---- accept

    function test_acceptVersion_takesTheVersionInEffect() public {
        vm.expectEmit(address(vault));
        emit IBasketVault.Followed(address(vault), id, 1);
        _accept(1);
        _assertTargets(_threeStocks());
        (bytes32 followed, uint32 version, bool autoFollow) = vault.following();
        assertEq(followed, id);
        assertEq(version, 1);
        assertTrue(autoFollow, "auto-follow is left as it was");
    }

    /// A18: an accept signed against version 1 that lands after version 2 took effect.
    function test_A18_anAcceptSignedAgainstAnOlderVersion_isRefused() public {
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionMismatch.selector, id, 1, 2));
        vault.acceptVersion(id, 1);
        _accept(2);
    }

    /// The number of the version that waits is not in effect yet.
    function test_acceptVersion_ofTheVersionThatWaits_isRefused() public {
        uint32 waiting = _publish(_weights(4000, 4000, 2000));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionNotEffective.selector, id, waiting));
        vault.acceptVersion(id, waiting);
        _accept(1);
    }

    function test_acceptVersion_isTheOwners() public {
        address[3] memory callers = [stranger, keeper, creator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.acceptVersion(id, 1);
        }
    }

    /// Accepting another portfolio is following it instead: the first is announced as left.
    function test_acceptVersion_ofAnotherPortfolio_leavesTheFirst() public {
        _accept(1);
        vm.prank(stranger);
        bytes32 other = registry.create(keccak256("other"), _weights(3000, 3000, 4000), META, 0, 0);
        vm.expectEmit(address(vault));
        emit IBasketVault.Unfollowed(address(vault), id);
        vm.expectEmit(address(vault));
        emit IBasketVault.Followed(address(vault), other, 1);
        vm.prank(owner);
        vault.acceptVersion(other, 1);
        (bytes32 followed,,) = vault.following();
        assertEq(followed, other);
    }

    /// Paused, the owner's accept still works: it is not a keeper path.
    function test_acceptVersion_worksWhileTheKeeperIsPaused() public {
        vm.prank(guardian);
        factory.pauseKeeper();
        _accept(1);
    }

    /// An asset a version drops stays as a target of zero while the vault holds it, so the keeper can sell
    /// it; one it holds nothing of goes.
    function test_acceptVersion_keepsWhatTheVersionDropsWhileItIsHeld() public {
        _accept(1);
        _ownerBuys(address(stockC), 1000 * USD);
        // A held asset the version keeps is there once, at the version's weight.
        _ownerBuys(address(stockA), 1000 * USD);
        // Version 2 swaps C for D: 20% out and 20% in, a turnover of 20%.
        Weight[] memory four = new Weight[](4);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        four[0] = Weight(address(stockA), 5000);
        four[1] = Weight(address(stockB), 3000);
        four[2] = Weight(address(stockD), 2000);
        four[3] = Weight(address(stockC), 0);
        Weight[] memory v2 = new Weight[](3);
        (v2[0], v2[1], v2[2]) = (four[0], four[1], four[2]);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _refresh();
        _accept(2);
        _assertTargets(_sort(four));

        // Sold, the leftover goes at the next version the owner takes.
        Swap memory sale = _sell(direct, address(stockC), stockC.balanceOf(address(vault)), 0);
        vm.prank(owner);
        vault.ownerSwap(_swaps(sale), LATER);
        vm.prank(owner);
        vault.setTargets(new Weight[](0));
        _accept(2);
        _assertTargets(_sort(v2));
    }

    /// `n` new listed tokens, sorted, at `bps` each, `held` of each in the vault.
    function _tokens(uint256 n, uint16 bps, uint256 held) internal returns (Weight[] memory list) {
        list = new Weight[](n);
        for (uint256 i; i < n; ++i) {
            BackdoorToken t = new BackdoorToken(dec);
            _list(address(t), dec);
            if (held != 0) t.mint(address(vault), held);
            list[i] = Weight(address(t), bps);
        }
        return _sort(list);
    }

    /// A version and the assets it drops that are still held must fit 24 targets, 16 of them above zero: past
    /// that, the owner sells first.
    function test_acceptVersion_moreThan24Lines_isRefused() public {
        Weight[] memory own = _tokens(16, 100, unit);
        vm.prank(owner);
        vault.setTargets(own);
        Weight[] memory other = _tokens(16, 600, 0);
        vm.prank(creator);
        bytes32 big = registry.create(keccak256("big"), other, META, 0, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.InvalidTargets.selector, 1));
        vault.acceptVersion(big, 1);
        // Three assets beside the sixteen held: 19 lines, room enough.
        vm.prank(owner);
        vault.acceptVersion(id, 1);
        assertEq(vault.targets().length, 19);
    }

    /// The case the second rules opened (SHARED-RULES-V2): a sixteen-asset portfolio swaps one asset. The
    /// follower still holds the one dropped, which stays as a target of zero beside the sixteen, and the vault
    /// takes the version; a later version that only moves weights is adopted with the leftover still there.
    function test_sixteenAssets_aSwapWithTheDroppedAssetHeld_isTaken() public {
        Weight[] memory sixteen = _tokens(16, 600, unit);
        vm.prank(creator);
        bytes32 big = registry.create(keccak256("big"), sixteen, META, 0, 0);
        vm.prank(owner);
        vault.acceptVersion(big, 1);
        assertEq(vault.targets().length, 16);

        // Swap the first asset for a new one, 6% moved each way: 12%.
        Weight[] memory swapped = new Weight[](16);
        Weight[] memory fresh = _tokens(1, 600, 0);
        swapped[0] = fresh[0];
        for (uint256 i = 1; i < 16; ++i) {
            swapped[i] = sixteen[i];
        }
        swapped = _sort(swapped);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(creator);
        registry.publish(big, swapped, META);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(owner);
        vault.acceptVersion(big, 2);
        Weight[] memory held = vault.targets();
        assertEq(held.length, 17, "sixteen, and the dropped asset at zero");
        (bool found, uint16 bps) = _targetOf(sixteen[0].token);
        assertTrue(found);
        assertEq(bps, 0);

        // Only weights move: the auto-follow vault adopts it, the leftover still held.
        vm.prank(owner);
        vault.setAutoFollow(true);
        for (uint256 i; i < 16; ++i) {
            swapped[i].bps = i < 8 ? 650 : 550;
        }
        vm.prank(creator);
        registry.publish(big, swapped, META);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vault.adoptVersion();
        assertEq(vault.targets().length, 17);
    }

    /// An adopt never adds a line, so it cannot pass 24: it takes no new asset (`NewAssetNeedsOwner`; the
    /// owner's accept is held to 24), and a version that drops an asset the vault holds turns that line to
    /// zero in place. A vault at 24 (sixteen followed, eight of its own still held at zero) stays at 24.
    function test_adoptVersion_atTwentyFourLines_addsNone() public {
        Weight[] memory own = _tokens(8, 100, unit);
        vm.prank(owner);
        vault.setTargets(own);
        Weight[] memory sixteen = _tokens(16, 600, unit);
        vm.prank(creator);
        bytes32 big = registry.create(keccak256("big"), sixteen, META, 0, 0);
        vm.prank(owner);
        vault.acceptVersion(big, 1);
        assertEq(vault.targets().length, 24, "sixteen, and the eight of its own at zero");
        vm.prank(owner);
        vault.setAutoFollow(true);

        // A new asset in place of the first: the adopt refuses it, and the targets stay as they were.
        Weight[] memory swapped = new Weight[](16);
        address fresh = _tokens(1, 600, 0)[0].token;
        swapped[0] = Weight(fresh, 600);
        for (uint256 i = 1; i < 16; ++i) {
            swapped[i] = sixteen[i];
        }
        swapped = _sort(swapped);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(creator);
        registry.publish(big, swapped, META);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NewAssetNeedsOwner.selector, fresh));
        vault.adoptVersion();
        assertEq(vault.targets().length, 24, "nothing changed");

        // The first asset dropped for cash, still held: adopted, its line at zero, 24 lines still.
        Weight[] memory fifteen = new Weight[](15);
        for (uint256 i = 1; i < 16; ++i) {
            fifteen[i - 1] = sixteen[i];
        }
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(creator);
        registry.publish(big, fifteen, META);
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vault.adoptVersion();
        assertEq(vault.targets().length, 24);
        (bool found, uint16 bps) = _targetOf(sixteen[0].token);
        assertTrue(found);
        assertEq(bps, 0);
    }

    // ---- auto-follow

    function test_setAutoFollow_isTheOwnersSwitch() public {
        vm.expectEmit(address(vault));
        emit IBasketVault.AutoFollowSet(address(vault), false);
        vm.prank(owner);
        vault.setAutoFollow(false);
        (,, bool on) = vault.following();
        assertFalse(on);

        address[3] memory callers = [stranger, keeper, guardian];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(IBasketVault.NotOwner.selector, callers[i]));
            vault.setAutoFollow(true);
        }
    }

    // ---- adopt

    function test_adoptVersion_takesAVersionThatOnlyChangesWeights() public {
        _accept(1);
        _publish(_weights(4000, 4000, 2000));
        // Waiting is not in effect.
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionNotEffective.selector, id, 1));
        vault.adoptVersion();

        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectEmit(address(vault));
        emit IBasketVault.VersionAdopted(address(vault), id, 2);
        vm.prank(stranger);
        vault.adoptVersion();
        _assertTargets(_weights(4000, 4000, 2000));
        (, uint32 version,) = vault.following();
        assertEq(version, 2);

        // Nothing newer: refused again.
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.VersionNotEffective.selector, id, 2));
        vault.adoptVersion();
    }

    /// A14: a version with an asset the owner never accepted waits for the owner.
    function test_A14_aNewAsset_needsTheOwner() public {
        _accept(1);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        Weight[] memory v2 = new Weight[](3);
        v2[0] = Weight(address(stockA), 5000);
        v2[1] = Weight(address(stockB), 3000);
        v2[2] = Weight(address(stockD), 2000);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NewAssetNeedsOwner.selector, address(stockD)));
        vault.adoptVersion();
        _accept(2);
    }

    /// A14: an asset a version dropped is held at a target of zero and is no longer accepted. A version
    /// that brings it back waits for the owner.
    function test_A14_anAssetDroppedEarlier_needsTheOwnerToComeBack() public {
        _accept(1);
        _ownerBuys(address(stockC), 1000 * USD);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        Weight[] memory v2 = new Weight[](3);
        v2[0] = Weight(address(stockA), 5000);
        v2[1] = Weight(address(stockB), 3000);
        v2[2] = Weight(address(stockD), 2000);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _accept(2);
        (bool found, uint16 bps) = _targetOf(address(stockC));
        assertTrue(found);
        assertEq(bps, 0);

        _publish(_threeStocks());
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.NewAssetNeedsOwner.selector, address(stockC)));
        vault.adoptVersion();
    }

    /// The keeper sells what a version dropped.
    function test_adoptVersion_theKeeperSellsWhatTheVersionDropped() public {
        _accept(1);
        _ownerBuys(address(stockC), 1000 * USD);
        BackdoorToken stockD = new BackdoorToken(dec);
        _list(address(stockD), dec);
        Weight[] memory v2 = new Weight[](3);
        v2[0] = Weight(address(stockA), 5000);
        v2[1] = Weight(address(stockB), 3000);
        v2[2] = Weight(address(stockD), 2000);
        _publish(_sort(v2));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        _accept(2);
        _refresh();
        _keeperSwap(_sell(direct, address(stockC), stockC.balanceOf(address(vault)), 0));
        assertEq(stockC.balanceOf(address(vault)), 0);
    }

    function test_adoptVersion_autoFollowOff_isRefused() public {
        _accept(1);
        vm.prank(owner);
        vault.setAutoFollow(false);
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.AutoFollowOff.selector));
        vault.adoptVersion();
    }

    /// Adopt is a keeper path: the guardian's pause stops it. The owner's accept is never stopped.
    function test_adoptVersion_paused_isRefused() public {
        _accept(1);
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        vm.prank(guardian);
        factory.pauseKeeper();
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.KeeperPaused.selector));
        vault.adoptVersion();
        _accept(2);
    }

    function test_adoptVersion_aVaultThatFollowsNothing_isRefused() public {
        vm.expectRevert(abi.encodeWithSelector(IBasketVault.IndexNotFound.selector, bytes32(0)));
        vault.adoptVersion();
    }

    /// A vault created following a portfolio, with auto-follow on from the start, adopts the next version.
    function test_createVault_followingWithAutoFollow_adopts() public {
        vm.prank(owner);
        BasketVault made =
            BasketVault(payable(factory.createVault(keccak256("plan-follow"), new Weight[](0), id, 1, true)));
        (bytes32 followed, uint32 version, bool on) = made.following();
        assertEq(followed, id);
        assertEq(version, 1);
        assertTrue(on);
        _publish(_weights(4000, 4000, 2000));
        vm.warp(block.timestamp + PUBLISH_DELAY);
        made.adoptVersion();
        (, version,) = made.following();
        assertEq(version, 2);
    }

    // ---- a portfolio that holds cash (gate SHARED-RULES-V2)

    /// A shared portfolio may leave part of itself in cash. A vault that follows it takes the weights as they
    /// are, its snapshot gives the cash what they leave, and the keeper buys up to the weights and no
    /// further: the rest stays cash.
    function test_followingAPortfolioWithCash_theKeeperLeavesTheCash() public {
        Weight[] memory seventy = new Weight[](1);
        seventy[0] = Weight(address(stockA), 7000);
        vm.prank(creator);
        bytes32 withCash = registry.create(keccak256("with-cash"), seventy, META, 0, 0);
        vm.prank(owner);
        vault.acceptVersion(withCash, 1);
        _assertTargets(seventy);
        Snapshot memory snap = vault.snapshot();
        assertEq(snap.tokens.length, 2);
        assertEq(snap.tokens[1], address(cash));
        assertEq(snap.targetBps[1], 3000, "what the weights leave is the cash's");

        _keeperSwap(_buy(direct, address(stockA), 6950 * USD, 0));
        assertEq(_weightOf(address(stockA)), 6950);
        vm.warp(block.timestamp + 3600);
        _refresh();
        _expectKeeperRevert(
            _buy(direct, address(stockA), 600 * USD, 0),
            abi.encodeWithSelector(IBasketVault.PastTarget.selector, address(stockA))
        );
        assertEq(cash.balanceOf(address(vault)), START - 6950 * USD);
    }
}
