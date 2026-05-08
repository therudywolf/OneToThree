import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const chatTypeEnum = pgEnum('chat_type', [
  'direct_e2e',
  'group_e2e',
  'public_open',
  // Phase 5.1 — Telegram-style broadcast: single author, many subscribers.
  'channel',
])

export const chatMemberRoleEnum = pgEnum('chat_member_role', [
  'owner',
  'admin',
  'member',
])

// Phase 5.1 — distinct role model for channels. Subscribers never post;
// editors can post but cannot edit channel metadata; owners can do both.
export const channelRoleEnum = pgEnum('channel_role', [
  'subscriber',
  'editor',
  'owner',
])

// Phase 5.2 — sticker pack format. `tgs` ≡ gzipped Lottie JSON (Telegram);
// `lottie` ≡ plain Lottie JSON; `static` ≡ WebP/PNG; `webm` ≡ animated video.
export const stickerFormatEnum = pgEnum('sticker_format', [
  'tgs',
  'lottie',
  'static',
  'webm',
])

export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])

export const reportStatusEnum = pgEnum('report_status', ['open', 'closed'])
export const nativePushPlatformEnum = pgEnum('native_push_platform', ['android'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  publicKeyJwk: text('public_key_jwk').notNull(),
  /** ECDH public JWK for E2E messaging (optional until client uploads). */
  ecdhPublicKeyJwk: text('ecdh_public_key_jwk'),
  isDiscoverable: boolean('is_discoverable').notNull().default(false),
  role: userRoleEnum('role').notNull().default('user'),
  isBanned: boolean('is_banned').notNull().default(false),
  /** Base32 TOTP secret; set during setup, cleared on disable. */
  totpSecret: text('totp_secret'),
  isTotpEnabled: boolean('is_totp_enabled').notNull().default(false),
  /** Opaque encrypted vault JSON (client-only passphrase); server never decrypts. */
  vaultBlob: text('vault_blob'),
  vaultVersion: integer('vault_version').notNull().default(0),
  vaultUpdatedAt: timestamp('vault_updated_at', { withTimezone: true }),
  /** MinIO object key under avatar bucket (e.g. avatars/{userId}/file.jpg). */
  avatarKey: text('avatar_key'),
  /** Updated on WS connect, heartbeat, and disconnect (presence / last seen). */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** When true, peers see offline / no last-seen; viewer still sees others (asymmetric). */
  hidePresence: boolean('hide_presence').notNull().default(false),
  /** When true, don't send read receipts to peers. */
  disableReadReceipts: boolean('disable_read_receipts').notNull().default(false),
  /** Server-side gate for issuing new device-link tokens. Default true — vault PIN is the real guard. */
  allowDeviceLinking: boolean('allow_device_linking').notNull().default(true),
  /** Recovery key material (server stores only KDF salt+hash, never plaintext key). */
  recoveryKeySalt: text('recovery_key_salt'),
  recoveryKeyHash: text('recovery_key_hash'),
  recoveryKeySetAt: timestamp('recovery_key_set_at', { withTimezone: true }),
  /** Short bio / about text. */
  bio: text('bio'),
  /** Optional user-facing display name distinct from immutable username/handle. */
  displayName: text('display_name'),
  /** Custom status text (e.g. "busy", "do not disturb", free-form). */
  statusText: text('status_text'),
  /**
   * Controls who can see presence / last-seen metadata when ghost mode is off.
   * Stored as text for migration simplicity; routes validate the allowed values.
   */
  lastSeenPrivacy: text('last_seen_privacy').notNull().default('everyone'),
  /** JSON array of {platform,url} social links. */
  socialLinks: text('social_links'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stable id from client localStorage (per browser profile). */
    clientDeviceKey: text('client_device_key').notNull(),
    deviceName: text('device_name').notNull(),
    /** Master device cannot be revoked by other devices */
    isMaster: boolean('is_master').notNull().default(false),
    lastActive: timestamp('last_active', { withTimezone: true })
      .notNull()
      .defaultNow(),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // --- Stage 3: E2EE device linking ---
    /** Per-device ECDSA public key JWK. Null until device completes E2EE link confirm. */
    e2eePublicKey: text('e2ee_public_key'),
    /** Per-device ECDH public key JWK for fan-out message encryption (Stage 5). */
    ecdhPublicKey: text('ecdh_public_key'),
    /** Timestamp when this device completed E2EE linking. */
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    /** Explicit user approval for backfilling old history to this device. */
    historySyncEnabledAt: timestamp('history_sync_enabled_at', {
      withTimezone: true,
    }),
    /** Human-readable label (e.g. "Chrome on MacBook", "Primary device (migrated)"). */
    label: text('label'),
    /** True when this record was auto-created from users.public_key_jwk at first login. */
    migrated: boolean('migrated').notNull().default(false),
  },
  (t) => ({
    userClientUnique: uniqueIndex('devices_user_client_key_idx').on(
      t.userId,
      t.clientDeviceKey
    ),
    userIdx: index('devices_user_id_idx').on(t.userId),
  })
)

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reportedId: uuid('reported_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  status: reportStatusEnum('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    type: chatTypeEnum('type').notNull(),
    /**
     * Increments when membership changes require clients to rotate the shared
     * group key (e.g. member kicked). Server does not hold the key material.
     */
    keyEpoch: integer('key_epoch').notNull().default(0),
    /** Random slug for group invite links; unique when set. */
    inviteCode: text('invite_code'),
    /** User-defined permanent invite slug for channels; unique when set. */
    inviteSlug: text('invite_slug'),
    /** When true, first successful join by a new member clears `invite_code`. */
    inviteOneTime: boolean('invite_one_time').notNull().default(false),
  },
  (t) => ({
    inviteCodeUnique: uniqueIndex('chats_invite_code_unique').on(t.inviteCode),
    inviteSlugUnique: uniqueIndex('chats_invite_slug_unique').on(t.inviteSlug),
  })
)

export const chatMembers = pgTable(
  'chat_members',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    encryptedGroupKey: text('encrypted_group_key'),
    role: chatMemberRoleEnum('role').notNull().default('member'),
    /**
     * Phase 5.1 — `channel_role` is non-null only for `chat.type = 'channel'`.
     * For other chat types it must stay NULL (CHECK enforced at migration).
     */
    channelRole: channelRoleEnum('channel_role'),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * Per-user mute of this chat. When set to a future timestamp, clients hide
     * push/ring notifications for this chat until it elapses. NULL = not muted.
     * Server-side broadcast still fires; suppression is a client concern.
     */
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.userId] }),
    // PK is (chat_id, user_id); filtering by user_id alone (e.g. "list all
    // chats for user X") does not use the PK efficiently. Explicit index
    // ensures `loadUserChats` stays O(log N) as membership grows.
    userIdx: index('chat_members_user_idx').on(t.userId),
  })
)

/** Per-user list of favorited chats for fast sidebar access. */
export const chatFavorites = pgTable(
  'chat_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.chatId] }),
    userIdx: index('chat_favorites_user_id_idx').on(t.userId),
    chatIdx: index('chat_favorites_chat_id_idx').on(t.chatId),
  })
)

/** Per-user favorite GIFs for composer quick access. */
export const gifFavorites = pgTable(
  'gif_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    gifId: text('gif_id').notNull(),
    title: text('title').notNull(),
    previewUrl: text('preview_url').notNull(),
    originalUrl: text('original_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.gifId] }),
    userIdx: index('gif_favorites_user_id_idx').on(t.userId),
    createdAtIdx: index('gif_favorites_created_at_idx').on(t.createdAt),
  })
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Global monotonic sequence for deterministic ordering when created_at ties. */
    seq: bigserial('seq', { mode: 'bigint' }).notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    replyToId: uuid('reply_to_id'),
    /**
     * Legacy / group_e2e shared-key ciphertext (single blob).
     * For direct_e2e fan-out (Stage 5) the ciphertext lives in
     * message_deliveries.ciphertext, keyed per device.
     * Kept nullable so old rows and group chats still work.
     */
    content: text('content'),
    iv: text('iv'),
    mediaPath: text('media_path'),
    mediaType: text('media_type'),
    mediaIv: text('media_iv'),
    /** Plaintext byte length of uploaded blob (for admin storage audit). */
    mediaOriginalBytes: bigint('media_original_bytes', { mode: 'number' }),
    /**
     * Phase 3 — transport protocol version:
     *   1 = legacy static ECDH + AES-GCM (pre-Ratchet, current default).
     *   2 = Double Ratchet over X3DH (new messages once both peers publish bundles).
     * Allows the receive path to dispatch to the correct decryptor.
     */
    protocolVersion: integer('protocol_version').notNull().default(1),
    /**
     * Double Ratchet header (v2 only). Carries `dhPub`, `previousChainLength`,
     * and `counter` as base64url fields. Null for v1.
     */
    drHeader: text('dr_header'),
    /**
     * Double Ratchet init payload (v2, first message only). Carries the X3DH
     * handshake material the responder needs to derive the initial shared
     * secret: initiator identity keys, ephemeral public, and the consumed
     * signed / one-time prekey ids.  Null for all subsequent v2 messages and
     * every v1 message.
     */
    drInit: text('dr_init'),
    /**
     * Sender's ECDH public key JWK at time of send — pinned so decryption
     * survives device key rotation (multi-device fix).
     */
    senderEcdhPublicKeyJwk: text('sender_ecdh_public_key_jwk'),
    /** Burn-after-read: hide locally after this time (server metadata). */
    burnAt: timestamp('burn_at', { withTimezone: true }),
    /**
     * Burn-after-read duration in seconds. When set, burn_at is computed server-side
     * as read_at + burnDurationSecs. Takes precedence over a client-supplied burn_at.
     */
    burnDurationSecs: integer('burn_duration_secs'),
    /** Direct E2E: set when the peer reads (first read wins). Null in group chats. */
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Pinned in chat header. Any member can pin/unpin. */
    isPinned: boolean('is_pinned').notNull().default(false),
    /** Timestamp of the most recent pin toggle (null if never pinned). */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    /** Set when the sender edits the message content; null for unedited. */
    editedAt: timestamp('edited_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    chatCreatedIdx: index('messages_chat_id_created_at_idx').on(
      t.chatId,
      t.createdAt
    ),
    chatSeqIdx: index('messages_chat_id_seq_idx').on(t.chatId, t.seq),
    senderIdx: index('messages_sender_id_idx').on(t.senderId),
    replyIdx: index('messages_reply_to_id_idx').on(t.replyToId),
    pinnedIdx: index('messages_chat_pinned_idx').on(t.chatId, t.isPinned),
  })
)

/** Per-message emoji reactions. */
export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: varchar('emoji', { length: 32 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    messageIdx: index('message_reactions_message_id_idx').on(t.messageId),
  })
)

/**
 * Per-device delivery slot for E2EE fan-out (Stage 5).
 *
 * Each row holds one ciphertext blob encrypted specifically for
 * the ECDH public key of `device_id`. The server never sees plaintext.
 *
 * Primary key: (message_id, device_id) — one slot per device per message.
 * user_id is a denormalized fast-path for "fetch my pending messages".
 */
export const messageDeliveries = pgTable(
  'message_deliveries',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Device this slot is addressed to. */
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    /** Denormalized owner — fast filter without joining devices. */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * ECDH-derived AES-GCM ciphertext for this device.
     * Null for legacy rows (pre-Stage-5) or group_e2e (content lives in messages.content).
     */
    ciphertext: text('ciphertext'),
    /** AES-GCM IV paired with ciphertext above. Null for legacy rows. */
    iv: text('iv'),
    /** Set when the recipient client acknowledges display. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.deviceId] }),
    userPendingIdx: index('message_deliveries_user_pending_idx').on(
      t.userId,
      t.deliveredAt
    ),
    deviceIdx: index('message_deliveries_device_id_idx').on(t.deviceId),
  })
)

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userEndpointIdx: uniqueIndex('push_subscriptions_user_id_endpoint_idx').on(
      t.userId,
      t.endpoint
    ),
  })
)

export const nativePushTokens = pgTable(
  'native_push_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: nativePushPlatformEnum('platform').notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userTokenUnique: uniqueIndex('native_push_tokens_user_platform_token_idx').on(
      t.userId,
      t.platform,
      t.token
    ),
    userIdx: index('native_push_tokens_user_idx').on(t.userId),
  })
)

/* ─────────────  SECURITY: Login Events & Blocks  ───────────────── */

export const loginEventOutcomeEnum = pgEnum('login_event_outcome', [
  'success',
  'fail_signature',
  'fail_totp',
  'fail_banned',
  'fail_device_revoked',
])

/** Audit trail for login attempts — retained for 90 days (cron or manual cleanup). */
export const loginEvents = pgTable(
  'login_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    username: text('username').notNull(),
    outcome: loginEventOutcomeEnum('outcome').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    deviceId: uuid('device_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index('login_events_user_id_idx').on(t.userId),
    createdAtIdx: index('login_events_created_at_idx').on(t.createdAt),
  })
)

/** Per-user block list — blocked user cannot message, see presence, or add to groups. */
export const userBlocks = pgTable(
  'user_blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.blockerId, t.blockedId] }),
    blockerIdx: index('user_blocks_blocker_id_idx').on(t.blockerId),
    blockedIdx: index('user_blocks_blocked_id_idx').on(t.blockedId),
  })
)

/* ─────────────  GROUP CHATS (TG + Discord style)  ───────────────── */

export const groupTypeEnum = pgEnum('group_type', [
  'group',
  'channel',
  'server',
])

export const channelTypeEnum = pgEnum('channel_type', [
  'text',
  'voice',
  'announcement',
])

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),
    avatar: text('avatar_url'),
    type: groupTypeEnum('type').notNull().default('group'),
    isPublic: boolean('is_public').notNull().default(false),
    inviteCode: varchar('invite_code', { length: 64 }).unique(),
    ownerId: uuid('owner_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerIdx: index('groups_owner_id_idx').on(t.ownerId),
    inviteIdx: uniqueIndex('groups_invite_code_idx').on(t.inviteCode),
  })
)

export const groupMembers = pgTable(
  'group_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: chatMemberRoleEnum('role').notNull().default('member'),
    nickname: varchar('nickname', { length: 50 }),
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    mutedUntil: timestamp('muted_until', { withTimezone: true }),
  },
  (t) => ({
    groupUserUnique: uniqueIndex('group_members_group_user_idx').on(
      t.groupId,
      t.userId
    ),
    userIdx: index('group_members_user_id_idx').on(t.userId),
  })
)

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 50 }).notNull(),
    type: channelTypeEnum('type').notNull().default('text'),
    topic: text('topic'),
    position: integer('position').notNull().default(0),
    isNsfw: boolean('is_nsfw').notNull().default(false),
    slowMode: integer('slow_mode').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    groupIdx: index('channels_group_id_idx').on(t.groupId),
    groupPositionIdx: index('channels_group_position_idx').on(
      t.groupId,
      t.position
    ),
  })
)

export const groupMessages = pgTable(
  'group_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references(() => channels.id, {
      onDelete: 'cascade',
    }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    replyToId: uuid('reply_to_id'),
    content: text('content'),
    isPinned: boolean('is_pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    groupCreatedIdx: index('group_messages_group_created_idx').on(
      t.groupId,
      t.createdAt
    ),
    channelCreatedIdx: index('group_messages_channel_created_idx').on(
      t.channelId,
      t.createdAt
    ),
    senderIdx: index('group_messages_sender_idx').on(t.senderId),
  })
)

/* ──────────────────────────────────────────────────────────────────────────
 *  Double Ratchet / X3DH key directory
 *  Added in protocol_version=2. See docs/project/MIGRATION_NOTES.md — phase 3.2.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * One Ed25519 + X25519 pair per user. The X25519 public key is the "identity
 * exchange" key used by X3DH (DH2). The Ed25519 key signs signed pre-keys
 * and message envelopes. Clients are expected to publish exactly one active
 * identity per account — rotation means user-visible "new identity" warning.
 */
export const identityKeys = pgTable(
  'identity_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Base64url Ed25519 public signing key (32 bytes). */
    signingPublicKey: text('signing_public_key').notNull(),
    /** Base64url X25519 public exchange key (32 bytes). */
    exchangePublicKey: text('exchange_public_key').notNull(),
    /** Monotonic — `curl POST /keys/identity` bumps this and invalidates prekeys. */
    generation: integer('generation').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId] }),
  })
)

/**
 * Signed pre-keys rotate every N days. Only one record is "current" —
 * clients overwrite the previous row on rotation. The `signature` field
 * is Ed25519(signingPrivateKey, exchangePublicKey).
 */
