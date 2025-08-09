require("dotenv").config()
const hre = require("hardhat")
const fs = require("fs")

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase()
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full")
}

// Helper to handle ethers v5/v6 differences
function formatEther(value) {
  if (hre.ethers.utils && hre.ethers.utils.formatEther) {
    // ethers v5
    return hre.ethers.utils.formatEther(value)
  } else if (hre.ethers.formatEther) {
    // ethers v6
    return hre.ethers.formatEther(value)
  } else {
    // fallback - just show the raw value
    return value.toString()
  }
}

function parseUnits(value, decimals) {
  if (hre.ethers.utils && hre.ethers.utils.parseUnits) {
    // ethers v5
    return hre.ethers.utils.parseUnits(value, decimals)
  } else if (hre.ethers.parseUnits) {
    // ethers v6
    return hre.ethers.parseUnits(value, decimals)
  } else {
    throw new Error("Cannot find parseUnits function")
  }
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

// Custom function to wait for transaction receipt with hash format handling
async function waitForTransactionReceipt(provider, txHash, maxWaitTime = 300000) {
  const start = Date.now()
  console.log(`[DEPLOY] Waiting for transaction receipt: ${txHash}`)

  while (Date.now() - start < maxWaitTime) {
    try {
      // Try with the hash as-is first
      let receipt = await provider.getTransactionReceipt(txHash)
      if (receipt) {
        console.log(`[DEPLOY] Transaction confirmed in block: ${receipt.blockNumber}`)
        return receipt
      }

      // If no receipt and hash doesn't start with 0x, try adding it
      if (!txHash.startsWith("0x")) {
        receipt = await provider.getTransactionReceipt(`0x${txHash}`)
        if (receipt) {
          console.log(`[DEPLOY] Transaction confirmed in block: ${receipt.blockNumber}`)
          return receipt
        }
      }

      // If hash starts with 0x, try without it
      if (txHash.startsWith("0x")) {
        receipt = await provider.getTransactionReceipt(txHash.slice(2))
        if (receipt) {
          console.log(`[DEPLOY] Transaction confirmed in block: ${receipt.blockNumber}`)
          return receipt
        }
      }
    } catch (err) {
      console.warn(`[DEPLOY] Error getting receipt for ${txHash}:`, err.message)
    }

    await sleep(3000) // Wait 3 seconds before trying again
  }

  throw new Error(`Transaction receipt not found after ${maxWaitTime}ms for hash: ${txHash}`)
}

async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment")
    return
  }

  await hre.run("compile")
  const [deployer] = await hre.ethers.getSigners()

  console.log("[DEPLOY] Network:", hre.network.name)
  console.log("[DEPLOY] Deployer:", deployer.address)

  // Debug ethers version
  console.log("[DEPLOY] Ethers utils available:", !!hre.ethers.utils)
  console.log("[DEPLOY] Ethers formatEther available:", !!hre.ethers.formatEther)

  // Fetch and print balance
  const balance = await hre.ethers.provider.getBalance(deployer.address)
  console.log("[DEPLOY] Balance (native):", formatEther(balance))

  // env/config
  const OWNER = process.env.OWNER || deployer.address
  const FEE_SINK = process.env.FEE_SINK || deployer.address
  const BOND_TOKEN = process.env.BOND_TOKEN // required
  const CREATION_FEE = process.env.CREATION_FEE_UNITS || "100" // human units (e.g. "100")
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100" // default 1%

  if (!BOND_TOKEN) throw new Error("❌ BOND_TOKEN is required (ERC20 address).")

  // resolve decimals/symbol so "100" => 100.0 tokens
  const erc20Abi = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"]

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

    try {
      // Get the contract bytecode and constructor args
      const deployTx = await Factory.getDeployTransaction(...args)
      console.log(`[DEPLOY] ${name} deploy transaction prepared`)

      // Estimate gas
      const estimatedGas = await deployer.estimateGas(deployTx)
      console.log(`[DEPLOY] ${name} estimated gas:`, estimatedGas.toString())

      // Get current nonce
      const nonce = await hre.ethers.provider.getTransactionCount(deployer.address, "pending")
      console.log(`[DEPLOY] ${name} nonce:`, nonce)

      // Prepare transaction object manually - use provider.sendTransaction directly
      const txRequest = {
        from: deployer.address,
        to: null, // deployment
        data: deployTx.data,
        gasLimit: estimatedGas,
        nonce: nonce,
        value: 0,
      }

      // Add fee data if available
      try {
        const feeData = await hre.ethers.provider.getFeeData()
        if (feeData.gasPrice) {
          txRequest.gasPrice = feeData.gasPrice
        }
        if (feeData.maxFeePerGas) {
          txRequest.maxFeePerGas = feeData.maxFeePerGas
        }
        if (feeData.maxPriorityFeePerGas) {
          txRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
        }
      } catch (err) {
        console.warn(`[DEPLOY] Could not get fee data:`, err.message)
      }

      await waitForQueue(deployer.address)

      // Send transaction using provider.send directly to bypass Hardhat's transaction handling
      console.log(`[DEPLOY] ${name} sending transaction via provider...`)
      const txHash = await withQueueRetries(async () => {
        // Use eth_sendTransaction instead of sendTransaction to avoid Hardhat's wrapper
        const hash = await hre.ethers.provider.send("eth_sendTransaction", [txRequest])
        console.log(`[DEPLOY] ${name} transaction sent:`, hash)
        return hash
      }, `${name} send`)

      // Wait for receipt using our custom function
      const receipt = await withQueueRetries(
        () => waitForTransactionReceipt(hre.ethers.provider, txHash),
        `${name} wait`,
      )

      console.log(`[DEPLOY] ✅ ${name} deployed at:`, receipt.contractAddress)
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
