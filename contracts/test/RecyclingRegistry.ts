import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { declarationKey } from "../helpers/declarationKey";

describe("RecyclingRegistry + EcoToken", function () {
  async function deployFixture() {
    const [admin, user, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("EcoToken");
    const token = await Token.deploy(admin.address);
    await token.waitForDeployment();
    const Registry = await ethers.getContractFactory("RecyclingRegistry");
    const registry = await Registry.deploy(await token.getAddress(), admin.address);
    await registry.waitForDeployment();
    await (await token.setMinter(await registry.getAddress())).wait();
    return { admin, user, other, token, registry };
  }

  it("uses the canonical UUID→bytes32 declarationKey (backend-compatible)", async function () {
    const uuid = "11111111-1111-1111-1111-111111111111";
    const key = declarationKey(uuid);
    expect(key).to.equal(ethers.id(uuid.toLowerCase()));
    expect(key).to.equal(ethers.keccak256(ethers.toUtf8Bytes(uuid.toLowerCase())));
    expect(declarationKey(uuid.toUpperCase())).to.equal(key);
  });

  it("mints a valid reward once and emits Rewarded", async function () {
    const { user, registry, token } = await loadFixture(deployFixture);
    const id = declarationKey("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const amount = ethers.parseUnits("25", 18);

    await expect(registry.reward(id, user.address, amount))
      .to.emit(registry, "Rewarded")
      .withArgs(id, user.address, amount);

    expect(await token.balanceOf(user.address)).to.equal(amount);
    expect(await registry.isProcessed(id)).to.equal(true);
    expect(await registry.processedDeclarations(id)).to.equal(true);
  });

  it("rejects an already processed declaration (double mint guard)", async function () {
    const { user, registry, token } = await loadFixture(deployFixture);
    const id = declarationKey("declaration-already-processed");
    const amount = ethers.parseUnits("10", 18);

    await registry.reward(id, user.address, amount);
    await expect(registry.reward(id, user.address, amount)).to.be.revertedWith("Already processed");
    expect(await token.balanceOf(user.address)).to.equal(amount);
  });

  it("rejects double mint with a different beneficiary for the same declarationId", async function () {
    const { user, other, registry, token } = await loadFixture(deployFixture);
    const id = declarationKey("same-id-other-wallet");
    const amount = ethers.parseUnits("7", 18);

    await registry.reward(id, user.address, amount);
    await expect(registry.reward(id, other.address, amount)).to.be.revertedWith("Already processed");
    expect(await token.balanceOf(user.address)).to.equal(amount);
    expect(await token.balanceOf(other.address)).to.equal(0);
  });

  it("rejects invalid beneficiary wallet (zero address)", async function () {
    const { registry } = await loadFixture(deployFixture);
    const id = declarationKey("invalid-wallet");
    await expect(registry.reward(id, ethers.ZeroAddress, 1n)).to.be.revertedWith("Invalid beneficiary");
  });

  it("rejects invalid amount (zero)", async function () {
    const { user, registry } = await loadFixture(deployFixture);
    const id = declarationKey("invalid-amount");
    await expect(registry.reward(id, user.address, 0n)).to.be.revertedWith("Amount must be positive");
  });

  it("rejects invalid declaration id (bytes32 zero)", async function () {
    const { user, registry } = await loadFixture(deployFixture);
    await expect(registry.reward(ethers.ZeroHash, user.address, 1n)).to.be.revertedWith(
      "Invalid declaration id"
    );
  });

  it("rejects unauthorized (non-owner) reward calls", async function () {
    const { other, user, registry } = await loadFixture(deployFixture);
    const id = declarationKey("unauthorized");
    await expect(registry.connect(other).reward(id, user.address, 1n)).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
  });

  it("verifies minter role: only registry can mint; setMinter is one-shot", async function () {
    const { admin, user, other, token, registry } = await loadFixture(deployFixture);
    const registryAddress = await registry.getAddress();

    expect(await token.minter()).to.equal(registryAddress);

    await expect(token.connect(user).mint(user.address, 1n)).to.be.revertedWith("Only registry can mint");
    await expect(token.connect(admin).mint(user.address, 1n)).to.be.revertedWith("Only registry can mint");
    await expect(token.connect(other).setMinter(other.address)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
    await expect(token.connect(admin).setMinter(other.address)).to.be.revertedWith("Minter already configured");
  });

  it("rejects setMinter(zero) before configuration on a fresh token", async function () {
    const [admin, stranger] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("EcoToken");
    const token = await Token.deploy(admin.address);
    await token.waitForDeployment();

    await expect(token.setMinter(ethers.ZeroAddress)).to.be.revertedWith("Invalid minter");
    await expect(token.connect(stranger).setMinter(stranger.address)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
    expect(await token.minter()).to.equal(ethers.ZeroAddress);
  });
});
