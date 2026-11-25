/**
 * Blitz Roll Arena — end-to-end devnet test.
 *
 * Full game loop against the real MagicBlock devnet Ephemeral Rollup:
 *   create_game (L1) -> join_game (L1) -> delegate_game (L1)
 *   -> roll_dice x2 per round (ER, VRF) -> undelegate_game (ER)
 *   -> claim_pot (L1)
 *
 * All transactions are sent and confirmed over plain HTTP (signature-status
 * polling) — no websocket subscriptions, which are unreliable behind some
 * proxies. Prints every transaction signature so each step is verifiable.
 *
 * Prerequisites: program deployed to devnet; deployer keypair funded.
 * Run:  npx tsx tests/e2e.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKDIR = path.resolve(ROOT, "..");

const BASE_RPC = process.env.BASE_RPC || "https://api.devnet.solana.com";
const ROUTER_RPC = "https://devnet-router.magicblock.app";

const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const EPHEMERAL_ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const MAGIC_PROGRAM_ID = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT_ID = new PublicKey("MagicContext1111111111111111111111111111111");

const GAME_SEED = Buffer.from("game");
const VAULT_SEED = Buffer.from("vault");
const STAKE = 0.05 * LAMPORTS_PER_SOL;
const PLAYER_FUND = 0.3 * LAMPORTS_PER_SOL;

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const explorerAddr = (addr: PublicKey) =>
  `https://explorer.solana.com/address/${addr.toBase58()}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

function loadOrCreateKeypair(file: string): Keypair {
  if (fs.existsSync(file)) return loadKeypair(file);
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

/** Send a tx and confirm it by polling signature statuses over HTTP. */
async function sendAndConfirm(
  conn: Connection,
  ix: TransactionInstruction,
  payer: Keypair,
  label: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let sig: string;
    try {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
      tx.add(ix);
      tx.sign(payer);
      sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    } catch (e) {
      console.log(`    (${label}: send attempt ${attempt} errored: ${String(e).slice(0, 120)}; retrying)`);
      await sleep(4000);
      continue;
    }
    // Poll for up to ~100s. Deliberately no slot-based early exit: behind a
    // load balancer / proxy the reported slot and the blockhash's validity
    // window can come from skewed node views, and a landed tx is still
    // findable via searchTransactionHistory after its blockhash expires.
    const deadline = Date.now() + 100_000;
    for (;;) {
      const st = await conn
        .getSignatureStatuses([sig], { searchTransactionHistory: true })
        .then((r) => r.value[0])
        .catch(() => null);
      if (st) {
        if (st.err) {
          const full = await conn.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
          }).catch(() => null);
          const logs = full?.meta?.logMessages?.join("\n") || "(no logs)";
          throw new Error(`${label} failed on-chain: ${JSON.stringify(st.err)}\n${logs}`);
        }
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") {
          return sig;
        }
      }
      if (Date.now() > deadline) break;
      await sleep(2500);
    }
    console.log(`    (${label}: attempt ${attempt} not confirmed in time, retrying)`);
  }
  throw new Error(`${label}: transaction never landed after retries`);
}

async function getBalanceRetry(conn: Connection, pk: PublicKey): Promise<number> {
  for (let i = 0; i < 6; i++) {
    try {
      return await conn.getBalance(pk);
    } catch {
      await sleep(3000);
    }
  }
  throw new Error(`getBalance failed for ${pk.toBase58()}`);
}

async function poll<T>(label: string, timeoutMs: number, fn: () => Promise<T | null>): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== null && v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(1500);
  }
}

async function getClosestValidator(): Promise<{ identity: string; fqdn: string }> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(ROUTER_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
      });
      const j: any = await r.json();
      if (j?.result?.identity) return j.result;
    } catch { /* retry */ }
    await sleep(3000);
  }
  throw new Error("Could not reach the MagicBlock router");
}

