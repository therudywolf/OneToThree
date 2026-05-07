'use client'

import { useEffect, useState, useCallback } from 'react'
import { getPoll, votePoll } from '@/lib/api/polls'
import type { Poll, PollResults } from '@/lib/api/polls'

type Props = {
  pollId: string
  initialPoll?: Poll
  initialResults?: PollResults
}

export function PollBubble({ pollId, initialPoll, initialResults }: Props) {
  const [poll, setPoll] = useState<Poll | null>(initialPoll ?? null)
  const [results, setResults] = useState<PollResults | null>(initialResults ?? null)
  const [voting, setVoting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (poll && results) return
    void getPoll(pollId)
      .then(({ poll: p, results: r }) => { setPoll(p); setResults(r) })
      .catch(() => setErr('LOAD_FAILED'))
  }, [pollId, poll, results])

  useEffect(() => {
    const handler = (e: Event) => {
      const { poll_id, results: r } = (e as CustomEvent<{ poll_id: string; results: PollResults }>).detail
      if (poll_id === pollId) setResults(r)
    }
    window.addEventListener('p13:poll_updated', handler)
    return () => window.removeEventListener('p13:poll_updated', handler)
  }, [pollId])

  const handleVote = useCallback(async (optionIndex: number) => {
    if (!poll || voting) return
    const currentMyVotes = results?.my_votes ?? []
    let newIndices: number[]
    if (poll.allow_multiple) {
      newIndices = currentMyVotes.includes(optionIndex)
        ? currentMyVotes.filter((i) => i !== optionIndex)
        : [...currentMyVotes, optionIndex]
    } else {
      newIndices = currentMyVotes[0] === optionIndex ? [] : [optionIndex]
    }
    setVoting(true)
    setErr(null)
    try {
      const { results: r } = await votePoll(pollId, newIndices)
      setResults(r)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'VOTE_FAILED')
    } finally {
      setVoting(false)
    }
  }, [poll, results, pollId, voting])

  if (err && !poll) {
    return (
      <div className="p-2 font-mono text-[10px] text-danger/80">[!] {err}</div>
    )
  }

  if (!poll) {
    return (
      <div className="min-w-[200px] p-3">
        <div className="animate-pulse font-mono text-[9px] text-neon-cyan/40">LOADING POLL...</div>
      </div>
    )
  }

  const options = poll.options as string[]
  const myVotes = results?.my_votes ?? []
  const totalVoters = results?.total_voters ?? 0
  const voteCounts = results?.vote_counts ?? []
  const isClosed = poll.closed_at ? new Date(poll.closed_at) < new Date() : false
  const hasVoted = myVotes.length > 0
  const getCount = (idx: number) => voteCounts.find((v) => v.optionIndex === idx)?.count ?? 0
  const maxCount = Math.max(...options.map((_, i) => getCount(i)), 1)

  return (
    <div className="poll-bubble min-w-[220px] max-w-[320px] select-none">
      <p className="poll-question mb-2 font-[family-name:var(--p13-font-body)] text-[13px] font-semibold leading-snug">
        {poll.question}
      </p>

      <div className="mb-2 flex flex-wrap gap-1">
        {poll.is_anonymous && <span className="poll-badge">ANON</span>}
        {poll.allow_multiple && <span className="poll-badge">MULTI</span>}
        {isClosed && <span className="poll-badge poll-badge--closed">CLOSED</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        {options.map((option, idx) => {
          const count = getCount(idx)
          const pct = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0
          const barPct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0
          const isSelected = myVotes.includes(idx)
          const showResults = hasVoted || isClosed
          return (
            <button
              key={idx}
              type="button"
              disabled={isClosed || voting}
              onClick={() => void handleVote(idx)}
              className={[
                'poll-option group relative w-full overflow-hidden rounded-[var(--p13-radius-msg)]',
                'border text-left transition-colors',
                isSelected
                  ? 'border-neon-cyan/70 bg-neon-cyan/10'
                  : 'border-neon-cyan/20 bg-void/40 hover:border-neon-cyan/40 hover:bg-neon-cyan/5',
                isClosed ? 'cursor-default' : 'cursor-pointer',
              ].join(' ')}
            >
              {showResults && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 rounded-[var(--p13-radius-msg)] bg-neon-cyan/10 transition-all duration-500"
                  style={{ width: barPct + '%' }}
                />
              )}
              <span className="relative flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="flex items-center gap-1.5 font-[family-name:var(--p13-font-body)] text-[12px] leading-snug">
                  {isSelected && (
                    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0 fill-neon-cyan">
                      <polyline points="1,5 4,8 9,2" stroke="currentColor" strokeWidth="2" fill="none" />
                    </svg>
                  )}
                  {option}
                </span>
                {showResults && (
                  <span className="shrink-0 font-mono text-[9px] tabular-nums text-text-muted">
                    {pct}%
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>

      <p className="mt-1.5 font-mono text-[9px] text-text-muted">
        {totalVoters === 0 ? 'No votes yet' : totalVoters + ' vote' + (totalVoters === 1 ? '' : 's')}
        {err ? <span className="ml-2 text-danger/70"> {err}</span> : null}
      </p>

    </div>
  )
}
