// scripts/deploy.js
require("dotenv").config();
const hre = require("hardhat");
const fs = require("fs");

// ethers v5/v6 shims (minimal)
const E = hre.ethers;
const formatEther = E.formatEther || (E.utils && E.utils.formatEther);
const parseUnits = E.parseUnits || (E.utils && E.utils.parseUnits);
const isBN = (x) => x && typeof x === "object" && typeof x.mul === "function";

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase();
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full");
};
async function withQueueRetries(fn, label) {
  const BASE = Number(process.env.RETRY_BASE_MS || 2500);
  const MAX  = Number(process.env.RETRY_MAX_MS  || 120000);
  const FACT = Number(process.env.RETRY_FACTOR || 1.7);
  let i = 0, lastLog = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { return await fn(); }
    catch (err) {
      if (!isQueueErr(err)) throw err;
      const delay = Math.min(Math.floor(BASE * Math.pow(FACT, i)), MAX);
      const jitter = Math.floor(delay * 0.2 * (Math.random() * 2 - 1));
      const waitMs = Math.max(1000, delay + jitter);
      const now = Date.now();
      if (now - lastLog > 15000) {
        console.warn(`[DEPLOY] ${label}: queue unavailable; retry #${i + 1} in ~${Math.round(waitMs/1000)}s`);
        lastLog = now;
      }
      await sleep(waitMs); i++;
    }
  }
}
async function waitForQueue(addr, maxMs = 120000) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const [pending, latest] = await Promise.all([
      E.provider.getTransactionCount(addr, "pending"),
      E.provider.getTransactionCount(addr, "latest"),
    ]);
    if (pending <= latest) return;
    if (Date.now() - start > maxMs) return;
    await sleep(1500);
  }
}

async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment");
    return;
  }

  await hre.run("compile");

  const [deployer] = await E.getSigners();
  console.log("[DEPLOY] Network:", hre.network.name);
  console.log("[DEPLOY] Deployer:", deployer.address);

  const bal = await E.provider.getBalance(deployer.address);
  console.log("[DEPLOY] Balance (native):", formatEther ? formatEther(bal) : String(bal));

  // env/config
  const OWNER          = process.env.OWNER || deployer.address;
  const FEE_SINK       = process.env.FEE_SINK || deployer.address;
  const BOND_TOKEN     = process.env.BOND_TOKEN;                   // required
  const CREATION_FEE   = process.env.CREATION_FEE_UNITS || "100";  // human units (e.g. "100")
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100";      // default 1%

  if (!BOND_TOKEN) throw new Error("❌ BOND_TOKEN is required (ERC20 address).");

  // resolve decimals/symbol so "100" => 100.0 tokens
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
  ];
  const bond = new E.Contract(BOND_TOKEN, erc20Abi, E.provider);
  const [decimals, symbol] = await Promise.all([
    bond.decimals(),
    bond.symbol().catch(() => "BOND"),
  ]);
  const creationFeeWei = parseUnits
    ? parseUnits(String(CREATION_FEE), decimals)
    : E.utils.parseUnits(String(CREATION_FEE), decimals);
  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol} (${creationFeeWei.toString()} base units)`);

  async function deployOne(name, args) {
    console.log(`\n[DEPLOY] ${name}...`);
    const Factory = await E.getContractFactory(name);

    // raw deploy tx
    const txReq = await Factory.getDeployTransaction(...args);

    // estimate gas + buffer
    let est;
    try { est = await deployer.estimateGas(txReq); }
    catch { est = (typeof 0n === "bigint") ? 5_000_000n : (E.BigNumber ? E.BigNumber.from(5_000_000) : 5_000_000); }

    if (typeof est === "bigint") {
      txReq.gasLimit = (est * 120n) / 100n;
    } else if (isBN(est)) {
      txReq.gasLimit = est.mul(12).div(10);
    } else {
      txReq.gasLimit = est;
    }

    // optional fee caps
    const fee = await E.provider.getFeeData().catch(() => ({}));
    if (fee && fee.maxFeePerGas != null) txReq.maxFeePerGas = fee.maxFeePerGas;
    if (fee && fee.maxPriorityFeePerGas != null) txReq.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;

    await waitForQueue(deployer.address);

    // send with quiet queue retries
    const sentTx = await withQueueRetries(
      () => deployer.sendTransaction(txReq),
      `${name} send`
    );
    console.log(`[DEPLOY] ${name} tx: ${sentTx.hash}`);

    const receipt = await sentTx.wait();
    console.log(`[DEPLOY] ✅ ${name} at: ${receipt.contractAddress}`);
    return receipt.contractAddress;
  }

  const ctor = [OWNER, FEE_SINK, BOND_TOKEN, creationFeeWei, REDEEM_FEE_BPS];
  const binaryFactory      = await deployOne("BinaryFactory", ctor);
  const categoricalFactory = await deployOne("CategoricalFactory", ctor);
  const scalarFactory      = await deployOne("ScalarFactory", ctor);

  fs.writeFileSync(
    "./deployments.json",
    JSON.stringify({
      network: hre.network.name,
      deployedAt: new Date().toISOString(),
      owner: OWNER,
      feeSink: FEE_SINK,
      bondToken: BOND_TOKEN,
      creationFee: creationFeeWei.toString(),
      redeemFeeBps: String(REDEEM_FEE_BPS),
      factories: {
        BinaryFactory: binaryFactory,
        CategoricalFactory: categoricalFactory,
        ScalarFactory: scalarFactory,
      },
    }, null, 2)
  );
  console.log("[DEPLOY] Wrote deployments.json");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });
