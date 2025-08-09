require("dotenv").config();
const hre = require("hardhat");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForQueue(provider, address, maxWaitMs = 120000) {
  const start = Date.now();
  while (true) {
    try {
      const pending = await provider.getTransactionCount(address, "pending");
      const latest  = await provider.getTransactionCount(address, "latest");
      const diff = Number(pending - latest);
      if (diff <= 0) return;
      if (Date.now() - start > maxWaitMs) {
        console.log(`[QUEUE] waited ${maxWaitMs}ms; still ${diff} pending — continuing.`);
        return;
      }
      console.log(`[QUEUE] ${diff} pending tx(s). waiting 4s...`);
      await sleep(4000);
    } catch (e) {
      console.log("[QUEUE] error reading nonce; continuing:", e?.message || String(e));
      return;
    }
  }
}

async function deployWithRetry(factory, params, label, provider, deployer, maxRetries = 10) {
  // get base gas price (legacy) if supported
  let baseGas = null;
  try { baseGas = await provider.getGasPrice?.(); } catch {}
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await waitForQueue(provider, await deployer.getAddress(), 120000);

      // gas overrides: bump ~+15% per attempt
      const overrides = {};
      try {
        const gp = (await provider.getGasPrice?.()) || baseGas;
        if (gp) {
          const bump = (BigInt(115 + attempt * 15) * gp) / 100n;
          overrides.gasPrice = bump;
        }
      } catch {}

      // estimate gas limit (best-effort)
      try {
        const tx = await factory.getDeployTransaction(...params, overrides);
        const est = await provider.estimateGas(tx);
        overrides.gasLimit = (est * 12n) / 10n; // +20%
      } catch {}

      console.log(`[GAS] ${label} gasPrice: ${overrides.gasPrice ? overrides.gasPrice.toString() : "auto"}`);
      console.log(`[GAS] ${label} gasLimit: ${overrides.gasLimit ? overrides.gasLimit.toString() : "auto"}`);

      console.log(`[DEPLOY] sending ${label}...`);
      const c = await factory.deploy(...params, overrides);
      console.log(`[DEPLOY] ${label} tx:`, c.deploymentTransaction()?.hash);
      await c.waitForDeployment();
      console.log(`✅ ${label}:`, await c.getAddress());
      return c;
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      const isQueue = /no available queue/i.test(msg);
      console.error(`[DEPLOY ERROR] ${label}:`, msg);
      if (!isQueue || attempt === maxRetries) throw err;
      const backoff = Math.min(60000, 3000 * 2 ** attempt);
      console.log(`[DEPLOY] retrying ${label} in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
}

async function main() {
  if (String(process.env.SKIP_DEPLOY || "false").toLowerCase() === "true") {
    console.log("⚡ SKIP_DEPLOY=true — skipping contract deployment");
    return;
  }

  const targetNet = process.env.HARDHAT_NETWORK || "kaspaTestnet";
  if (hre.network.name !== targetNet && typeof hre.changeNetwork === "function") {
    console.log(`[DEPLOY] switching network: ${hre.network.name} → ${targetNet}`);
    hre.changeNetwork(targetNet);
  } else {
    console.log(`[DEPLOY] using network: ${hre.network.name}`);
  }

  await hre.run("compile");
  const net = await hre.ethers.provider.getNetwork();
  console.log("Network:", Number(net.chainId), net.name || "");

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
