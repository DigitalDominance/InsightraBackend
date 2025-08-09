require("dotenv").config()
const hre = require("hardhat")
const fs = require("fs")

// helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const isQueueErr = (e) => {
  const m = (e?.message || String(e)).toLowerCase()
  return m.includes("no available queue") || m.includes("queue full") || m.includes("txpool is full")
}

// ethers v5/v6 shims
function formatEther(value) {
  if (hre.ethers.utils && hre.ethers.utils.formatEther) {
    // v5
    return hre.ethers.utils.formatEther(value)
  } else if (hre.ethers.formatEther) {
    // v6
    return hre.ethers.formatEther(value)
  }
  return value.toString()
}
function parseUnits(value, decimals) {
  if (hre.ethers.utils && hre.ethers.utils.parseUnits) {
    // v5
    return hre.ethers.utils.parseUnits(value, decimals)
  } else if (hre.ethers.parseUnits) {
    // v6
    return hre.ethers.parseUnits(value, decimals)
  }
  throw new Error("Cannot find parseUnits function")
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

  const balance = await hre.ethers.provider.getBalance(deployer.address)
  console.log("[DEPLOY] Balance (native):", formatEther(balance))

  // env/config
  const OWNER = process.env.OWNER || deployer.address
  const FEE_SINK = process.env.FEE_SINK || deployer.address
  const BOND_TOKEN = process.env.BOND_TOKEN // required
  const CREATION_FEE = process.env.CREATION_FEE_UNITS || "100" // human units
  const REDEEM_FEE_BPS = process.env.REDEEM_FEE_BPS || "100" // default 1%

  if (!BOND_TOKEN) throw new Error("❌ BOND_TOKEN is required (ERC20 address).")
  if (!BOND_TOKEN.startsWith("0x")) throw new Error("❌ BOND_TOKEN must be a 0x-prefixed address.")

  // resolve decimals/symbol so "100" => 100.0 tokens
  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
  ]
  const bond = new hre.ethers.Contract(BOND_TOKEN, erc20Abi, hre.ethers.provider)
  const [decimals, symbol] = await Promise.all([bond.decimals(), bond.symbol().catch(() => "BOND")])

  const creationFeeWei = parseUnits(String(CREATION_FEE), decimals)
  console.log(`[DEPLOY] Creation fee: ${CREATION_FEE} ${symbol} (${creationFeeWei.toString()} base units)`)

  const isV6 = !!hre.ethers.formatEther // crude but reliable

  async function deployOne(name, args) {
    console.log(`\n[DEPLOY] ${name}...`)
    const Factory = await hre.ethers.getContractFactory(name)
    console.log(
      `[DEPLOY] ${name} interface loaded:`,
      Factory.interface.fragments.map((f) => f.name || f.type),
    )

    await waitForQueue(deployer.address)

    try {
      // Standard ethers deploy path -> signs locally -> eth_sendRawTransaction
      const contract = await withQueueRetries(() => Factory.deploy(...args), `${name} deploy`)

      // Get tx hash in both ethers versions
      let txResponse
      if (isV6) {
        txResponse = contract.deploymentTransaction()
      } else {
        txResponse = contract.deployTransaction
      }
      const txHash = txResponse?.hash
      if (txHash) console.log(`[DEPLOY] ${name} tx: ${txHash}`)

      // Wait for deployment/confirmation and receipt
      if (isV6) {
        await withQueueRetries(() => contract.waitForDeployment(), `${name} waitForDeployment`)
        const receipt = await txResponse.wait()
        const addr = await contract.getAddress()
        console.log(`[DEPLOY] ✅ ${name} deployed at: ${addr} (block ${receipt.blockNumber})`)
        return addr
      } else {
        await withQueueRetries(() => contract.deployed(), `${name} deployed()`)
        const receipt = await txResponse.wait()
        console.log(`[DEPLOY] ✅ ${name} deployed at: ${contract.address} (block ${receipt.blockNumber})`)
        return contract.address
      }
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
