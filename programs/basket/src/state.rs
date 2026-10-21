//! Account layouts, as DESIGN-VAULT.md section 3.7 lays them out. Fields for instructions
//! that do not exist yet are here with their space, so adding those instructions needs no
//! migration.

use anchor_lang::prelude::*;

use crate::errors::BasketError;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ASSETS_SEED: &[u8] = b"assets";
pub const RECIPE_SEED: &[u8] = b"recipe";
pub const VAULT_SEED: &[u8] = b"vault";

pub const MAX_POSITIONS: usize = 16;
pub const MAX_ASSETS: usize = 64;
/// The most lines a version of a shared portfolio holds, as many as a vault has positions.
pub const MAX_COMPONENTS: usize = 16;
/// The lines a version keeps inside `RecipeVersion`: the account was first laid out for twelve.
pub const INLINE_COMPONENTS: usize = 12;
/// The lines past the twelve, which the account keeps after the end of its first layout.
pub const EXTRA_COMPONENTS: usize = MAX_COMPONENTS - INLINE_COMPONENTS;
pub const MAX_PRICE_ACCOUNTS: usize = 4;
pub const BPS: u32 = 10_000;
/// `AssetEntry.flags`, bit 0: the keeper may trade the asset and value a vault by its price.
/// The admin sets it once the asset's price entry is seen to be live. The owner's own swap
/// and withdrawal never read it.
pub const ASSET_KEEPER: u8 = 1;
/// A price range is at most this wide: its ceiling over its floor. Wide enough for a stock's
/// worst month, too narrow to pass a price that is double or half the real one from the
/// middle of the range, and never "no check".
pub const MAX_PRICE_RANGE_RATIO: u64 = 2;

/// One per program, at seeds ["config"].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// Two-step hand-over; all zeros when none is pending.
    pub pending_admin: Pubkey,
    pub guardian: Pubkey,
    pub default_keeper: Pubkey,
    /// The only program a vault may swap through. Never fixed in code: Jupiter on mainnet,
    /// the test exchange on devnet. Locked once `launched` is set.
    pub router_program: Pubkey,
    /// The program that must own a price account. Never fixed in code: Kamino Scope on
    /// mainnet, the test price program on devnet. Locked once `launched` is set.
    pub price_owner: Pubkey,
    /// The one mint a vault takes as a deposit: the chain's dollar token. Never fixed in
    /// code: USDC on mainnet, the test dollar token on devnet. Locked once `launched` is set.
    pub cash_mint: Pubkey,
    /// Stops the keeper paths only. No owner instruction reads it.
    pub keeper_paused: bool,
    /// One-way; raises the floor on `publish_delay_s` and locks the three addresses above,
    /// and the price accounts of the asset list.
    pub launched: bool,
    pub tolerance_bps: u16,
    pub loss_cap_bps: u16,
    pub band_bps: u16,
    pub twap_dev_bps: u16,
    pub max_price_age_s: u16,
    pub asset_cooldown_s: u32,
    pub publish_delay_s: u32,
    pub session_open_utc_s: u32,
    pub session_close_utc_s: u32,
    pub closed_until: i64,
    /// Days since 1970, UTC.
    pub closed_days: [u16; 32],
    /// The bump of this account's own address, so every read can check the address.
    pub bump: u8,
    pub reserved: [u8; 63],
}

/// The keeper and registry settings an admin chooses, within the hard bounds in `checks`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Params {
    pub tolerance_bps: u16,
    pub loss_cap_bps: u16,
    pub band_bps: u16,
    pub twap_dev_bps: u16,
    pub max_price_age_s: u16,
    pub asset_cooldown_s: u32,
    pub publish_delay_s: u32,
    pub session_open_utc_s: u32,
    pub session_close_utc_s: u32,
}

