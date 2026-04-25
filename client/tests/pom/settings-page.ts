import type { Locator, Page } from '@playwright/test'

export class SettingsPage {
  constructor(readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole('dialog', { name: /settings|настройки/i })
  }

  openButton(): Locator {
    return this.page
      .getByRole('button', { name: /settings|настройки|CFG/i })
      .first()
  }

  async open(): Promise<void> {
    await this.openButton().click()
    await this.dialog().waitFor({
      state: 'visible',
      timeout: 30_000,
    })
  }

  async close(): Promise<void> {
    await this.dialog()
      .getByRole('button', { name: /\[X\]|✕|×|Close|Закрыть/i })
      .click()
  }

  discoverabilitySwitch(): Locator {
    return this.dialog().getByRole('switch', {
      name: /Profile Visibility|Видимость профиля/i,
    })
  }

  languageSelect(): Locator {
    return this.dialog().getByLabel(/Language|Язык/i)
  }
}
