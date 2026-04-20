'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from '@/hooks/use-translation'

type MediaItem = {
  id: string
  url: string
  type: 'image' | 'video'
  mimeType: string
}

type MediaLightboxProps = {
  isOpen: boolean
  media: MediaItem[]
  currentIndex: number
  onClose: () => void
  onNavigate: (index: number) => void
  onLoadMedia?: (index: number) => Promise<string | null>
}

export function MediaLightbox({
  isOpen,
  media,
  currentIndex,
  onClose,
  onNavigate,
  onLoadMedia,
}: MediaLightboxProps) {
  const { t: _t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [isZoomed, setIsZoomed] = useState(false)
  const [panX, setPanX] = useState(0)
  const [panY, setPanY] = useState(0)
  const dragRef = useRef<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null)
  const pinchRef = useRef<{ initialDistance: number; initialZoom: number } | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  const resetPan = useCallback(() => {
    setPanX(0)
    setPanY(0)
  }, [])

  const [loadingNav, setLoadingNav] = useState(false)

  // Memoize navigation callbacks to prevent stale closures in event listeners
  const navigatePrev = useCallback(async () => {
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (media[i]) {
        if (media[i].url) {
          onNavigate(i)
          setZoom(1)
          setIsZoomed(false)
          resetPan()
          return
        }
        if (onLoadMedia) {
          setLoadingNav(true)
          const url = await onLoadMedia(i)
          setLoadingNav(false)
          if (url) {
            onNavigate(i)
            setZoom(1)
            setIsZoomed(false)
            resetPan()
            return
          }
        }
      }
    }
  }, [currentIndex, media, onNavigate, resetPan, onLoadMedia])

  const navigateNext = useCallback(async () => {
    for (let i = currentIndex + 1; i < media.length; i++) {
      if (media[i]) {
        if (media[i].url) {
          onNavigate(i)
          setZoom(1)
          setIsZoomed(false)
          resetPan()
          return
        }
        if (onLoadMedia) {
          setLoadingNav(true)
          const url = await onLoadMedia(i)
          setLoadingNav(false)
          if (url) {
            onNavigate(i)
            setZoom(1)
            setIsZoomed(false)
            resetPan()
            return
          }
        }
      }
    }
  }, [currentIndex, media, onNavigate, resetPan, onLoadMedia])

  useEffect(() => {
    if (!isOpen) {
      setZoom(1)
      setIsZoomed(false)
      resetPan()
      return
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          e.preventDefault()
          navigatePrev()
          break
        case 'ArrowRight':
          e.preventDefault()
          navigateNext()
          break
        case '+':
        case '=':
          e.preventDefault()
          handleZoomIn()
          break
        case '-':
          e.preventDefault()
          handleZoomOut()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, navigateNext, navigatePrev, onClose])

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(prev * 1.5, 3))
    setIsZoomed(true)
  }

  const handleZoomOut = () => {
    const newZoom = zoom / 1.5
    setZoom(newZoom)
    if (newZoom <= 1) {
      setIsZoomed(false)
      resetPan()
    }
  }

  const resetZoom = () => {
    setZoom(1)
    setIsZoomed(false)
    resetPan()
  }

  // Pointer handlers for drag-to-pan
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPanX: panX,
      startPanY: panY,
    }
  }, [zoom, panX, panY])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || zoom <= 1) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    setPanX(dragRef.current.startPanX + dx / zoom)
    setPanY(dragRef.current.startPanY + dy / zoom)
  }, [zoom])

  const handlePointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  // Touch pinch-to-zoom
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      pinchRef.current = {
        initialDistance: Math.hypot(dx, dy),
        initialZoom: zoom,
      }
    }
  }, [zoom])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      e.preventDefault()
      const dx = e.touches[0].clientX - e.touches[1].clientX
      const dy = e.touches[0].clientY - e.touches[1].clientY
      const distance = Math.hypot(dx, dy)
      const scale = distance / pinchRef.current.initialDistance
      const newZoom = Math.min(Math.max(pinchRef.current.initialZoom * scale, 1), 3)
      setZoom(newZoom)
      setIsZoomed(newZoom > 1)
      if (newZoom <= 1) resetPan()
    }
  }, [resetPan])

  const handleTouchEnd = useCallback(() => {
    pinchRef.current = null
  }, [])

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setZoom((prev) => {
      const next = Math.min(Math.max(prev * factor, 1), 3)
      if (next <= 1) {
        setIsZoomed(false)
        resetPan()
      } else {
        setIsZoomed(true)
      }
      return next
    })
  }, [resetPan])

  if (!isOpen || !media[currentIndex]) return null

  const currentMedia = media[currentIndex]

  const hasPrev = media.slice(0, currentIndex).some(m => m && (!!m.url || !!onLoadMedia))
  const hasNext = media.slice(currentIndex + 1).some(m => m && (!!m.url || !!onLoadMedia))
  const hasMultiple = hasPrev || hasNext

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-void/95 backdrop-blur-md">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-none border border-neon-cyan/50 bg-void/80 p-2 text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
        aria-label="Close lightbox"
      >
        <X className="h-6 w-6" />
      </button>

      {/* Navigation buttons */}
      {hasMultiple && (
        <>
          {hasPrev && (
            <button
              onClick={(e) => { e.stopPropagation(); navigatePrev(); }}
              className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-none border border-neon-cyan/50 bg-void/80 p-3 text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-8 w-8" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={(e) => { e.stopPropagation(); navigateNext(); }}
              className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-none border border-neon-cyan/50 bg-void/80 p-3 text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
              aria-label="Next image"
            >
              <ChevronRight className="h-8 w-8" />
            </button>
          )}
        </>
      )}

      {/* Zoom controls */}
      <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); handleZoomOut(); }}
          disabled={zoom <= 1}
          className="rounded-none border border-neon-cyan/50 bg-void/80 p-2 text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); resetZoom(); }}
          disabled={!isZoomed}
          className="min-w-[60px] rounded-none border border-neon-cyan/50 bg-void/80 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleZoomIn(); }}
          disabled={zoom >= 3}
          className="rounded-none border border-neon-cyan/50 bg-void/80 p-2 text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
      </div>

      {/* Media counter */}
      {media.length > 1 && (
        <div className="absolute bottom-4 right-4 z-10 font-mono text-[10px] uppercase tracking-widest text-neon-cyan/80 bg-void/50 px-2 py-1 border border-neon-cyan/20">
          {currentIndex + 1} / {media.length}
        </div>
      )}

      {/* Loading indicator */}
      {loadingNav && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/50">
          <p className="animate-pulse font-mono text-[10px] uppercase tracking-widest text-neon-cyan">
            [ DECRYPTING... ]
          </p>
        </div>
      )}

      {/* Media content */}
      <div
        className="relative flex h-full w-full items-center justify-center overflow-hidden p-4"
        onClick={zoom <= 1 ? onClose : undefined}
        onWheel={handleWheel}
      >
        {currentMedia.type === 'image' ? (
          <img
            ref={imageRef}
            src={currentMedia.url}
            alt="Decrypted Media"
            className="max-h-full max-w-full object-contain select-none"
            style={{
              transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
              cursor: zoom > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'zoom-in',
              transition: dragRef.current ? 'none' : 'transform 0.2s ease',
              touchAction: 'none',
            }}
            onClick={(e) => {
              e.stopPropagation()
              if (!dragRef.current) {
                isZoomed ? resetZoom() : handleZoomIn()
              }
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            draggable={false}
          />
        ) : (
          <video
            src={currentMedia.url}
            controls
            className="max-h-full max-w-full object-contain border border-neon-cyan/30"
            style={{ transform: `scale(${zoom})` }}
            autoPlay={false}
            playsInline
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>
    </div>
  )
}
