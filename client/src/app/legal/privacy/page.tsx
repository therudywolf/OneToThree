// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 therudywolf

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy — OneToThree',
  description: 'How OneToThree handles your data on onetothree.ru.',
}

const LAST_UPDATED = '2026-05-15'

export default function PrivacyPage() {
  return (
    <>
      <h1 className="font-mono text-2xl uppercase tracking-widest">
        Privacy policy
      </h1>
      <p className="mt-2 text-text-muted">Last updated: {LAST_UPDATED}</p>

      <p>
        OneToThree is an end-to-end encrypted messenger. This page describes
        what data the publicly hosted instance at <code>onetothree.ru</code>{' '}
        processes. If you self-host the same code under
        <a href="https://github.com/therudywolf/OneToThree"> AGPL-3.0</a>,
        you are the data controller for your own deployment and this page
        does not apply to you.
      </p>

      <h2>What stays on your device only</h2>
      <ul>
        <li>
          <strong>Private keys</strong> (ECDSA/ECDH/Ed25519/X25519): generated
          locally, wrapped under your PIN with Argon2id + AES-256-GCM, and
          stored only in your browser <code>localStorage</code> /
          <code> IndexedDB</code>. The server never sees them.
        </li>
        <li>
          <strong>Plaintext message content</strong>: encrypted on your device
          before it reaches our infrastructure. Server-side rows hold
          ciphertext and routing metadata only.
        </li>
        <li>
          <strong>Decrypted attachments and message cache</strong>: kept in a
          quota-bounded Dexie database on your device. Wiped on logout.
        </li>
      </ul>

      <h2>What the server stores about you</h2>
      <ul>
        <li>
          <strong>Account record</strong>: username, public ECDSA key, account
          creation timestamp.
        </li>
        <li>
          <strong>Encrypted vault blob</strong>: your PIN-wrapped private-key
          bundle, opaque to the server. Used only to let you log in from a
          new device after entering your PIN.
        </li>
        <li>
          <strong>Encrypted messages</strong>: ciphertext plus chat id,
          sender id, delivery status, and timestamps. The server cannot read
          message bodies — only your other devices and the recipients can.
        </li>
        <li>
          <strong>Encrypted media</strong>: AES-GCM blobs in MinIO. Per-file
          keys are wrapped under the chat key and never leave the encrypted
          payload. Default retention: 30 days, then purged.
        </li>
        <li>
          <strong>Login event log</strong>: timestamp, IP address, User-Agent,
          outcome (success / failed signature / banned / device revoked).
          Kept to detect brute-force attacks and rate-limit logins.
        </li>
        <li>
          <strong>2FA secret</strong> (only if you enable TOTP): stored
          encrypted at rest with AES-256-GCM under the server-side
          <code> TOTP_WRAP_KEY</code>.
        </li>
        <li>
          <strong>Web push subscription</strong> (only if you grant the
          permission): the browser-issued endpoint URL and subscription keys,
          used to wake your device when a new message arrives.
        </li>
      </ul>

      <h2>What the server does NOT store</h2>
      <ul>
        <li>Plaintext messages, files, or media.</li>
        <li>Passwords (we use ECDSA challenge / response — there is no password to store).</li>
        <li>Address books or contacts beyond the usernames you explicitly add.</li>
        <li>Telemetry, analytics, fingerprinting, or third-party trackers.</li>
      </ul>

      <h2>Cookies</h2>
      <p>
        A single cookie is set after a successful login: <code>fm_session</code>
        — HttpOnly, Secure, SameSite=Lax (or None on cross-subdomain
        deployments), holding a signed JWT that proves you are logged in.
        That is the only cookie. No advertising, no analytics.
      </p>

      <h2>Third-party services</h2>
      <ul>
        <li>
          <strong>TURN</strong> (calls): Cloudflare's TURN service or our
          own coturn fallback. Only relays encrypted media when a direct
          peer connection cannot be established.
        </li>
        <li>
          <strong>GIF search</strong>: Tenor (Google) and optionally Giphy.
          Search queries are sent to those providers but no account info.
        </li>
        <li>
          <strong>Web push delivery</strong>: your browser's push service
          (e.g. <code>fcm.googleapis.com</code>, <code>updates.push.services.mozilla.com</code>).
          Push payloads from us are E2E encrypted under VAPID.
        </li>
      </ul>

      <h2>Your rights</h2>
      <ul>
        <li>
          <strong>Export</strong>: contact us at{' '}
          <a href="mailto:privacy@onetothree.ru">privacy@onetothree.ru</a>{' '}
          to request a machine-readable copy of every server-side record we
          have for your username.
        </li>
        <li>
          <strong>Deletion</strong>: <em>Settings → Account → Delete account</em>
          permanently removes your record, devices, push subscriptions, and
          message history (including the encrypted blobs in object storage).
          Deletion is irreversible.
        </li>
        <li>
          <strong>Rectification</strong>: change your username / 2FA / linked
          devices in <em>Settings</em> at any time.
        </li>
      </ul>

      <h2>Retention</h2>
      <ul>
        <li>Encrypted media: 30 days (configurable per deployment).</li>
        <li>Login event log: 90 days.</li>
        <li>Server-side message ciphertext: until you or the recipient
          delete the message, or you delete your account.</li>
        <li>Backups: rolling 7 daily / 4 weekly / 6 monthly snapshots,
          encrypted with AES-256-CBC.</li>
      </ul>

      <h2>Security disclosure</h2>
      <p>
        Found a vulnerability? See{' '}
        <a href="https://github.com/therudywolf/OneToThree/blob/main/SECURITY.md">
          SECURITY.md
        </a>{' '}
        for the disclosure process. We do not have a bug bounty yet but we
        will credit reporters in the changelog if you'd like.
      </p>

      <h2>Changes</h2>
      <p>
        Material changes to this policy will be announced in the changelog
        and via an in-app banner. The current text always lives at{' '}
        <code>onetothree.ru/legal/privacy</code> and in the open-source
        repo, so you can <code>git log</code> the diff.
      </p>
    </>
  )
}
