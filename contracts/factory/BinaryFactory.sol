// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../libs/oz/IERC20.sol";
import {IKasOracle} from "../interfaces/IKasOracle.sol";
import {BinaryMarket} from "../market/BinaryMarket.sol";
import {FactoryBase} from "./FactoryBase.sol";

contract BinaryFactory is FactoryBase {
    event BinaryCreated(address market, bytes32 questionId);

    constructor(address _owner, address _feeSink, uint256 _defaultRedeemFeeBps)
        FactoryBase(_owner, _feeSink, _defaultRedeemFeeBps) {}

    function createBinary(
        IERC20 collateral,
        IKasOracle oracle,
        bytes32 questionId,
        string calldata marketName
    ) external onlyOwner returns (BinaryMarket mkt) {
        mkt = new BinaryMarket(collateral, oracle, questionId, feeSink, defaultRedeemFeeBps, marketName);
        emit BinaryCreated(address(mkt), questionId);
    }
}
