import { API_URL } from './auth'

export type PollOption = string

export type Poll = {
  id: string
  chat_id: string
  message_id: string | null
  created_by: string
  question: string
  options: PollOption[]
  allow_multiple: boolean
  is_anonymous: boolean
  closed_at: string | null
  created_at: string
}

export type PollResults = {
  vote_counts: { optionIndex: number; count: number }[]
  total_voters: number
  my_votes: number[]
  is_anonymous: boolean
}

export type CreatePollInput = {
  chat_id: string
  question: string
  options: string[]
  allow_multiple?: boolean
  is_anonymous?: boolean
}

export async function createPoll(input: CreatePollInput): Promise<{ poll_id: string; message_id: string }> {
  const res = await fetch(`${API_URL}/polls`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error ?? 'CREATE_POLL_FAILED')
  return res.json() as Promise<{ poll_id: string; message_id: string }>
}

export async function votePoll(pollId: string, optionIndices: number[]): Promise<{ results: PollResults }> {
  const res = await fetch(`${API_URL}/polls/${pollId}/vote`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ option_indices: optionIndices }),
  })
  if (!res.ok) throw new Error((await res.json() as { error: string }).error ?? 'VOTE_FAILED')
  return res.json() as Promise<{ results: PollResults }>
}

export async function getPoll(pollId: string): Promise<{ poll: Poll; results: PollResults }> {
  const res = await fetch(`${API_URL}/polls/${pollId}`, { credentials: 'include' })
  if (!res.ok) throw new Error('FETCH_POLL_FAILED')
  return res.json() as Promise<{ poll: Poll; results: PollResults }>
}
