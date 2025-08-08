import { ethers } from "hardhat";

async function main() {
  const OWNER = process.env.OWNER || (await ethers.getSigners())[0].address;
  const FEE_SINK = process.env.FEE_SINK!;
  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || "100"); // 1% default

  if (!FEE_SINK) throw new Error("FEE_SINK env is required");

  const Factory = await ethers.getContractFactory("PredictionMarketFactory");
  const factory = await Factory.deploy(OWNER, FEE_SINK, REDEEM_FEE_BPS);
  await factory.waitForDeployment();
  console.log("PredictionMarketFactory:", await factory.getAddress());
}

main().catch((e) => { console.error(e); process.exit(1); });
