// Deployment script for the prediction market factories with user-submitted listings fee.
//
// ENV required:
//  - KASPA_TESTNET_RPC or RPC_URL (see hardhat.config.js)
//  - PRIVATE_KEY
//  - FEE_SINK (treasury address)
//  - BOND_TOKEN (ERC20 used to pay creation fee)
// Optional:
//  - OWNER (defaults to deployer)
//  - REDEEM_FEE_BPS (defaults 100 = 1%)
//  - CREATION_FEE_UNITS (override raw units; if omitted we compute 100 * 10**decimals by calling bondToken.decimals())
//  - SKIP_DEPLOY ("true" to skip)
//
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  if ((process.env.SKIP_DEPLOY || "false").toLowerCase() === "true") {
    console.log("[DEPLOY] SKIP_DEPLOY=true — skipping deployments.");
    return;
  }

  const [deployer] = await hre.ethers.getSigners();
  const owner = process.env.OWNER || deployer.address;
  const feeSink = process.env.FEE_SINK;
  const bondTokenAddr = process.env.BOND_TOKEN;
  const redeemFeeBps = Number(process.env.REDEEM_FEE_BPS || 100);

  if (!feeSink) throw new Error("FEE_SINK missing");
  if (!bondTokenAddr) throw new Error("BOND_TOKEN missing");

  const provider = hre.ethers.provider;

  // Resolve creationFee in raw units
  let creationFee;
  if (process.env.CREATION_FEE_UNITS) {
    creationFee = hre.ethers.BigNumber.from(process.env.CREATION_FEE_UNITS);
  } else {
    // Query decimals via ERC20Metadata
    const erc20MetaAbi = ["function decimals() view returns (uint8)"];
    const bond = new hre.ethers.Contract(bondTokenAddr, erc20MetaAbi, provider);
    const dec = await bond.decimals();
    creationFee = hre.ethers.BigNumber.from(10).pow(dec).mul(100); // 100 tokens
  }

  console.log("[DEPLOY] Deployer:", deployer.address);
  console.log("[DEPLOY] Owner:", owner);
  console.log("[DEPLOY] Fee sink:", feeSink);
  console.log("[DEPLOY] Bond token:", bondTokenAddr);
  console.log("[DEPLOY] Creation fee (raw units):", creationFee.toString());
  console.log("[DEPLOY] Redeem fee bps:", redeemFeeBps);

  // Helper to deploy a contract with args and log address
  async function deploy(name, args) {
    const Fac = await hre.ethers.getContractFactory(name);
    const instance = await Fac.connect(deployer).deploy(...args);
    const receipt = await instance.deployTransaction.wait();
    console.log(`✅ ${name} deployed at: ${instance.address}`);
    return instance.address;
  }

  // Deploy factories
  const constructorArgs = [owner, feeSink, bondTokenAddr, creationFee, redeemFeeBps];
  await deploy("BinaryFactory", constructorArgs);
  await deploy("CategoricalFactory", constructorArgs);
  await deploy("ScalarFactory", constructorArgs);
}

main().catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
