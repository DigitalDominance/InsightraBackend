// hardhat.config.js
require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");

const { KASPA_TESTNET_RPC, PRIVATE_KEY, BLOCKSCOUT_API_KEY } = process.env;

if (!KASPA_TESTNET_RPC) {
  console.warn("⚠️ KASPA_TESTNET_RPC is not set; defaulting to https://rpc.kasplextest.xyz");
}
if (!PRIVATE_KEY) {
  console.warn("⚠️ PRIVATE_KEY is not set; deployments will fail.");
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 50 },
      viaIR: true,
    },
  },
  defaultNetwork: "kaspaTestnet",
  networks: {
    hardhat: {},
    kaspaTestnet: {
      url: KASPA_TESTNET_RPC || "https://rpc.kasplextest.xyz",
      chainId: 167012,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { kaspaTestnet: BLOCKSCOUT_API_KEY || "blockscout" },
    customChains: [
      {
        network: "kaspaTestnet",
        chainId: 167012,
        urls: {
          apiURL: "https://frontend.kasplextest.xyz/api",
          browserURL: "https://frontend.kasplextest.xyz",
        },
      },
    ],
  },
  sourcify: { enabled: false },
};
