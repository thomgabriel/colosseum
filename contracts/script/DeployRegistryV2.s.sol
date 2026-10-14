// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {IndexRegistry} from "../src/IndexRegistry.sol";

/// Deploys the registry's second logic (gate SHARED-RULES-V2) where Arachnid's CREATE2 deployer puts it for
/// the salt "SHARED-RULES-V2": an address that depends only on the code, so the Safe's batch names it before
/// it exists, and anyone may deploy it. The logic owns nothing and holds nothing; it changes no registry until
/// the timelock runs `upgradeToAndCall` on the proxy, 48 hours after the Safe schedules it.
///
///   forge script script/DeployRegistryV2.s.sol --rpc-url <4663 node> --sender <any address>
///
/// That is a dry run: it checks the code built here gives the address the batch names, says whether it is
/// there already, and simulates the deploy. Sending is `--broadcast` with a key, and a person does that,
/// never an agent: `scripts/mainnet/deploy-registry-v2.sh` is the command.
contract DeployRegistryV2 is Script {
    /// Arachnid's deterministic deployer: calldata is the salt, then the init code.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant SALT = "SHARED-RULES-V2";
    /// What `upgradeToAndCall` in the Safe's batch names.
    address internal constant EXPECTED = 0x3200F7b8F56590F41D3F2fD9448F706A04bF3129;

    error Refused(string why);

    function run() external {
        require(block.chainid == 4663, Refused("this is Robinhood Chain mainnet's logic: run it against 4663"));
        require(CREATE2_DEPLOYER.code.length != 0, Refused("no CREATE2 deployer on this chain"));
        bytes memory initCode = type(IndexRegistry).creationCode;
        address at = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, SALT, keccak256(initCode)))))
        );
        console2.log("init code hash");
        console2.logBytes32(keccak256(initCode));
        console2.log("the logic goes to", at);
        require(at == EXPECTED, Refused("the code built here is not the code the Safe's batch names"));

        if (at.code.length != 0) {
            console2.log("already deployed: nothing to send");
        } else {
            vm.startBroadcast();
            (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(SALT, initCode));
            vm.stopBroadcast();
            require(ok && at.code.length != 0, Refused("the CREATE2 deploy failed"));
            console2.log("deployed");
        }

        // The logic answers as the second rules, is a UUPS logic, and cannot be initialised.
        IndexRegistry logic = IndexRegistry(at);
        require(logic.rulesVersion() == 2, Refused("not the second rules"));
        require(logic.proxiableUUID() == ERC1967Utils.IMPLEMENTATION_SLOT, Refused("not a UUPS logic"));
        try logic.initialize(address(1), 172_800) {
            revert Refused("the logic can be initialised");
        } catch {}
        console2.log("checked: rulesVersion 2, UUPS, cannot be initialised");
    }
}
