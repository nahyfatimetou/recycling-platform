// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ECO reward token. Only the configured RecyclingRegistry may mint.
contract EcoToken is ERC20, Ownable {
    address public minter;
    event MinterConfigured(address indexed minter);

    constructor(address initialOwner) ERC20("EcoToken", "ECO") Ownable(initialOwner) {}

    /// @dev One-time setup: prevents replacing the registry after deployment.
    function setMinter(address registry) external onlyOwner {
        require(minter == address(0), "Minter already configured");
        require(registry != address(0), "Invalid minter");
        minter = registry;
        emit MinterConfigured(registry);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter && minter != address(0), "Only registry can mint");
        _mint(to, amount);
    }
}
