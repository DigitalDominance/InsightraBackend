// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {SafeERC20} from "../libs/oz/SafeERC20.sol";
import {ReentrancyGuard} from "../libs/oz/ReentrancyGuard.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";

abstract contract MarketBase is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum MarketType { BINARY, CATEGORICAL, SCALAR }
    enum MarketStatus { OPEN, RESOLVED, CANCELLED }

    IERC20 public immutable collateral;
    IKasOracle public immutable oracle;
    bytes32 public immutable questionId;
    MarketType public immutable marketType;

    address public immutable feeSink;
    uint256 public immutable redeemFeeBps; // e.g., 100 = 1%
    uint256 public constant BPS = 10_000;

    MarketStatus public status;
    bytes public resolvedAnswer; // ABI-encoded per market type
    uint256 public resolvedAt;

    event Finalized(bytes32 indexed questionId, bytes encodedOutcome);
    event Cancelled(bytes32 indexed questionId);
    event Redeemed(address indexed user, uint256 collateralOut, bytes meta);

    error NotOpen();
    error AlreadyResolved();
    error OracleNotFinal();
    error BadAmount();
    error InvalidOutcome();

    constructor(
        IERC20 _collateral,
        IKasOracle _oracle,
        bytes32 _questionId,
        MarketType _mType,
        address _feeSink,
        uint256 _redeemFeeBps
    ) {
        require(address(_collateral) != address(0), "collateral=0");
        require(address(_oracle) != address(0), "oracle=0");
        require(_feeSink != address(0), "feeSink=0");
        require(_redeemFeeBps <= 1000, "fee>10%");

        collateral = _collateral;
        oracle = _oracle;
        questionId = _questionId;
        marketType = _mType;
        feeSink = _feeSink;
        redeemFeeBps = _redeemFeeBps;
        status = MarketStatus.OPEN;
    }

    modifier onlyOpen() {
        if (status != MarketStatus.OPEN) revert NotOpen();
        _;
    }

    function isResolved() public view returns (bool) {
        return status == MarketStatus.RESOLVED;
    }

    /// @notice Anyone can finalize after the oracle is FINALIZED/ARBITRATED.
    function finalizeFromOracle() public nonReentrant onlyOpen {
        IKasOracle.Status s = oracle.getStatus(questionId);
        require(s == IKasOracle.Status.FINALIZED || s == IKasOracle.Status.ARBITRATED, "oracle not final");
        IKasOracle.Answer memory ans = oracle.getBestAnswer(questionId);
        _validateAndStoreAnswer(ans.encoded);
        status = MarketStatus.RESOLVED;
        resolvedAt = block.timestamp;
        emit Finalized(questionId, ans.encoded);
    }

    /// @dev child contracts validate and store per-type meta in resolvedAnswer
    function _validateAndStoreAnswer(bytes memory oracleEncoded) internal virtual;

    /// @dev internal helpers for fee and payout
    function _payout(address to, uint256 gross) internal returns (uint256 net) {
        uint256 fee = (gross * redeemFeeBps) / BPS;
        if (fee > 0) {
            collateral.safeTransfer(feeSink, fee);
        }
        net = gross - fee;
        collateral.safeTransfer(to, net);
    }
}
