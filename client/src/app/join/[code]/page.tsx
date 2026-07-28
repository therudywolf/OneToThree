export const dynamic = 'force-static'
export function generateStaticParams() {
  return [{ code: '_' }]
}
import { Suspense } from 'react'
import { JoinPackClient } from './page-client'

export default async function JoinPackPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  // JoinPackClient reads `?code=` (the form native deep links must use, since
  // only /join/_ exists in the static export), and useSearchParams needs a
  // Suspense boundary to prerender.
  return (
    <Suspense>
      <JoinPackClient code={code} />
    </Suspense>
  )
}
