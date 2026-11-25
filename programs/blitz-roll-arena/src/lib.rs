use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    anchor::{commit, delegate, ephemeral, vrf, vrf_callback},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    vrf::{
        self,
        instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

declare_id!("GDQEgMDsQqbKxjcZX3jragWPFhyVaGxDs8qM2xzstwjG");

pub const GAME_SEED: &[u8] = b"game";
pub const VAULT_SEED: &[u8] = b"vault";

/// Sentinel stored in a roll slot while a VRF request is in flight.
/// Real dice results are 1..=6 and 0 means "not rolled yet".
pub const ROLL_PENDING: u8 = 7;

#[ephemeral]
#[program]
pub mod blitz_roll_arena {

    use ephemeral_rollups_sdk::vrf;

    use super::*;

    // 1️⃣ Create a game room and auto-join as Player 1.
    // Player 1's stake moves into the vault PDA — a base-layer SOL escrow that
    // is never delegated, so the pot stays on L1 while the game runs on the ER.
    pub fn create_game(ctx: Context<CreateGame>, game_id: u64, stake: u64) -> Result<()> {
        if stake > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.player1.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                stake,
            )?;
        }

        let game = &mut ctx.accounts.game;
        game.game_id = game_id;
        game.player1 = ctx.accounts.player1.key();
        game.player2 = None;
        game.stake = stake;
        game.paid = false;
        game.round = 1;
        game.roll1 = 0;
        game.roll2 = 0;
        game.winner = None;

        msg!("Game {} created by {}", game_id, game.player1);
        msg!("Stake per player: {} lamports", stake);
        Ok(())
    }

    // 2️⃣ Player 2 joins and matches Player 1's stake into the vault.
    pub fn join_game(ctx: Context<JoinGame>, _game_id: u64) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let player = ctx.accounts.player.key();

        require!(!game.paid, GameError::GameSettled);
        require!(game.player1 != player, GameError::CannotJoinOwnGame);
        require!(game.player2.is_none(), GameError::GameFull);

        if game.stake > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.player.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                    },
                ),
                game.stake,
            )?;
        }

        game.player2 = Some(player);
        msg!("{} joined game {} as player 2", player, game.game_id);
        Ok(())
    }

    // 3️⃣ Delegate the Game PDA to the Ephemeral Rollup. Dice rolls then run
    // on the ER with ~10ms blocks and no per-move fees.
    /// Set a specific validator via the first remaining account, see
    /// https://docs.magicblock.gg/pages/get-started/how-integrate-your-program/local-setup
    pub fn delegate_game(ctx: Context<DelegateGame>, game_id: u64) -> Result<()> {
        ctx.accounts.delegate_game(
            &ctx.accounts.payer,
            &[GAME_SEED, &game_id.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        msg!("Game {} delegated to the ephemeral rollup", game_id);
        Ok(())
    }

    // 4️⃣ Roll the dice — runs on the ER. The signer must be one of the two
    // players; the handler derives the player index from the signer (never
    // from user-supplied args) and marks that player's slot as pending before
    // requesting verifiable randomness from the MagicBlock VRF oracle.
    pub fn roll_dice(ctx: Context<RollDice>, _game_id: u64, client_seed: u8) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(game.player2.is_some(), GameError::GameNotFull);
        require!(game.winner.is_none(), GameError::GameDecided);

        let payer = ctx.accounts.payer.key();
        let player_index: u8 = if payer == game.player1 {
            require!(game.roll1 == 0, GameError::AlreadyRolled);
            game.roll1 = ROLL_PENDING;
            1
        } else if game.player2 == Some(payer) {
            require!(game.roll2 == 0, GameError::AlreadyRolled);
            game.roll2 = ROLL_PENDING;
            2
        } else {
            return err!(GameError::NotAPlayer);
        };
        let game_key = game.key();

        msg!(
            "Player {} requesting VRF roll in game {} (client_seed={})",
            player_index,
            game.game_id,
            client_seed
        );

        let ix = create_request_scoped_randomness_ix(RequestRandomnessParams {
            payer,
            oracle_queue: ctx.accounts.oracle_queue.key(),
            callback_program_id: ID,
            callback_discriminator: instruction::CallbackRoll::DISCRIMINATOR.to_vec(),
            caller_seed: [client_seed; 32],
            accounts_metas: Some(vec![SerializableAccountMeta {
                pubkey: game_key,
                is_signer: false,
                is_writable: true,
            }]),
            // Echoed back into the callback after the `randomness` arg:
            // [player_index, client_seed]. player_index is derived from the
            // authenticated signer above, so a player can only ever roll
            // (and be recorded) for themselves.
            callback_args: Some(vec![player_index, client_seed]),
            ..Default::default()
        });
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    // 5️⃣ VRF callback — invoked by the VRF oracle on the ER. Records the
    // roller's dice (1..=6). When both dice are in, the higher roll wins the
    // match; a tie clears both slots and advances the round for a re-roll.
    pub fn callback_roll(
        ctx: Context<CallbackRoll>,
        randomness: [u8; 32],
        player_index: u8,
        _client_seed: u8,
    ) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let roll = vrf::rnd::random_u8_with_range(&randomness, 1, 6);

        match player_index {
            1 => {
                require!(game.roll1 == ROLL_PENDING, GameError::RollNotPending);
                game.roll1 = roll;
            }
            2 => {
                require!(game.roll2 == ROLL_PENDING, GameError::RollNotPending);
                game.roll2 = roll;
            }
            _ => return err!(GameError::InvalidPlayerIndex),
        }
        msg!(
            "Game {} round {}: player {} rolled {}",
            game.game_id,
            game.round,
            player_index,
            roll
        );

        if game.roll1 != 0 && game.roll1 != ROLL_PENDING && game.roll2 != 0 && game.roll2 != ROLL_PENDING
        {
            if game.roll1 > game.roll2 {
                game.winner = Some(game.player1);
            } else if game.roll2 > game.roll1 {
                game.winner = game.player2;
            } else {
                // Tie — re-roll next round.
                game.roll1 = 0;
                game.roll2 = 0;
                game.round = game.round.saturating_add(1);
                msg!("Game {} tied, advancing to round {}", game.game_id, game.round);
            }
            if let Some(winner) = game.winner {
                msg!("Game {} decided: winner {}", game.game_id, winner);
            }
        }
        Ok(())
    }

    // 6️⃣ Commit the final game state and undelegate the Game PDA back to
    // the base layer. Only once the match is decided.
    pub fn undelegate_game(ctx: Context<UndelegateGame>, _game_id: u64) -> Result<()> {
        require!(ctx.accounts.game.winner.is_some(), GameError::NoWinnerYet);
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.game.to_account_info()])
        .build_and_invoke()?;
        msg!("Game {} committed and undelegated", ctx.accounts.game.game_id);
        Ok(())
    }

    // 7️⃣ Pay out the pot — base layer, after undelegation. The winner takes
    // both stakes from the vault. Anyone can trigger it; funds only ever go
    // to the winner recorded on the game. Idempotent via `paid`.
    pub fn claim_pot(ctx: Context<ClaimPot>, _game_id: u64) -> Result<()> {
        let game = &mut ctx.accounts.game;
        let winner = game.winner.ok_or(GameError::NoWinnerYet)?;
        require!(!game.paid, GameError::AlreadyPaid);

        let player1 = game.player1;
        let player2 = game.player2.ok_or(GameError::GameNotFull)?;
        require!(
            ctx.accounts.player1.key() == player1,
            GameError::WrongPlayerAccount
        );
        require!(
            ctx.accounts.player2.key() == player2,
            GameError::WrongPlayerAccount
        );

        game.paid = true;

        if game.stake == 0 {
            return Ok(());
        }

        let game_id_bytes = game.game_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &game_id_bytes, &[ctx.bumps.vault]]];
        let to = if winner == player1 {
            ctx.accounts.player1.to_account_info()
        } else {
            ctx.accounts.player2.to_account_info()
        };
        let pot = game.stake.checked_mul(2).ok_or(GameError::MathOverflow)?;
        transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to,
                },
                signer_seeds,
            ),
            pot,
        )?;
        msg!("Paid pot of {} lamports to winner {}", pot, winner);
        Ok(())
    }

    // 8️⃣ Refund the creator if nobody ever joined. Base layer; only callable
    // by player 1 while player 2 is still empty.
    pub fn cancel_game(ctx: Context<CancelGame>, _game_id: u64) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            ctx.accounts.player1.key() == game.player1,
            GameError::WrongPlayerAccount
        );
        require!(game.player2.is_none(), GameError::CannotCancelStarted);
        require!(!game.paid, GameError::AlreadyPaid);

        game.paid = true;

        if game.stake > 0 {
            let game_id_bytes = game.game_id.to_le_bytes();
            let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &game_id_bytes, &[ctx.bumps.vault]]];
            let stake = game.stake;
            transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.player1.to_account_info(),
                    },
                    signer_seeds,
                ),
                stake,
            )?;
        }
        msg!("Game {} cancelled, stake refunded to creator", game.game_id);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CreateGame<'info> {
    #[account(
        init,
        payer = player1,
        space = 8 + Game::LEN,
        seeds = [GAME_SEED, &game_id.to_le_bytes()],
        bump
    )]
    pub game: Account<'info, Game>,

    /// CHECK: SOL escrow PDA, system-owned, holds the pot. Validated by seeds.
    #[account(mut, seeds = [VAULT_SEED, &game_id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub player1: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct JoinGame<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: Account<'info, Game>,

    /// CHECK: SOL escrow PDA, system-owned, holds the pot. Validated by seeds.
    #[account(mut, seeds = [VAULT_SEED, &game_id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,

    #[account(mut)]
    pub player: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct DelegateGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The Game PDA to delegate. Validated by seeds.
    #[account(mut, del, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: UncheckedAccount<'info>,
}

