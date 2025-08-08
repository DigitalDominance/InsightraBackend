// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IKasOracle {
    enum Status { NONE, OPEN, FINALIZED, ARBITRATED }

    struct Answer {
        address reporter;
        bytes encoded;
        uint256 bond;
        uint64 ts;
    }

    function getStatus(bytes32 id) external view returns (Status);
    function getBestAnswer(bytes32 id) external view returns (Answer memory);
}
