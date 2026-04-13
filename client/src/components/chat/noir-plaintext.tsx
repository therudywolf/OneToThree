'use client'

import React, { useMemo } from 'react'
import emojiRegex from 'emoji-regex'

/**
 * PROJECT 13 :: TEXT_VISUAL_FILTER
 * Level: Interface Layer (Aesthetic Processing)
 * Vibe: Clinical Pure / Noir Filter / Dead Inside
 * Purpose: Wrapping emoji clusters for terminal-grade CSS injection.
 */

type Props = { 
  text: string; 
  className?: string 
}

export function NoirPlaintext({ text, className = '' }: Props) {
  const processedNodes = useMemo(() => {
    const re = emojiRegex()
    const segments: React.ReactNode[] = []
    
    let lastCursor = 0
    let nodeIndex = 0

    // [PROCESS_STREAM] :: Поиск и изоляция эмодзи-кластеров
    for (const match of text.matchAll(re)) {
      const emoji = match[0]
      const index = match.index ?? 0

      // Вставка обычного текстового узла до эмодзи
      if (index > lastCursor) {
        segments.push(text.slice(lastCursor, index))
      }

      // Вставка изолированного эмодзи-узла под нуар-фильтр
      segments.push(
        <span 
          key={`node-${nodeIndex++}`} 
          className="noir-emoji-inline"
          aria-hidden="false"
        >
          {emoji}
        </span>
      )
      
      lastCursor = index + emoji.length
    }

    // Хвост текстового потока
    if (lastCursor < text.length) {
      segments.push(text.slice(lastCursor))
    }

    return segments
  }, [text])

  return <span className={className}>{processedNodes}</span>
}