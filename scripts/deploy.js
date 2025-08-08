// scripts/deploy.js
require("dotenv").config();
const hre = require("hardhat");

async function main() {
  // Optional toggle to avoid redeploying on every dyno restart
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment");
    return;
  }

  // Make sure artifacts exist (safe even if already compiled)
  try {
    await hre.run("compile");
  } catch (e) {
    console.warn("⚠️ compile step failed (continuing):", e?.message || e);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance (ETH):", hre.ethers.formatEther(balance));

  const OWNER = process.env.OWNER || deployer.address;
  const FEE_SINK = process.env.FEE_SINK;
  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || "100"); // 1%

  if (!FEE_SINK) throw new Error("FEE_SINK env is required");

  console.log("OWNER:", OWNER);
  console.log("FEE_SINK:", FEE_SINK);
  console.log("REDEEM_FEE_BPS:", REDEEM_FEE_BPS);

  const Factory = await hre.ethers.getContractFactory("PredictionMarketFactory");
  console.log("PredictionMarketFactory interface loaded");

  // Deploy (standard path)
  const factory = await Factory.deploy(OWNER, FEE_SINK, REDEEM_FEE_BPS);
  console.log("Sent deploy tx:", factory.deploymentTransaction()?.hash);

  console.log("Waiting for deployment...");
  await factory.waitForDeployment();

  const addr = await factory.getAddress();
  console.log("✅ PredictionMarketFactory deployed at:", addr);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });
