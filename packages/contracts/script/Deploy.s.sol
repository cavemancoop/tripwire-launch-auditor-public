// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {CommitRegistry} from "../src/CommitRegistry.sol";

/// @notice Deploy CommitRegistry to Robinhood Chain (4663).
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast
/// Requires GAS_WALLET_PRIVATE_KEY in the environment. The gas wallet is the
/// contract owner (it is what will post commit transactions).
contract Deploy is Script {
    function run() external returns (CommitRegistry reg) {
        // tolerate a private key stored with or without the 0x prefix
        string memory raw = vm.envString("GAS_WALLET_PRIVATE_KEY");
        if (bytes(raw).length == 64) raw = string.concat("0x", raw);
        uint256 pk = vm.parseUint(raw);
        address deployer = vm.addr(pk);
        console.log("chain id     ", block.chainid);
        console.log("deployer/owner", deployer);
        console.log("deployer bal  ", deployer.balance);

        vm.startBroadcast(pk);
        reg = new CommitRegistry(deployer);
        vm.stopBroadcast();

        console.log("CommitRegistry", address(reg));
        console.log("-> set COMMIT_REGISTRY_ADDRESS in .env");
    }
}
