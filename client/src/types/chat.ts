export type DecryptedMessage = {
  id: string
  chat_id: string
  sender_id: string
  plaintext: string
  created_at: string
  media_path?: string | null
  media_type?: 'audio' | 'video' | 'image' | null
  media_iv?: string | null
}

export type ChatRow = {
  id: string
  is_group: boolean
  created_at: string
}
