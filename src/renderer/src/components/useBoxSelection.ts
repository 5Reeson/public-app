import {
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
  boxSelectionScrollDelta,
  hasCrossedBoxSelectionThreshold,
  intersectRectangles,
  rectanglesIntersect,
  viewportPointInScrollContent,
} from './boxSelection.js'

const BOX_SELECTION_THRESHOLD = 5
const BOX_ITEM_SELECTOR = '[data-box-selection-id]'

interface BoxSelectionSession {
  pointerId: number
  startContentX: number
  startContentY: number
  clientX: number
  clientY: number
  active: boolean
  targetIds: Set<string>
  scrollElement: HTMLElement
}

function findScrollElement(grid: HTMLElement): HTMLElement {
  for (let element = grid.parentElement; element; element = element.parentElement) {
    const overflowY = window.getComputedStyle(element).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return element
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

function occludingFooter(grid: HTMLElement): Element | null | undefined {
  return (
    grid.closest('.wechat-import-picker-dialog')?.querySelector(':scope > footer') ??
    grid.closest('.workflow-workspace')?.querySelector('.workspace-footer')
  )
}

export function useBoxSelection({
  disabled = false,
  excludeSelector,
  onSelectIds,
}: {
  disabled?: boolean
  excludeSelector?: string
  onSelectIds(ids: string[]): void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<BoxSelectionSession | null>(null)
  const scrollFrameRef = useRef<number | null>(null)
  const moveFrameRef = useRef<number | null>(null)
  const removeListenersRef = useRef<() => void>(() => undefined)
  const suppressClickRef = useRef(false)
  const onSelectIdsRef = useRef(onSelectIds)

  useEffect(() => {
    onSelectIdsRef.current = onSelectIds
  }, [onSelectIds])

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current)
      if (moveFrameRef.current !== null) window.cancelAnimationFrame(moveFrameRef.current)
      removeListenersRef.current()
    },
    [],
  )

  function clearVisuals(grid: HTMLDivElement) {
    grid.classList.remove('is-box-selecting')
    for (const item of grid.querySelectorAll<HTMLElement>(BOX_ITEM_SELECTOR)) {
      item.classList.remove('is-box-target')
    }
    if (marqueeRef.current) marqueeRef.current.hidden = true
  }

  function stopAutoScroll() {
    if (scrollFrameRef.current === null) return
    window.cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = null
  }

  function updateVisuals(session: BoxSelectionSession) {
    const grid = gridRef.current
    const marquee = marqueeRef.current
    if (!grid || !marquee) return
    const scrollLeft = session.scrollElement.scrollLeft
    const scrollTop = session.scrollElement.scrollTop
    const current = viewportPointInScrollContent(
      session.clientX,
      session.clientY,
      scrollLeft,
      scrollTop,
    )
    const selection = {
      top: Math.min(session.startContentY, current.y),
      right: Math.max(session.startContentX, current.x),
      bottom: Math.max(session.startContentY, current.y),
      left: Math.min(session.startContentX, current.x),
    }
    const gridBounds = grid.getBoundingClientRect()
    const gridContent = {
      top: gridBounds.top + scrollTop,
      right: gridBounds.right + scrollLeft,
      bottom: gridBounds.bottom + scrollTop,
      left: gridBounds.left + scrollLeft,
    }
    const documentScrollElement = document.scrollingElement
    const scrollViewport =
      session.scrollElement === documentScrollElement
        ? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
        : session.scrollElement.getBoundingClientRect()
    const footerTop = occludingFooter(grid)?.getBoundingClientRect().top
    const visibleClientBottom = Math.min(scrollViewport.bottom, footerTop ?? scrollViewport.bottom)
    const visibleContent = {
      top: Math.max(gridBounds.top, scrollViewport.top) + scrollTop,
      right: Math.min(gridBounds.right, scrollViewport.right) + scrollLeft,
      bottom: Math.min(gridBounds.bottom, visibleClientBottom) + scrollTop,
      left: Math.max(gridBounds.left, scrollViewport.left) + scrollLeft,
    }
    const visualSelection = intersectRectangles(selection, visibleContent)
    marquee.hidden = !visualSelection
    if (visualSelection) {
      marquee.style.transform = `translate(${visualSelection.left - gridContent.left}px, ${visualSelection.top - gridContent.top}px)`
      marquee.style.width = `${visualSelection.right - visualSelection.left}px`
      marquee.style.height = `${visualSelection.bottom - visualSelection.top}px`
    }
    grid.classList.add('is-box-selecting')

    const nextTargets = new Set<string>()
    for (const item of grid.querySelectorAll<HTMLElement>(BOX_ITEM_SELECTOR)) {
      const bounds = item.getBoundingClientRect()
      const targeted = rectanglesIntersect(selection, {
        top: bounds.top + scrollTop,
        right: bounds.right + scrollLeft,
        bottom: bounds.bottom + scrollTop,
        left: bounds.left + scrollLeft,
      })
      item.classList.toggle('is-box-target', targeted)
      if (targeted && item.dataset.boxSelectionId) {
        nextTargets.add(item.dataset.boxSelectionId)
      }
    }
    session.targetIds = nextTargets
  }

  function continueAutoScroll() {
    scrollFrameRef.current = null
    const session = sessionRef.current
    if (!session?.active) return
    const documentScrollElement = document.scrollingElement
    const scrollBounds =
      session.scrollElement === documentScrollElement
        ? { top: 0, height: window.innerHeight }
        : session.scrollElement.getBoundingClientRect()
    const delta = boxSelectionScrollDelta(session.clientY - scrollBounds.top, scrollBounds.height)
    if (delta === 0) return
    session.scrollElement.scrollBy({ top: delta, behavior: 'auto' })
    updateVisuals(session)
    scrollFrameRef.current = window.requestAnimationFrame(continueAutoScroll)
  }

  function startAutoScroll() {
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = window.requestAnimationFrame(continueAutoScroll)
  }

  function scheduleVisuals(session: BoxSelectionSession) {
    if (moveFrameRef.current !== null) return
    moveFrameRef.current = window.requestAnimationFrame(() => {
      moveFrameRef.current = null
      if (sessionRef.current === session) updateVisuals(session)
    })
  }

  function moveSelection(event: PointerEvent) {
    const session = sessionRef.current
    const grid = gridRef.current
    const marquee = marqueeRef.current
    if (!session || session.pointerId !== event.pointerId || !grid || !marquee) return
    session.clientX = event.clientX
    session.clientY = event.clientY
    const current = viewportPointInScrollContent(
      event.clientX,
      event.clientY,
      session.scrollElement.scrollLeft,
      session.scrollElement.scrollTop,
    )
    if (
      !session.active &&
      !hasCrossedBoxSelectionThreshold(
        session.startContentX,
        session.startContentY,
        current.x,
        current.y,
        BOX_SELECTION_THRESHOLD,
      )
    ) {
      return
    }
    session.active = true
    event.preventDefault()
    scheduleVisuals(session)
    startAutoScroll()
  }

  function finishSelection(event: PointerEvent) {
    const session = sessionRef.current
    const grid = gridRef.current
    if (!session || session.pointerId !== event.pointerId || !grid) return
    session.clientX = event.clientX
    session.clientY = event.clientY
    if (moveFrameRef.current !== null) {
      window.cancelAnimationFrame(moveFrameRef.current)
      moveFrameRef.current = null
    }
    if (session.active) updateVisuals(session)
    sessionRef.current = null
    removeListenersRef.current()
    stopAutoScroll()
    clearVisuals(grid)
    if (!session.active) return

    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
    onSelectIdsRef.current([...session.targetIds])
  }

  function cancelSelection(event: PointerEvent) {
    const session = sessionRef.current
    const grid = gridRef.current
    if (!session || session.pointerId !== event.pointerId || !grid) return
    sessionRef.current = null
    removeListenersRef.current()
    stopAutoScroll()
    if (moveFrameRef.current !== null) {
      window.cancelAnimationFrame(moveFrameRef.current)
      moveFrameRef.current = null
    }
    if (grid.hasPointerCapture(event.pointerId)) grid.releasePointerCapture(event.pointerId)
    clearVisuals(grid)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled || event.pointerType !== 'mouse' || event.button !== 0) return
    const target = event.target as HTMLElement
    if (excludeSelector && target.closest(excludeSelector)) return
    const scrollElement = findScrollElement(event.currentTarget)
    const start = viewportPointInScrollContent(
      event.clientX,
      event.clientY,
      scrollElement.scrollLeft,
      scrollElement.scrollTop,
    )
    sessionRef.current = {
      pointerId: event.pointerId,
      startContentX: start.x,
      startContentY: start.y,
      clientX: event.clientX,
      clientY: event.clientY,
      active: false,
      targetIds: new Set(),
      scrollElement,
    }
    window.addEventListener('pointermove', moveSelection)
    window.addEventListener('pointerup', finishSelection)
    window.addEventListener('pointercancel', cancelSelection)
    removeListenersRef.current = () => {
      window.removeEventListener('pointermove', moveSelection)
      window.removeEventListener('pointerup', finishSelection)
      window.removeEventListener('pointercancel', cancelSelection)
    }
  }

  function onClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  return { gridRef, marqueeRef, onPointerDown, onClickCapture }
}
