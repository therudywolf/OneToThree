/**
 * Shared "[deleted]" sentinel user. On account deletion (self-delete or admin
 * purge) a user's group/sector messages are re-pointed to this row and redacted,
 * so peers see "[deleted]" tombstones instead of gaps — the `messages.sender_id`
 * FK is ON DELETE CASCADE and would otherwise hard-delete every message the user
 * ever sent. The username uses characters the nickname validator rejects, so no
 * real user can register or collide with it; it has no public key so it can't
 * log in, and is_discoverable defaults to false so it never appears in search.
 * Resolved to "[deleted]" via /users/lookup.
 */
export const DELETED_USER_ID = '00000000-0000-4000-8000-000000000000'
export const DELETED_USER_USERNAME = '[deleted]'
