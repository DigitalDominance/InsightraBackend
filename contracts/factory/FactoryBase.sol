// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step} from "../libs/oz/Ownable2Step.sol";
import {IERC20} from "../libs/oz/IERC20.sol";
import {SafeERC20} from "../libs/oz/SafeERC20.sol";

abstract contract FactoryBase is Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Treasury-like address to receive fees (also used for market redemption fees)
    address public immutable feeSink;

    /// @notice Token required to pay the user creation fee (a.k.a. Bond token)
    IERC20 public immutable bondToken;

    /// @notice Flat fee (in bondToken smallest units) for user-submitted markets (e.g., 100 * 10**decimals)
    uint256 public immutable creationFee;

    /// @notice Default redeem fee in basis points, stored into each market upon deployment
    uint256 public defaultRedeemFeeBps;

    /// @dev Market registry
    mapping(address => bool) public isMarket;
    address[] public allMarkets;
    mapping(address => bool) public isRemoved; // soft-delete flag for listings

    event DefaultRedeemFeeUpdated(uint256 bps);
    event MarketRegistered(address indexed market);
    event ListingRemoved(address indexed market, string reason);
    event ListingRestored(address indexed market);

    constructor(
        address _owner,
        address _feeSink,
        IERC20 _bondToken,
        uint256 _creationFee,
        uint256 _defaultRedeemFeeBps
    ) Ownable2Step(_owner) {
        require(_feeSink != address(0), "feeSink=0");
        require(address(_bondToken) != address(0), "bondToken=0");
        feeSink = _feeSink;
        bondToken = _bondToken;
        creationFee = _creationFee;
        defaultRedeemFeeBps = 0; // enforce zero market redeem fee; oracle charges 2% on finalize
    }

    function setDefaultRedeemFeeBps(uint256 /*bps*/) external onlyOwner { defaultRedeemFeeBps = 0; emit DefaultRedeemFeeUpdated(0); }

    /// @dev internal: collect user creation fee (transfers bond token to feeSink)
    function _collectCreationFee() internal { /* no-op: oracle collects creation fee */ }
    }

    /// @dev internal: register a newly created market
    function _registerMarket(address market) internal {
        isMarket[market] = true;
        allMarkets.push(market);
        emit MarketRegistered(market);
    }

    /// @notice Soft-remove a market listing so frontends can hide it or block interactions
    function removeListing(address market, string calldata reason) external onlyOwner {
        require(isMarket[market], "unknown market");
        isRemoved[market] = true;
        emit ListingRemoved(market, reason);
    }

    /// @notice Restore a previously removed listing
    function restoreListing(address market) external onlyOwner {
        require(isMarket[market], "unknown market");
        require(isRemoved[market], "not removed");
        isRemoved[market] = false;
        emit ListingRestored(market);
    }

    /// @return total number of markets ever created via this factory (including removed)
    function marketCount() external view returns (uint256) {
        return allMarkets.length;
    }
}
