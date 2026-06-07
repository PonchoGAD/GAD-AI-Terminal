"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SELL_STAGES = void 0;
exports.loadKeypairFromString = loadKeypairFromString;
exports.getKeypairFromEnv = getKeypairFromEnv;
exports.getConnection = getConnection;
exports.getTokenPriceInSol = getTokenPriceInSol;
exports.executeAutoBuy = executeAutoBuy;
exports.executeAutoSell = executeAutoSell;
const web3_js_1 = require("@solana/web3.js");
const axios_1 = __importDefault(require("axios"));
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://api.jup.ag/swap/v1/swap';
const LAMPORTS_PER_SOL = 1000000000;
// ─── Staged sell config ───────────────────────────────────────────────────────
exports.SELL_STAGES = [
    { stage: 1, multiplier: 4.0, sellPct: 75 }, // +300% → sell 75%
    { stage: 2, multiplier: 7.0, sellPct: 75 }, // +600% → sell 75% of remaining
    { stage: 3, multiplier: 11.0, sellPct: 75 }, // +1000%
    { stage: 4, multiplier: 16.0, sellPct: 75 }, // +1500%
    { stage: 5, multiplier: 21.0, sellPct: 75 }, // +2000%
    { stage: 6, multiplier: 31.0, sellPct: 100 }, // +3000% → sell ALL remaining
];
// ─── Keypair loader ───────────────────────────────────────────────────────────
function loadKeypairFromString(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
        try {
            const bytes = JSON.parse(trimmed);
            return web3_js_1.Keypair.fromSecretKey(Uint8Array.from(bytes));
        }
        catch {
            throw new Error('WALLET_PRIVATE_KEY looks like a JSON array but could not be parsed.');
        }
    }
    try {
        const bs58 = require('bs58');
        return web3_js_1.Keypair.fromSecretKey(bs58.decode(trimmed));
    }
    catch {
        throw new Error('Could not decode WALLET_PRIVATE_KEY as base58.');
    }
}
function getKeypairFromEnv() {
    const raw = process.env.WALLET_PRIVATE_KEY;
    if (!raw)
        return null;
    return loadKeypairFromString(raw);
}
function getConnection() {
    const rpc = process.env.SOLANA_RPC || (0, web3_js_1.clusterApiUrl)('mainnet-beta');
    return new web3_js_1.Connection(rpc, { commitment: 'confirmed' });
}
async function getQuote(inputMint, outputMint, amount, slippageBps) {
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: String(amount),
        slippageBps: String(slippageBps)
    });
    const res = await axios_1.default.get(`${JUPITER_QUOTE_URL}?${params}`, { timeout: 10000 });
    return res.data;
}
async function getSwapTransaction(quoteResponse, userPublicKey, priorityFeeMicroLamports) {
    const body = {
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFeeMicroLamports ?? 'auto'
    };
    const res = await axios_1.default.post(JUPITER_SWAP_URL, body, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
    return res.data;
}
async function sendAndConfirm(connection, keypair, swapTransaction) {
    const txBuffer = Buffer.from(swapTransaction, 'base64');
    const tx = web3_js_1.VersionedTransaction.deserialize(txBuffer);
    tx.sign([keypair]);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2
    });
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature, ...latestBlockhash }, 'confirmed');
    return signature;
}
// ─── Get token price in SOL via Jupiter ──────────────────────────────────────
async function getTokenPriceInSol(mintAddress, tokenAmount, slippageBps = 100) {
    const quote = await getQuote(mintAddress, NATIVE_SOL_MINT, Number(tokenAmount), slippageBps);
    const solLamports = Number(quote.outAmount);
    const priceSol = solLamports / LAMPORTS_PER_SOL;
    return { priceSol, rawQuote: quote };
}
// ─── Buy SOL → TOKEN ─────────────────────────────────────────────────────────
async function executeAutoBuy(params, connection, keypair) {
    const { mintAddress, amountSol, slippageBps = 100, priorityFeeMicroLamports } = params;
    if (amountSol <= 0)
        return { success: false, error: 'amountSol must be > 0' };
    try {
        new web3_js_1.PublicKey(mintAddress);
    }
    catch {
        return { success: false, error: `Invalid mint address: ${mintAddress}` };
    }
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    try {
        const quote = await getQuote(NATIVE_SOL_MINT, mintAddress, lamports, slippageBps);
        const { swapTransaction } = await getSwapTransaction(quote, keypair.publicKey.toBase58(), priorityFeeMicroLamports);
        const signature = await sendAndConfirm(connection, keypair, swapTransaction);
        const outputAmountRaw = BigInt(quote.outAmount);
        const entryPriceSol = Number(outputAmountRaw) > 0
            ? lamports / LAMPORTS_PER_SOL / Number(outputAmountRaw)
            : 0;
        return {
            success: true,
            txSignature: signature,
            inputAmountSol: amountSol,
            outputAmount: quote.outAmount,
            outputAmountRaw,
            entryPriceSol
        };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg.length > 300 ? msg.slice(0, 300) + '...' : msg };
    }
}
// ─── Sell TOKEN → SOL ─────────────────────────────────────────────────────────
async function executeAutoSell(params, connection, keypair) {
    const { mintAddress, tokenAmount, slippageBps = 150, priorityFeeMicroLamports } = params;
    if (tokenAmount <= 0n)
        return { success: false, error: 'tokenAmount must be > 0' };
    try {
        new web3_js_1.PublicKey(mintAddress);
    }
    catch {
        return { success: false, error: `Invalid mint address: ${mintAddress}` };
    }
    try {
        const quote = await getQuote(mintAddress, NATIVE_SOL_MINT, Number(tokenAmount), slippageBps);
        const { swapTransaction } = await getSwapTransaction(quote, keypair.publicKey.toBase58(), priorityFeeMicroLamports);
        const signature = await sendAndConfirm(connection, keypair, swapTransaction);
        const solLamports = Number(quote.outAmount);
        const solReceived = solLamports / LAMPORTS_PER_SOL;
        const currentPriceSol = Number(tokenAmount) > 0 ? solReceived / Number(tokenAmount) : 0;
        return {
            success: true,
            txSignature: signature,
            tokensIn: tokenAmount,
            solReceived,
            currentPriceSol
        };
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg.length > 300 ? msg.slice(0, 300) + '...' : msg };
    }
}
