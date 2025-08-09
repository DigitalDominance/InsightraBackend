// scripts/deploy.js
require("dotenv").config()
const hre = require("hardhat")
const fs = require("fs") // optional: only for deployments.json

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ensure0x = (h) => (typeof h === "string" && !h.startsWith("0x") ? `0x${h}` : h)
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase()
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full")
}

// ethers v5/v6 shims
function formatEther(v) {
  if (hre.ethers.utils?.formatEther) return hre.ethers.utils.formatEther(v) // v5
  if (hre.ethers.formatEther) return hre.ethers.formatEther(v)             // v6
  return String(v)
}
function parseUnits(v, d) {
  if (hre.ethers.utils?.parseUnits) return hre.ethers.utils.parseUnits(v, d) // v5
  if (hre.ethers.parseUnits) return hre.ethers.parseUnits(v, d)              // v6
  throw new Error("Cannot find parseUnits")
}
function getCreateAddress(from, nonce) {
  if (hre.ethers.getCreateAddress) return hre.ethers.getCreateAddress({ from, nonce }) // v6
  if (hre.ethers.utils?.getContractAddress) return hre.ethers.utils.getContractAddress({ from, nonce }) // v5
  throw new Error("Cannot compute CREATE address (no helper available)")
}

async function withQueueRetries(fn, label) {
  const BASE = Number(process.env.RETRY_BASE_MS || 2500)
  const MAX = Number(process.env.RETRY_MAX_MS || 120000)
  const FACT = Number(process.env.RETRY_FACTOR || 1.7)
  let i = 0, lastLog = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (err) {
      if (!isQueueErr(err)) throw err
      const delay = Math.min(Math.floor(BASE * Math.pow(FACT, i)), MAX)
      const jitter = Math.floor(delay * 0.2 * (Math.random() * 2 - 1))
      const waitMs = Math.max(1000, delay + jitter)
      const now = Date.now()
      if (now - lastLog > 15000) {
        console.warn(`[DEPLOY] ${label}: queue unavailable; retry #${i + 1} in ~${Math.round(waitMs / 1000)}s`)
        lastLog = now
      }
      await sleep(waitMs)
      i++
    }
  }
}

async function waitForQueue(addr, maxMs = 120000) {
  const start = Date.now()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const [pending, latest] = await Promise.all([
        hre.ethers.provider.getTransactionCount(addr, "pending"),
        hre.ethers.provider.getTransactionCount(addr, "latest"),
      ])
      if (pending <= latest) return
      if (Date.now() - start > maxMs) return
      await sleep(1500)
    } catch (err) {
      console.warn(`[DEPLOY] Error checking queue for ${addr}:`, err.message)
      await sleep(2000)
      if (Date.now() - start > maxMs) return
    }
  }
}

// Only 0x-prefixed polling (no no-0x attempt, avoids your RPC error)
async function waitForReceipt(provider, txHash, maxWaitMs = 300000) {
  const start = Date.now()
  const hash = ensure0x(txHash)
  console.log(`[DEPLOY] Waiting for receipt: ${hash}`)
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await provider.getTransactionReceipt(hash)
      if (r) return r
    } catch (e) {
      console.warn(`[DEPLOY] getReceipt error for ${hash}:`, e.message)
    }
    await sleep(2500)
  }
  throw new Error(`Receipt not found after ${maxWaitMs}ms for ${hash}`)
}