impl Config {
    pub fn apply_params(&mut self, params: &Params) {
        self.tolerance_bps = params.tolerance_bps;
        self.loss_cap_bps = params.loss_cap_bps;
        self.band_bps = params.band_bps;
        self.twap_dev_bps = params.twap_dev_bps;
        self.max_price_age_s = params.max_price_age_s;
        self.asset_cooldown_s = params.asset_cooldown_s;
        self.publish_delay_s = params.publish_delay_s;
        self.session_open_utc_s = params.session_open_utc_s;
        self.session_close_utc_s = params.session_close_utc_s;
    }

    /// Marks a day (days since 1970, UTC) as closed. A zero is an empty slot, so day zero
    /// cannot be closed, and the list holds 32 days.
    pub fn close_day(&mut self, day: u16) -> Result<()> {
        require!(day != 0, BasketError::ParamOutOfBounds);
        if self.closed_days.contains(&day) {
            return Ok(());
        }
        let free = self
            .closed_days
            .iter_mut()
            .find(|slot| **slot == 0)
            .ok_or(BasketError::ParamOutOfBounds)?;
        *free = day;
        Ok(())
    }

    /// Takes a day off the list of closed days.
    pub fn open_day(&mut self, day: u16) -> Result<()> {
        require!(day != 0, BasketError::ParamOutOfBounds);
        for slot in self.closed_days.iter_mut() {
            if *slot == day {
                *slot = 0;
            }
        }
        Ok(())
    }
}

/// The platform's list of tokens a vault may hold: one per program, at seeds ["assets"].
///
/// Zero-copy and packed: the bytes are the fields in this order with no padding. 8 bytes of
/// discriminator, then `price_accounts` at 8, `count` at 136, and entry `i` at `137 + 96·i`.
/// 6,281 bytes in all.
#[account(zero_copy(unsafe))]
pub struct AssetRegistry {
    /// The price accounts an entry's `price_slot` points into. Written by
    /// `set_price_account`, until `launched` is set.
    pub price_accounts: [Pubkey; MAX_PRICE_ACCOUNTS],
    /// How many of `assets` are in use.
    pub count: u8,
    pub assets: [AssetEntry; MAX_ASSETS],
}

/// One listed token: 96 bytes. Offsets inside the entry: `mint` 0, `price_slot` 32,
/// `price_index` 33, `twap_index` 35, `decimals` 37, `price_kind` 38, `session` 39,
/// `max_weight_bps` 40, `flags` 42, `source_check` 43, `min_price` 75, `max_price` 83,
/// `reserved` 91.
#[zero_copy(unsafe)]
pub struct AssetEntry {
    pub mint: Pubkey,
    /// Which of the registry's `price_accounts` holds this asset's price.
    pub price_slot: u8,
    pub price_index: u16,
    pub twap_index: u16,
    /// Read from the mint when the entry is written.
    pub decimals: u8,
    /// 0 none, 1 Scope layout.
    pub price_kind: u8,
    /// 0 always open, 1 US market hours.
    pub session: u8,
    /// The most a shared portfolio may hold of it. The registry also caps every weight at 50%.
    pub max_weight_bps: u16,
    /// Bit 0 is `ASSET_KEEPER`; the other bits must be zero.
    pub flags: u8,
    /// All zeros means off (DESIGN-VAULT.md section 5).
    pub source_check: [u8; 32],
    /// The range the asset's price is plausible in, in millionths of a dollar for one whole
    /// token: a keeper leg takes no price under `min_price` or over `max_price`. The admin
    /// sets it and moves it by hand. Zero and zero is "no range", which only an asset the
    /// keeper does not trade may have. The two took sixteen bytes of what was reserved.
    pub min_price: u64,
    pub max_price: u64,
    pub reserved: [u8; 5],
}

impl AssetRegistry {
    pub const SPACE: usize = 8 + core::mem::size_of::<AssetRegistry>();

    /// The entry for `mint`, if the mint is listed.
    pub fn find(&self, mint: &Pubkey) -> Option<&AssetEntry> {
        let count = (self.count as usize).min(MAX_ASSETS);
        self.assets[..count]
            .iter()
            .find(|entry| entry.mint == *mint)
    }

