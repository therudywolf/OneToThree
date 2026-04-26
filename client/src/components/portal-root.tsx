'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ensureBackdropCleanup } from '@/lib/backdrop-cleanup'

type PortalRootProps = {
  children: React.ReactNode
}

/**
 * Portal wrapper to render overlays, modals, and custom elements at document.body.
 * Ensures proper z-index stacking and cleanup of overflow/dark filters.
 */
export function PortalRoot({ children }: PortalRootProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = document.createElement('div')
    node.dataset.fmPortalRoot = 'true'
    node.style.position = 'relative'
    node.style.zIndex = '1000'
    document.body.appendChild(node)
    containerRef.current = node
    setContainer(node)

    return () => {
      if (containerRef.current && containerRef.current.parentNode) {
        containerRef.current.parentNode.removeChild(containerRef.current)
      }
      containerRef.current = null
      // Do not unlock the page while another dialog portal is still mounted.
      ensureBackdropCleanup()
    }
  }, [])

  if (!container) return null

  return createPortal(children, container)
}
