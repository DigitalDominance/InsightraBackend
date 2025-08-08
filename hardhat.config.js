require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const {
  KASPA_TESTNET_RPC,
  RPC_URL,
  PRIVATE_KEY,
  BLOCKSCOUT_API_KEY,
} = process.env;

const KASPA_URL = KASPA_TESTNET_RPC || RPC_URL || "https://rpc.kasplextest.xyz";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  defaultNetwork: "kaspaTestnet",
  networks: {
    hardhat: {},
    kaspaTestnet: {
      url: KASPA_URL,
      chainId: 167012,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { kaspaTestnet: BLOCKSCOUT_API_KEY || "placeholder" },
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
