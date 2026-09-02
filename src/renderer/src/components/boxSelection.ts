export interface SelectionRectangle {
  top: number
  right: number
  bottom: number
  left: number
}

export const BOX_SELECTION_EDGE_SIZE = 72
export const BOX_SELECTION_MAX_SCROLL_SPEED = 18

export function viewportPointInScrollContent(
  clientX: number,
  clientY: number,
  scrollLeft: number,
  scrollTop: number,
): { x: number; y: number } {
  return { x: clientX + scrollLeft, y: clientY + scrollTop }
}

export function hasCrossedBoxSelectionThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold: number,
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= threshold
}

export function rectanglesIntersect(
  selection: SelectionRectangle,
  target: SelectionRectangle,
): boolean {
  return (
    selection.left < target.right &&
    selection.right > target.left &&
    selection.top < target.bottom &&
    selection.bottom > target.top
  )
}

export function intersectRectangles(
  first: SelectionRectangle,
  second: SelectionRectangle,
): SelectionRectangle | undefined {
  const intersection = {
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
    left: Math.max(first.left, second.left),
  }
  return intersection.left < intersection.right && intersection.top < intersection.bottom
    ? intersection
    : undefined
}

export function boxSelectionScrollDelta(
  pointerY: number,
  viewportHeight: number,
  edgeSize = BOX_SELECTION_EDGE_SIZE,
  maxSpeed = BOX_SELECTION_MAX_SCROLL_SPEED,
): number {
  if (viewportHeight <= 0 || edgeSize <= 0 || maxSpeed <= 0) return 0
  if (pointerY < edgeSize) {
    return -maxSpeed * Math.min(1, (edgeSize - pointerY) / edgeSize)
  }
  const bottomEdge = viewportHeight - edgeSize
  if (pointerY > bottomEdge) {
    return maxSpeed * Math.min(1, (pointerY - bottomEdge) / edgeSize)
  }
  return 0
}
