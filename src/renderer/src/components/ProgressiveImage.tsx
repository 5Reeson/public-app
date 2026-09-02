import { useEffect, useRef, useState, type ImgHTMLAttributes } from 'react'

const MAX_CONCURRENT_IMAGE_REQUESTS = 6
let activeImageRequests = 0
const pendingImageRequests: Array<{ start: () => void; cancel: () => void }> = []

function pumpImageRequests() {
  while (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS && pendingImageRequests.length) {
    pendingImageRequests.shift()?.start()
  }
}

function queueImageRequest(start: (release: () => void) => void): () => void {
  let phase: 'pending' | 'active' | 'finished' = 'pending'
  function release() {
    if (phase === 'finished') return
    if (phase === 'active') activeImageRequests -= 1
    phase = 'finished'
    pumpImageRequests()
  }
  const entry = {
    start: () => {
      if (phase !== 'pending') return
      phase = 'active'
      activeImageRequests += 1
      start(release)
    },
    cancel: () => {
      if (phase !== 'pending') return
      phase = 'finished'
      const index = pendingImageRequests.indexOf(entry)
      if (index >= 0) pendingImageRequests.splice(index, 1)
    },
  }
  pendingImageRequests.push(entry)
  pumpImageRequests()
  return () => {
    if (phase === 'pending') {
      entry.cancel()
      return
    }
    release()
  }
}

interface ProgressiveImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src: string
  eager?: boolean
}

const TRANSPARENT_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

export function ProgressiveImage({
  src,
  eager = false,
  className,
  ...props
}: ProgressiveImageProps) {
  const imageRef = useRef<HTMLImageElement>(null)
  const releaseRequest = useRef<() => void>(() => undefined)
  const [requested, setRequested] = useState(eager)
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'failed'>(
    eager ? 'loading' : 'idle',
  )

  useEffect(() => {
    releaseRequest.current()
    releaseRequest.current = () => undefined
    setRequested(eager)
    setState(eager ? 'loading' : 'idle')
    if (eager) return
    const image = imageRef.current
    if (!image || typeof IntersectionObserver === 'undefined') {
      setRequested(true)
      setState('loading')
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        releaseRequest.current = queueImageRequest((release) => {
          releaseRequest.current = release
          setRequested(true)
          setState('loading')
        })
      },
      { rootMargin: '240px' },
    )
    observer.observe(image)
    return () => {
      observer.disconnect()
      releaseRequest.current()
      releaseRequest.current = () => undefined
    }
  }, [eager, src])

  function finish(nextState: 'loaded' | 'failed') {
    releaseRequest.current()
    releaseRequest.current = () => undefined
    setState(nextState)
  }

  return (
    <img
      {...props}
      ref={imageRef}
      className={`progressive-image${className ? ` ${className}` : ''}`}
      data-load-state={state}
      src={requested ? src : TRANSPARENT_PLACEHOLDER}
      alt={requested ? props.alt : ''}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      onLoad={() => {
        if (requested) finish('loaded')
      }}
      onError={() => {
        if (requested) finish('failed')
      }}
    />
  )
}
