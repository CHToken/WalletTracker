// // src/verifyTransaction.ts
// import { ethers } from "ethers";
// import dotenv from "dotenv";

// dotenv.config();

// const INFURA_URL = process.env.INFURA_URL as string;
// const RHINO_FI_ADDRESS = "0xaf8aE6955d07776aB690e565Ba6Fbc79B8dE3a5d".toLowerCase();
// const TRANSACTION_HASH = "0xedb4a293ac58677ab36f4e6884df4072269a9d6735eda211c8296a76c11d4884";

// export async function verifyTransaction(): Promise<void> {
//   const provider = new ethers.JsonRpcProvider(INFURA_URL);

//   try {
//     const tx = await provider.getTransaction(TRANSACTION_HASH);

//     if (!tx) {
//       console.log(`Transaction with hash ${TRANSACTION_HASH} not found.`);
//       return;
//     }

//     const receipt = await provider.getTransactionReceipt(TRANSACTION_HASH);
//     console.log("Transaction Receipt:", receipt);

//     if (tx.from.toLowerCase() === RHINO_FI_ADDRESS) {
//       console.log(`Transaction ${TRANSACTION_HASH} is a deposit from the Rhino.fi address.`);
//       console.log(`From: ${tx.from}`);
//       console.log(`To: ${tx.to}`);
//       console.log(`Amount: ${ethers.formatUnits(tx.value)} ETH`);
//       console.log(`Transaction Hash: ${tx.hash}`);
//     } else {
//       console.log(`Transaction ${TRANSACTION_HASH} is NOT a deposit from the Rhino.fi address.`);
//     }
//   } catch (error: any) {
//     console.error("Error verifying transaction:", error.message);
//   }
// }

// verifyTransaction();
