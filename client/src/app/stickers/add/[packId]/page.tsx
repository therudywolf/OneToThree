import type { Metadata } from 'next'
import { StickerAddClient } from './page-client'

export const metadata: Metadata = {
  title: 'Add sticker pack',
}

export const dynamic = 'force-static'

export function generateStaticParams() {
  return [{ packId: '_' }]
}

export default async function StickerAddPage({
  params,
}: {
  params: Promise<{ packId: string }>
}) {
  const { packId } = await params
  return <StickerAddClient packId={packId} />
}
