/**
 * PROJECT 13 :: DATA_STRUCTURE_PROTOCOL
 * Level: Decrypted Layer (Atomic Nodes)
 * Vibe: Clinical Steel / Noir Intelligence
 */

export type DecryptedNode = {
  id: string
  chat_id: string
  sender_id: string
  
  /** Дешифрованный полезный код (Тело сообщения) */
  body: string 
  
  created_at: string
  reply_to_id?: string | null
  
  /** * Сегментарный слой (Attachments)
   * Путь к зашифрованному объекту в хранилище и его вектор инициализации.
   */
  segment_path?: string | null
  segment_type?: 'audio' | 'video' | 'image' | 'file' | null
  segment_iv?: string | null
  
  /** * Метка доступа (Access Mark)
   * Устанавливается при вскрытии узла получателем (server read_at). 
   */
  access_mark?: string | null
  
  /** * Метка ликвидации (Burn Mark)
   * Таймер самоликвидации. После этого момента узел должен быть стерт из всех слоев.
   */
  burn_mark?: string | null
}

/**
 * Описание коммуникационного канала (Линка)
 */
export type ChannelNode = {
  id: string
  
  /** Режим вещания: true — групповой сектор, false — прямой линк */
  is_broadcast: boolean 
  
  created_at: string
}