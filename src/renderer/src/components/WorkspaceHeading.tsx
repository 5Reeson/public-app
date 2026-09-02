import type { ReactNode } from 'react'

export function WorkspaceHeading({
  title,
  description,
  aside,
}: {
  title: string
  description: string
  aside?: ReactNode
}) {
  return (
    <header className="workspace-heading">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {aside}
    </header>
  )
}
