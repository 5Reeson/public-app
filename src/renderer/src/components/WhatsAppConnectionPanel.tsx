import { WhatsappLogoIcon as WhatsappLogo } from '@phosphor-icons/react/WhatsappLogo'
import { XIcon as X } from '@phosphor-icons/react/X'

import type { WhatsAppConnectionView } from '../../../shared/domain.js'
import { whatsAppConnectionLabel } from '../../../shared/whatsapp-connection.js'
import { WhatsAppConnectionControls } from './WhatsAppConnectionControls.js'
import { useWhatsAppConnectionController } from './useWhatsAppConnectionController.js'

export function WhatsAppConnectionPanel({
  connection,
  compact = false,
  onStatus,
  onError,
  onClose,
}: {
  connection: WhatsAppConnectionView
  compact?: boolean
  onStatus(status: WhatsAppConnectionView): void
  onError(message: string): void
  onClose?(): void
}) {
  const controller = useWhatsAppConnectionController({
    connection,
    onConnectionChange: onStatus,
    onError,
  })

  return (
    <section className={`connection-panel${compact ? ' is-compact' : ''}`}>
      <header>
        <span className="destination-icon whatsapp">
          <WhatsappLogo size={30} weight="regular" />
        </span>
        <div>
          <h3>WhatsApp</h3>
          <p>{connection.message ?? '登录凭证将被保存在本地，供未来重复使用、减少重复扫码登录'}</p>
        </div>
        <div className="connection-panel-header-actions">
          <span className={`semantic-status ${connection.phase}`}>
            {whatsAppConnectionLabel(connection.phase)}
          </span>
          {onClose && (
            <button
              className="panel-close"
              type="button"
              aria-label="关闭 WhatsApp 连接面板"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          )}
        </div>
      </header>

      <WhatsAppConnectionControls
        connection={connection}
        controller={controller}
        variant="panel"
        showConnectedActions
      />
    </section>
  )
}
