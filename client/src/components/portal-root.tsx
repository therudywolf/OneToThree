'use client'

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cleanupBackdropOverflow, ensureBackdropCleanup } from '@/lib/backdrop-cleanup'

type PortalRootProps = {
  children: React.ReactNode
}

/**
 * Portal wrapper to render overlays, modals, and custom elements at document.body.
 * Ensures proper z-index stacking and cleanup of overflow/dark filters.
 */
export function PortalRoot({ children }: PortalRootProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // Create a portal container if it doesn't exist
    if (!containerRef.current) {
      const container = document.createElement('div')
      container.id = 'fm-portal-root'
      container.style.position = 'relative'
      container.style.zIndex = '1000'
      document.body.appendChild(container)
      containerRef.current = container
    }

    return () => {
      // Cleanup: remove container and ensure backdrop is clean
      if (containerRef.current && containerRef.current.parentNode) {
        containerRef.current.parentNode.removeChild(containerRef.current)
        containerRef.current = null
      }
      // Ensure body overflow is restored and dark filters are removed
      cleanupBackdropOverflow()
      ensureBackdropCleanup()
    }
  }, [])

  if (!containerRef.current) {
    return null
  }

  return createPortal(children, containerRef.current)
}
