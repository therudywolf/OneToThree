// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Terms — OneToThree',
  description: 'Terms of service for the publicly hosted OneToThree instance.',
}

const LAST_UPDATED = '2026-05-15'

export default function TermsPage() {
  return (
    <>
      <h1 className="font-mono text-2xl uppercase tracking-widest">
        Terms of service
      </h1>
      <p className="mt-2 text-text-muted">Last updated: {LAST_UPDATED}</p>

      <p>
        These terms govern your use of the publicly hosted OneToThree
        instance at <code>onetothree.ru</code>. The software itself is
        open-source under{' '}
        <a href="https://github.com/therudywolf/OneToThree/blob/main/LICENSE">
          AGPL-3.0-only
        </a>
        ; if you self-host it, the AGPL terms govern your obligations and
        these service terms do not apply to you.
      </p>

      <h2>1. Eligibility</h2>
      <p>
        You must be at least 13 years old (16 in the EU) to create an
        account. By creating an account you confirm you meet that age
        requirement and that doing so does not violate any law of your
        jurisdiction.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>
          Authentication is by ECDSA challenge / response. There is no
          password to recover. If you lose your PIN <em>and</em> your
          recovery key <em>and</em> all your linked devices, your account
          is unrecoverable.
        </li>
        <li>
          You are responsible for keeping your PIN, recovery key, and
          devices secure.
        </li>
        <li>
          You may not share your account with another person. You may link
          multiple devices to the same account.
        </li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>
        Because content is end-to-end encrypted we cannot read your
        messages. That puts the responsibility for what you send entirely
        on you. You agree not to use the service to:
      </p>
      <ul>
        <li>
          Distribute material that is illegal under the laws applicable to
          you or to the recipient (e.g. CSAM, terrorism content, threats of
          violence, doxxing).
        </li>
        <li>
          Send unsolicited bulk messages, run spam-style automation, or
          attempt to enumerate / scrape the user directory.
        </li>
        <li>
          Probe, scan, or test the vulnerability of the service except via
          coordinated disclosure (see SECURITY.md).
        </li>
        <li>
          Circumvent rate limits, account bans, or security controls.
        </li>
        <li>
          Use the service to infringe intellectual property, run a phishing
          operation, or impersonate another person.
        </li>
      </ul>
      <p>
        If we receive a credible report (e.g. from a recipient or a court
        order) of prohibited content tied to a username, we may suspend
        the account pending review. We can never read message bodies, only
        act on metadata (sender id, timestamps) and reports.
      </p>

      <h2>4. Service availability</h2>
      <p>
        The service is provided <strong>as-is</strong>, with no uptime
        guarantee. We run reasonable backups and uptime monitoring (see{' '}
        <a href="https://github.com/therudywolf/OneToThree/blob/main/docs/OPS.md">
          docs/OPS.md
        </a>
        ) but downtime, data loss, or message-delivery delays may happen.
        For mission-critical messaging, run your own instance.
      </p>

      <h2>5. Termination</h2>
      <ul>
        <li>
          You may delete your account at any time from <em>Settings →
          Account → Delete account</em>. Deletion is permanent.
        </li>
        <li>
          We may suspend or terminate accounts that violate these terms,
          with notice when feasible.
        </li>
        <li>
          We may shut down the public instance with at least 30 days'
          notice. The source code remains AGPL so you can stand up your
          own.
        </li>
      </ul>

      <h2>6. Disclaimer & liability</h2>
      <p>
        To the maximum extent permitted by law, the service is provided
        without warranties of any kind, and our aggregate liability for
        any claim arising from your use is limited to the greater of
        (a) what you paid us in the past 12 months — usually zero — or
        (b) the equivalent of $100 USD.
      </p>

      <h2>7. Governing law</h2>
      <p>
        These terms are governed by the laws of the operator's jurisdiction
        (Russia, for the canonical <code>onetothree.ru</code> deployment),
        without giving effect to conflict-of-laws rules. Disputes go to
        the competent courts of that jurisdiction.
      </p>

      <h2>8. Changes</h2>
      <p>
        Material changes are announced in the changelog and via an in-app
        banner at least 14 days before they take effect. Continued use
        after the effective date means you accept the new terms.
      </p>

      <h2>9. Contact</h2>
      <p>
        Questions about these terms or privacy:{' '}
        <a href="mailto:dev@onetothree.ru">dev@onetothree.ru</a>.
        Security disclosures: see{' '}
        <a href="https://github.com/therudywolf/OneToThree/blob/main/SECURITY.md">
          SECURITY.md
        </a>
        .
      </p>
    </>
  )
}
