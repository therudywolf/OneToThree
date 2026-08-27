import type { Metadata } from 'next'
import { Suspense } from 'react'
import { StickerAddClient } from './page-client'

export const metadata: Metadata = {
  title: 'Add sticker pack',
}

export const dynamic = 'force-static'

export function generateStaticParams() {
  return [{ packId: '_' }]
}

/**
 * Same static-export pattern as /join/[code] and /guest/**: only
 * /stickers/add/_ exists in the NEXT_EXPORT build, so the client also accepts
 * `?packId=` — and `useSearchParams` needs a Suspense boundary to prerender.
 */
export default async function StickerAddPage({
  params,
}: {
  params: Promise<{ packId: string }>
}) {
  const { packId } = await params
  return (
    <Suspense>
      <StickerAddClient packId={packId} />
    </Suspense>
  )
}
