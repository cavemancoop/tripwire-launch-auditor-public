// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommitRegistry} from "../src/CommitRegistry.sol";

contract CommitRegistryTest is Test {
    CommitRegistry reg;
    address owner = address(0xA11CE);
    address stranger = address(0xB0B);

    event BatchCommitted(uint256 indexed batchId, bytes32 merkleRoot, uint256 leafCount, uint256 timestamp);
    event ArtifactCommitted(bytes32 indexed kind, bytes32 hash, uint256 timestamp);
    event OwnerRotated(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        reg = new CommitRegistry(owner);
    }

    function test_constructor_setsOwner() public view {
        assertEq(reg.owner(), owner);
        assertEq(reg.batchCount(), 0);
    }

    function test_constructor_zeroOwnerDefaultsToDeployer() public {
        CommitRegistry r = new CommitRegistry(address(0));
        assertEq(r.owner(), address(this));
    }

    function test_commitBatch_incrementsAndEmits() public {
        bytes32 root = keccak256("root-0");
        vm.expectEmit(true, false, false, true);
        emit BatchCommitted(0, root, 42, block.timestamp);
        vm.prank(owner);
        uint256 id = reg.commitBatch(root, 42);
        assertEq(id, 0);
        assertEq(reg.batchCount(), 1);

        vm.prank(owner);
        uint256 id2 = reg.commitBatch(keccak256("root-1"), 7);
        assertEq(id2, 1);
        assertEq(reg.batchCount(), 2);
    }

    function test_commitBatch_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CommitRegistry.NotOwner.selector);
        reg.commitBatch(bytes32(0), 1);
    }

    function test_commitArtifact_emits() public {
        bytes32 kind = keccak256("weights");
        bytes32 h = keccak256("det_v0.json bytes");
        vm.expectEmit(true, false, false, true);
        emit ArtifactCommitted(kind, h, block.timestamp);
        vm.prank(owner);
        reg.commitArtifact(kind, h);
    }

    function test_commitArtifact_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CommitRegistry.NotOwner.selector);
        reg.commitArtifact(bytes32(0), bytes32(0));
    }

    function test_rotateOwner() public {
        address next = address(0xC0FFEE);
        vm.expectEmit(true, true, false, false);
        emit OwnerRotated(owner, next);
        vm.prank(owner);
        reg.rotateOwner(next);
        assertEq(reg.owner(), next);

        // old owner can no longer commit
        vm.prank(owner);
        vm.expectRevert(CommitRegistry.NotOwner.selector);
        reg.commitBatch(bytes32(0), 1);

        // new owner can
        vm.prank(next);
        reg.commitBatch(keccak256("x"), 1);
    }

    function test_rotateOwner_rejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(CommitRegistry.ZeroAddress.selector);
        reg.rotateOwner(address(0));
    }

    function testFuzz_commitBatch_idsAreSequential(uint8 n) public {
        vm.assume(n > 0 && n <= 50);
        for (uint256 i = 0; i < n; i++) {
            vm.prank(owner);
            uint256 id = reg.commitBatch(keccak256(abi.encode(i)), i);
            assertEq(id, i);
        }
        assertEq(reg.batchCount(), n);
    }
}
