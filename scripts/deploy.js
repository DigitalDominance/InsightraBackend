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
      // Build deployment transaction without immediately broadcasting. We assemble
      // the transaction using `getDeployTransaction` so that we can send it
      // manually via the signer. This avoids a Hardhat/Ethers bug where
      // deployment hashes sometimes omit the 0x prefix and cause JSON-RPC
      // deserialization errors.
      const deployTx = await factory.getDeployTransaction(...params, overrides);
      // Merge any gas overrides into the unsigned transaction. Ethers will
      // automatically populate fields like nonce and chainId when sending.
      const unsignedTx = Object.assign({}, deployTx, overrides);
      const sentTx = await deployer.sendTransaction(unsignedTx);
      // Normalise the hash with a 0x prefix to satisfy RPCs that expect it.
      let txHash = sentTx.hash;
      if (txHash && typeof txHash === 'string' && !txHash.startsWith('0x')) {
        txHash = '0x' + txHash;
      }
      console.log(`[DEPLOY] ${label} tx:`, txHash);
      // Wait for the transaction to be mined. `wait()` returns a receipt with
      // the deployed contract address.
      const receipt = await sentTx.wait();
      const addr = receipt?.contractAddress;
      if (!addr) {
        throw new Error(`Failed to deploy ${label}: contract address not found`);
      }
      console.log(`✅ ${label}:`, addr);
      // Attach the deployed contract instance to the factory for later use.
      const c = await factory.attach(addr);
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
