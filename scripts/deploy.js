require("dotenv").config()
const hre = require("hardhat")
const fs = require("fs")

// ethers v5/v6 shims (minimal)
const E = hre.ethers
const formatEther = E.formatEther || (E.utils && E.utils.formatEther)
const parseUnits = E.parseUnits || (E.utils && E.utils.parseUnits)
const isBN = (x) => x && typeof x === "object" && typeof x.mul === "function"

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase()
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full")
}

// Ensure hash has 0x prefix
const ensureHexPrefix = (hash) => {
  if (!hash) return hash
  return hash.startsWith("0x") ? hash : `0x${hash}`
}

async function withQueueRetries(fn, label) {
  const BASE = Number(process.env.RETRY_BASE_MS || 2500)
  const MAX = Number(process.env.RETRY_MAX_MS || 120000)
  const FACT = Number(process.env.RETRY_FACTOR || 1.7)
  let i = 0,
    lastLog = 0

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
        E.provider.getTransactionCount(addr, "pending"),
        E.provider.getTransactionCount(addr, "latest"),
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

// Custom transaction receipt waiter that handles Kaspa's hash format
async function waitForTransactionReceipt(txHash, maxWaitTime = 300000) {
  const start = Date.now()
  const normalizedHash = ensureHexPrefix(txHash)

  console.log(`[DEPLOY] Waiting for transaction receipt: ${normalizedHash}`)

  while (Date.now() - start < maxWaitTime) {
    try {
      const receipt = await E.provider.getTransactionReceipt(normalizedHash)
      if (receipt) {
        console.log(`[DEPLOY] Transaction confirmed in block: ${receipt.blockNumber}`)
        return receipt
      }
    } catch (err) {
      // If we get the hex prefix error, try without prefix
      if (err.message.includes("cannot unmarshal hex string without 0x prefix")) {
        try {
          const receipt = await E.provider.getTransactionReceipt(txHash.replace("0x", ""))
          if (receipt) {
            console.log(`[DEPLOY] Transaction confirmed in block: ${receipt.blockNumber}`)
            return receipt
          }
        } catch (err2) {
          console.warn(`[DEPLOY] Error getting receipt (attempt 2):`, err2.message)
        }
      } else {
        console.warn(`[DEPLOY] Error getting receipt:`, err.message)
      }
    }

    await sleep(2000) // Wait 2 seconds before trying again
  }

  throw new Error(`Transaction receipt not found after ${maxWaitTime}ms`)
}

async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment")
    return
  }

  await hre.run("compile")
  const [deployer] = await E.getSigners()

  console.log("[DEPLOY] Network:", hre.network.name)
  console.log("[DEPLOY] Deployer:", deployer.address)

  const bal = await E.provider.getBalance(deployer.address)
  console.log("[DEPLOY] Balance (native):", formatEther ? formatEther(bal) : String(bal))

  // env/config
  const OWNER = process.env.OWNER || deployer.address
  const FEE_SINK = process.env.FEE_SINK || deployer.address
  const BOND_TOKEN = process.env.BOND_TOKEN // required
  const CREATION_FEE = process.env.CREATION_FEE_UNITS || "100" // human units (e.g. "100")
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100" // default 1%

  if (!BOND_TOKEN) throw new Error("❌ BOND_TOKEN is required (ERC20 address).")

  // resolve decimals/symbol so "100" => 100.0 tokens
  const erc20Abi = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"]

  const bond = new E.Contract(BOND_TOKEN, erc20Abi, E.provider)
  const [decimals, symbol] = await Promise.all([bond.decimals(), bond.symbol().catch(() => "BOND")])

  const creationFeeWei = parseUnits
    ? parseUnits(String(CREATION_FEE), decimals)
    : E.utils.parseUnits(String(CREATION_FEE), decimals)

  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol} (${creationFeeWei.toString()} base units)`)

  async function deployOne(name, args) {
    console.log(`\n[DEPLOY] ${name}...`)
    const Factory = await E.getContractFactory(name)

    try {
      // Prepare deployment transaction
      const deployTx = await Factory.getDeployTransaction(...args)
      console.log(`[DEPLOY] ${name} deploy transaction prepared`)

      // Estimate gas
      const estimatedGas = await deployer.estimateGas(deployTx)
      console.log(`[DEPLOY] ${name} estimated gas:`, estimatedGas.toString())

      // Set gas limit with buffer
      if (typeof estimatedGas === "bigint") {
        deployTx.gasLimit = (estimatedGas * 120n) / 100n
      } else if (isBN(estimatedGas)) {
        deployTx.gasLimit = estimatedGas.mul(12).div(10)
      } else {
        deployTx.gasLimit = estimatedGas
      }

      // Optional fee caps
      try {
        const fee = await E.provider.getFeeData()
        if (fee && fee.maxFeePerGas != null) deployTx.maxFeePerGas = fee.maxFeePerGas
        if (fee && fee.maxPriorityFeePerGas != null) deployTx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas
      } catch (err) {
        console.warn(`[DEPLOY] Could not get fee data:`, err.message)
      }

      await waitForQueue(deployer.address)

      // Send transaction using provider directly to avoid Hardhat's checkTx
      const sentTx = await withQueueRetries(async () => {
        // Use provider.sendTransaction instead of deployer.sendTransaction
        const response = await E.provider.sendTransaction(deployTx)
        console.log(`[DEPLOY] ${name} raw response:`, response)
        return response
      }, `${name} send`)

      console.log(`[DEPLOY] ${name} tx hash: ${sentTx.hash || sentTx}`)

      // Use our custom receipt waiter
      const receipt = await withQueueRetries(() => waitForTransactionReceipt(sentTx.hash || sentTx), `${name} wait`)

      console.log(`[DEPLOY] ✅ ${name} deployed at: ${receipt.contractAddress}`)
      return receipt.contractAddress
    } catch (err) {
      console.error(`❌ Error deploying ${name}:`, err)
      throw err
    }
  }

  const ctor = [OWNER, FEE_SINK, BOND_TOKEN, creationFeeWei, REDEEM_FEE_BPS]

  const binaryFactory = await deployOne("BinaryFactory", ctor)
  const categoricalFactory = await deployOne("CategoricalFactory", ctor)
  const scalarFactory = await deployOne("ScalarFactory", ctor)

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
