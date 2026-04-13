'use client'

export function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-zinc-800/60 rounded ${className ?? ''}`} />
}

export function ChatRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Skeleton className="h-9 w-9 rounded-full shrink-0" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-2.5 w-48" />
      </div>
    </div>
  )
}

export function MessageSkeleton({ align }: { align: 'left' | 'right' }) {
  return (
    <div className={`flex ${align === 'right' ? 'justify-end' : 'justify-start'} px-4 py-1`}>
      <Skeleton className={`h-8 rounded ${align === 'right' ? 'w-48' : 'w-56'}`} />
    </div>
  )
}