    pub fn is_listed(&self, mint: &Pubkey) -> bool {
        self.find(mint).is_some()
    }
}

impl AssetEntry {
    pub fn keeper_on(&self) -> bool {
        self.flags & ASSET_KEEPER != 0
    }
}

/// One line of a shared portfolio.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Component {
    pub mint: Pubkey,
    pub weight_bps: u16,
}

/// One version of a shared portfolio: 453 bytes. `version` zero means the slot is empty.
/// `count` is every line of the version: the first twelve are here, the rest past the end
/// of the account's first layout (`Recipe::lines`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct RecipeVersion {
    pub version: u32,
    /// Unix seconds. The version is in effect from this second on.
    pub effective_at: i64,
    pub meta_hash: [u8; 32],
    /// How many lines the version has, here and past the end.
    pub count: u8,
    pub components: [Component; INLINE_COMPONENTS],
}

/// Which of a portfolio's two versions.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Current = 0,
    Pending = 1,
}

/// A shared portfolio: one per creator per family, at seeds ["recipe", creator, family_id].
/// Only the version in effect and the one waiting live here; history is in the
/// `RecipePublished` events. `last_version` took four bytes of what was reserved.
///
/// The fields below are the account's first 1,022 bytes, as they were laid out when a version
/// held at most twelve lines, and every account written then still reads as it is. The lines
/// past twelve follow them: four for the current version from byte 1,022, then four for the
/// waiting one from byte 1,158, 34 bytes each (mint, weight). A portfolio published since has
/// those 272 bytes from the start (`Recipe::SPACE`); an older one gets them the first time a
/// version of more than twelve lines is published to it.
#[account]
#[derive(InitSpace)]
pub struct Recipe {
    pub creator: Pubkey,
    pub family_id: [u8; 32],
    pub current: RecipeVersion,
    /// The version that is published and not yet in effect; `version` zero when there is none.
    pub pending: RecipeVersion,
    /// The time of the last publish, whether or not that version was later cancelled.
    pub last_publish_ts: i64,
    /// Stored and required to be zero.
    pub max_fee_bps: u16,
    /// Stored and required to be zero.
    pub flags: u8,
    /// Not written yet: the guardian's veto is `cancel_pending`.
    pub vetoed: bool,
    /// The highest version number ever given out, cancelled ones included, so a number is
    /// never used twice. Zero on an account written before this field existed: the number
    /// of the version in effect stands in for it.
    pub last_version: u32,
    pub reserved: [u8; 28],
}

impl Recipe {
    /// The fields, behind the discriminator: 1,022 bytes.
    pub const HEAD_SPACE: usize = 8 + Recipe::INIT_SPACE;
    /// The fields and the lines past twelve of both versions: 1,294 bytes.
    pub const SPACE: usize = Recipe::HEAD_SPACE + 2 * EXTRA_COMPONENTS * Component::INIT_SPACE;

    /// True when a version is waiting and its time has not come.
    pub fn has_pending(&self, now: i64) -> bool {
        self.pending.version != 0 && now < self.pending.effective_at
    }

    pub fn version(&self, slot: Slot) -> &RecipeVersion {
        match slot {
            Slot::Current => &self.current,
            Slot::Pending => &self.pending,
        }
    }

    /// Which version is in effect at `now`. A waiting version whose time has come is in
    /// effect with no transaction.
    pub fn active_slot(&self, now: i64) -> Slot {
        if self.pending.version != 0 && now >= self.pending.effective_at {
            Slot::Pending
        } else {
            Slot::Current
        }
    }

    /// The version in effect at `now`.
    pub fn active(&self, now: i64) -> &RecipeVersion {
        self.version(self.active_slot(now))
    }

