import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import {
  ConnectionProvider,
  WalletProvider,
  useAnchorWallet,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BASE_RPC,
  DICE_FACES,
  EPHEMERAL_ORACLE_QUEUE,
  IDL,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PROGRAM_ID,
  ROLL_PENDING,
  ROUTER_RPC,
  ROUTER_WS,
  SLOT_HASHES_SYSVAR,
  VRF_PROGRAM_ID,
  explorerAddr,
  explorerTx,
  gamePda,
  loadFqdn,
  programIdentityPda,
  saveFqdn,
  short,
  vaultPda,
} from "./lib";

type Game = {
  gameId: BN;
  player1: PublicKey;
  player2: PublicKey | null;
  stake: BN;
  paid: boolean;
  round: number;
  roll1: number;
  roll2: number;
  winner: PublicKey | null;
};

type LogEntry = { label: string; sig: string };

function useProgram(conn: Connection | null) {
  const anchorWallet = useAnchorWallet();
  return useMemo(() => {
    if (!conn || !anchorWallet) return null;
    const provider = new anchor.AnchorProvider(conn, anchorWallet, {
      commitment: "confirmed",
    });
    return new Program(IDL, provider) as any;
  }, [conn, anchorWallet]);
}

function Arena() {
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const baseConn = useMemo(() => new Connection(BASE_RPC, "confirmed"), []);
  const router = useMemo(
    () => new ConnectionMagicRouter(ROUTER_RPC, { wsEndpoint: ROUTER_WS }),
    [],
  );
  const baseProgram = useProgram(baseConn);

  const [gameIdStr, setGameIdStr] = useState<string>(() => {
    const q = new URLSearchParams(window.location.search).get("game");
    return q || "";
  });
  const [stakeSol, setStakeSol] = useState("0.05");
  const [game, setGame] = useState<Game | null>(null);
  const [delegated, setDelegated] = useState(false);
  const [fqdn, setFqdn] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const busyRef = useRef(false);

  const gameId = useMemo(() => {
    try {
      return gameIdStr ? BigInt(gameIdStr) : null;
    } catch {
      return null;
    }
  }, [gameIdStr]);

  const erConn = useMemo(
    () => (fqdn ? new Connection(fqdn, "confirmed") : null),
    [fqdn],
  );
  const erProgram = useProgram(erConn);

  const addLog = (label: string, sig: string) =>
    setLog((l) => [{ label, sig }, ...l].slice(0, 8));

  // Adopt ?er= from a shared link.
  useEffect(() => {
    const er = new URLSearchParams(window.location.search).get("er");
    if (er && gameId !== null) {
      saveFqdn(gameId, er);
      setFqdn(er);
    }
  }, [gameId]);

  const readProgram = useCallback(
    (conn: Connection) => {
      const w =
        anchorWallet ??
        ({
          publicKey: PublicKey.default,
          signTransaction: async (t: any) => t,
          signAllTransactions: async (t: any) => t,
        } as any);
      return new Program(
        IDL,
        new anchor.AnchorProvider(conn, w, { commitment: "confirmed" }),
      ) as any;
    },
    [anchorWallet],
  );

  const refresh = useCallback(async () => {
    if (gameId === null) {
      setGame(null);
      setDelegated(false);
      return;
    }
    const pda = gamePda(gameId);
    try {
      const info = await baseConn.getAccountInfo(pda);
      const isDelegated = !!info && info.owner.equals(DELEGATION_PROGRAM_ID);
      setDelegated(isDelegated);
      if (isDelegated) {
        let f = loadFqdn(gameId);
        if (!f) {
          const closest = await router.getClosestValidator();
          f = closest.fqdn || "https://devnet.magicblock.app";
          saveFqdn(gameId, f);
        }
        setFqdn(f);
        const prog = readProgram(new Connection(f, "confirmed"));
        const g = await prog.account.game.fetch(pda);
        setGame(g);
      } else if (info && info.owner.equals(PROGRAM_ID)) {
        const g = await readProgram(baseConn).account.game.fetch(pda);
        setGame(g);
      } else {
        setGame(null);
      }
    } catch {
      /* transient RPC errors are ignored; next poll retries */
    }
  }, [gameId, baseConn, router, readProgram]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(label);
    setError(null);
    try {
      const sig = await fn();
      addLog(label, sig);
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const createGame = () =>
    run("create_game", async () => {
      if (!baseProgram || !publicKey) throw new Error("Connect a wallet first");
      const id = BigInt(Date.now());
      const stake = Math.round(parseFloat(stakeSol) * LAMPORTS_PER_SOL);
      if (!Number.isFinite(stake) || stake < 0) throw new Error("Invalid stake");
      const sig = await baseProgram.methods
        .createGame(new BN(id.toString()), new BN(stake))
        .accounts({
          game: gamePda(id),
          vault: vaultPda(id),
          player1: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      setGameIdStr(id.toString());
      return sig;
    });

  const joinGame = () =>
    run("join_game", async () => {
      if (!baseProgram || !publicKey || gameId === null)
        throw new Error("Connect a wallet and load a game first");
      return baseProgram.methods
        .joinGame(new BN(gameId.toString()))
        .accounts({
          game: gamePda(gameId),
          vault: vaultPda(gameId),
          player: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

  const delegateGame = () =>
    run("delegate_game", async () => {
      if (!baseProgram || !publicKey || gameId === null)
        throw new Error("Connect a wallet and load a game first");
      const closest = await router.getClosestValidator();
      if (!closest.identity || !closest.fqdn)
        throw new Error("Router returned no validator");
      saveFqdn(gameId, closest.fqdn);
      setFqdn(closest.fqdn);
      return baseProgram.methods
        .delegateGame(new BN(gameId.toString()))
        .accounts({ payer: publicKey, game: gamePda(gameId) })
        .remainingAccounts([
          { pubkey: new PublicKey(closest.identity), isSigner: false, isWritable: false },
        ])
        .rpc();
    });

  const roll = () =>
    run("roll_dice (ER)", async () => {
      if (!erProgram || !publicKey || gameId === null)
        throw new Error("Game is not on the Ephemeral Rollup yet");
      const seed = Math.floor(Math.random() * 256);
      return erProgram.methods
        .rollDice(new BN(gameId.toString()), seed)
        .accounts({
          payer: publicKey,
          game: gamePda(gameId),
          oracleQueue: EPHEMERAL_ORACLE_QUEUE,
          programIdentity: programIdentityPda(),
          vrfProgram: VRF_PROGRAM_ID,
          slotHashes: SLOT_HASHES_SYSVAR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

  const settle = () =>
    run("undelegate_game (ER)", async () => {
      if (!erProgram || !publicKey || gameId === null)
        throw new Error("Game is not on the Ephemeral Rollup");
      return erProgram.methods
        .undelegateGame(new BN(gameId.toString()))
        .accounts({
          payer: publicKey,
          game: gamePda(gameId),
          magicProgram: MAGIC_PROGRAM_ID,
          magicContext: MAGIC_CONTEXT_ID,
        })
        .rpc();
    });

  const claim = () =>
    run("claim_pot", async () => {
      if (!baseProgram || !publicKey || gameId === null || !game)
        throw new Error("Connect a wallet and load a settled game first");
      return baseProgram.methods
        .claimPot(new BN(gameId.toString()))
        .accounts({
          game: gamePda(gameId),
          vault: vaultPda(gameId),
          player1: game.player1,
          player2: game.player2,
          payer: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    });

  const me = publicKey;
  const iAmP1 = !!(me && game && me.equals(game.player1));
  const iAmP2 = !!(me && game?.player2 && me.equals(game.player2));
  const iAmPlayer = iAmP1 || iAmP2;
  const myRoll = iAmP1 ? game?.roll1 : iAmP2 ? game?.roll2 : undefined;
  const stakeNum = game ? Number(game.stake) / LAMPORTS_PER_SOL : 0;
  const shareUrl =
    gameId !== null
      ? `${window.location.origin}${window.location.pathname}?game=${gameId.toString()}${
          fqdn ? `&er=${encodeURIComponent(fqdn)}` : ""
        }`
      : null;

  const dice = (v: number | undefined, label: string) => {
    if (v === undefined) return <div className="dice">🎲</div>;
    if (v === 0) return <div className="dice">🎲</div>;
    if (v === ROLL_PENDING) return <div className="dice pending">🎲</div>;
    return <div className="dice">{DICE_FACES[v]}</div>;
  };

  let status: string;
  if (!game) status = gameId === null ? "" : "Game not found (yet). Create it or check the ID.";
  else if (!game.player2) status = "Waiting for player 2 to join…";
  else if (!delegated && !game.winner)
    status = "Both players are in. Delegate the game to the Ephemeral Rollup to start rolling.";
  else if (delegated && !game.winner)
    status = `Round ${game.round}: rolls happen on the Ephemeral Rollup (~10ms blocks, zero fees). Dice are decided by MagicBlock VRF.`;
  else if (game.winner && delegated)
    status = "Match decided! Settle to commit the result back to Solana L1.";
  else if (game.winner && !game.paid)
    status = `Winner: ${short(game.winner)}. The pot is ready to claim.`;
  else status = "Pot claimed. Game over — create a new room to play again.";

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>🎲 Blitz <span className="roll">Roll</span> Arena</h1>
          <p className="tagline">
            Real-time dice duels on Solana — MagicBlock Ephemeral Rollups + VRF.
            Devnet only; play money, real on-chain stakes.
          </p>
        </div>
        <WalletMultiButton />
      </header>

      <div className="card">
        <h2>Start a room</h2>
        <div className="row">
          <label>
            Stake (SOL)&nbsp;
            <input
              value={stakeSol}
              onChange={(e) => setStakeSol(e.target.value)}
              size={6}
              inputMode="decimal"
            />
          </label>
          <button className="action" onClick={createGame} disabled={!me || !!busy}>
            {busy === "create_game" ? "Creating…" : "Create game"}
          </button>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <input
            placeholder="Game ID (from the creator)"
            value={gameIdStr}
            onChange={(e) => setGameIdStr(e.target.value.trim())}
            style={{ flex: 1 }}
          />
          {game && !game.player2 && me && !iAmP1 && (
            <button className="action alt" onClick={joinGame} disabled={!!busy}>
              {busy === "join_game" ? "Joining…" : `Join & match ${stakeNum} SOL`}
            </button>
          )}
        </div>
        {shareUrl && game && (
          <p className="hint">
            Share this link with your opponent: <code>{shareUrl}</code>
            <br />
            Program:{" "}
            <a href={explorerAddr(PROGRAM_ID)} target="_blank" rel="noreferrer">
              <code>{PROGRAM_ID.toBase58()}</code>
            </a>{" "}
            · Game PDA: <code>{short(gamePda(gameId!))}</code>
          </p>
        )}
        {error && <div className="err">{error}</div>}
      </div>

      {game && (
        <div className="card">
          <h2>Game #{game.gameId.toString()}</h2>
          <div className="players">
            <div className={`player ${game.winner?.equals(game.player1) ? "winner" : ""}`}>
              <div className="who">Player 1 {iAmP1 && "(you)"}</div>
              <div className="addr">{short(game.player1)}</div>
              {dice(game.roll1, "p1")}
              <div>{game.roll1 >= 1 && game.roll1 <= 6 ? `Rolled ${game.roll1}` : game.roll1 === ROLL_PENDING ? "Rolling…" : "Not rolled"}</div>
            </div>
            <div className="vs">VS</div>
            <div className={`player ${game.player2 && game.winner?.equals(game.player2) ? "winner" : ""}`}>
              <div className="who">Player 2 {iAmP2 && "(you)"}</div>
              <div className="addr">{game.player2 ? short(game.player2) : "—"}</div>
              {dice(game.roll2, "p2")}
              <div>{!game.player2 ? "Waiting…" : game.roll2 >= 1 && game.roll2 <= 6 ? `Rolled ${game.roll2}` : game.roll2 === ROLL_PENDING ? "Rolling…" : "Not rolled"}</div>
            </div>
          </div>

          <div className="meta">
            <span>Stake: <b>{stakeNum} SOL</b> each</span>
            <span>Pot: <b>{stakeNum * 2} SOL</b></span>
            <span>Round: <b>{game.round}</b></span>
            <span>State: <b>{delegated ? "Ephemeral Rollup" : "Solana L1"}</b></span>
          </div>

          <div className="status">{status}</div>

          <div className="row" style={{ marginTop: 14 }}>
            {game.player2 && !delegated && !game.winner && (
              <button className="action" onClick={delegateGame} disabled={!me || !!busy}>
                {busy === "delegate_game" ? "Delegating…" : "Delegate & start"}
              </button>
            )}
            {delegated && !game.winner && iAmPlayer && myRoll === 0 && (
              <button className="action alt" onClick={roll} disabled={!!busy}>
                {busy === "roll_dice (ER)" ? "Rolling…" : "Roll the dice"}
              </button>
            )}
            {delegated && game.winner && (
              <button className="action" onClick={settle} disabled={!me || !!busy}>
                {busy === "undelegate_game (ER)" ? "Settling…" : "Settle to L1"}
              </button>
            )}
            {!delegated && game.winner && !game.paid && (
              <button className="action alt" onClick={claim} disabled={!me || !!busy}>
                {busy === "claim_pot" ? "Claiming…" : `Claim pot (${stakeNum * 2} SOL)`}
              </button>
            )}
          </div>

          {log.length > 0 && (
            <div className="log">
              {log.map((e, i) => (
                <div key={i}>
                  {e.label}:{" "}
                  <a href={explorerTx(e.sig)} target="_blank" rel="noreferrer">
                    {short(e.sig)}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="hint" style={{ marginTop: 24 }}>
        How it works: both players stake devnet SOL into an L1 vault PDA. The game
        account is delegated to a MagicBlock Ephemeral Rollup, where each roll is a
        VRF request (verifiable randomness) resolved in ~10&nbsp;ms with no fees.
        Higher dice wins; ties re-roll. The result is committed back to L1 and the
        winner claims the pot.
      </p>
    </div>
  );
}

export default function App() {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={BASE_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Arena />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
