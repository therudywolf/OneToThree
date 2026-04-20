'use client'

import React, { useCallback, useRef, useState } from 'react'
import {
  ReactCrop,
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
  type PercentCrop,
} from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'

/**
 * ONETOTHREE :: OPTICS_CALIBRATOR
 * Level: Interface Layer (Identity Segmenting)
 * Vibe: Clinical Pure / Terminal Noir / Dead Inside
 */

function calibrateSegment(
  width: number,
  height: number,
  aspect: number
): PercentCrop {
  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 85,
      },
      aspect,
      width,
      height
    ),
    width,
    height
  )
}

/** [DATA_EXTRACTION] :: Стерильная вырезка сегмента из памяти */
async function extractSegmentBlob(
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

  if (!ctx) throw new Error('ERR_CANVAS_INIT_FAILURE')

  ctx.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    w,
    h,
    0,
    0,
    w,
    h
  )

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('ERR_BLOB_GENERATION_FAILED')),
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
  const opticsRef = useRef<HTMLImageElement | null>(null)
  const [sequence, setSequence] = useState<Crop>()
  const [pixelData, setPixelData] = useState<PixelCrop | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)

  const onOpticsLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const { width, height } = e.currentTarget
      setSequence(calibrateSegment(width, height, 1))
    },
    []
  )

  const commitData = async () => {
    const img = opticsRef.current
    if (!img || !pixelData || pixelData.width < 2 || pixelData.height < 2) return

    setIsProcessing(true)
    try {
      const blob = await extractSegmentBlob(img, pixelData)
      onCropped(blob)
    } catch (err) {
      console.error('[SYS.OPTICS] Extraction failed:', err)
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-void/95 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-md border border-border-strong bg-void p-6 shadow-2xl">
        {/* TOP_DECOR_LINE */}
        <div className="absolute top-0 left-0 h-[1px] w-full bg-gradient-to-r from-transparent via-neon-cyan to-transparent opacity-50" />

        <header className="mb-6 flex items-center gap-2 border-b border-border-strong pb-4">
          <span className="h-2 w-2 animate-pulse bg-neon-cyan shadow-[0_0_8px_rgba(0,255,255,0.4)]" />
          <p className="text-[10px] uppercase tracking-[0.4em] text-text-muted">
            SYS.OPTICS // {isProcessing ? 'PROCESSING' : 'CALIBRATION'}
          </p>
        </header>

        {/* VIEWPORT_CONTAINER */}
        <div className="relative mx-auto max-h-[min(60vh,420px)] overflow-hidden border border-border-strong bg-void">
          {/* @ts-ignore react-image-crop typing/runtime compat in this workspace */}
          <ReactCrop
            crop={sequence}
            circularCrop
            aspect={1}
            onChange={(_: unknown, p: unknown) => setSequence(p as typeof sequence)}
            onComplete={(c: unknown) => setPixelData((c as PixelCrop) ?? null)}
          >
            <img
              ref={opticsRef}
              alt="Node Target"
              src={imageSrc}
              className="max-h-[min(60vh,420px)] w-full object-contain"
              onLoad={onOpticsLoad}
            />
          </ReactCrop>
        </div>

        {/* TACTICAL_CONTROLS */}
        <div className="mt-6 flex gap-3">
          <button
            type="button"
            disabled={isProcessing}
            onClick={onCancel}
            className="flex-1 border border-border-strong bg-void py-2.5 font-mono text-[10px] uppercase tracking-widest text-text-muted/70 transition-all hover:border-neon-red hover:text-neon-red disabled:opacity-20"
          >
            [ ABORT_SEQ ]
          </button>
          
          <button
            type="button"
            disabled={isProcessing || !pixelData}
            onClick={() => void commitData()}
            className="flex-1 border border-neon-cyan bg-void py-2.5 font-mono text-[10px] uppercase tracking-[0.3em] text-neon-cyan transition-all hover:bg-neon-cyan/10 hover:shadow-[0_0_15px_rgba(0,255,255,0.1)] disabled:opacity-20"
          >
            {isProcessing ? 'EXTRACTING...' : '>> COMMIT_SEGMENT'}
          </button>
        </div>

        {/* FOOTER_MARK */}
        <footer className="mt-8 pt-4 border-t border-border-strong/50">
          <p className="text-center text-[8px] uppercase tracking-widest text-text-muted/50">
            ONETOTHREE // Identity_Calibrator_v4
          </p>
        </footer>
      </div>
    </div>
  )
}
