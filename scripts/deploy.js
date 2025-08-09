require("dotenv").config()
const hre = require("hardhat")
const fs = require("fs") // optional: only used to write deployments.json

// -------- helpers --------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase()
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full")
}
const ensure0x = (h) => (typeof h === "string" && !h.startsWith("0x") ? `0x${h}` : h)

// ethers v5/v6 shims
function formatEther(value) {
  if (hre.ethers.utils?.formatEther) return hre.ethers.utils.formatEther(value) // v5
  if (hre.ethers.formatEther) return hre.ethers.formatEther(value) // v6
  return String(value)
}
function parseUnits(value, decimals) {
  if (hre.ethers.utils?.parseUnits) return hre.ethers.utils.parseUnits(value, decimals) // v5
  if (hre.ethers.parseUnits) return hre.ethers.parseUnits(value, decimals) // v6
  throw new Error("Cannot find parseUnits")
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

// Poll receipt; tolerant to 0x/no-0x hashes
async function waitForTransactionReceipt(provider, txHash, maxWaitTime = 300000) {
  const start = Date.now()
  const hash0x = ensure0x(txHash)
  console.log(`[DEPLOY] Waiting for receipt: ${hash0x}`)

  while (Date.now() - start < maxWaitTime) {
    try {
      let receipt = await provider.getTransactionReceipt(hash0x)
      if (receipt) {
        console.log(`[DEPLOY] Confirmed in block ${receipt.blockNumber}`)
        return receipt
      }
      // Try without 0x as a fallback (some RPCs are odd)
      if (hash0x.startsWith("0x")) {
        receipt = await provider.getTransactionReceipt(hash0x.slice(2))
        if (receipt) {
          console.log(`[DEPLOY] Confirmed in block ${receipt.blockNumber}`)
          return receipt
        }
      }
    } catch (err) {
      console.warn(`[DEPLOY] getReceipt error for ${hash0x}:`, err.message)
    }
    await sleep(3000)
  }
  throw new Error(`Receipt not found after ${maxWaitTime}ms for ${hash0x}`)
}

// -------- main --------
async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment")
    return
  }

  await hre.run("compile")
  const [deployer] = await hre.ethers.getSigners()

  console.log("[DEPLOY] Network:", hre.network.name)
  console.log("[DEPLOY] Deployer:", deployer.address)
  console.log("[DEPLOY] Ethers utils available:", !!hre.ethers.utils)
  console.log("[DEPLOY] Ethers formatEther available:", !!hre.ethers.formatEther)

  const balance = await hre.ethers.provider.getBalance(deployer.address)
  console.log("[DEPLOY] Balance (native):", formatEther(balance))

  // env/config
  const OWNER = process.env.OWNER || deployer.address
  const FEE_SINK = process.env.FEE_SINK || deployer.address
  const BOND_TOKEN = process.env.BOND_TOKEN // required
  const CREATION_FEE = process.env.CREATION_FEE_UNITS || "100"
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100"

  if (!BOND_TOKEN) throw new Error("❌ BOND_TOKEN is required (ERC20 address).")
  if (!BOND_TOKEN.startsWith("0x")) throw new Error("❌ BOND_TOKEN must be 0x-prefixed.")

  // Resolve decimals/symbol for creation fee
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
  ]
  const bond = new hre.ethers.Contract(BOND_TOKEN, erc20Abi, hre.ethers.provider)
  const [decimals, symbol] = await Promise.all([bond.decimals(), bond.symbol().catch(() => "BOND")])
  const creationFeeWei = parseUnits(String(CREATION_FEE), decimals)
  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol} (${creationFeeWei.toString()} base units)`)

  async function deployOne(name, args) {
    console.log(`\n[DEPLOY] ${name}...`)
    const Factory = await hre.ethers.getContractFactory(name)
    console.log(
      `[DEPLOY] ${name} interface loaded:`,
      Factory.interface.fragments.map((f) => f.name || f.type),
    )

    // Build raw deploy tx
    const deployTx = await Factory.getDeployTransaction(...args)

    // Minimal request; leave fees to populateTransaction
    const txRequest = {
      from: deployer.address,
      to: undefined,             // contract creation
      data: deployTx.data,       // bytecode + encoded ctor args
      value: undefined
    }

    // Estimate and set gas limit (avoid provider doing it after signing)
    const estimatedGas = await deployer.estimateGas(txRequest)
    txRequest.gasLimit = estimatedGas
    console.log(`[DEPLOY] ${name} estimated gas: ${estimatedGas.toString()}`)

    await waitForQueue(deployer.address)

    // Populate (nonce, chainId, fees), sign, and send raw
    const populated = await deployer.populateTransaction(txRequest)
    const signed = await withQueueRetries(() => deployer.signTransaction(populated), `${name} sign`)
    const txHashRaw = await withQueueRetries(
      () => hre.ethers.provider.send("eth_sendRawTransaction", [signed]),
      `${name} sendRaw`
    )
    const txHash = ensure0x(txHashRaw)
    if (txHash !== txHashRaw) {
      console.log(`[DEPLOY] ${name} RPC returned non-0x hash; normalized -> ${txHash}`)
    }
    console.log(`[DEPLOY] ${name} tx: ${txHash}`)

    // Wait for receipt (no Hardhat checkTx calls)
    const receipt = await withQueueRetries(
      () => waitForTransactionReceipt(hre.ethers.provider, txHash),
      `${name} wait`
    )

    console.log(`[DEPLOY] ✅ ${name} deployed at: ${receipt.contractAddress} (block ${receipt.blockNumber})`)
    return receipt.contractAddress
  }

  const ctor = [OWNER, FEE_SINK, BOND_TOKEN, creationFeeWei, REDEEM_FEE_BPS]
  const binaryFactory = await deployOne("BinaryFactory", ctor)
  const categoricalFactory = await deployOne("CategoricalFactory", ctor)
  const scalarFactory = await deployOne("ScalarFactory", ctor)

  // Optional: write a deployment manifest
  const deploymentData = {
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
