import { PublicKey } from "@solana/web3.js";
import idlJson from "./idl/blitz_roll_arena.json";

export const IDL = idlJson as any;
export const PROGRAM_ID = new PublicKey(IDL.address);

export const BASE_RPC = "https://api.devnet.solana.com";
export const ROUTER_RPC = "https://devnet-router.magicblock.app";
export const ROUTER_WS = "wss://devnet-router.magicblock.app";

export const VRF_PROGRAM_ID = new PublicKey(
  "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz",
);
export const EPHEMERAL_ORACLE_QUEUE = new PublicKey(
  "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc",
);
export const SLOT_HASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111",
);
export const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111",
);
export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111",
);
export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);

export const GAME_SEED = Buffer.from("game");
export const VAULT_SEED = Buffer.from("vault");
export const ROLL_PENDING = 7;

export function gamePda(gameId: bigint): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(gameId);
  return PublicKey.findProgramAddressSync([GAME_SEED, buf], PROGRAM_ID)[0];
}

export function vaultPda(gameId: bigint): PublicKey {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(gameId);
  return PublicKey.findProgramAddressSync([VAULT_SEED, buf], PROGRAM_ID)[0];
}

export function programIdentityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID)[0];
}

export const explorerTx = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddr = (pk: PublicKey) =>
  `https://explorer.solana.com/address/${pk.toBase58()}?cluster=devnet`;

export const short = (pk: PublicKey | string) => {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

export const DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

const fqdnKey = (gameId: bigint) => `bra-er-fqdn-${gameId.toString()}`;
export const saveFqdn = (gameId: bigint, fqdn: string) =>
  localStorage.setItem(fqdnKey(gameId), fqdn);
export const loadFqdn = (gameId: bigint) => localStorage.getItem(fqdnKey(gameId));
