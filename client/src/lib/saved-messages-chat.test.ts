import { describe, expect, it } from 'vitest'
import { isSavedMessagesChat } from '@/lib/saved-messages-chat'

describe('isSavedMessagesChat', () => {
  const uid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('returns true when API sets is_self', () => {
    expect(
      isSavedMessagesChat(
        { is_group: false, member_ids: ['other-id'], is_self: true },
        uid
      )
    ).toBe(true)
  })

  it('returns true for single-member direct matching user (legacy)', () => {
    expect(
      isSavedMessagesChat({ is_group: false, member_ids: [uid], is_self: undefined }, uid)
    ).toBe(true)
  })

  it('returns false for two-member DM', () => {
    expect(
      isSavedMessagesChat(
        { is_group: false, member_ids: [uid, 'peer-id'], is_self: false },
        uid
      )
    ).toBe(false)
  })
})
