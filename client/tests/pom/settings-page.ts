import type { Locator, Page } from '@playwright/test'

export class SettingsPage {
  constructor(readonly page: Page) {}

  openButton(): Locator {
    return this.page.getByRole('button', { name: /\[ CFG \]/i })
  }

  async open(): Promise<void> {
    await this.openButton().click()
    await this.page.getByRole('dialog', { name: /settings/i }).waitFor({
      state: 'visible',
      timeout: 30_000,
    })
  }

  async close(): Promise<void> {
    await this.page.getByRole('button', { name: /\[X\]/i }).click()
  }

  discoverabilitySwitch(): Locator {
    return this.page.getByRole('switch')
  }

  localeButton(): Locator {
    return this.page.getByRole('button', { name: /Toggle language|Переключить язык/i })
  }
}
