// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {SafeERC20} from "../libs/oz/SafeERC20.sol";
import {MarketBase} from "./MarketBase.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";

contract CategoricalMarket is MarketBase {
    using SafeERC20 for IERC20;

    uint8 public immutable outcomeCount;
    OutcomeToken[] public outcomeTokens;

    uint256 public collateralLocked;
    uint8 public winner; // index of winning outcome

    event Split(address indexed user, uint256 collateralIn);
    event Merge(address indexed user, uint256 setsBurned);

    constructor(
        IERC20 _collateral,
        IKasOracle _oracle,
        bytes32 _questionId,
        address _feeSink,
        uint256 _redeemFeeBps,
        string memory marketName,
        uint8 _outcomeCount,
        string[] memory outcomeNames
    )
        MarketBase(_collateral, _oracle, _questionId, MarketType.CATEGORICAL, _feeSink, _redeemFeeBps)
    {
        require(_outcomeCount >= 2 && _outcomeCount <= 32, "bad count");
        require(outcomeNames.length == _outcomeCount, "names mismatch");
        outcomeCount = _outcomeCount;
        outcomeTokens = new OutcomeToken[](_outcomeCount);
        for (uint8 i = 0; i < _outcomeCount; i++) {
            outcomeTokens[i] = new OutcomeToken(
                string(abi.encodePacked(marketName, " #", _toString(i), " ", outcomeNames[i])),
                outcomeNames[i],
                address(this)
            );
        }
    }

    function _toString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory buf;
        uint256 tmp = v;
        while (tmp > 0) { buf = abi.encodePacked(bytes1(uint8(48 + tmp % 10)), buf); tmp /= 10; }
        return string(buf);
    }

    /* ##########    Pre-resolution mechanics    ########## */
    function split(uint256 amount) external onlyOpen {
        require(amount > 0, "amount=0");
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        collateralLocked += amount;
        for (uint8 i = 0; i < outcomeCount; i++) {
            outcomeTokens[i].mint(msg.sender, amount);
        }
        emit Split(msg.sender, amount);
    }

    function merge(uint256 sets) external onlyOpen {
        require(sets > 0, "sets=0");
        for (uint8 i = 0; i < outcomeCount; i++) {
            outcomeTokens[i].burn(msg.sender, sets);
        }
        collateralLocked -= sets;
        collateral.safeTransfer(msg.sender, sets);
        emit Merge(msg.sender, sets);
    }

    /* ##########    Finalization & redemption    ########## */

    function _validateAndStoreAnswer(bytes memory oracleEncoded) internal override {
        uint256 idx = abi.decode(oracleEncoded, (uint256));
        require(idx < outcomeCount, "winner oob");
        winner = uint8(idx);
        resolvedAnswer = oracleEncoded;
    }

    function redeem(uint256 amount) external returns (uint256 netOut) {
        if (!isResolved()) finalizeFromOracle();
        require(amount > 0, "amount=0");

        outcomeTokens[winner].burn(msg.sender, amount);

        require(collateralLocked >= amount, "insufficient pool");
        collateralLocked -= amount;
        netOut = _payout(msg.sender, amount);
        emit Redeemed(msg.sender, netOut, abi.encode(winner, amount));
    }

    function tokens(uint8 idx) external view returns (OutcomeToken) {
        return outcomeTokens[idx];
    }
}