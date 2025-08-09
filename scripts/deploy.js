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
    const estimatedGas = await deployer.estimateGas(deployTx);
    console.log(`[GAS] ${name} estimated gas:`, estimatedGas.toString());

    // Assign the gas limit on the transaction. You may optionally bump
    // this value (e.g. *1.2) to add a safety margin; here we trust the
    // estimate as the network is relatively stable and the deployer has
    // ample balance.
    deployTx.gasLimit = estimatedGas;

    // Send the transaction using the deployer's wallet. The returned
    // `txResponse` contains the hash and other metadata. Hardhat and
    // ethers.js automatically populate nonce, chainId and gas price.
    const txResponse = await deployer.sendTransaction(deployTx);
    // Normalise the hash by ensuring it has a 0x prefix. Some custom
    // JSON-RPC providers omit this prefix, causing clients to reject
    // the hash as invalid. Adding it conditionally ensures universal
    // compatibility.
    let txHash = txResponse.hash;
    if (txHash && typeof txHash === 'string' && !txHash.startsWith('0x')) {
      txHash = '0x' + txHash;
    }
    console.log(`[DEPLOY] ${name} tx:`, txHash);

    // Await confirmation of the deployment. The receipt includes the
    // deployed contract address under contractAddress. Once mined, the
    // factory can be instantiated via `Factory.attach()` if further
    // interaction is required within this script.
    const receipt = await txResponse.wait();
    const address = receipt.contractAddress;
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
