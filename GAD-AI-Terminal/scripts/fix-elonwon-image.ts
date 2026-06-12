/**
 * Fix ELONWON image — re-upload with CIDv0 (QmXxx) + update on-chain metadata URI
 * Root cause: CIDv1 (bafybei...) on gateway.pinata.cloud blocked by pump.fun CDN.
 * Fix: re-upload image with cidVersion:0 → QmXxx → use ipfs.io URL → update metadata.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import FormData from 'form-data';
import bs58 from 'bs58';
import {
  Keypair, Connection, PublicKey, Transaction,
  TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
dotenv.config();

const SOLANA_RPC     = process.env.SOLANA_RPC ?? 'https://api.mainnet-beta.solana.com';
const MAIN_WALLET_PK = process.env.WALLET_PRIVATE_KEY!;
const PINATA_JWT     = process.env.PINATA_JWT!;
const PINATA_GATEWAY = process.env.PINATA_GATEWAY ?? 'https://gateway.pinata.cloud/ipfs/';

const MINT_ADDRESS = '61tp47fvb7ym6y8Ut5GJ6xzgCkvPYtcWib3WuDnkPjZK';
const LOGO_PATH    = '/tmp/elonwon_logo.png';

const TOKEN_NAME   = 'Elon Won';
const TOKEN_SYMBOL = 'ELONWON';
const TOKEN_DESC   = 'SpaceX IPO: $135 → $150 on day one. $1.75 TRILLION valuation. The biggest IPO in history. Elon officially became the world\'s first trillionaire TODAY. Bezos is crying. Zuck is crying. The race is OVER. Elon Won. 🚀';
const TOKEN_WEBSITE = 'https://www.npr.org/2026/06/12/nx-s1-5855004/stock-ai-spacex-ipo-elon-musk';

async function pinataUploadFile(filePath: string, filename: string): Promise<string> {
  const { default: axios } = await import('axios');
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), { filename });
  // cidVersion: 0 → produces QmXxx hash, universally supported by pump.fun CDN
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

async function updateTokenMetadata(
  connection: Connection,
  payer: Keypair,
  mintPubkey: PublicKey,
  newUri: string,
  name: string,
  symbol: string,
): Promise<string> {
  const { default: axios } = await import('axios');

  // Metaplex Token Metadata program
  const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

  // Derive metadata account PDA
  const [metadataAccount] = await PublicKey.findProgramAddress(
    [
      Buffer.from('metadata'),
      METADATA_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );

  console.log('Metadata account:', metadataAccount.toBase58());

  // Use Metaplex JS SDK to build updateMetadataAccountV2 instruction
  // We'll build it manually using the instruction data format
  // Instruction discriminator for updateMetadataAccountV2 = 15
  const INSTRUCTION_UPDATE_METADATA_V2 = 15;

  // Encode the instruction data
  // Layout: [u8 instruction, Option<DataV2>, Option<pubkey>, Option<u8>, Option<bool>]
  function encodeString(str: string): Buffer {
    const bytes = Buffer.from(str, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([len, bytes]);
  }

  function optionSome(data: Buffer): Buffer {
    return Buffer.concat([Buffer.from([1]), data]);
  }

  function optionNone(): Buffer {
    return Buffer.from([0]);
  }

  // DataV2 struct
  const nameEncoded   = encodeString(name);
  const symbolEncoded = encodeString(symbol);
  const uriEncoded    = encodeString(newUri);

  // sellerFeeBasisPoints: 0 (u16)
  const fee = Buffer.alloc(2);
  fee.writeUInt16LE(0, 0);

  // creators: None, collection: None, uses: None
  const creatorsNone   = optionNone();
  const collectionNone = optionNone();
  const usesNone       = optionNone();

  const dataV2 = Buffer.concat([
    nameEncoded,
    symbolEncoded,
    uriEncoded,
    fee,
    creatorsNone,
    collectionNone,
    usesNone,
  ]);

  const instructionData = Buffer.concat([
    Buffer.from([INSTRUCTION_UPDATE_METADATA_V2]),
    optionSome(dataV2),    // new_data: Some(DataV2)
    optionNone(),          // new_update_authority: None
    optionNone(),          // primary_sale_happened: None
    optionNone(),          // is_mutable: None
  ]);

  const updateIx = new TransactionInstruction({
    programId: METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataAccount,    isSigner: false, isWritable: true },
      { pubkey: payer.publicKey,    isSigner: true,  isWritable: false },
    ],
    data: instructionData,
  });

  const tx = new Transaction().add(updateIx);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(payer);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function main() {
  if (!PINATA_JWT) throw new Error('PINATA_JWT not set');
  if (!fs.existsSync(LOGO_PATH)) throw new Error(`Logo not at ${LOGO_PATH}`);

  const { default: axios } = await import('axios');
  const keypair = Keypair.fromSecretKey(bs58.decode(MAIN_WALLET_PK));
  const conn = new Connection(SOLANA_RPC, 'confirmed');

  console.log('Wallet:', keypair.publicKey.toBase58());
  console.log('Mint:  ', MINT_ADDRESS);

  // Step 1: Re-upload image with cidVersion:0 (QmXxx)
  console.log('\n📌 Re-uploading image with CIDv0...');
  const imageCid = await pinataUploadFile(LOGO_PATH, 'elonwon_logo.png');
  const imageUrl = `https://ipfs.io/ipfs/${imageCid}`;  // ipfs.io URL — pump.fun CDN can access this
  console.log('✅ Image CID (v0):', imageCid);
  console.log('   Image URL:', imageUrl);

  // Verify accessibility
  const check = await axios.get(
    `${PINATA_GATEWAY}${imageCid}`,
    { responseType: 'arraybuffer', timeout: 15000 }
  );
  console.log('✅ Image verified:', check.status, Math.round((check.data as Buffer).length / 1024) + 'KB');

  // Step 2: Upload new metadata with ipfs.io image URL
  const metadata = {
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    description: TOKEN_DESC,
    image: imageUrl,
    website: TOKEN_WEBSITE,
    showName: true,
    createdOn: 'https://pump.fun',
  };

  console.log('\n📌 Uploading new metadata...');
  const metaCid = await pinataUploadJson(metadata, 'ELONWON_metadata_v2');
  const metaUri = `${PINATA_GATEWAY}${metaCid}`;
  console.log('✅ New metadata URI:', metaUri);

  const metaCheck = await axios.get(metaUri, { timeout: 10000 });
  console.log('✅ Metadata OK | image:', metaCheck.data.image);

  // Step 3: Update on-chain metadata
  console.log('\n🔧 Updating on-chain metadata...');
  const mintPubkey = new PublicKey(MINT_ADDRESS);
  const sig = await updateTokenMetadata(conn, keypair, mintPubkey, metaUri, TOKEN_NAME, TOKEN_SYMBOL);
  console.log('✅ Metadata updated! TX:', `https://solscan.io/tx/${sig.slice(0, 20)}`);

  console.log('\n════════════════════════════════════════');
  console.log('✅ IMAGE FIX COMPLETE');
  console.log('New image URL:', imageUrl);
  console.log('New meta URI: ', metaUri);
  console.log('pump.fun:     ', `https://pump.fun/coin/${MINT_ADDRESS}`);
  console.log('Wait 60s for pump.fun CDN to refresh');
  console.log('════════════════════════════════════════');
}

main().catch(e => { console.error('FAILED:', e.message, e.stack?.slice(0, 300)); process.exit(1); });
