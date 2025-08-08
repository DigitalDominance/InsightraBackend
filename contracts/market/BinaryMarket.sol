// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {SafeERC20} from "../libs/oz/SafeERC20.sol";
import {MarketBase} from "./MarketBase.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";

contract BinaryMarket is MarketBase {
    using SafeERC20 for IERC20;

    OutcomeToken public immutable yesToken;
    OutcomeToken public immutable noToken;

    // Total collateral locked by splitters (complete sets minted - redeemed)
    uint256 public collateralLocked;

    event Split(address indexed user, uint256 collateralIn);
    event Merge(address indexed user, uint256 setsBurned);

    constructor(
        IERC20 _collateral,
        IKasOracle _oracle,
        bytes32 _questionId,
        address _feeSink,
        uint256 _redeemFeeBps,
        string memory marketName
    )
        MarketBase(_collateral, _oracle, _questionId, MarketType.BINARY, _feeSink, _redeemFeeBps)
    {
        yesToken = new OutcomeToken(string(abi.encodePacked(marketName, " YES")), "YES", address(this));
        noToken  = new OutcomeToken(string(abi.encodePacked(marketName, " NO")), "NO", address(this));
    }

    /* ##########    Pre-resolution mechanics (split/merge)    ########## */

    /// @notice Lock `amount` collateral to mint 1 YES and 1 NO per unit
    function split(uint256 amount) external onlyOpen {
        require(amount > 0, "amount=0");
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        collateralLocked += amount;
        yesToken.mint(msg.sender, amount);
        noToken.mint(msg.sender, amount);
        emit Split(msg.sender, amount);
    }

    /// @notice Burn complete sets to retrieve collateral 1:1 pre-resolution
    function merge(uint256 sets) external onlyOpen {
        require(sets > 0, "sets=0");
        yesToken.burn(msg.sender, sets);
        noToken.burn(msg.sender, sets);
        collateralLocked -= sets;
        collateral.safeTransfer(msg.sender, sets);
        emit Merge(msg.sender, sets);
    }

    /* ##########    Finalization & redemption    ########## */

    bool public outcomeYes; // stored winning outcome

    function _validateAndStoreAnswer(bytes memory oracleEncoded) internal override {
        // decode bool
        bool value = abi.decode(oracleEncoded, (bool));
        outcomeYes = value;
        resolvedAnswer = oracleEncoded;
    }

    /// @notice Redeem winning tokens after resolution (anyone can call finalize first)
    function redeem(uint256 amount) external returns (uint256 netOut) {
        if (!isResolved()) finalizeFromOracle();
        require(amount > 0, "amount=0");

        if (outcomeYes) {
            yesToken.burn(msg.sender, amount);
        } else {
            noToken.burn(msg.sender, amount);
        }

        // each winning token pays 1 collateral (less fee)
        require(collateralLocked >= amount, "insufficient pool");
        collateralLocked -= amount;
        netOut = _payout(msg.sender, amount);
        emit Redeemed(msg.sender, netOut, abi.encode(outcomeYes, amount));
    }
}