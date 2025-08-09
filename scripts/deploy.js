// Deployment script for the prediction market factories.
//
// This script is intentionally simple and mirrors the approach used in
// other Hardhat projects: it compiles the contracts, obtains a signer,
// constructs raw deployment transactions for each factory, estimates
// the gas required, and sends the transactions directly. Waiting for
// confirmations is performed using the receipt returned from `wait()`,
// and the deployed contract addresses are logged on completion.
//
// Environment variables required (see hardhat.config.js for details):
//   - OWNER: the default owner for newly deployed factories (defaults to the deployer address)
//   - FEE_SINK: an address to receive protocol fees (required)
//   - REDEEM_FEE_BPS: the redemption fee, in basis points (defaults to 100)
//   - HARDHAT_NETWORK: optional override for the target network
//   - SKIP_DEPLOY: if set to "true", deployment is skipped entirely

require("dotenv").config();
const hre = require("hardhat");

// Utility to pause execution for a specified number of milliseconds.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits until the network's pending transaction queue for the given
// address is empty or a timeout has elapsed. Some RPC providers on
// kaspaTestnet return "no available queue" errors when the address has
// unmined transactions pending. Monitoring the nonce difference between
// pending and latest allows us to wait for the queue to drain.
async function waitForQueue(provider, address, maxWaitMs = 120000) {
  const start = Date.now();
  while (true) {
    try {
      const pending = await provider.getTransactionCount(address, "pending");
      const latest = await provider.getTransactionCount(address, "latest");
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

async function main() {
  // Respect SKIP_DEPLOY to allow running tests without hitting the network.
  if (String(process.env.SKIP_DEPLOY || "false").toLowerCase() === "true") {
    console.log("⚡ SKIP_DEPLOY=true — skipping contract deployment");
    return;
  }

  // Optionally switch networks at runtime based on HARDHAT_NETWORK. When
  // running via `hardhat run --network <network>` the network is already
  // configured, but this fallback allows environment-based overrides.
  const targetNet = process.env.HARDHAT_NETWORK || "kaspaTestnet";
  if (hre.network.name !== targetNet && typeof hre.changeNetwork === "function") {
    console.log(`[DEPLOY] switching network: ${hre.network.name} → ${targetNet}`);
    hre.changeNetwork(targetNet);
  } else {
    console.log(`[DEPLOY] using network: ${hre.network.name}`);
  }

  // Compile contracts before deployment. Hardhat caches builds, so this is
  // normally a no-op when nothing has changed. It's important to run
  // compile within the script to ensure ABI definitions are up to date.
  await hre.run("compile");
  const netInfo = await hre.ethers.provider.getNetwork();
  console.log("Network:", Number(netInfo.chainId), netInfo.name || "");

  // Acquire the default signer. `getSigners()` returns an array of accounts
  // configured for the selected network; the first account is used by
  // convention as the deployer. The deployer address and balance are
  // displayed for transparency.
  const [deployer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  console.log("Deploying with:", deployer.address);
  const balance = await provider.getBalance(deployer.address);
  console.log("Deployer balance (ETH):", hre.ethers.formatEther(balance));

  // Load deployment parameters from environment variables. OWNER defaults
  // to the deployer address if unset. FEE_SINK must be provided. The
  // redemption fee defaults to 100 basis points (1%).
  const OWNER = process.env.OWNER || deployer.address;
  const FEE_SINK = process.env.FEE_SINK;
  const REDEEM_FEE_BPS = Number(process.env.REDEEM_FEE_BPS || "100");
  if (!FEE_SINK) throw new Error("FEE_SINK env is required");

  console.log("OWNER:", OWNER);
  console.log("FEE_SINK:", FEE_SINK);
  console.log("REDEEM_FEE_BPS:", REDEEM_FEE_BPS);

  // Prepare an array of factories to deploy. Each entry includes the
  // Hardhat contract name and the constructor parameters. This makes
  // iterating deployments straightforward without duplicating logic.
  const deployments = [
    { name: "BinaryFactory", params: [OWNER, FEE_SINK, REDEEM_FEE_BPS] },
    { name: "CategoricalFactory", params: [OWNER, FEE_SINK, REDEEM_FEE_BPS] },
    { name: "ScalarFactory", params: [OWNER, FEE_SINK, REDEEM_FEE_BPS] },
  ];

  // Create a raw ethers Wallet using the deployer's private key. Hardhat's
  // `Signer` implementation performs additional sanity checks on the
  // transaction hash after broadcasting, which invokes
  // `provider.getTransaction()` with the raw hash returned by the node. On
  // kaspaTestnet, the node sometimes returns hashes without a `0x` prefix,
  // causing Hardhat to throw a JSON unmarshalling error. By using a
  // stand‑alone Wallet from ethers.js, we bypass those internal checks and
  // simply broadcast the raw signed transaction. The private key is loaded
  // from the environment via hardhat.config.js. If it is not defined, we
  // fall back to the Hardhat deployer.
  const pk = process.env.PRIVATE_KEY;
  let wallet = null;
  if (pk) {
    wallet = new hre.ethers.Wallet(pk, provider);
  } else {
    // Use the deployer signer if no private key is provided. This should
    // rarely happen because the Hardhat config enforces PRIVATE_KEY. We
    // connect the default deployer to the provider so we can call
    // wallet.sendTransaction() uniformly.
    wallet = deployer;
  }

  for (const { name, params } of deployments) {
    console.log(`\n── Deploying ${name} ──`);
    // Obtain the contract factory. This exposes the ABI and bytecode as
    // well as convenience helpers such as getDeployTransaction().
    const Factory = await hre.ethers.getContractFactory(name);
    console.log(
      `${name} interface loaded:`,
      Factory.interface.fragments.map((f) => f.name || f.type)
    );

    // Build the raw deployment transaction. Passing constructor parameters
    // here ensures the correct bytecode is generated. Note: no gas limit
    // or price is specified yet; those will be set after estimating.
    const deployTx = await Factory.getDeployTransaction(...params);

    // Estimate the gas required for deployment. If this estimate fails
    // (rarely), Hardhat will throw and the catch below will surface the
    // error. Estimating helps prevent underestimating gas and having a
    // transaction revert due to out-of-gas.
    const estimatedGas = await wallet.estimateGas(deployTx);
    console.log(`[GAS] ${name} estimated gas:`, estimatedGas.toString());

    // Assign the gas limit on the transaction. You may optionally bump
    // this value (e.g. *1.2) to add a safety margin; here we trust the
    // estimate as the network is relatively stable and the deployer has
    // ample balance.
    deployTx.gasLimit = estimatedGas;

    // Before sending, wait for the account's pending queue to clear. The
    // kaspaTestnet RPC enforces a single tx queue per account; attempting
    // to send a new transaction while one is unmined results in the
    // "no available queue" error. Waiting ensures the previous deployment
    // completes before proceeding.
    await waitForQueue(provider, wallet.address, 120000);

    // Send the transaction with retry logic. If the provider returns
    // "no available queue", wait and retry up to a few times with
    // exponential backoff. Other errors are rethrown.
    let txResponse;
    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        txResponse = await wallet.sendTransaction(deployTx);
        break;
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        if (/no available queue/i.test(msg) && attempt < maxRetries) {
          const delay = Math.min(60000, 3000 * 2 ** attempt);
          console.log(`[QUEUE] ${name}: queue busy, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }
    if (!txResponse) {
      throw new Error(`Failed to send ${name} deployment transaction`);
    }

    // Normalise the hash by ensuring it has a 0x prefix. Some custom
    // JSON-RPC providers omit this prefix, causing clients to reject
    // the hash as invalid. Adding it conditionally ensures universal
    // compatibility. We also update the hash property on the returned
    // transaction response to avoid Hardhat/ethers from later using the
    // non-prefixed value internally.
    let txHash = txResponse.hash;
    if (txHash && typeof txHash === 'string' && !txHash.startsWith('0x')) {
      txHash = '0x' + txHash;
      try {
        // Override the hash on the response object if possible. Some
        // properties may be read-only, in which case assignment will
        // silently fail. This protects against Hardhat's internal
        // `checkTx()` fetching a transaction by the old hash and
        // encountering an unmarshalling error.
        txResponse.hash = txHash;
      } catch {}
    }
    console.log(`[DEPLOY] ${name} tx:`, txHash);

    // Await confirmation of the deployment. We avoid using txResponse.wait()
    // because Hardhat's internal implementation calls
    // provider.getTransaction() with the raw hash returned from some
    // RPC providers. If the provider omits the "0x" prefix, Hardhat
    // attempts to decode a non-prefixed hex string and throws an
    // unmarshalling error ("invalid argument 0: json: cannot unmarshal hex
    // string without 0x prefix"). Instead, we call `provider.waitForTransaction`
    // ourselves with the normalised hash to retrieve the receipt.
    const receipt = await provider.waitForTransaction(txHash);
    const address = receipt && receipt.contractAddress;
    console.log(`✅ ${name} deployed at:`, address);
  }
}

// Execute the script and properly handle any unhandled errors. In
// Node.js, unhandled promise rejections do not necessarily cause the
// process to exit with a non-zero code, so we explicitly catch and
// report any errors before exiting.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });