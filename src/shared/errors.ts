export class CollectionError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_MANIFEST' | 'IMPORT_FAILED' | 'INVALID_INPUT',
  ) {
    super(message)
    this.name = 'CollectionError'
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
