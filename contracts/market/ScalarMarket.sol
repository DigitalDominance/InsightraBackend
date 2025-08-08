// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {SafeERC20} from "../libs/oz/SafeERC20.sol";
import {MarketBase} from "./MarketBase.sol";
import {OutcomeToken} from "./OutcomeToken.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";

/// @notice Scalar market using LONG/SHORT pair; 1 collateral splits to 1 LONG + 1 SHORT
/// Payout after resolution: LONG gets fraction f, SHORT gets (1-f), where
/// f = (resolved - min) / (max - min), clamped to [0,1].
contract ScalarMarket is MarketBase {
    using SafeERC20 for IERC20;

    OutcomeToken public immutable longToken;
    OutcomeToken public immutable shortToken;

    int256 public immutable scalarMin;
    int256 public immutable scalarMax;
    uint32 public immutable scalarDecimals; // purely informational

    uint256 public collateralLocked;
    int256 public resolvedValue;
    uint256 public fNumerator;   // fraction numerator (scaled by 1e18)
    uint256 public constant SCALE = 1e18;

    event Split(address indexed user, uint256 collateralIn);
    event Merge(address indexed user, uint256 setsBurned);

    constructor(
        IERC20 _collateral,
        IKasOracle _oracle,
        bytes32 _questionId,
        address _feeSink,
        uint256 _redeemFeeBps,
        string memory marketName,
        int256 _min,
        int256 _max,
        uint32 _scalarDecimals
    )
        MarketBase(_collateral, _oracle, _questionId, MarketType.SCALAR, _feeSink, _redeemFeeBps)
    {
        require(_min < _max, "bad range");
        scalarMin = _min;
        scalarMax = _max;
        scalarDecimals = _scalarDecimals;
        longToken = new OutcomeToken(string(abi.encodePacked(marketName, " LONG")), "LONG", address(this));
        shortToken = new OutcomeToken(string(abi.encodePacked(marketName, " SHORT")), "SHORT", address(this));
    }

    function split(uint256 amount) external onlyOpen {
        require(amount > 0, "amount=0");
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        collateralLocked += amount;
        longToken.mint(msg.sender, amount);
        shortToken.mint(msg.sender, amount);
        emit Split(msg.sender, amount);
    }

    function merge(uint256 sets) external onlyOpen {
        require(sets > 0, "sets=0");
        longToken.burn(msg.sender, sets);
        shortToken.burn(msg.sender, sets);
        collateralLocked -= sets;
        collateral.safeTransfer(msg.sender, sets);
        emit Merge(msg.sender, sets);
    }

    function _validateAndStoreAnswer(bytes memory oracleEncoded) internal override {
        int256 v = abi.decode(oracleEncoded, (int256));
        // clamp within range to guard minor oracle rounding
        if (v < scalarMin) v = scalarMin;
        if (v > scalarMax) v = scalarMax;
        resolvedValue = v;
        // f = (v - min)/(max-min) scaled by 1e18
        uint256 num = uint256(int256(v - scalarMin));
        uint256 den = uint256(int256(scalarMax - scalarMin));
        fNumerator = (num * SCALE) / den;
        resolvedAnswer = abi.encode(v);
    }

    function redeemLong(uint256 amount) external returns (uint256 netOut) {
        if (!isResolved()) finalizeFromOracle();
        require(amount > 0, "amount=0");
        longToken.burn(msg.sender, amount);
        // payout = amount * f
        uint256 gross = (amount * fNumerator) / SCALE;
        require(collateralLocked >= gross, "insufficient pool");
        collateralLocked -= gross;
        netOut = _payout(msg.sender, gross);
        emit Redeemed(msg.sender, netOut, abi.encode(true, amount));
    }

    function redeemShort(uint256 amount) external returns (uint256 netOut) {
        if (!isResolved()) finalizeFromOracle();
        require(amount > 0, "amount=0");
        shortToken.burn(msg.sender, amount);
        // payout = amount * (1-f)
        uint256 gross = amount - ((amount * fNumerator) / SCALE);
        require(collateralLocked >= gross, "insufficient pool");
        collateralLocked -= gross;
        netOut = _payout(msg.sender, gross);
        emit Redeemed(msg.sender, netOut, abi.encode(false, amount));
    }
}