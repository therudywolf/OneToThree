import { boolean, pgEnum, pgTable, primaryKey, text, timestamp, uuid, } from 'drizzle-orm/pg-core';
export const chatTypeEnum = pgEnum('chat_type', [
    'direct_e2e',
    'group_e2e',
    'public_open',
]);
export const users = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull().unique(),
    publicKeyJwk: text('public_key_jwk').notNull(),
    /** ECDH public JWK for E2E messaging (optional until client uploads). */
    ecdhPublicKeyJwk: text('ecdh_public_key_jwk'),
    isDiscoverable: boolean('is_discoverable').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
export const chats = pgTable('chats', {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    type: chatTypeEnum('type').notNull(),
});
export const chatMembers = pgTable('chat_members', {
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
}, (t) => ({
    pk: primaryKey({ columns: [t.chatId, t.userId] }),
}));
export const messages = pgTable('messages', {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
        .notNull()
        .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content'),
    iv: text('iv'),
    mediaPath: text('media_path'),
    mediaType: text('media_type'),
    mediaIv: text('media_iv'),
    createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
});