// ---------- main ----------
async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment")
    return
  }

  const pkRaw = process.env.PRIVATE_KEY
  if (!pkRaw) throw new Error("❌ PRIVATE_KEY is required")
  const PRIVATE_KEY = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`

  await hre.run("compile")

  const provider = hre.ethers.provider
  const wallet = new hre.ethers.Wallet(PRIVATE_KEY, provider)

  console.log("[DEPLOY] Network:", hre.network.name)
  console.log("[DEPLOY] Deployer:", wallet.address)
  console.log("[DEPLOY] Ethers utils available:", !!hre.ethers.utils)
  console.log("[DEPLOY] Ethers formatEther available:", !!hre.ethers.formatEther)

  const bal = await provider.getBalance(wallet.address)
  console.log("[DEPLOY] Balance (native):", formatEther(bal))

  // ---- env/config ----
  const OWNER = process.env.OWNER || wallet.address
  const FEE_SINK = process.env.FEE_SINK || wallet.address
  const BOND_TOKEN = process.env.BOND_TOKEN
  const CREATION_FEE = process.env.CREATION_FEE_UNITS || "100"
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100"

  if (!BOND_TOKEN) throw new Error("❌ BOND_TOKEN is required (ERC20 address).")
  if (!BOND_TOKEN.startsWith("0x")) throw new Error("❌ BOND_TOKEN must be 0x-prefixed.")

  const erc20Abi = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"]
  const bond = new hre.ethers.Contract(BOND_TOKEN, erc20Abi, provider)
  const [decimals, symbol] = await Promise.all([bond.decimals(), bond.symbol().catch(() => "BOND")])
  const creationFeeWei = parseUnits(String(CREATION_FEE), decimals)
  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol} (${creationFeeWei.toString()} base units)`)

  async function deployOne(name, args, overrideEnvVar) {
    const overrideAddrRaw = process.env[overrideEnvVar]
    if (overrideAddrRaw) {
      const addr = ensure0x(overrideAddrRaw)
      console.log(`[DEPLOY] ⚠️ Using override for ${name}: ${addr}`)
      return addr
    }

    console.log(`\n[DEPLOY] ${name}...`)
    const BaseFactory = await hre.ethers.getContractFactory(name)
    const Factory = BaseFactory.connect(wallet)
    console.log(
      `[DEPLOY] ${name} interface loaded:`,
      Factory.interface.fragments.map((f) => f.name || f.type),
    )

    // Prepare deployment bytes
    const deployTx = await Factory.getDeployTransaction(...args)

    // Queue control
    await waitForQueue(wallet.address)

    // Fix nonce up-front so we can PREDICT contract address
    const nonce = await provider.getTransactionCount(wallet.address, "pending")
    const predicted = getCreateAddress(wallet.address, nonce)
    console.log(`[DEPLOY] ${name} predicted address: ${predicted}`)

    // Build request
    const req = {
      from: wallet.address,
      to: undefined,
      data: deployTx.data,
      nonce, // critical for deterministic predicted address
    }

    // Gas setup
    const gasLimit = await wallet.estimateGas(req)
    req.gasLimit = gasLimit
    console.log(`[DEPLOY] ${name} estimated gas: ${gasLimit.toString()}`)

    // Populate fees/chainId, sign and send raw
    const populated = await wallet.populateTransaction(req)
    const signed = await withQueueRetries(() => wallet.signTransaction(populated), `${name} sign`)
    const txHashRaw = await withQueueRetries(
      () => provider.send("eth_sendRawTransaction", [signed]),
      `${name} sendRaw`
    )
    const txHash = ensure0x(txHashRaw)
    if (txHash !== txHashRaw) console.log(`[DEPLOY] ${name} RPC returned non-0x hash; normalized -> ${txHash}`)
    console.log(`[DEPLOY] ${name} tx: ${txHash}`)

    // Wait for receipt (0x-only)
    let finalAddr = predicted
    try {
      const r = await withQueueRetries(() => waitForReceipt(provider, txHash), `${name} wait`)
      if (r?.contractAddress) finalAddr = ensure0x(r.contractAddress)
      console.log(`[DEPLOY] ✅ ${name} deployed at: ${finalAddr} (block ${r.blockNumber})`)
    } catch (e) {
      // Fall back to predicted if RPC won't give us a proper receipt
      console.warn(`[DEPLOY] ⚠️ ${name} receipt unavailable; using predicted address: ${finalAddr}`)
    }
    return finalAddr
  }

  const ctor = [OWNER, FEE_SINK, BOND_TOKEN, creationFeeWei, REDEEM_FEE_BPS]

  // If you want to pin BinaryFactory to your known address:
  // export BINARY_FACTORY_ADDRESS_OVERRIDE=0x5F23306E9aACbAe41D6ED66De7E78E768603d566
  const binaryFactory = await deployOne("BinaryFactory", ctor, "BINARY_FACTORY_ADDRESS_OVERRIDE")

  // Deploy CategoricalFactory now (optionally allow override)
  const categoricalFactory = await deployOne("CategoricalFactory", ctor, "CATEGORICAL_FACTORY_ADDRESS_OVERRIDE")

  // ScalarFactory (unchanged; keep if needed)
  const scalarFactory = await deployOne("ScalarFactory", ctor, "SCALAR_FACTORY_ADDRESS_OVERRIDE")

  const deploymentData = {
    network: hre.network.name,
    deployedAt: new Date().toISOString(),
    owner: OWNER,
    feeSink: FEE_SINK,
    bondToken: BOND_TOKEN,
    creationFee: creationFeeWei.toString(),
    redeemFeeBps: String(REDEEM_FEE_BPS),
    factories: {
      BinaryFactory: ensure0x(binaryFactory),
      CategoricalFactory: ensure0x(categoricalFactory),
      ScalarFactory: ensure0x(scalarFactory),
    },
  }
  fs.writeFileSync("./deployments.json", JSON.stringify(deploymentData, null, 2))
  console.log("[DEPLOY] ✅ Wrote deployments.json")
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Unhandled error:", err)
    process.exit(1)
  })
