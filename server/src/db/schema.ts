import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'

export const chatTypeEnum = pgEnum('chat_type', [
  'direct_e2e',
  'group_e2e',
  'public_open',
])

export const chatMemberRoleEnum = pgEnum('chat_member_role', [
  'owner',
  'admin',
  'member',
])

export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])

export const reportStatusEnum = pgEnum('report_status', ['open', 'closed'])

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
  /** Short bio / about text. */
  bio: text('bio'),
  /** Custom status text (e.g. "busy", "do not disturb", free-form). */
  statusText: text('status_text'),
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
    /** Random slug for group invite links; unique when set. */
    inviteCode: text('invite_code'),
    /** When true, first successful join by a new member clears `invite_code`. */
    inviteOneTime: boolean('invite_one_time').notNull().default(false),
  },
  (t) => ({
    inviteCodeUnique: uniqueIndex('chats_invite_code_unique').on(t.inviteCode),
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
    joinedAt: timestamp('joined_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.userId] }),
  })
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    replyToId: uuid('reply_to_id'),
    content: text('content'),
    iv: text('iv'),
    mediaPath: text('media_path'),
    mediaType: text('media_type'),
    mediaIv: text('media_iv'),
    /** Plaintext byte length of uploaded blob (for admin storage audit). */
    mediaOriginalBytes: bigint('media_original_bytes', { mode: 'number' }),
    /** Burn-after-read: hide locally after this time (server metadata). */
    burnAt: timestamp('burn_at', { withTimezone: true }),
    /** Direct E2E: set when the peer reads (first read wins). Null in group chats. */
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    chatCreatedIdx: index('messages_chat_id_created_at_idx').on(
      t.chatId,
      t.createdAt
    ),
    senderIdx: index('messages_sender_id_idx').on(t.senderId),
    replyIdx: index('messages_reply_to_id_idx').on(t.replyToId),
  })
)

/** Per-recipient delivery for store-and-forward (E2EE ciphertext is opaque to the server). */
export const messageDeliveries = pgTable(
  'message_deliveries',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Set when the recipient client acknowledges display (REST) or equivalent sync. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.messageId, t.userId] }),
    userPendingIdx: index('message_deliveries_user_pending_idx').on(
      t.userId,
      t.deliveredAt
    ),
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

/* ─────────────  SECURITY: Login Events & Blocks  ───────────── */

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

/* ─────────────  GROUP CHATS (TG + Discord style)  ───────────── */

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