export const signedPrekeys = pgTable(
  'signed_prekeys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    preKeyId: integer('pre_key_id').notNull(),
    publicKey: text('public_key').notNull(),
    signature: text('signature').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.preKeyId] }),
    userCreatedIdx: index('signed_prekeys_user_created_idx').on(
      t.userId,
      t.createdAt
    ),
  })
)

/**
 * One-time pre-keys are consumed atomically by the first X3DH request that
 * references them. The server deletes the row as part of the bundle fetch
 * transaction; clients replenish the pool as part of key-management cadence.
 */
export const oneTimePrekeys = pgTable(
  'onetime_prekeys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    preKeyId: integer('pre_key_id').notNull(),
    publicKey: text('public_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.preKeyId] }),
    userIdx: index('onetime_prekeys_user_idx').on(t.userId),
  })
)

/**
 * Phase 5.2 — sticker directory. Packs are user-owned but can be shared:
 * `owner_id` is the uploader, `is_public` exposes the pack on discovery.
 * Individual stickers store a MinIO key (`media_key`) and a per-sticker
 * thumbhash for fast rendering before the asset downloads.
 */
export const stickerPacks = pgTable(
  'sticker_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 128 }).notNull(),
    shortName: varchar('short_name', { length: 64 }).notNull(),
    format: stickerFormatEnum('format').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    /** Matches Telegram pack `short_name` when imported via Bot API. */
    tgSource: text('tg_source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    shortNameUnique: uniqueIndex('sticker_packs_short_name_unique').on(t.shortName),
    ownerIdx: index('sticker_packs_owner_idx').on(t.ownerId),
  })
)

export const stickerPackShares = pgTable(
  'sticker_pack_shares',
  {
    packId: uuid('pack_id')
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.packId, t.userId] }),
    userIdx: index('sticker_pack_shares_user_idx').on(t.userId),
  })
)

export const stickers = pgTable(
  'stickers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packId: uuid('pack_id')
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    /** Unicode emoji(s) the sticker is associated with (comma-joined). */
    emoji: varchar('emoji', { length: 32 }).notNull().default(''),
    mediaKey: text('media_key').notNull(),
    thumbhash: text('thumbhash'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    packPositionIdx: index('stickers_pack_position_idx').on(t.packId, t.position),
  })
)

export const messageThreads = pgTable(
  'message_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id').references(() => channels.id, {
      onDelete: 'cascade',
    }),
    groupId: uuid('group_id').references(() => groups.id, {
      onDelete: 'cascade',
    }),
    title: varchar('title', { length: 100 }),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    channelIdx: index('message_threads_channel_idx').on(t.channelId),
    groupIdx: index('message_threads_group_idx').on(t.groupId),
  })
)

export const polls = pgTable(
  'polls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    question: varchar('question', { length: 300 }).notNull(),
    options: jsonb('options').notNull().$type<string[]>(),
    allowMultiple: boolean('allow_multiple').notNull().default(false),
    isAnonymous: boolean('is_anonymous').notNull().default(false),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chatIdx: index('polls_chat_idx').on(t.chatId),
    msgIdx: index('polls_message_idx').on(t.messageId),
  })
)

export const pollVotes = pgTable(
  'poll_votes',
  {
    pollId: uuid('poll_id').notNull().references(() => polls.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    optionIndex: integer('option_index').notNull(),
    votedAt: timestamp('voted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.pollId, t.userId, t.optionIndex] }),
    pollIdx: index('poll_votes_poll_idx').on(t.pollId),
  })
)

export const callSessions = pgTable(
  'call_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    initiatedBy: uuid('initiated_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSecs: integer('duration_secs'),
    callType: text('call_type').notNull().default('audio'),
    participantIds: uuid('participant_ids').array().notNull().default(sql`'{}'::uuid[]`),
    endReason: text('end_reason'),
  },
  (t) => ({
    chatIdx: index('call_sessions_chat_idx').on(t.chatId),
    initiatedByIdx: index('call_sessions_initiated_by_idx').on(t.initiatedBy),
    startedAtIdx: index('call_sessions_started_at_idx').on(t.startedAt),
  })
)
