// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "./libs/oz/IERC20.sol";
import {Ownable2Step} from "./libs/oz/Ownable2Step.sol";
import {BinaryMarket} from "./market/BinaryMarket.sol";
import {CategoricalMarket} from "./market/CategoricalMarket.sol";
import {ScalarMarket} from "./market/ScalarMarket.sol";
import {IKasOracle} from "./interfaces/IKasOracle.sol";

contract PredictionMarketFactory is Ownable2Step {
    address public immutable feeSink;
    uint256 public defaultRedeemFeeBps; // applies to markets at deployment

    event BinaryCreated(address market, bytes32 questionId);
    event CategoricalCreated(address market, bytes32 questionId);
    event ScalarCreated(address market, bytes32 questionId);

    error BadFee();

    constructor(address _owner, address _feeSink, uint256 _redeemFeeBps) Ownable2Step(_owner) {
        require(_feeSink != address(0), "feeSink=0");
        require(_redeemFeeBps <= 1000, "fee>10%");
        feeSink = _feeSink;
        defaultRedeemFeeBps = _redeemFeeBps;
    }

    function setDefaultRedeemFee(uint256 bps) external onlyOwner {
        require(bps <= 1000, "fee>10%");
        defaultRedeemFeeBps = bps;
    }

    function createBinary(
        IERC20 collateral,
        IKasOracle oracle,
        bytes32 questionId,
        string calldata marketName
    ) external onlyOwner returns (BinaryMarket mkt) {
        mkt = new BinaryMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName);
        emit BinaryCreated(address(mkt), questionId);
    }

    function createCategorical(
        IERC20 collateral,
        IKasOracle oracle,
        bytes32 questionId,
        string calldata marketName,
        uint8 outcomeCount,
        string[] calldata outcomeNames
    ) external onlyOwner returns (CategoricalMarket mkt) {
        mkt = new CategoricalMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName, outcomeCount, outcomeNames);
        emit CategoricalCreated(address(mkt), questionId);
    }

    function createScalar(
        IERC20 collateral,
        IKasOracle oracle,
        bytes32 questionId,
        string calldata marketName,
        int256 scalarMin,
        int256 scalarMax,
        uint32 scalarDecimals
    ) external onlyOwner returns (ScalarMarket mkt) {
        mkt = new ScalarMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName, scalarMin, scalarMax, scalarDecimals);
        emit ScalarCreated(address(mkt), questionId);
    }
}