async function main() {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/blitz_roll_arena.json"), "utf8"));
  const programId = new PublicKey(idl.address);
  console.log(`Program: ${programId.toBase58()}  ${explorerAddr(programId)}`);

  const deployer = loadKeypair(path.join(WORKDIR, "deployer-keypair.json"));
  const player1 = loadOrCreateKeypair(path.join(WORKDIR, "player1-keypair.json"));
  const player2 = loadOrCreateKeypair(path.join(WORKDIR, "player2-keypair.json"));
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Player 1: ${player1.publicKey.toBase58()}`);
  console.log(`Player 2: ${player2.publicKey.toBase58()}`);

  const baseConn = new Connection(BASE_RPC, "confirmed");
  const mkProgram = (conn: Connection, kp: Keypair) =>
    new Program(
      idl,
      new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" }),
    ) as any;
  const baseProgram = mkProgram(baseConn, deployer);

  const deployerBal = await getBalanceRetry(baseConn, deployer.publicKey);
  console.log(`Deployer balance: ${deployerBal / LAMPORTS_PER_SOL} SOL`);
  if (deployerBal < 0.8 * LAMPORTS_PER_SOL) throw new Error("Deployer underfunded (< 0.8 SOL)");

  // Fund both players from the deployer if needed.
  for (const p of [player1, player2]) {
    const bal = await getBalanceRetry(baseConn, p.publicKey);
    if (bal < 0.2 * LAMPORTS_PER_SOL) {
      const ix = SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: p.publicKey,
        lamports: PLAYER_FUND - bal,
      });
      const sig = await sendAndConfirm(baseConn, ix, deployer, `fund ${p.publicKey.toBase58()}`);
      console.log(`Funded ${p.publicKey.toBase58()}: ${explorerTx(sig)}`);
    }
  }

  const gameId = new BN(Date.now());
  const [gamePda] = PublicKey.findProgramAddressSync(
    [GAME_SEED, gameId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, gameId.toArrayLike(Buffer, "le", 8)],
    programId,
  );
  console.log(`\nGame ID: ${gameId.toString()}`);
  console.log(`Game PDA: ${gamePda.toBase58()}  ${explorerAddr(gamePda)}`);
  console.log(`Vault PDA: ${vaultPda.toBase58()}`);

  const sigs: Record<string, string> = {};
  const progP1 = mkProgram(baseConn, player1);
  const progP2 = mkProgram(baseConn, player2);

  // 1) create_game (player 1, base layer)
  sigs.create_game = await sendAndConfirm(
    baseConn,
    await progP1.methods.createGame(gameId, new BN(STAKE)).accounts({
      game: gamePda, vault: vaultPda, player1: player1.publicKey,
      systemProgram: SystemProgram.programId,
    }).instruction(),
    player1, "create_game",
  );
  console.log(`\n[1] create_game: ${explorerTx(sigs.create_game)}`);

  // 2) join_game (player 2, base layer)
  sigs.join_game = await sendAndConfirm(
    baseConn,
    await progP2.methods.joinGame(gameId).accounts({
      game: gamePda, vault: vaultPda, player: player2.publicKey,
      systemProgram: SystemProgram.programId,
    }).instruction(),
    player2, "join_game",
  );
  console.log(`[2] join_game: ${explorerTx(sigs.join_game)}`);

  const vaultBal = await getBalanceRetry(baseConn, vaultPda);
  console.log(`    Vault balance: ${vaultBal / LAMPORTS_PER_SOL} SOL (expect 0.1)`);
  if (vaultBal !== 2 * STAKE) throw new Error("Vault does not hold both stakes");

  // 3) delegate_game to the closest ER validator (base layer tx)
  const closest = await getClosestValidator();
  console.log(`    Closest ER validator: ${closest.identity} @ ${closest.fqdn}`);
  const validator = new PublicKey(closest.identity);
  sigs.delegate_game = await sendAndConfirm(
    baseConn,
    await progP1.methods.delegateGame(gameId)
      .accounts({ payer: player1.publicKey, game: gamePda })
      .remainingAccounts([{ pubkey: validator, isSigner: false, isWritable: false }])
      .instruction(),
    player1, "delegate_game",
  );
  console.log(`[3] delegate_game: ${explorerTx(sigs.delegate_game)}`);

  const erConn = new Connection(closest.fqdn, "confirmed");
  await poll("game account visible on the ER", 90_000, async () => {
    const info = await erConn.getAccountInfo(gamePda);
    return info && info.data.length > 0 ? true : null;
  });
  console.log("    Game account is live on the Ephemeral Rollup");

  const erProg1 = mkProgram(erConn, player1);
  const erProg2 = mkProgram(erConn, player2);
  const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], programId);
  const fetchGameEr = async () => {
    try { return await erProg1.account.game.fetch(gamePda); } catch { return null; }
  };
  const rollAccounts = (payer: PublicKey) => ({
    payer, game: gamePda, oracleQueue: EPHEMERAL_ORACLE_QUEUE,
    programIdentity, vrfProgram: VRF_PROGRAM_ID, slotHashes: SLOT_HASHES_SYSVAR,
    systemProgram: SystemProgram.programId,
  });

  // 4) Roll rounds until the match is decided (ties re-roll automatically).
  let round = 0;
  let finalGame: any = null;
  for (;;) {
    round += 1;
    if (round > 10) throw new Error("Too many tied rounds");
    const before: any = await fetchGameEr();
    console.log(`\n[4] Round ${before?.round ?? round}: rolling...`);

    sigs[`roll_p1_r${round}`] = await sendAndConfirm(
      erConn,
      await erProg1.methods.rollDice(gameId, round * 2 - 1).accounts(rollAccounts(player1.publicKey)).instruction(),
      player1, `roll_dice p1 r${round}`,
    );
    console.log(`    player 1 roll_dice (ER): ${sigs[`roll_p1_r${round}`]}`);
    const afterP1: any = await poll(`player 1 roll result round ${round}`, 90_000, async () => {
      const g: any = await fetchGameEr();
      return g && g.roll1 >= 1 && g.roll1 <= 6 ? g : null;
    });
    console.log(`    player 1 rolled: ${afterP1.roll1}`);

    sigs[`roll_p2_r${round}`] = await sendAndConfirm(
      erConn,
      await erProg2.methods.rollDice(gameId, round * 2).accounts(rollAccounts(player2.publicKey)).instruction(),
      player2, `roll_dice p2 r${round}`,
    );
    console.log(`    player 2 roll_dice (ER): ${sigs[`roll_p2_r${round}`]}`);
    const afterP2: any = await poll(`round ${round} resolution`, 90_000, async () => {
      const g: any = await fetchGameEr();
      if (!g) return null;
      if (g.winner) return g;
      if (g.roll1 === 0 && g.roll2 === 0 && Number(g.round) > round) return g; // tie
      return null;
    });
    if (afterP2.winner) {
      console.log(`    player 2 rolled: ${afterP2.roll2} -> WINNER: ${afterP2.winner.toBase58()}`);
      finalGame = afterP2;
      break;
    }
    console.log("    Tie — re-rolling next round");
  }

  // 5) undelegate_game (ER tx): commit final state back to L1.
  sigs.undelegate_game = await sendAndConfirm(
    erConn,
    await erProg1.methods.undelegateGame(gameId).accounts({
      payer: player1.publicKey, game: gamePda,
      magicProgram: MAGIC_PROGRAM_ID, magicContext: MAGIC_CONTEXT_ID,
    }).instruction(),
    player1, "undelegate_game",
  );
  console.log(`\n[5] undelegate_game (ER): ${sigs.undelegate_game}`);

  const settled: any = await poll("game undelegated back on L1 with winner", 120_000, async () => {
    const info = await baseConn.getAccountInfo(gamePda);
    if (!info || !info.owner.equals(programId)) return null;
    const g: any = await baseProgram.account.game.fetch(gamePda);
    return g.winner ? g : null;
  });
  const winnerPk: PublicKey = settled.winner;
  console.log(`    Settled on L1. Winner: ${winnerPk.toBase58()}`);

  // 6) claim_pot (base layer). Paid by the deployer so the winner's delta is exact.
  const winnerBalBefore = await getBalanceRetry(baseConn, winnerPk);
  sigs.claim_pot = await sendAndConfirm(
    baseConn,
    await baseProgram.methods.claimPot(gameId).accounts({
      game: gamePda, vault: vaultPda, player1: player1.publicKey, player2: player2.publicKey,
      payer: deployer.publicKey, systemProgram: SystemProgram.programId,
    }).instruction(),
    deployer, "claim_pot",
  );
  console.log(`[6] claim_pot: ${explorerTx(sigs.claim_pot)}`);

  const winnerBalAfter = await getBalanceRetry(baseConn, winnerPk);
  const delta = winnerBalAfter - winnerBalBefore;
  console.log(`    Winner received ${delta / LAMPORTS_PER_SOL} SOL (expect 0.1)`);
  if (delta !== 2 * STAKE) throw new Error(`Unexpected payout delta: ${delta} lamports`);

  console.log("\n=== END-TO-END GAME COMPLETE ===");
  console.log(JSON.stringify({
    programId: programId.toBase58(),
    gameId: gameId.toString(),
    gamePda: gamePda.toBase58(),
    winner: winnerPk.toBase58(),
    finalRolls: { roll1: finalGame.roll1, roll2: finalGame.roll2, rounds: Number(finalGame.round) },
    sigs,
  }, null, 2));
}

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
