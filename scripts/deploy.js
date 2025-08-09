require("dotenv").config()
const hre = require("hardhat")
const fs = require("fs")

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase()
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full")
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

async function main() {
  if (process.env.SKIP_DEPLOY === "true") {
    console.log("⚡ SKIP_DEPLOY is true — skipping contract deployment")
    return
  }

  await hre.run("compile")
  const [deployer] = await hre.ethers.getSigners()

  console.log("[DEPLOY] Network:", hre.network.name)
  console.log("[DEPLOY] Deployer:", deployer.address)

  const balance = await hre.ethers.provider.getBalance(deployer.address)
  console.log("[DEPLOY] Balance (native):", hre.ethers.utils.formatEther(balance))

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

  const creationFeeWei = hre.ethers.utils.parseUnits(String(CREATION_FEE), decimals)
  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol} (${creationFeeWei.toString()} base units)`)

  async function deployOne(name, args) {
    console.log(`\n[DEPLOY] ${name}...`)
    const Factory = await hre.ethers.getContractFactory(name)

    console.log(
      `[DEPLOY] ${name} interface loaded:`,
      Factory.interface.fragments.map((f) => f.name || f.type),
    )

    try {
      // Prepare the deployment transaction
      const deployTx = await Factory.getDeployTransaction(...args)
      console.log(`[DEPLOY] ${name} raw deploy TX:`, deployTx)

      // Estimate gas
      const estimatedGas = await deployer.estimateGas(deployTx)
      console.log(`[DEPLOY] ${name} estimated gas:`, estimatedGas.toString())

      // Set gas limit with buffer
      deployTx.gasLimit = estimatedGas.mul(12).div(10) // 20% buffer

      // Optional fee caps
      try {
        const fee = await hre.ethers.provider.getFeeData()
        if (fee && fee.maxFeePerGas != null) deployTx.maxFeePerGas = fee.maxFeePerGas
        if (fee && fee.maxPriorityFeePerGas != null) deployTx.maxPriorityFeePerGas = fee.maxPriorityFeePerGas
      } catch (err) {
        console.warn(`[DEPLOY] Could not get fee data:`, err.message)
      }

      await waitForQueue(deployer.address)

      // Send transaction with queue retries
      const sentTx = await withQueueRetries(() => deployer.sendTransaction(deployTx), `${name} send`)

      console.log(`[DEPLOY] ${name} sent raw TX:`, sentTx.hash)

      // Wait for confirmation with custom error handling
      let receipt
      try {
        receipt = await sentTx.wait()
      } catch (waitError) {
        console.warn(`[DEPLOY] Error waiting for ${name} receipt:`, waitError.message)

        // If it's the hex prefix error, try to get receipt manually
        if (waitError.message.includes("cannot unmarshal hex string without 0x prefix")) {
          console.log(`[DEPLOY] Attempting manual receipt lookup for ${name}...`)

          // Wait a bit for the transaction to be mined
          await sleep(5000)

          // Try to get receipt directly
          try {
            const hash = sentTx.hash.startsWith("0x") ? sentTx.hash : `0x${sentTx.hash}`
            receipt = await hre.ethers.provider.getTransactionReceipt(hash)

            if (!receipt) {
              // Try without 0x prefix
              const hashWithoutPrefix = sentTx.hash.replace("0x", "")
              receipt = await hre.ethers.provider.getTransactionReceipt(hashWithoutPrefix)
            }
          } catch (receiptError) {
            console.error(`[DEPLOY] Could not get receipt for ${name}:`, receiptError.message)
            throw receiptError
          }
        } else {
          throw waitError
        }
      }

      if (!receipt) {
        throw new Error(`[DEPLOY] No receipt found for ${name}`)
      }

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
