import type { ReactNode } from 'react'
import { ArchiveIcon as Archive } from '@phosphor-icons/react/Archive'
import { ExportIcon as Export } from '@phosphor-icons/react/Export'
import { GearSixIcon as GearSix } from '@phosphor-icons/react/GearSix'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { LinkIcon as Link } from '@phosphor-icons/react/Link'
import { SmileyIcon as Smiley } from '@phosphor-icons/react/Smiley'
import brandLogo from '../assets/tudu-logo-128.png'

export type AppPage = 'export' | 'library' | 'archives' | 'connections' | 'settings' | 'about'

export function AppShell({
  page,
  onNavigate,
  rail,
  children,
}: {
  page: AppPage
  onNavigate(page: AppPage): void
  rail?: ReactNode
  children: ReactNode
}) {
  const items = [
    { id: 'export' as const, label: '导出表情包', icon: Export },
    { id: 'library' as const, label: '我的表情库', icon: Smiley },
    { id: 'archives' as const, label: '表情分组存档', icon: Archive },
    { id: 'connections' as const, label: '连接到 App', icon: Link },
    { id: 'settings' as const, label: '设置', icon: GearSix },
  ]
  return (
    <div className={`product-shell${rail ? ' has-rail' : ''}`}>
      <div className="window-drag-region" aria-hidden="true" />
      <aside className="product-sidebar">
        <div className="product-brand" aria-label="图渡">
          <img src={brandLogo} alt="图渡" />
          <strong>图渡 - TuDu</strong>
        </div>
        <nav aria-label="主导航">
          {items.map(({ id, label, icon: Icon }) => (
            <button
              className={`product-nav-item${page === id ? ' is-active' : ''}`}
              type="button"
              key={id}
              onClick={() => onNavigate(id)}
            >
              <Icon size={18} /> {label}
            </button>
          ))}
        </nav>
        <button
          className={`product-about-link${page === 'about' ? ' is-active' : ''}`}
          type="button"
          onClick={() => onNavigate('about')}
        >
          <Info size={17} /> 关于与安全
        </button>
      </aside>
      {rail}
      <main className="product-main">{children}</main>
    </div>
  )
}