    /// Every line of the version in `slot`: the first twelve from the fields, the rest from
    /// `data`, the account's own bytes.
    pub fn lines(&self, slot: Slot, data: &[u8]) -> Result<Vec<Component>> {
        let version = self.version(slot);
        let count = version.count as usize;
        require!(count <= MAX_COMPONENTS, ErrorCode::AccountDidNotDeserialize);
        let mut lines = version.components[..count.min(INLINE_COMPONENTS)].to_vec();
        for i in 0..count.saturating_sub(INLINE_COMPONENTS) {
            let at = extra_at(slot, i);
            let bytes = data
                .get(at..at + Component::INIT_SPACE)
                .ok_or(ErrorCode::AccountDidNotDeserialize)?;
            lines.push(Component {
                mint: Pubkey::try_from(&bytes[..32]).unwrap_or_default(),
                weight_bps: u16::from_le_bytes([bytes[32], bytes[33]]),
            });
        }
        Ok(lines)
    }

    /// Writes a version into `slot`: the fields here, which Anchor writes back to the account
    /// when the instruction ends, and the lines past twelve into `data` now. What the slot
    /// held past twelve before is cleared. An account without room past its fields takes no
    /// more than twelve lines.
    pub fn put(
        &mut self,
        slot: Slot,
        data: &mut [u8],
        version: RecipeVersion,
        components: &[Component],
    ) -> Result<()> {
        require!(
            components.len() <= MAX_COMPONENTS,
            BasketError::InvalidTargets
        );
        let mut head = RecipeVersion {
            count: components.len() as u8,
            components: [Component::default(); INLINE_COMPONENTS],
            ..version
        };
        let inline = components.len().min(INLINE_COMPONENTS);
        head.components[..inline].copy_from_slice(&components[..inline]);
        let extra = &components[inline..];
        if data.len() >= Recipe::SPACE {
            for i in 0..EXTRA_COMPONENTS {
                let at = extra_at(slot, i);
                let line = extra.get(i).copied().unwrap_or_default();
                data[at..at + 32].copy_from_slice(line.mint.as_ref());
                data[at + 32..at + 34].copy_from_slice(&line.weight_bps.to_le_bytes());
            }
        } else {
            require!(extra.is_empty(), ErrorCode::AccountDidNotDeserialize);
        }
        match slot {
            Slot::Current => self.current = head,
            Slot::Pending => self.pending = head,
        }
        Ok(())
    }

    /// The number the next version takes: one past the highest ever given out. A version
    /// that was cancelled keeps its number, so what a person reviewed under a number is the
    /// only content that number ever names.
    pub fn next_version(&self) -> u32 {
        self.last_version.max(self.current.version) + 1
    }

    /// Moves a waiting version whose time has come into `current`, its lines past twelve
    /// included. Whatever writes to a recipe does this first.
    pub fn promote(&mut self, now: i64, data: &mut [u8]) -> Result<()> {
        if self.active_slot(now) == Slot::Pending {
            let lines = self.lines(Slot::Pending, data)?;
            let pending = self.pending;
            self.put(Slot::Current, data, pending, &lines)?;
            self.put(Slot::Pending, data, RecipeVersion::default(), &[])?;
        }
        Ok(())
    }
}

/// Where line `12 + i` of the version in `slot` starts in the account's bytes.
fn extra_at(slot: Slot, i: usize) -> usize {
    Recipe::HEAD_SPACE + (slot as usize * EXTRA_COMPONENTS + i) * Component::INIT_SPACE
}

