require("dotenv").config();
const { ethers } = require("ethers");
const hre = require("hardhat");

function ensure0x(h) { return typeof h === 'string' && h.startsWith('0x') ? h : '0x' + String(h); }

async function main() {
  const URL = process.env.KASPA_TESTNET_RPC || "https://rpc.kasplextest.xyz";
  const CHAIN_ID = 167012;

  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY missing in env");
  }

  // Use a raw JsonRpcProvider + Wallet to avoid provider quirks
  const provider = new ethers.JsonRpcProvider(URL, { chainId: CHAIN_ID, name: "kaspaTestnet" });
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`[DEPLOY] using network: kaspaTestnet`);
  console.log(`[DEPLOY] Deploying with: ${wallet.address}`);
  const bal = await provider.getBalance(wallet.address);
  console.log(`[DEPLOY] Deployer balance (ETH): ${ethers.formatEther(bal)}`);

  const OWNER = process.env.OWNER || wallet.address;
  const FEE_SINK = process.env.FEE_SINK || wallet.address;
  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || 100); // 1%

  async function deployContract(name, args = []) {
    const factory = await hre.ethers.getContractFactory(name, wallet);
    const contract = await factory.deploy(...args);
    const dtx = contract.deploymentTransaction();
    console.log(`[DEPLOY] sent ${name} tx: ${dtx ? dtx.hash : '(unknown)'}`);

    if (dtx && dtx.hash) {
      // Some RPCs require 0x-prefixed hashes; enforce it
      const txHash = ensure0x(dtx.hash);
      await provider.waitForTransaction(txHash);
    } else {
      // Fallback if Hardhat didn't expose the tx
      await contract.waitForDeployment();
    }

    const addr = await contract.getAddress();
    console.log(`[DEPLOY] ${name} deployed at: ${addr}`);
    return addr;
  }

  const bin = await deployContract("BinaryFactory", [OWNER, FEE_SINK, REDEEM_FEE_BPS]);
  const cat = await deployContract("CategoricalFactory", [OWNER, FEE_SINK, REDEEM_FEE_BPS]);
  const sca = await deployContract("ScalarFactory", [OWNER, FEE_SINK, REDEEM_FEE_BPS]);

  console.log(JSON.stringify({ BinaryFactory: bin, CategoricalFactory: cat, ScalarFactory: sca }, null, 2));
}

main().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