#[vrf]
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct RollDice<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: Account<'info, Game>,
    /// CHECK: validated by the ephemeral VRF program when it processes the request
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[vrf_callback]
#[derive(Accounts)]
pub struct CallbackRoll<'info> {
    #[account(mut)]
    pub game: Account<'info, Game>,
}

#[commit]
#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct UndelegateGame<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: Account<'info, Game>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct ClaimPot<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: Account<'info, Game>,
    /// CHECK: SOL escrow PDA, system-owned. Validated by seeds.
    #[account(mut, seeds = [VAULT_SEED, &game_id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: payout recipient, verified against game.player1 in the handler.
    #[account(mut)]
    pub player1: UncheckedAccount<'info>,
    /// CHECK: payout recipient, verified against game.player2 in the handler.
    #[account(mut)]
    pub player2: UncheckedAccount<'info>,
    /// Anyone can trigger the payout.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(game_id: u64)]
pub struct CancelGame<'info> {
    #[account(mut, seeds = [GAME_SEED, &game_id.to_le_bytes()], bump)]
    pub game: Account<'info, Game>,
    /// CHECK: SOL escrow PDA, system-owned. Validated by seeds.
    #[account(mut, seeds = [VAULT_SEED, &game_id.to_le_bytes()], bump)]
    pub vault: SystemAccount<'info>,
    /// Only the creator can cancel; the refund goes back to them.
    #[account(mut)]
    pub player1: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Game {
    pub game_id: u64,
    pub player1: Pubkey,
    pub player2: Option<Pubkey>,
    pub stake: u64, // per-player wager in lamports (0 = free game)
    pub paid: bool, // pot claimed / game cancelled
    pub round: u8,  // current round, 1-based (ties advance the round)
    pub roll1: u8,  // player 1's dice: 0 = none, 7 = VRF pending, 1..=6 = result
    pub roll2: u8,  // player 2's dice: same encoding
    pub winner: Option<Pubkey>,
}
impl Game {
    pub const LEN: usize = 8    // game_id
        + 32                    // player1
        + (1 + 32)              // player2
        + 8                     // stake
        + 1                     // paid
        + 1                     // round
        + 1                     // roll1
        + 1                     // roll2
        + (1 + 32); // winner
}

#[error_code]
pub enum GameError {
    #[msg("You cannot join your own game.")]
    CannotJoinOwnGame,
    #[msg("Game is already full.")]
    GameFull,
    #[msg("Game does not have two players yet.")]
    GameNotFull,
    #[msg("This game has already been settled.")]
    GameSettled,
    #[msg("The match is already decided.")]
    GameDecided,
    #[msg("Only a player of this game can do this.")]
    NotAPlayer,
    #[msg("You already rolled (or a roll is pending) this round.")]
    AlreadyRolled,
    #[msg("No VRF roll is pending for this player.")]
    RollNotPending,
    #[msg("Invalid player index in VRF callback.")]
    InvalidPlayerIndex,
    #[msg("The match has no winner yet.")]
    NoWinnerYet,
    #[msg("The pot has already been paid out.")]
    AlreadyPaid,
    #[msg("Wrong player account for this game.")]
    WrongPlayerAccount,
    #[msg("Cannot cancel a game that already has two players.")]
    CannotCancelStarted,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
