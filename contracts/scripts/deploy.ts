import { ethers } from "hardhat";

async function main() {
  const [operator] = await ethers.getSigners();
  if (!operator) throw new Error("No deployer account configured");

  const Token = await ethers.getContractFactory("EcoToken");
  const token = await Token.deploy(operator.address);
  await token.waitForDeployment();

  const Registry = await ethers.getContractFactory("RecyclingRegistry");
  const registry = await Registry.deploy(await token.getAddress(), operator.address);
  await registry.waitForDeployment();

  const setup = await token.setMinter(await registry.getAddress());
  await setup.wait();

  const tokenAddress = await token.getAddress();
  const registryAddress = await registry.getAddress();
  console.log("TOKEN_CONTRACT_ADDRESS=", tokenAddress);
  console.log("REGISTRY_CONTRACT_ADDRESS=", registryAddress);
  console.log("DEPLOYER=", operator.address);
  console.log("TOKEN_MINTER (must equal registry)=", await token.minter());
  console.log("REGISTRY_OWNER (must equal deployer)=", await registry.owner());
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
