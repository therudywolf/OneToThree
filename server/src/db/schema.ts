import {
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const chatTypeEnum = pgEnum('chat_type', [
  'direct_e2e',
  'group_e2e',
  'public_open',
])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  publicKeyJwk: text('public_key_jwk').notNull(),
  /** ECDH public JWK for E2E messaging (optional until client uploads). */
  ecdhPublicKeyJwk: text('ecdh_public_key_jwk'),
  isDiscoverable: boolean('is_discoverable').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export const chats = pgTable('chats', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  type: chatTypeEnum('type').notNull(),
})

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
