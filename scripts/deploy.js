// scripts/deploy.js
require("dotenv").config();
const hre = require("hardhat");

// Ethers v5/v6 compatibility shims
const E = hre.ethers;
const toBigInt = (x) => (typeof x === "bigint" ? x : BigInt(String(x)));
const formatEther = E.formatEther || (E.utils && E.utils.formatEther);
const parseUnits = E.parseUnits || (E.utils && E.utils.parseUnits);
const getContractAddress =
  E.getCreateAddress
    ? ({ from, nonce }) => E.getCreateAddress({ from, nonce })
    : ({ from, nonce }) => E.utils.getContractAddress({ from, nonce });

function add0x(s) {
  if (typeof s !== "string") return s;
  return s.startsWith("0x") ? s : "0x" + s;
}

async function main() {
  // Allow bypass during Heroku boot, etc.
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY=true — skipping on-chain deployment");
    return;
  }

  // ✅ IMPORTANT: compile when running via `node scripts/deploy.js`
  await hre.run("compile");
  console.log("[DEPLOY] Contracts compiled");

  const [deployer] = await E.getSigners();
  console.log("[DEPLOY] Network:", hre.network.name);
  console.log("[DEPLOY] Deployer:", deployer.address);

  // Show balance in native currency
  const bal = await E.provider.getBalance(deployer.address);
  console.log("[DEPLOY] Balance:", (formatEther ? formatEther(bal) : (Number(bal)/1e18)) , "(native)");

  // ---- Constructor parameters (via ENV) ----
  const OWNER          = process.env.OWNER || deployer.address;
  const FEE_SINK       = process.env.FEE_SINK || deployer.address;
  const BOND_TOKEN     = process.env.BOND_TOKEN;      // required
  const CREATION_FEE   = process.env.CREATION_FEE_UNITS || "100"; // human units (e.g., 100 tokens)
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100";     // default 1%

  if (!BOND_TOKEN) {
    throw new Error("❌ BOND_TOKEN is required (ERC20 address used to charge creation fee).");
  }

  // Resolve decimals from the BOND_TOKEN on-chain so 100 means '100.0 tokens'
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
  ];
  const bond = new E.Contract(BOND_TOKEN, erc20Abi, E.provider);
  const [decimals, symbol, name] = await Promise.all([
    bond.decimals(),
    bond.symbol().catch(() => ""),
    bond.name().catch(() => ""),
  ]);

  const creationFeeWei = parseUnits ? parseUnits(String(CREATION_FEE), decimals) : E.utils.parseUnits(String(CREATION_FEE), decimals);
  console.log(`[DEPLOY] Bond token: ${name} (${symbol}) @ ${BOND_TOKEN} | decimals=${decimals}`);
  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol || "BOND"} (${creationFeeWei.toString()} base units)`);
  console.log(`[DEPLOY] Redeem fee (bps): ${REDEEM_FEE_BPS}`);
  console.log(`[DEPLOY] Owner: ${OWNER}`);
  console.log(`[DEPLOY] Fee sink: ${FEE_SINK}`);

  // Some Kasplex/Kaspa RPCs can return queue-full errors if pending-nonce > latest-nonce.
  async function waitForQueue(addr, maxMs = 120000) {
    const start = Date.now();
    while (true) {
      const [pending, latest] = await Promise.all([
        E.provider.getTransactionCount(addr, "pending"),
        E.provider.getTransactionCount(addr, "latest"),
      ]);
      if (pending <= latest) return;
      if (Date.now() - start > maxMs) return;
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Deploy helper using getDeployTransaction() like your working script
  async function deployFactory(name, args) {
    console.log(`\n[DEPLOY] Preparing ${name}...`);
    const Factory = await E.getContractFactory(name);
    console.log(`[DEPLOY] ${name} ABI loaded with ${Factory.interface.fragments.length} fragments`);

    // Build the raw deploy tx
    const unsigned = await Factory.getDeployTransaction(...args);
    // Gas padding
    const estGas = await deployer.estimateGas(unsigned);
    // +20% buffer, preserve type (BigNumber vs bigint)
    let gasLimit;
    if (typeof estGas === "bigint") {
      gasLimit = (estGas * 120n) / 100n;
    } else if (estGas && typeof estGas.mul === "function") {
      gasLimit = estGas.mul(12).div(10);
    } else {
      gasLimit = toBigInt(estGas);
    }
    const feeData = await E.provider.getFeeData().catch(() => ({}));
    const txRequest = {
      ...unsigned,
      gasLimit,
      maxFeePerGas: feeData.maxFeePerGas || undefined,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
    };

    // Wait if provider queue is busy
    await waitForQueue(deployer.address);

    // Send raw deploy transaction
    const sent = await deployer.sendTransaction(txRequest);
    const safeHash = add0x(sent.hash);
    console.log(`[DEPLOY] ${name} tx sent: ${safeHash}`);
    console.log(`[DEPLOY] Nonce: ${sent.nonce} | GasLimit: ${gasLimit.toString()}`);

    // Predict address from nonce as a fallback
    const predicted = getContractAddress({ from: deployer.address, nonce: sent.nonce });
    console.log(`[DEPLOY] Predicted address: ${predicted}`);

    // Wait for confirmation (works v5/v6)
    let receipt;
    try {
      receipt = await sent.wait();
    } catch (e) {
      console.warn(`[DEPLOY] .wait() failed (${e && e.message}). Falling back to provider.waitForTransaction...`);
      receipt = await E.provider.waitForTransaction(safeHash);
    }

    if (!receipt) throw new Error(`[DEPLOY] No receipt for ${name}`);
    const deployedAt = receipt.contractAddress || predicted;

    console.log(`[DEPLOY] ✅ ${name} deployed at: ${deployedAt}`);
    console.log(`[DEPLOY]    Block #${receipt.blockNumber} | gasUsed=${(receipt.gasUsed || receipt.gas).toString()}`);

    return deployedAt;
  }

  const ctor = [OWNER, FEE_SINK, BOND_TOKEN, creationFeeWei, REDEEM_FEE_BPS];
  const binaryFactory      = await deployFactory("BinaryFactory", ctor);
  const categoricalFactory = await deployFactory("CategoricalFactory", ctor);
  const scalarFactory      = await deployFactory("ScalarFactory", ctor);

  // Optionally output a single JSON artifact for your server to read
  const fs = require("fs");
  const out = {
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
      ScalarFactory: scalarFactory
    }
  };
  fs.writeFileSync("./deployments.json", JSON.stringify(out, null, 2));
  console.log("[DEPLOY] Wrote deployments.json");
}

main().then(() => process.exit(0)).catch((err) => {
  if (err && err._stack) console.error(err._stack);
  console.error("❌ Unhandled error:", err);
  process.exit(1);
});
