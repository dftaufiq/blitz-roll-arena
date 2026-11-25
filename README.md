# Blitz Roll Arena

**Real-time dice duels on Solana.** Two players stake SOL into a pot, the game
account moves onto a **MagicBlock Ephemeral Rollup** where dice rolls resolve
in ~10 ms blocks with zero fees, every roll is decided by **MagicBlock VRF**
(verifiable randomness — nobody picks their dice), and the winner takes the
pot back on Solana L1.

Built for **Solana Blitz v10** (MagicBlock) — theme: *Entertainment Finance*.

## Live on devnet

| | |
|---|---|
| Program ID | `GDQEgMDsQqbKxjcZX3jragWPFhyVaGxDs8qM2xzstwjG` |
| Program (explorer) | https://explorer.solana.com/address/GDQEgMDsQqbKxjcZX3jragWPFhyVaGxDs8qM2xzstwjG?cluster=devnet |
| Frontend (GitHub Pages) | https://dftaufiq.github.io/blitz-roll-arena/ |
| Cluster | Solana devnet + MagicBlock devnet Ephemeral Rollups |

### Proof: a complete game, end to end (devnet, 2026-11-25)

Two scripted players played a full match — create → join → delegate → VRF
rolls → settle → claim. Player 1 rolled **2**, player 2 rolled **6**, player 2
won and claimed the **0.1 SOL** pot (balance delta verified exactly).

- Game PDA: [`4RRRSZsVtL9gMmkLAiivB2Sv3YEpFAaRGCgzhndippo8`](https://explorer.solana.com/address/4RRRSZsVtL9gMmkLAiivB2Sv3YEpFAaRGCgzhndippo8?cluster=devnet)
- create_game: [`3NCAyo8F…66ZuEHR`](https://explorer.solana.com/tx/3NCAyo8FJjJnytZSkHuvm45AkUFNUWCFFYVs1V9V1TVAY8iNQDb66ANah7fo3VB6b9Mh4wtCvne1AopGs66ZuEHR?cluster=devnet)
- join_game: [`mr44gqyE…fjcmis`](https://explorer.solana.com/tx/mr44gqyEwcvqjPKfPBBwqE6ZzoBHAv7T7gLd96Tv3vrTD9zCBXWfRa2UjzMHDfxfoXeJPHTbeK5D2hJWdfjcmis?cluster=devnet)
- delegate_game: [`5r8vWqov…TYE3JnvH`](https://explorer.solana.com/tx/5r8vWqovHVYEZDE6ahw3rFGQe68D6BsP9jCdhQAea4whXFh3Rin9kUd7qdEx93xB1XD34o1C5q7mncwkTYE3JnvH?cluster=devnet)
- roll_dice P1 (ER): `3XD2Z1XuMk1vSfzPCH28JesG7EjLdKuGeyUEFu43AJGjNxmoe9bR6Yn1evrY4rWR8MGEadp9djBCNYyDzVKbkHrV`
- roll_dice P2 (ER): `2EuvSrqzyBZtFqp9VjeH1dwWY9uDh2bmahVEiHN7SsgfwTFQbQUm68UoP3SkjVHumayBoGd5TvyJJyzAfuvGXEim`
- undelegate_game (ER): `2dWB3vYZA6HEH96aGdeEZ3apHnWDwykrK5gsWnZKe5VpPijUPGzqrWX5EuLbAsnFe83wbQJWtmRYFfTvmyLoqWjh`
- claim_pot: [`4hqxEp1T…A9V4XFr`](https://explorer.solana.com/tx/4hqxEp1T5JY3sa73VSoN68Ke2Atafy8irPXnRHowxgZ9wYnZTH6gxLpy36wQ1QgoR7yzKVqrzuswovhK5A9V4XFr?cluster=devnet)

Reproduce it yourself with the automated run: `npx tsx tests/e2e.ts`
(see below).

## How it works

```
 L1 (Solana devnet)                     Ephemeral Rollup (~10 ms, gasless)
 ─────────────────────                   ─────────────────────────────────
 create_game ──► vault PDA holds pot
 join_game   ──► both stakes locked
 delegate_game ────────────────────────► Game PDA delegated to an ER validator
                                         roll_dice ─► VRF request (oracle queue)
                                         callback_roll ◄─ VRF oracle writes the
                                           dice (1–6) into the Game PDA
                                         higher dice wins · tie → re-roll
 undelegate_game ◄────────────────────── commit + undelegate final state
 claim_pot   ──► winner takes 2× stake
 cancel_game ──► creator refund if nobody joined
```

### Why MagicBlock is the perfect fit

- **Ephemeral Rollups** — a dice duel is a burst of tiny, latency-sensitive
  state changes. On L1 each roll would cost a fee and a 400 ms slot; on the ER
  rolls are fee-less and land in ~10 ms blocks, while the money (the pot)
  never leaves L1 escrow.
- **VRF** — gambling on a dice roll is only fair if the randomness is
  verifiable. Rolls use MagicBlock's ephemeral VRF
  (`create_request_scoped_randomness_ix` + `#[vrf_callback]`): the oracle
  supplies 32 bytes of randomness and the program derives the die with
  `random_u8_with_range(&randomness, 1, 6)`. The player index recorded by the
  callback is derived from the *authenticated signer* of the roll request, so
  a player can only ever roll for themselves.
- **Delegation / commit** — the `Game` PDA is delegated with `#[delegate]`
  and brought home with `MagicIntentBundleBuilder::commit_and_undelegate`,
  so L1 always ends up with the final, settled state that `claim_pot` pays
  out against.

### Program design

A single `Game` PDA (seeds `["game", game_id]`) holds both players, the
stake, the round counter, both dice (`0` = not rolled, `7` = VRF pending,
`1..=6` = result) and the winner. A separate `vault` PDA (system-owned,
never delegated) escrows the stakes on L1. Instructions: `create_game`,
`join_game`, `delegate_game`, `roll_dice`, `callback_roll` (VRF callback),
`undelegate_game`, `claim_pot`, `cancel_game`.

Built on MagicBlock's official examples (`roll-dice` for the VRF pattern,
`rock-paper-scissor` for the two-player pot flow) with
`ephemeral-rollups-sdk 0.16.2`, Anchor `1.0.2`, Solana `3.1.9`.

## Run it

### Frontend

Live: https://dftaufiq.github.io/blitz-roll-arena/ — or locally:

```bash
cd app
npm install
npm run dev        # http://localhost:5173
```

Connect a devnet wallet (Phantom/Solflare with some devnet SOL), create a
room with a stake, and share the game link with a second player (second
browser/profile + wallet). They join and match the stake, either player hits
**Delegate & start**, both roll, the winner settles and claims the pot.

### Automated end-to-end game (two scripted players)

```bash
# from the repo root — needs a funded devnet keypair at
# ../deployer-keypair.json (override paths in tests/e2e.ts) and the two
# player keypairs it creates next to it.
npm install
npx tsx tests/e2e.ts
```

The script funds two fresh player wallets from the deployer, plays a
complete match on the real devnet ER, asserts the vault balance and the
winner's payout delta, and prints every transaction signature.

### Build / deploy the program

```bash
anchor build                 # Anchor 1.0.2, Rust 1.89.0, Solana 3.1.9
anchor deploy --provider.cluster devnet
```

## Layout

- `programs/blitz-roll-arena/` — the Anchor program (ER delegation + VRF dice)
- `tests/e2e.ts` — full-game end-to-end run against devnet + the live ER
- `app/` — Vite + React + wallet-adapter frontend
