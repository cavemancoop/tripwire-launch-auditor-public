// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CommitRegistry
/// @notice Timestamps Merkle roots of Launch Auditor report hashes on chain,
///         plus the hashes of the frozen artifacts (weights, feature code,
///         outcome rule text, scorer, model id). All data lives in event logs;
///         the off-chain service keeps the leaves and proofs (spec §6).
/// @dev Owner-gated. The owner is the "gas wallet" that posts commits; it can be
///      rotated. No funds are ever held here.
contract CommitRegistry {
    address public owner;

    /// @notice number of report batches committed so far
    uint256 public batchCount;

    event BatchCommitted(
        uint256 indexed batchId,
        bytes32 merkleRoot,
        uint256 leafCount,
        uint256 timestamp
    );

    /// @param kind e.g. keccak256("weights"), keccak256("feature_code"),
    ///             keccak256("outcome_rule"), keccak256("scorer"), keccak256("model_id")
    event ArtifactCommitted(bytes32 indexed kind, bytes32 hash, uint256 timestamp);

    event OwnerRotated(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        owner = initialOwner == address(0) ? msg.sender : initialOwner;
        emit OwnerRotated(address(0), owner);
    }

    /// @notice Commit a Merkle root of report hashes.
    /// @return batchId monotonically increasing id for this batch
    function commitBatch(bytes32 merkleRoot, uint256 leafCount)
        external
        onlyOwner
        returns (uint256 batchId)
    {
        batchId = batchCount;
        unchecked {
            batchCount = batchId + 1;
        }
        emit BatchCommitted(batchId, merkleRoot, leafCount, block.timestamp);
    }

    /// @notice Commit the hash of a frozen artifact (once, on first run).
    function commitArtifact(bytes32 kind, bytes32 hash) external onlyOwner {
        emit ArtifactCommitted(kind, hash, block.timestamp);
    }

    /// @notice Hand the owner role (the commit signer) to a new address.
    function rotateOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerRotated(owner, newOwner);
        owner = newOwner;
    }
}
