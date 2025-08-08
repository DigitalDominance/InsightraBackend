// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracleConsumer {
    function onOracleFinalize(bytes32 questionId, bytes calldata encodedOutcome) external;
}
