export function PathDisplay({
  path,
  prefix = '',
  placement = 'top',
}: {
  path: string
  prefix?: string
  placement?: 'top' | 'right'
}) {
  return (
    <span
      className="path-display"
      data-tooltip-placement={placement}
      aria-label={`${prefix}${path}`}
    >
      <span className="path-display-text">
        {prefix}
        {path}
      </span>
      <span className="path-display-tooltip" role="tooltip">
        {path}
      </span>
    </span>
  )
}
