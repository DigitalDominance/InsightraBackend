import { ethers } from "hardhat";

async function main() {
  console.log("🚀 Starting deployment of PredictionMarketFactory...");

  const OWNER = process.env.OWNER || (await ethers.getSigners())[0].address;
  console.log(`👤 Owner address: ${OWNER}`);

  const FEE_SINK = process.env.FEE_SINK!;
  console.log(`💰 Fee sink address: ${FEE_SINK || "(not provided)"}`);

  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || "100"); // 1% default
  console.log(`📊 Redeem fee (BPS): ${REDEEM_FEE_BPS}`);

  if (!FEE_SINK) throw new Error("❌ FEE_SINK env is required");

  console.log("🔍 Getting contract factory for PredictionMarketFactory...");
  const Factory = await ethers.getContractFactory("PredictionMarketFactory");

  console.log("📦 Deploying contract...");
  const factory = await Factory.deploy(OWNER, FEE_SINK, REDEEM_FEE_BPS);

  console.log("⏳ Waiting for deployment to confirm...");
  await factory.waitForDeployment();

  const deployedAddress = await factory.getAddress();
  console.log(`✅ PredictionMarketFactory deployed at: ${deployedAddress}`);
}

main().catch((e) => {
  console.error("❌ Deployment failed:", e);
  process.exit(1);
});