/// One per owner per plan, at seeds ["vault", owner, basket_id as u64 LE]. It stores the
/// state and is the authority of the vault's token accounts.
///
/// Borsh. The field order is frozen: `owner` is at byte 8, `recipe` at 40,
/// `accepted_version` at 72 and `auto_follow` at 76, and other code filters on them.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    /// The shared portfolio this vault follows; all zeros when it follows none.
    pub recipe: Pubkey,
    /// The version of `recipe` whose weights the vault took; zero when it follows none.
    pub accepted_version: u32,
    pub auto_follow: bool,
    pub basket_id: u64,
    pub bump: u8,
    /// All zeros means Config's default keeper.
    pub keeper: Pubkey,
    /// How many of `positions` are in use.
    pub count: u8,
    pub positions: [Position; MAX_POSITIONS],
    pub loss_accum: u64,
    pub loss_ts: i64,
    /// Byte 0 is the vault type; 0 is the standard vault.
    pub reserved: [u8; 128],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Position {
    pub mint: Pubkey,
    pub target_bps: u16,
    /// The balance the vault's token account held when the program last looked. A hint,
    /// not a balance: an issuer with a permanent delegate, or anyone sending tokens in,
    /// changes the real one. Anything that values the vault reads the token accounts.
    pub tracked: u64,
    pub last_keeper_ts: i64,
}

/// One line of a vault's targets.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Target {
    pub mint: Pubkey,
    pub target_bps: u16,
}

impl Vault {
    /// Records the balance now held for `mint`, if the mint is one of the positions.
    pub fn record_balance(&mut self, mint: &Pubkey, amount: u64) {
        let count = self.count as usize;
        if let Some(position) = self
            .positions
            .iter_mut()
            .take(count)
            .find(|position| position.mint == *mint)
        {
            position.tracked = amount;
        }
    }

    /// The position on `mint`, if the mint is one of the vault's.
    pub fn position(&self, mint: &Pubkey) -> Option<&Position> {
        let count = (self.count as usize).min(MAX_POSITIONS);
        self.positions[..count].iter().find(|p| p.mint == *mint)
    }

    /// True when the owner has accepted the asset: it is a position with a target above
    /// zero. Holding a token is not accepting it.
    pub fn accepts(&self, mint: &Pubkey) -> bool {
        self.position(mint).is_some_and(|p| p.target_bps > 0)
    }

    /// Stamps the time of a keeper trade on the position of `mint`.
    pub fn stamp_keeper(&mut self, mint: &Pubkey, now: i64) {
        let count = (self.count as usize).min(MAX_POSITIONS);
        if let Some(position) = self.positions[..count].iter_mut().find(|p| p.mint == *mint) {
            position.last_keeper_ts = now;
        }
    }

    /// Takes the weights of a version of a shared portfolio, every line of it. A mint the
    /// version no longer holds and the vault still does stays as a position with a target of
    /// zero, so the keeper can sell it; one the vault holds nothing of goes. More than 16
    /// lines in all is refused: the owner sells what is left over first.
    pub fn take_version(&mut self, components: &[Component]) -> Result<()> {
        let mut next: Vec<(Pubkey, u16)> = components
            .iter()
            .map(|component| (component.mint, component.weight_bps))
            .collect();
        let count = (self.count as usize).min(MAX_POSITIONS);
        for held in self.positions[..count].iter().filter(|p| p.tracked > 0) {
            if components.iter().all(|c| c.mint != held.mint) {
                next.push((held.mint, 0));
            }
        }
        require!(next.len() <= MAX_POSITIONS, BasketError::InvalidTargets);
        self.set_positions(next.into_iter());
        Ok(())
    }

    /// Replaces the targets. A mint that stays keeps what the program recorded for it
    /// (`tracked`, `last_keeper_ts`); a slot that is no longer used is cleared.
    pub fn set_positions(&mut self, targets: impl ExactSizeIterator<Item = (Pubkey, u16)>) {
        let old = self.positions;
        let old_count = (self.count as usize).min(MAX_POSITIONS);
        self.positions = [Position::default(); MAX_POSITIONS];
        self.count = targets.len() as u8;
        for (slot, (mint, target_bps)) in self.positions.iter_mut().zip(targets) {
            let kept = old[..old_count].iter().find(|p| p.mint == mint);
            *slot = Position {
                mint,
                target_bps,
                tracked: kept.map_or(0, |p| p.tracked),
                last_keeper_ts: kept.map_or(0, |p| p.last_keeper_ts),
            };
        }
    }
}
