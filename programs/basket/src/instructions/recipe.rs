use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::checks::{
    check_change, check_header, check_no_cash, check_shape, refuse_limit, CreatorLimits,
    CREATOR_LIMITS,
};
use crate::errors::BasketError;
use crate::events::{RecipePublished, VersionCancelled};
use crate::state::{
    AssetRegistry, Component, Config, Recipe, RecipeVersion, Slot, ASSETS_SEED, CONFIG_SEED,
    INLINE_COMPONENTS, RECIPE_SEED,
};

/// Creator: the first version of a shared portfolio. It takes effect at once.
#[derive(Accounts)]
#[instruction(family_id: [u8; 32])]
pub struct PublishRecipe<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Recipe::SPACE,
        seeds = [RECIPE_SEED, creator.key().as_ref(), &family_id],
        bump
    )]
    pub recipe: Box<Account<'info, Recipe>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    pub system_program: Program<'info, System>,
}

impl PublishRecipe<'_> {
    pub fn handle(
        ctx: Context<PublishRecipe>,
        family_id: [u8; 32],
        components: Vec<Component>,
        meta_hash: [u8; 32],
        max_fee_bps: u16,
        flags: u8,
    ) -> Result<()> {
        refuse_limit(check_header(max_fee_bps, flags))?;
        refuse_limit(check_shape(&components, &*ctx.accounts.assets.load()?))?;
        // The first version has nothing to wait for and nothing to be measured against.
        refuse_limit(check_no_cash(&components, &ctx.accounts.config.cash_mint))?;

        let now = Clock::get()?.unix_timestamp;
        let info = ctx.accounts.recipe.to_account_info();
        let recipe = &mut ctx.accounts.recipe;
        recipe.creator = ctx.accounts.creator.key();
        recipe.family_id = family_id;
        recipe.put(
            Slot::Current,
            &mut info.try_borrow_mut_data()?,
            RecipeVersion {
                version: 1,
                effective_at: now,
                meta_hash,
                ..Default::default()
            },
            &components,
        )?;
        recipe.last_version = 1;
        recipe.last_publish_ts = now;
        recipe.max_fee_bps = max_fee_bps;
        recipe.flags = flags;

        emit!(RecipePublished {
            recipe: recipe.key(),
            version: 1,
            creator: recipe.creator,
            components,
            effective_at: now,
            turnover_bps: 0,
            meta_hash,
        });
        Ok(())
    }
}

/// Creator: a later version. It waits one publish delay before it takes effect.
#[derive(Accounts)]
pub struct UpdateRecipe<'info> {
    /// Pays for the room past twelve lines on a portfolio published before there was any.
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator)]
    pub recipe: Box<Account<'info, Recipe>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
    #[account(
        seeds = [ASSETS_SEED],
        bump
    )]
    pub assets: AccountLoader<'info, AssetRegistry>,
    pub system_program: Program<'info, System>,
}

impl UpdateRecipe<'_> {
    pub fn handle(
        ctx: Context<UpdateRecipe>,
        components: Vec<Component>,
        meta_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let info = ctx.accounts.recipe.to_account_info();
        let recipe = &mut ctx.accounts.recipe;
        // A version that waited and whose time has come is the one in effect, and the one
        // this version is measured against.
        recipe.promote(now, &mut info.try_borrow_mut_data()?)?;

        refuse_limit(check_shape(&components, &*ctx.accounts.assets.load()?))?;
        let turnover_bps = refuse_limit(check_change(
            &recipe.lines(Slot::Current, &info.try_borrow_data()?)?,
            &components,
            recipe.has_pending(now),
            now,
            recipe.last_publish_ts,
            config.publish_delay_s,
        ))?;
        refuse_limit(check_no_cash(&components, &config.cash_mint))?;

        // A portfolio published when a version held at most twelve lines has no room for more
        // until it is given some, at the creator's cost.
        if components.len() > INLINE_COMPONENTS && info.data_len() < Recipe::SPACE {
            let rent = Rent::get()?
                .minimum_balance(Recipe::SPACE)
                .saturating_sub(info.lamports());
            if rent > 0 {
                transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.creator.to_account_info(),
                            to: info.clone(),
                        },
                    ),
                    rent,
                )?;
            }
            info.resize(Recipe::SPACE)?;
        }

        let version = recipe.next_version();
        let effective_at = now.saturating_add(config.publish_delay_s as i64);
        recipe.put(
            Slot::Pending,
            &mut info.try_borrow_mut_data()?,
            RecipeVersion {
                version,
                effective_at,
                meta_hash,
                ..Default::default()
            },
            &components,
        )?;
        recipe.last_version = version;
        recipe.last_publish_ts = now;

        emit!(RecipePublished {
            recipe: recipe.key(),
            version,
            creator: recipe.creator,
            components,
            effective_at,
            turnover_bps,
            meta_hash,
        });
        Ok(())
    }
}

/// Creator or guardian: takes back a version that is waiting. The time of its publish
/// stays, so a cancel does not give the slot back, and so does its number: the next version
/// published takes the one after it.
#[derive(Accounts)]
pub struct CancelPending<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub recipe: Box<Account<'info, Recipe>>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Box<Account<'info, Config>>,
}

impl CancelPending<'_> {
    pub fn handle(ctx: Context<CancelPending>) -> Result<()> {
        let by = ctx.accounts.signer.key();
        let info = ctx.accounts.recipe.to_account_info();
        let recipe = &mut ctx.accounts.recipe;
        require!(
            by == recipe.creator || by == ctx.accounts.config.guardian,
            BasketError::NotCreatorOrGuardian
        );
        // A version whose time has come is in effect: there is nothing left to cancel.
        let now = Clock::get()?.unix_timestamp;
        require!(recipe.has_pending(now), BasketError::NoPendingVersion);

        emit!(VersionCancelled {
            recipe: recipe.key(),
            version: recipe.pending.version,
            by,
        });
        // The cancelled number is spent, also on an account written before the counter.
        recipe.last_version = recipe.last_version.max(recipe.pending.version);
        recipe.put(
            Slot::Pending,
            &mut info.try_borrow_mut_data()?,
            RecipeVersion::default(),
            &[],
        )?;
        Ok(())
    }
}

/// Anyone, and read only: the author limits this program holds a shared portfolio to, as
/// the instruction's return data. The app simulates it and reads the numbers from the
/// program it talks to, instead of keeping a copy of its own.
#[derive(Accounts)]
pub struct ReadCreatorLimits {}

impl ReadCreatorLimits {
    pub fn handle(_ctx: Context<ReadCreatorLimits>) -> Result<CreatorLimits> {
        Ok(CREATOR_LIMITS)
    }
}
