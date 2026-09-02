import type { ReactNode } from 'react'
import { LinkIcon as Link } from '@phosphor-icons/react/Link'
import { WechatLogoIcon as WechatLogo } from '@phosphor-icons/react/WechatLogo'

import type { WhatsAppConnectionView } from '../../../shared/domain.js'
import { WhatsAppConnectionPanel } from './WhatsAppConnectionPanel.js'
import { WorkspaceHeading } from './WorkspaceHeading.js'

export function ConnectionsPage({
  connection,
  onError,
  onStatus,
  onWechat,
  wechatPanel,
}: {
  connection: WhatsAppConnectionView
  onError(message: string): void
  onStatus(status: WhatsAppConnectionView): void
  onWechat(): void
  wechatPanel: ReactNode
}) {
  return (
    <div className="page-workspace">
      <WorkspaceHeading
        title="连接到 App"
        description="管理长期连接与本机导入授权。连接配置不会变成第二条导出流程。"
      />
      <WhatsAppConnectionPanel connection={connection} onError={onError} onStatus={onStatus} />
      <section className="connection-panel wechat-access">
        <header>
          <span className="destination-icon wechat">
            <WechatLogo size={30} weight="fill" />
          </span>
          <div>
            <h3>微信导入访问</h3>
            <p>选择账号时，应用会按需请求系统授权；微信数据只在本机读取。</p>
          </div>
        </header>
        <footer>
          <button className="secondary-button" type="button" onClick={onWechat}>
            选择微信账号
          </button>
        </footer>
      </section>
      {wechatPanel && <div className="page-inline-panel">{wechatPanel}</div>}
      <section className="connection-panel is-muted">
        <header>
          <span className="destination-icon">
            <Link size={27} />
          </span>
          <div>
            <h3>更多 App</h3>
            <p>暂未支持。可以先导出到本地文件夹后手动添加。</p>
          </div>
        </header>
      </section>
    </div>
  )
}
