// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./EcoToken.sol";

/// @notice One reward per declaration key. The owner is the backend operator account.
contract RecyclingRegistry is Ownable {
    EcoToken public immutable ecoToken;
    mapping(bytes32 => bool) public processedDeclarations;

    event Rewarded(bytes32 indexed declarationId, address indexed beneficiary, uint256 amount);

    constructor(address tokenAddress, address admin) Ownable(admin) {
        require(tokenAddress != address(0), "Invalid token");
        ecoToken = EcoToken(tokenAddress);
    }

    function reward(bytes32 declarationId, address beneficiary, uint256 amount) external onlyOwner {
        require(declarationId != bytes32(0), "Invalid declaration id");
        require(!processedDeclarations[declarationId], "Already processed");
        require(beneficiary != address(0), "Invalid beneficiary");
        require(amount > 0, "Amount must be positive");

        // Mark before external call; transaction rollback restores state if mint reverts.
        processedDeclarations[declarationId] = true;
        ecoToken.mint(beneficiary, amount);
        emit Rewarded(declarationId, beneficiary, amount);
    }

    function isProcessed(bytes32 declarationId) external view returns (bool) {
        return processedDeclarations[declarationId];
    }
}
