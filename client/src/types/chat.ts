export type DecryptedMessage = {
  id: string
  chat_id: string
  sender_id: string
  plaintext: string
  created_at: string
  reply_to_id?: string | null
  media_path?: string | null
  media_type?: 'audio' | 'video' | 'image' | 'file' | null
  media_iv?: string | null
  /** Direct E2E: set when peer has read (server `read_at`). */
  read_at?: string | null
  /** Burn-after-read: remove locally after this instant (server-synced metadata). */
  burn_at?: string | null
}

export type ChatRow = {
  id: string
  is_group: boolean
  created_at: string
}
