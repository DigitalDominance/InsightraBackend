// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";
import {BinaryMarket} from "../market/BinaryMarket.sol";
import {FactoryBase} from "./FactoryBase.sol";

contract BinaryFactory is FactoryBase {
    event BinaryCreated(address market, bytes32 questionId);

    constructor(address _owner, address _feeSink, IERC20 _bondToken, uint256 _creationFee, uint256 _defaultRedeemFeeBps)
        FactoryBase(_owner, _feeSink, _bondToken, _creationFee, _defaultRedeemFeeBps) {}

    function createBinary(
        IERC20 collateral,
        IKasOracle oracle,
        bytes32 questionId,
        string calldata marketName
    ) external onlyOwner returns (BinaryMarket mkt) {
        mkt = new BinaryMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName);
        _registerMarket(address(mkt));
        emit BinaryCreated(address(mkt), questionId);
    }

/// @notice Public user-submitted market creation (no local fee; oracle collects the fee via createQuestionPublic)
function submitBinary(
    IERC20 collateral,
    IKasOracle oracle,
    bytes32 questionId,
    string calldata marketName
) external returns (BinaryMarket mkt) {
    // creation fee handled by oracle now (no-op here)
    mkt = new BinaryMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName);
    _registerMarket(address(mkt));
    emit BinaryCreated(address(mkt), questionId);
}

}
