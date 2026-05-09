'use client'

/**
 * @mentions autocomplete popover for the chat composer.
 *
 * Usage: render inside the composer container with absolute positioning.
 * Parent calls `onInsert(username)` when a member is selected, and toggles
 * `open` based on whether the composer text contains an active `@` trigger.
 */

import { useEffect, useRef, useCallback } from 'react'
import { User } from 'lucide-react'

export interface MentionMember {
  userId: string
  username: string
  displayName?: string
  avatarUrl?: string
}

interface MentionsPopoverProps {
  open: boolean
  members: MentionMember[]
  query: string          // text after the @ trigger
  activeIndex: number
  onSelect: (member: MentionMember) => void
  onClose?: () => void
}

export function MentionsPopover({
  open,
  members,
  query,
  activeIndex,
  onSelect,
}: MentionsPopoverProps) {
  const listRef = useRef<HTMLUListElement>(null)

  // Filter members by the typed query
  const filtered = query
    ? members.filter(
        (m) =>
          m.username.toLowerCase().startsWith(query.toLowerCase()) ||
          (m.displayName?.toLowerCase().startsWith(query.toLowerCase()) ?? false)
      )
    : members.slice(0, 8)

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleClick = useCallback(
    (m: MentionMember) => {
      onSelect(m)
    },
    [onSelect]
  )

  if (!open || filtered.length === 0) return null

  return (
    <div
      role="listbox"
      aria-label="Mentions autocomplete"
      className="p13-mentions-popover"
    >
      <ul ref={listRef} className="p13-mentions-list">
        {filtered.map((m, i) => (
          <li
            key={m.userId}
            role="option"
            aria-selected={i === activeIndex}
            className={`p13-mention-item${i === activeIndex ? ' p13-mention-item--active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault() // avoid blurring the textarea
              handleClick(m)
            }}
          >
            {m.avatarUrl ? (
              <img
                src={m.avatarUrl}
                alt=""
                className="p13-mention-avatar"
                aria-hidden="true"
              />
            ) : (
              <span className="p13-mention-avatar p13-mention-avatar--placeholder" aria-hidden="true">
                <User size={14} />
              </span>
            )}
            <span className="p13-mention-name">
              {m.displayName && (
                <span className="p13-mention-display">{m.displayName}</span>
              )}
              <span className="p13-mention-username">@{m.username}</span>
            </span>
          </li>
        ))}
      </ul>

      <style>{`
        .p13-mentions-popover {
          position: absolute;
          bottom: calc(100% + 4px);
          left: 0;
          right: 0;
          max-height: 220px;
          overflow: hidden;
          background: var(--surface-2, #1e1e2e);
          border: 1px solid var(--border-subtle, rgba(255,255,255,0.1));
          border-radius: 10px;
          box-shadow: 0 4px 24px rgba(0,0,0,0.35);
          z-index: 50;
          animation: p13MentionFadeIn 120ms ease;
        }
        @keyframes p13MentionFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .p13-mentions-list {
          list-style: none;
          margin: 0;
          padding: 4px 0;
          overflow-y: auto;
          max-height: 220px;
        }
        .p13-mention-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 7px 14px;
          cursor: pointer;
          transition: background 80ms;
        }
        .p13-mention-item:hover,
        .p13-mention-item--active {
          background: var(--accent-2-15, rgba(120,120,255,0.15));
        }
        .p13-mention-avatar {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
        }
        .p13-mention-avatar--placeholder {
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--surface-3, #2a2a3e);
          color: var(--text-secondary, #888);
        }
        .p13-mention-name {
          display: flex;
          flex-direction: column;
          line-height: 1.3;
          min-width: 0;
        }
        .p13-mention-display {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #e0e0e0);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .p13-mention-username {
          font-size: 11px;
          color: var(--text-secondary, #888);
        }
        [data-shell="terminal"] .p13-mentions-popover {
          border-radius: 2px;
          font-family: var(--font-mono, monospace);
          border-color: var(--accent-term, #0f0);
        }
        [data-shell="terminal"] .p13-mention-display {
          font-size: 12px;
        }
      `}</style>
    </div>
  )
}

/**
 * Parse the active `@mention` trigger from the current textarea value and
 * cursor position. Returns `{ trigger: true, query }` when an active mention
 * is being typed, or `{ trigger: false }` otherwise.
 */
export function parseMentionTrigger(
  text: string,
  cursorPos: number
): { trigger: true; query: string; triggerStart: number } | { trigger: false } {
  // Scan backwards from the cursor for an unspaced '@'
  const before = text.slice(0, cursorPos)
  const atIdx = before.lastIndexOf('@')
  if (atIdx === -1) return { trigger: false }

  // Ensure there's no space between '@' and cursor
  const fragment = before.slice(atIdx + 1)
  if (fragment.includes(' ') || fragment.includes('\n')) return { trigger: false }

  // '@' must be at start or preceded by whitespace / newline
  if (atIdx > 0 && !/[\s\n]/.test(before[atIdx - 1])) return { trigger: false }

  return { trigger: true, query: fragment, triggerStart: atIdx }
}
