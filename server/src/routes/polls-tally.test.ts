import { describe, expect, it } from 'vitest'
import { tallyPollVotes } from './polls.js'

/**
 * Regression net for `poll-broadcast-leaks-voter-ballot`: poll_updated used to
 * ship ONE getPollResults() object — including the voter's own `my_votes` — to
 * every member, which disclosed the ballot of an anonymous poll and made the
 * next member's client re-POST the leaked indices as its own vote. The fan-out
 * is now per recipient, built from this tally.
 */
describe('tallyPollVotes', () => {
  it('keeps ballots scoped per voter and counts each option once', () => {
    const { voteCounts, totalVoters, byUser } = tallyPollVotes([
      { userId: 'alice', optionIndex: 1 },
      { userId: 'bob', optionIndex: 0 },
      { userId: 'bob', optionIndex: 1 },
    ])

    expect(byUser.get('alice')).toEqual([1])
    expect(byUser.get('bob')).toEqual([0, 1])
    // Carol has not voted: she must get an EMPTY ballot, never Alice's.
    expect(byUser.get('carol')).toBeUndefined()

    expect(totalVoters).toBe(2)
    expect([...voteCounts].sort((a, b) => a.optionIndex - b.optionIndex)).toEqual([
      { optionIndex: 0, count: 1 },
      { optionIndex: 1, count: 2 },
    ])
  })

  it('returns empty tallies for a poll nobody voted in', () => {
    const { voteCounts, totalVoters, byUser } = tallyPollVotes([])
    expect(voteCounts).toEqual([])
    expect(totalVoters).toBe(0)
    expect(byUser.size).toBe(0)
  })
})
