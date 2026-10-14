// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AddAssets} from "../../script/AddAssets.s.sol";
import {IVaultConfig} from "../../src/interfaces/IVaultConfig.sol";

/// The tokens `script/config/4663-assets-2.json` adds, against the factory deployed on Robinhood Chain
/// mainnet on 2026-10-12 and its real timelock and Safe: the Safe schedules the batch, cannot run it before
/// the delay, runs it after, and then every token is listed as the file says and a vault trades each one in
/// its own pool within the bound to its feed (`AddAssets.check`).
///
/// Opt-in, like the other fork tests: skipped unless `RH_FORK_URL` is set. It forks the chain's head, or
/// `RH_ADD_FORK_BLOCK` when that is set (the factory exists from block 86,877,019). It sends nothing.
contract RobinhoodForkAddAssetsTest is Test {
    AddAssets internal script;
    bool internal forked;

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
        uint256 forkBlock = vm.envOr("RH_ADD_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, forkBlock);
        script = new AddAssets();
    }

    function test_fork_theSafeSchedules_waits_executes_andEveryTokenTradesWithinTheBound() public onFork {
        // Reading the file in Solidity costs more gas than a block of this chain holds: only the Safe's two
        // calls are metered, and each must fit in one transaction.
        vm.pauseGasMetering();
        AddAssets.File memory f = script.readFile("script/config/4663-assets-2.json");
        script.checkFile(f);
        TimelockController timelock = TimelockController(payable(f.timelock));
        uint256 delay = timelock.getMinDelay();
        assertEq(delay, 172_800, "the timelock waits 48 hours");
        for (uint256 i; i < f.assets.length; ++i) {
            assertFalse(IVaultConfig(f.factory).isAsset(f.assets[i].token), "not listed before");
        }

        // The Safe's first transaction: exactly the bytes the Safe file carries.
        bytes memory schedule = script.scheduleCalldata(f, delay);
        vm.prank(f.safe);
        vm.resumeGasMetering();
        uint256 before = gasleft();
        (bool ok,) = f.timelock.call(schedule);
        uint256 used = before - gasleft();
        vm.pauseGasMetering();
        assertTrue(ok, "the Safe schedules the batch");
        emit log_named_uint("gas, the schedule", used);
        assertLt(used, 10_000_000, "the schedule fits in a transaction");

        // Nobody else can run it, and the Safe cannot run it early.
        bytes memory execute = script.executeCalldata(f);
        vm.prank(makeAddr("stranger"));
        (ok,) = f.timelock.call(execute);
        assertFalse(ok, "a stranger cannot execute");
        vm.warp(block.timestamp + delay - 1);
        vm.prank(f.safe);
        (ok,) = f.timelock.call(execute);
        assertFalse(ok, "the Safe cannot execute a second early");
        for (uint256 i; i < f.assets.length; ++i) {
            assertFalse(IVaultConfig(f.factory).isAsset(f.assets[i].token), "still not listed");
        }

        // The second transaction, once the 48 hours have passed.
        vm.warp(block.timestamp + 1);
        vm.prank(f.safe);
        vm.resumeGasMetering();
        before = gasleft();
        (ok,) = f.timelock.call(execute);
        used = before - gasleft();
        vm.pauseGasMetering();
        assertTrue(ok, "the Safe executes the batch after the delay");
        emit log_named_uint("gas, the execute", used);
        assertLt(used, 10_000_000, "the execute fits in a transaction");

        script.check();
    }

    function test_fork_theFileRefusesAToken_alreadyListed() public onFork {
        vm.pauseGasMetering();
        AddAssets.File memory f = script.readFile("script/config/4663-assets-2.json");
        // NVDA, listed by the deploy.
        f.assets[0].token = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
        vm.expectRevert();
        script.checkFile(f);
    }
}
