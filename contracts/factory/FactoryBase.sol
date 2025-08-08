// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step} from "../libs/oz/Ownable2Step.sol";

abstract contract FactoryBase is Ownable2Step {
    address public immutable feeSink;
    uint256 public defaultRedeemFeeBps; // applies to markets at deployment

    event DefaultRedeemFeeUpdated(uint256 bps);

    constructor(address _owner, address _feeSink, uint256 _defaultRedeemFeeBps) Ownable2Step(_owner) {
        require(_feeSink != address(0), "feeSink=0");
        feeSink = _feeSink;
        defaultRedeemFeeBps = _defaultRedeemFeeBps;
        // owner set via Ownable2Step constructor
    }

    function setDefaultRedeemFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 2_000, "fee too high"); // max 20%
        defaultRedeemFeeBps = bps;
        emit DefaultRedeemFeeUpdated(bps);
    }
}
