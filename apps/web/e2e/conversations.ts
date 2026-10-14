import type { Locator, Page } from '@playwright/test';

// The conversations panel of /invest, as the specs reach it: the rail beside the conversation from
// 1024px, the sheet opened from the button over it under that.

/** The panel's list, opened first where it is a sheet. */
export async function conversations(page: Page): Promise<Locator> {
  const width = page.viewportSize()?.width ?? 0;
  if (width >= 1024) return page.locator('aside[data-ui="conversations"]');
  const sheet = page.locator('[data-ui="conversations-sheet"]');
  if (!(await sheet.evaluate((node) => (node as HTMLDialogElement).open)))
    await page.locator('[data-ui="conversations-open"]').click();
  return sheet;
}

/** Opens a vault of the person's from the panel: its row's link, to its own page. */
export async function openVault(page: Page, chain: string, address: string) {
  const list = await conversations(page);
  await list
    .locator(
      `[data-ui="conversation-row"][data-kind="vault"][data-chain="${chain}"][data-address="${address}"] [data-ui="conversation-open"]`,
    )
    .click();
}
