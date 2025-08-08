// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";
import {CategoricalMarket} from "../market/CategoricalMarket.sol";
import {FactoryBase} from "./FactoryBase.sol";

contract CategoricalFactory is FactoryBase {
    event CategoricalCreated(address market, bytes32 questionId);

    constructor(address _owner, address _feeSink, uint256 _defaultRedeemFeeBps)
        FactoryBase(_owner, _feeSink, _defaultRedeemFeeBps) {}

    function createCategorical(
        IERC20 collateral,
        IKasOracle oracle,
        bytes32 questionId,
        string calldata marketName,
        uint8 numOutcomes,
        string[] calldata outcomeNames
    ) external onlyOwner returns (CategoricalMarket mkt) {
        mkt = new CategoricalMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName, numOutcomes, outcomeNames);
        emit CategoricalCreated(address(mkt), questionId);
    }
}
