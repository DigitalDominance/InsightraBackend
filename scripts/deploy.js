require("dotenv").config();
const hre = require("hardhat");

async function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function waitForQueue(provider, addr, maxWaitMs = 60000) {
  const start = Date.now();
  while (true) {
    const pending = await provider.getTransactionCount(addr, "pending");
    const latest  = await provider.getTransactionCount(addr, "latest");
    const diff = Number(pending - latest);
    if (diff <= 0) return;
    if (Date.now() - start > maxWaitMs) {
      console.log(`[QUEUE] Waited ${maxWaitMs}ms, still ${diff} pending — continuing anyway.`);
      return;
    }
    console.log(`[QUEUE] ${diff} pending tx(s). Waiting 4s...`);
    await sleep(4000);
  }
}

async function deployWithRetry(factory, params, label, provider, deployer, maxRetries = 8) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      await waitForQueue(provider, await deployer.getAddress(), 90000);

      console.log(`[DEPLOY] Sending ${label}...`);
      const c = await factory.deploy(...params);
      console.log(`[DEPLOY] ${label} tx:`, c.deploymentTransaction()?.hash);
      await c.waitForDeployment();
      const addr = await c.getAddress();
      console.log(`✅ ${label}:`, addr);
      return c;
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      const isQueue = /no available queue/i.test(msg);
      console.error(`[DEPLOY ERROR] ${label}:`, msg);
      if (!isQueue || i === maxRetries) throw err;
      const backoff = 2000 * Math.pow(2, i); // 2s, 4s, 8s, ...
      console.log(`[DEPLOY] Retrying ${label} in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
}

async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment");
    return;
  }

  const targetNet = process.env.HARDHAT_NETWORK || "kaspaTestnet";
  if (hre.network.name !== targetNet && typeof hre.changeNetwork === "function") {
    console.log(`[DEPLOY] Switching network: ${hre.network.name} → ${targetNet}`);
    hre.changeNetwork(targetNet);
  } else {
    console.log(`[DEPLOY] Using network: ${hre.network.name}`);
  }

  await hre.run("compile");

  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  console.log("Deploying with:", await deployer.getAddress());
  const balance = await provider.getBalance(await deployer.getAddress());
  console.log("Deployer balance (ETH):", hre.ethers.formatEther(balance));

  const OWNER = process.env.OWNER || await deployer.getAddress();
  const FEE_SINK = process.env.FEE_SINK;
  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || "100");
  if (!FEE_SINK) throw new Error("FEE_SINK env is required");

  console.log("OWNER:", OWNER);
  console.log("FEE_SINK:", FEE_SINK);
  console.log("REDEEM_FEE_BPS:", REDEEM_FEE_BPS);

  const BinaryFactory = await hre.ethers.getContractFactory("BinaryFactory");
  const CategoricalFactory = await hre.ethers.getContractFactory("CategoricalFactory");
  const ScalarFactory = await hre.ethers.getContractFactory("ScalarFactory");

  await deployWithRetry(BinaryFactory, [OWNER, FEE_SINK, REDEEM_FEE_BPS], "BinaryFactory", provider, deployer);
  await deployWithRetry(CategoricalFactory, [OWNER, FEE_SINK, REDEEM_FEE_BPS], "CategoricalFactory", provider, deployer);
  await deployWithRetry(ScalarFactory, [OWNER, FEE_SINK, REDEEM_FEE_BPS], "ScalarFactory", provider, deployer);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
