/**
 * $USMNT — "USA Team"
 * FIFA World Cup 2026 — USA vs Paraguay TONIGHT!
 * SoFi Stadium, Los Angeles — June 12, 2026
 * America hosts the World Cup. USMNT plays their first home match in 32 years.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import FormData from 'form-data';
import bs58 from 'bs58';
import { Keypair, Connection } from '@solana/web3.js';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import { AnchorProvider } from '@coral-xyz/anchor';
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
dotenv.config();

const SOLANA_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const MAIN_WALLET_PK = process.env.WALLET_PRIVATE_KEY!;
const PUMP_WALLET_PK = process.env.PUMPFUN_WALLET_PRIVATE_KEY!;
const PINATA_JWT     = process.env.PINATA_JWT!;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';

const LOGO_PATH    = '/tmp/usmnt_logo.png';
const TOKEN_NAME   = 'USMNT';
const TOKEN_SYMBOL = 'USMNT';
const TOKEN_DESC   = 'USA 🦅 vs Paraguay — FIFA World Cup 2026 TONIGHT. SoFi Stadium, Los Angeles. America hosts the greatest tournament on Earth. First US home World Cup match in 32 years. ARE YOU READY? 🇺🇸⚽🏆 LFG!!!';
const TOKEN_WEBSITE = 'https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026';
const TOKEN_TWITTER = '';
const TOKEN_TELEGRAM = '';

const DEV_BUY_SOL  = Number(process.env.USMNT_DEV_BUY  || '0.15');
const PUMP_BUY_SOL = Number(process.env.USMNT_PUMP_BUY || '0.08');

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function pinataUploadFile(filePath: string, filename: string): Promise<string> {
  const { default: axios } = await import('axios');
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename });
  form.append('pinataOptions', JSON.stringify({ cidVersion: 0 }));
  const res = await axios.post('https://api.pinata.cloud/pinning/pinFileToIPFS', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${PINATA_JWT}` },
    maxBodyLength: Infinity,
    timeout: 30000,
  });
  return res.data.IpfsHash as string;
}

async function pinataUploadJson(obj: object, name: string): Promise<string> {
  const { default: axios } = await import('axios');
  const res = await axios.post(
    'https://api.pinata.cloud/pinning/pinJSONToIPFS',
    { pinataContent: obj, pinataMetadata: { name }, pinataOptions: { cidVersion: 0 } },
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PINATA_JWT}` }, timeout: 15000 }
  );
  return res.data.IpfsHash as string;
}

async function launch() {
  if (!PINATA_JWT) throw new Error('PINATA_JWT not set');
  if (!fs.existsSync(LOGO_PATH)) {
    throw new Error(`Logo not found at ${LOGO_PATH}\nUpload: docker cp ./usmnt_logo.png gad-ai-autobuy:/tmp/usmnt_logo.png`);
  }

  const mainKeypair = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PK));
  const pumpKeypair = Keypair.fromSecretKey(bs58.decode(PUMP_WALLET_PK));
  const conn = new Connection(SOLANA_RPC, 'confirmed');

  const [mainBal, pumpBal] = await Promise.all([
    conn.getBalance(mainKeypair.publicKey),
    conn.getBalance(pumpKeypair.publicKey),
  ]);
  console.log('Main wallet:', mainKeypair.publicKey.toBase58(), '—', (mainBal/1e9).toFixed(4), 'SOL');
  console.log('Pump wallet:', pumpKeypair.publicKey.toBase58(), '—', (pumpBal/1e9).toFixed(4), 'SOL');

  const neededMain = (DEV_BUY_SOL + 0.025) * 1e9;
  const neededPump = (PUMP_BUY_SOL + 0.005) * 1e9;
  if (mainBal < neededMain) throw new Error(`Need ${neededMain/1e9} SOL in main, have ${(mainBal/1e9).toFixed(4)}`);
  if (pumpBal < neededPump) throw new Error(`Need ${neededPump/1e9} SOL in pump, have ${(pumpBal/1e9).toFixed(4)}`);

  console.log('\n📌 Uploading logo to Pinata (CIDv0)...');
  const imageCid = await pinataUploadFile(LOGO_PATH, 'usmnt_logo.png');
  const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;
  console.log('✅ Image CID:', imageCid);
  console.log('   Image URL:', imageUrl);

  const { default: axios } = await import('axios');
  const imgCheck = await axios.get(`${PINATA_GATEWAY}${imageCid}`, { responseType: 'arraybuffer', timeout: 10000 });
  console.log('✅ Image verified:', imgCheck.status, Math.round((imgCheck.data as Buffer).length / 1024) + 'KB');

  const metadata = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    description: TOKEN_DESC,
    image: imageUrl,
    website: TOKEN_WEBSITE,
    twitter: TOKEN_TWITTER,
    telegram: TOKEN_TELEGRAM,
    showName: true,
    createdOn: 'https://pump.fun',
  };
  console.log('\n📌 Uploading metadata to Pinata...');
  const metaCid = await pinataUploadJson(metadata, `${TOKEN_SYMBOL}_metadata`);
  const metaUri = `${PINATA_GATEWAY}${metaCid}`;
  console.log('✅ Metadata URI:', metaUri);

  const metaCheck = await axios.get(metaUri, { timeout: 10000 });
  console.log('✅ Metadata OK:', metaCheck.data.name, '| image:', metaCheck.data.image?.slice(0, 60));

  const provider = new AnchorProvider(conn, new NodeWallet(mainKeypair), { commitment: 'confirmed' });
  const sdk = new PumpFunSDK(provider);
  const mintKp = Keypair.generate();

  console.log('\n🚀 Creating $USMNT on pump.fun...');
  console.log('   Mint:', mintKp.publicKey.toBase58());

  const imageBytes = fs.readFileSync(LOGO_PATH);
  const imageBlob = new Blob([imageBytes], { type: 'image/png' });

  const createResult = await sdk.createAndBuy(
    mainKeypair, mintKp,
    { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: metaUri,
      twitter: TOKEN_TWITTER, telegram: TOKEN_TELEGRAM, website: TOKEN_WEBSITE,
      file: imageBlob, description: TOKEN_DESC } as any,
    BigInt(0), 500n,
    { unitLimit: 250000, unitPrice: 250000 }
  );

  if (!createResult?.success) {
    console.error('❌ Create failed:', JSON.stringify(createResult).slice(0, 200));
    process.exit(1);
  }

  const mintAddr = mintKp.publicKey.toBase58();
  console.log('✅ CREATED! Mint:', mintAddr);
  console.log('   Waiting 6s...');
  await sleep(6000);

  for (const [label, wallet, amount] of [
    ['Main dev buy', mainKeypair, DEV_BUY_SOL],
    ['Pump wallet',  pumpKeypair, PUMP_BUY_SOL],
  ] as [string, Keypair, number][]) {
    try {
      console.log(`\n💰 ${label} — ${amount} SOL...`);
      const buyR = await axios.post(
        'https://pumpportal.fun/api/trade-local',
        { publicKey: wallet.publicKey.toBase58(), action: 'buy', mint: mintAddr,
          amount, denominatedInSol: 'true', slippage: 30, priorityFee: 0.003, pool: 'pump' },
        { responseType: 'arraybuffer', timeout: 25000 }
      );
      const bytes = new Uint8Array(buyR.data as ArrayBuffer);
      let sig: string;
      try {
        const { VersionedTransaction } = await import('@solana/web3.js');
        const tx = VersionedTransaction.deserialize(bytes);
        tx.sign([wallet]);
        sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      } catch {
        const { Transaction } = await import('@solana/web3.js');
        const tx = Transaction.from(Buffer.from(bytes));
        tx.partialSign(wallet);
        sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      }
      await conn.confirmTransaction(sig, 'confirmed');
      console.log(`✅ ${label} TX: https://solscan.io/tx/${sig}`);
      await sleep(2000);
    } catch (err: any) {
      const body = err.response?.data ? Buffer.from(err.response.data as ArrayBuffer).toString() : err.message;
      console.warn(`⚠️  ${label} FAILED: ${body.slice(0, 200)}`);
    }
  }

  const [finalMain, finalPump] = await Promise.all([
    conn.getBalance(mainKeypair.publicKey),
    conn.getBalance(pumpKeypair.publicKey),
  ]);

  console.log('\n════════════════════════════════════════');
  console.log('🇺🇸 $USMNT — USA TEAM');
  console.log('pump.fun: https://pump.fun/coin/' + mintAddr);
  console.log('Mint:     ' + mintAddr);
  console.log('Image:    ' + imageUrl);
  console.log('════════════════════════════════════════');
  console.log(`Main after: ${(finalMain/1e9).toFixed(4)} SOL | Pump after: ${(finalPump/1e9).toFixed(4)} SOL`);

  const tgMsg = `🇺🇸 <b>$USMNT — USA Team</b> ⚽

FIFA World Cup 2026 — USA vs Paraguay TONIGHT!
SoFi Stadium, Los Angeles 🏟️

America hosts the World's greatest tournament.
First US home World Cup match in 32 years.

🦅 We are the hosts. We are the team. LFG!!!

💰 Mint: <code>${mintAddr}</code>
📈 <a href="https://pump.fun/coin/${mintAddr}">pump.fun</a>

#USMNT #WorldCup2026 #Solana #pumpfun #USA`;

  console.log('\n📣 TELEGRAM POST (copy to @gadfamilytg):');
  console.log(tgMsg);
}

launch().catch(e => { console.error('FAILED:', e.message, e.stack?.slice(0, 300)); process.exit(1); });
