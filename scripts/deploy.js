require("dotenv").config();
const hre = require("hardhat");

async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment");
    return;
  }

  // Force the right network if provided
  const targetNet = process.env.HARDHAT_NETWORK || "kaspaTestnet";
  if (hre.network.name !== targetNet && typeof hre.changeNetwork === "function") {
    console.log(`[DEPLOY] Switching network: ${hre.network.name} → ${targetNet}`);
    hre.changeNetwork(targetNet);
  } else {
    console.log(`[DEPLOY] Using network: ${hre.network.name}`);
  }

  await hre.run("compile");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance (ETH):", hre.ethers.formatEther(balance));

  const OWNER = process.env.OWNER || deployer.address;
  const FEE_SINK = process.env.FEE_SINK;
  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || "100");
  if (!FEE_SINK) throw new Error("FEE_SINK env is required");

  console.log("OWNER:", OWNER);
  console.log("FEE_SINK:", FEE_SINK);
  console.log("REDEEM_FEE_BPS:", REDEEM_FEE_BPS);

  const BinaryFactory = await hre.ethers.getContractFactory("BinaryFactory");
  const CategoricalFactory = await hre.ethers.getContractFactory("CategoricalFactory");
  const ScalarFactory = await hre.ethers.getContractFactory("ScalarFactory");

  console.log("[DEPLOY] Deploying BinaryFactory...");
  const binF = await BinaryFactory.deploy(OWNER, FEE_SINK, REDEEM_FEE_BPS);
  console.log("[DEPLOY] Tx:", binF.deploymentTransaction()?.hash);
  await binF.waitForDeployment();
  console.log("✅ BinaryFactory:", await binF.getAddress());

  console.log("[DEPLOY] Deploying CategoricalFactory...");
  const catF = await CategoricalFactory.deploy(OWNER, FEE_SINK, REDEEM_FEE_BPS);
  console.log("[DEPLOY] Tx:", catF.deploymentTransaction()?.hash);
  await catF.waitForDeployment();
  console.log("✅ CategoricalFactory:", await catF.getAddress());

  console.log("[DEPLOY] Deploying ScalarFactory...");
  const scaF = await ScalarFactory.deploy(OWNER, FEE_SINK, REDEEM_FEE_BPS);
  console.log("[DEPLOY] Tx:", scaF.deploymentTransaction()?.hash);
  await scaF.waitForDeployment();
  console.log("✅ ScalarFactory:", await scaF.getAddress());
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
