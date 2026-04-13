'use client'

import { useEffect, useState, useCallback } from 'react'
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
}

export function MediaLightbox({
  isOpen,
  media,
  currentIndex,
  onClose,
  onNavigate,
}: MediaLightboxProps) {
  const { t } = useTranslation()
  const [zoom, setZoom] = useState(1)
  const [isZoomed, setIsZoomed] = useState(false)

  // Memoize navigation callbacks to prevent stale closures in event listeners
  const navigatePrev = useCallback(() => {
    // Find the closest previous index that has a valid URL
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (media[i] && media[i].url) {
        onNavigate(i)
        setZoom(1)
        setIsZoomed(false)
        return
      }
    }
  }, [currentIndex, media, onNavigate])

  const navigateNext = useCallback(() => {
    // Find the closest next index that has a valid URL
    for (let i = currentIndex + 1; i < media.length; i++) {
      if (media[i] && media[i].url) {
        onNavigate(i)
        setZoom(1)
        setIsZoomed(false)
        return
      }
    }
  }, [currentIndex, media, onNavigate])

  useEffect(() => {
    if (!isOpen) {
      setZoom(1)
      setIsZoomed(false)
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
    }
  }

  const resetZoom = () => {
    setZoom(1)
    setIsZoomed(false)
  }

  if (!isOpen || !media[currentIndex]) return null

  const currentMedia = media[currentIndex]
  
  // Check if there are actual valid previous/next items
  const hasPrev = media.slice(0, currentIndex).some(m => m && !!m.url)
  const hasNext = media.slice(currentIndex + 1).some(m => m && !!m.url)
  const hasMultiple = hasPrev || hasNext

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 backdrop-blur-md">
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute right-4 top-4 z-10 rounded-none border border-neon-cyan/50 bg-black/80 p-2 text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
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
              className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-none border border-neon-cyan/50 bg-black/80 p-3 text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-8 w-8" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={(e) => { e.stopPropagation(); navigateNext(); }}
              className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-none border border-neon-cyan/50 bg-black/80 p-3 text-neon-cyan transition-colors hover:border-neon-red hover:text-neon-red"
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
          className="rounded-none border border-neon-cyan/50 bg-black/80 p-2 text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-5 w-5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); resetZoom(); }}
          disabled={!isZoomed}
          className="min-w-[60px] rounded-none border border-neon-cyan/50 bg-black/80 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); handleZoomIn(); }}
          disabled={zoom >= 3}
          className="rounded-none border border-neon-cyan/50 bg-black/80 p-2 text-neon-cyan transition-colors hover:border-neon-cyan hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-5 w-5" />
        </button>
      </div>

      {/* Media counter */}
      {media.length > 1 && (
        <div className="absolute bottom-4 right-4 z-10 font-mono text-[10px] uppercase tracking-widest text-neon-cyan/80 bg-black/50 px-2 py-1 border border-neon-cyan/20">
          {currentIndex + 1} / {media.length}
        </div>
      )}

      {/* Media content */}
      <div 
        className="relative flex h-full w-full items-center justify-center p-4"
        onClick={onClose} // Clicking the dark background closes the lightbox
      >
        {currentMedia.type === 'image' ? (
          <img
            src={currentMedia.url}
            alt="Decrypted Media"
            className="max-h-full max-w-full object-contain transition-transform duration-200"
            style={{
              transform: `scale(${zoom})`,
              cursor: isZoomed ? 'zoom-out' : 'zoom-in',
            }}
            onClick={(e) => {
              e.stopPropagation();
              isZoomed ? resetZoom() : handleZoomIn();
            }}
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
            onClick={(e) => e.stopPropagation()} // Prevent video click from closing modal
          />
        )}
      </div>
    </div>
  )
}