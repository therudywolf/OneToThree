'use client'

import { createElement, useCallback, useRef, useState } from 'react'
import {
  ReactCrop,
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
  type PercentCrop,
} from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'

function centerAspectCrop(
  mediaWidth: number,
  mediaHeight: number,
  aspect: number
): PercentCrop {
  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 85,
      },
      aspect,
      mediaWidth,
      mediaHeight
    ),
    mediaWidth,
    mediaHeight
  )
}

async function canvasFromCrop(
  image: HTMLImageElement,
  crop: PixelCrop
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  const scaleX = image.naturalWidth / image.width
  const scaleY = image.naturalHeight / image.height
  const w = Math.floor(crop.width * scaleX)
  const h = Math.floor(crop.height * scaleY)
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('NO_2D')
  }
  const sx = crop.x * scaleX
  const sy = crop.y * scaleY
  ctx.drawImage(image, sx, sy, w, h, 0, 0, w, h)
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b)
        else reject(new Error('TO_BLOB_FAILED'))
      },
      'image/jpeg',
      0.92
    )
  })
}

export function AvatarCropModal({
  imageSrc,
  onCancel,
  onCropped,
}: {
  imageSrc: string
  onCancel: () => void
  onCropped: (blob: Blob) => void
}) {
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [crop, setCrop] = useState<Crop>()
  const [pixelCrop, setPixelCrop] = useState<PixelCrop | null>(null)
  const [busy, setBusy] = useState(false)

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = e.currentTarget
      setCrop(centerAspectCrop(width, height, 1))
    },
    []
  )

  async function confirm() {
    const img = imgRef.current
    if (!img || !pixelCrop || pixelCrop.width < 2 || pixelCrop.height < 2) {
      return
    }
    setBusy(true)
    try {
      const blob = await canvasFromCrop(img, pixelCrop)
      onCropped(blob)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/95 px-3"
      role="dialog"
      aria-modal="true"
      aria-label="Crop avatar"
    >
      <div className="w-full max-w-md border border-neon-cyan/50 bg-black p-4 font-mono shadow-[0_0_24px_rgba(0,255,255,0.08)]">
        <p className="mb-3 text-center text-[10px] uppercase tracking-[0.4em] text-neon-cyan">
          :: CROP_MARK ::
        </p>
        <div className="relative mx-auto max-h-[min(60vh,420px)] overflow-hidden border border-neon-cyan/30">
          {createElement(
            ReactCrop as never,
            {
              crop,
              circularCrop: true,
              aspect: 1,
              onChange: (_pixel: PixelCrop, percent: PercentCrop) => {
                setCrop(percent)
              },
              onComplete: (c: PixelCrop) => setPixelCrop(c),
            },
            // eslint-disable-next-line @next/next/no-img-element
            createElement('img', {
              ref: imgRef,
              alt: '',
              src: imageSrc,
              className: 'max-h-[min(60vh,420px)] w-full object-contain',
              onLoad: onImageLoad,
            })
          )}
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="flex-1 border border-red-900 py-2 text-[10px] uppercase tracking-widest text-red-800 hover:border-neon-red hover:text-neon-red disabled:opacity-40"
          >
            [ ABORT ]
          </button>
          <button
            type="button"
            disabled={busy || !pixelCrop}
            onClick={() => void confirm()}
            className="flex-1 border border-neon-cyan py-2 text-[10px] uppercase tracking-widest text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-40"
          >
            {busy ? '…' : '[ COMMIT ]'}
          </button>
        </div>
      </div>
    </div>
  )
}
