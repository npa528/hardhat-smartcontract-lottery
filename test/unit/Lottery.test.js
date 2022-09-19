const { assert, expect } = require("chai")
const { network, getNamedAccounts, deployments, ethers } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Lottery Unit Tests", function () {
          let lottery, vrfCoordinatorV2Mock, lotteryEntraceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async () => {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])

              lottery = await ethers.getContract("Lottery", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              lotteryEntraceFee = await lottery.getEntranceFee()
              interval = await lottery.getInterval()
          })

          describe("Constructor", function () {
              it("initialize the Lottery correctly", async () => {
                  // Ideally we make our tests have just 1 assert per "it"
                  const lotteryState = await lottery.getLotteryState()
                  assert.equal(lotteryState.toString(), "0")
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })

          describe("enterLottery", function () {
              it("reverts when you dont pay enough", async () => {
                  await expect(lottery.enterLottery()).to.be.revertedWith("Lottery_NotEnoughETHEntered")
              })

              it("records players when they enter", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  const playerFromContract = await lottery.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })

              it("emits event on enter", async () => {
                  await expect(lottery.enterLottery({ value: lotteryEntraceFee })).to.emit(lottery, "LotteryEnter")
              })

              it("does not allow entrance when lottery is calculating", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  // pretend to be a Chainlink Keeper
                  await lottery.performUpkeep([])
                  await expect(lottery.enterLottery({ value: lotteryEntraceFee })).to.be.revertedWith("Lottery_NotOpen")
              })
          })

          describe("checkUpkeep", function () {
              it("returns false if people have not sent any ETH", async () => {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert(!upkeepNeeded)
              })

              it("returns false if lottery is not open", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await lottery.performUpkeep([])
                  const lotteryState = await lottery.getLotteryState()
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])
                  assert.equal(lotteryState.toString(), "1")
                  assert.equal(upkeepNeeded, false)
              })

              it("returns false if enough time has not passed", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 5]) // use a higher number here if this test fails
                  await network.provider.request({ method: "evm_mine", params: [] })
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                  assert(!upkeepNeeded)
              })
              it("returns true if enough time has passed, has players, ETH, and is open", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.request({ method: "evm_mine", params: [] })
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
                  assert(upkeepNeeded)
              })
          })

          describe("performUpkeep", function () {
              it("it can only run if checkUpkeep is true", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const tx = await lottery.performUpkeep([])
                  assert(tx)
              })

              it("reverts when checkUpkeep is false", async () => {
                  await expect(lottery.performUpkeep([])).to.be.revertedWith("Lottery_UpkeepNotNeeded")
              })

              it("updates the lottery state, emits event and calls the vrf coordinator", async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const txResponse = await lottery.performUpkeep([])
                  const txReceipt = await txResponse.wait(1)
                  const lotteryState = await lottery.getLotteryState()
                  const requestId = txReceipt.events[1].args.requestId
                  assert(requestId.toNumber() > 0)
                  assert(lotteryState.toString() == "1")
              })
          })

          describe("fulfulRandomWords", function () {
              beforeEach(async () => {
                  await lottery.enterLottery({ value: lotteryEntraceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
              })

              it("can only be called after performUpKeep", async () => {
                  await expect(vrfCoordinatorV2Mock.fulfillRandomWords(0, lottery.address)).to.be.revertedWith("nonexistent request")
                  await expect(vrfCoordinatorV2Mock.fulfillRandomWords(1, lottery.address)).to.be.revertedWith("nonexistent request")
              })

              // Way to big
              it("picks a winner, resets, and sends money", async () => {
                  const additionalEntrants = 3
                  const startingAccountIndex = 1 // deployer = 0
                  const accounts = await ethers.getSigners()
                  for (let i = startingAccountIndex; i < startingAccountIndex + additionalEntrants; i++) {
                      const accountConnectedLottery = lottery.connect(accounts[i])
                      await accountConnectedLottery.enterLottery({ value: lotteryEntraceFee })
                  }

                  const startingTimestamp = await lottery.getLatestTimestamp()

                  // This test simulates users entering the lottery and wraps the entire functionality of the lottery
                  // inside a promise that will resolve if everything is successful.
                  // An event listener for the WinnerPicked is set up
                  // Mocks of chainlink keepers and vrf coordinator are used to kickoff this winnerPicked event
                  // All the assertions are done once the WinnerPicked event is fired

                  // performUpkeep (mock being chainlink keepers)
                  // fulfillRandomWords (mock being chainlink vrf)
                  // We will have to wait for the fulfillRandomWords to be called
                  await new Promise(async (resolve, reject) => {
                      lottery.once("WinnerPicked", async () => {
                          console.log("WinnerPicked event fired!")
                          try {
                              const recentWinner = await lottery.getRecentWinner()
                              //   console.log(`recent winner: ${recentWinner}`)
                              //   console.log(accounts[2].address)
                              //   console.log(accounts[0].address)
                              //   console.log(accounts[1].address)
                              //   console.log(accounts[3].address)
                              const lotteryState = await lottery.getLotteryState()
                              const endingTimestamp = await lottery.getLatestTimestamp()
                              const numPlayers = await lottery.getNumberOfPlayers()
                              const winnerEndingBalance = await accounts[1].getBalance()
                              assert.equal(numPlayers.toString(), "0")
                              assert.equal(lotteryState.toString(), "0")
                              assert(endingTimestamp > startingTimestamp)

                              assert.equal(
                                  winnerEndingBalance.toString(),
                                  winnerStartingBalance.add(lotteryEntraceFee.mul(additionalEntrants).add(lotteryEntraceFee).toString())
                              )
                          } catch (e) {
                              reject(e)
                          }
                          resolve()
                      })

                      // Setting up the listener
                      // below, we will fire the event, and the listener will pick it up and resolve
                      const tx = await lottery.performUpkeep([])
                      const txReceipt = await tx.wait(1)
                      const winnerStartingBalance = await accounts[1].getBalance()
                      await vrfCoordinatorV2Mock.fulfillRandomWords(txReceipt.events[1].args.requestId, lottery.address)
                  })
              })
          })
      })
