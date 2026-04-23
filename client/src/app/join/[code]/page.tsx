export const dynamic = 'force-static'
export function generateStaticParams() {
  return [{ code: '_' }]
}
import { JoinPackClient } from './page-client'

export default async function JoinPackPage({
  params,
}: {
  params: Promise<{ code: string }>
}) {
  const { code } = await params
  return <JoinPackClient code={code} />
}