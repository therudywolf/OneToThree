export type DecryptedMessage = {
  id: string
  chat_id: string
  sender_id: string
  plaintext: string
  created_at: string
}

export type ChatRow = {
  id: string
  is_group: boolean
  created_at: string
}
