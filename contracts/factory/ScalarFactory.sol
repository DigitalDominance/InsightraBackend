// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";
import {ScalarMarket} from "../market/ScalarMarket.sol";
import {FactoryBase} from "./FactoryBase.sol";

contract ScalarFactory is FactoryBase {
    event ScalarCreated(address market, bytes32 questionId);

    constructor(address _owner, address _feeSink, IERC20 _bondToken, uint256 _creationFee, uint256 _defaultRedeemFeeBps)
        FactoryBase(_owner, _feeSink, _bondToken, _creationFee, _defaultRedeemFeeBps) {}

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
        _registerMarket(address(mkt));
        emit ScalarCreated(address(mkt), questionId);
    }

/// @notice Public user-submitted market creation (requires paying the creation fee in bondToken)
function submitScalar(
    IERC20 collateral,
    IKasOracle oracle,
    bytes32 questionId,
    string calldata marketName,
    int256 scalarMin,
    int256 scalarMax,
    uint32 scalarDecimals
) external returns (ScalarMarket mkt) {
    _collectCreationFee();
    mkt = new ScalarMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName, scalarMin, scalarMax, scalarDecimals);
    _registerMarket(address(mkt));
    emit ScalarCreated(address(mkt), questionId);
}

}
