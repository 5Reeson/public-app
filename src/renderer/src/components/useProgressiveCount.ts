import { useEffect, useRef, useState } from 'react'

export function nextProgressiveCount(current: number, total: number, batchSize: number): number {
  return Math.min(total, current + batchSize)
}

export function useProgressiveCount({
  total,
  initialCount,
  batchSize,
  resetKey,
}: {
  total: number
  initialCount: number
  batchSize: number
  resetKey: string
}) {
  const [progress, setProgress] = useState({ key: resetKey, count: initialCount })
  const sentinelRef = useRef<HTMLButtonElement>(null)
  const visibleCount = Math.min(total, progress.key === resetKey ? progress.count : initialCount)
  const hasMore = visibleCount < total

  useEffect(() => {
    if (progress.key !== resetKey) setProgress({ key: resetKey, count: initialCount })
  }, [initialCount, progress.key, resetKey])

  function showMore() {
    setProgress((current) => ({
      key: resetKey,
      count: nextProgressiveCount(
        current.key === resetKey ? current.count : initialCount,
        total,
        batchSize,
      ),
    }))
  }

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!hasMore || !sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showMore()
      },
      { rootMargin: '320px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  })

  return { visibleCount, hasMore, showMore, sentinelRef }
}
