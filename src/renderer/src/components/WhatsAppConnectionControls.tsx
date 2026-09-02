import { DeviceMobileIcon as DeviceMobile } from '@phosphor-icons/react/DeviceMobile'
import { SignOutIcon as SignOut } from '@phosphor-icons/react/SignOut'

import type { WhatsAppConnectionView } from '../../../shared/domain.js'
import { isWhatsAppConnectionPending } from '../../../shared/whatsapp-connection.js'
import { WhatsAppQrPreview } from './WhatsAppQrPreview.js'
import type { WhatsAppConnectionController } from './useWhatsAppConnectionController.js'

interface WhatsAppConnectionControlsProps {
  connection: WhatsAppConnectionView
  controller: WhatsAppConnectionController
  variant: 'panel' | 'card'
  showConnectedActions?: boolean
}

export function WhatsAppConnectionControls({
  connection,
  controller,
  variant,
  showConnectedActions = false,
}: WhatsAppConnectionControlsProps) {
  const connected = connection.phase === 'connected'
  const pending = isWhatsAppConnectionPending(connection.phase)
  const credentialClassName = variant === 'panel' ? 'credential-options' : 'credential-mode-picker'
  const cancelClassName = variant === 'panel' ? 'secondary-button' : 'text-button'
  const ActionContainer = variant === 'panel' ? 'footer' : 'div'

  return (
    <>
      {!connected && (
        <>
          <fieldset
            className={credentialClassName}
            disabled={!connection.canChangeCredentialMode || controller.busy}
          >
            <legend>WhatsApp 凭证存储</legend>
            <label className={connection.credentialMode === 'keychain' ? 'is-selected' : ''}>
              <input
                type="radio"
                name={`whatsapp-credential-mode-${variant}`}
                checked={connection.credentialMode === 'keychain'}
                onChange={() => void controller.setCredentialMode('keychain')}
              />
              <span>
                <strong>macOS 钥匙串保护</strong>
                <small>推荐。使用系统安全存储加密登录凭证。</small>
              </span>
            </label>
            <label className={connection.credentialMode === 'plaintext' ? 'is-selected' : ''}>
              <input
                type="radio"
                name={`whatsapp-credential-mode-${variant}`}
                checked={connection.credentialMode === 'plaintext'}
                onChange={() => void controller.setCredentialMode('plaintext')}
              />
              <span>
                <strong>本地明文文件</strong>
                <small>安全性较低；仅建议排障时使用。</small>
              </span>
            </label>
          </fieldset>
          {!connection.canChangeCredentialMode && (
            <p className={variant === 'panel' ? 'inline-note' : 'credential-mode-note'}>
              {connection.hasSession
                ? '已有登录凭证时不能直接切换；如需更改，请先登出 WhatsApp。'
                : '连接流程进行中；如需更改，请先取消连接。'}
            </p>
          )}
        </>
      )}

      {connection.phase === 'awaiting-qr' && connection.qrDataUrl && (
        <div className="login-challenge">
          <WhatsAppQrPreview src={connection.qrDataUrl} />
          <div>
            <strong>请用手机扫描二维码</strong>
            <p>WhatsApp → 设置 → 已关联设备 → 关联设备。</p>
            <button
              className="text-button"
              type="button"
              onClick={() => void controller.showPhonePairing()}
            >
              改用手机号关联
            </button>
          </div>
        </div>
      )}

      {connection.phase === 'awaiting-pairing-code' && connection.pairingCode && (
        <div className="pairing-code-box">
          <span>手机 WhatsApp → 已关联设备 → 使用电话号码关联</span>
          <strong>{connection.pairingCode}</strong>
        </div>
      )}

      {controller.pairingMode && !connection.hasSession && !pending && (
        <div className="pairing-form">
          <label>
            <span>手机号（含国家/地区代码）</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="例如 85212345678"
              value={controller.pairingPhone}
              onChange={(event) => controller.setPairingPhone(event.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={controller.busy || !controller.pairingPhoneIsValid}
            onClick={() => void controller.requestPairingCode()}
          >
            获取配对码
          </button>
        </div>
      )}

      <ActionContainer className={variant === 'card' ? 'connection-actions' : undefined}>
        {!connected && !pending && (
          <div className="connection-methods">
            <button
              className="primary-button connection-method-button"
              type="button"
              disabled={controller.busy}
              onClick={() => void controller.connectWithQr()}
            >
              <DeviceMobile size={16} />
              {connection.hasSession ? '恢复连接' : '扫描二维码连接'}
            </button>
            {!connection.hasSession && (
              <>
                <span className="connection-choice-or" aria-hidden="true">
                  <strong>或</strong>
                </span>
                <button
                  className="secondary-button connection-method-button"
                  type="button"
                  disabled={controller.busy}
                  onClick={() => void controller.togglePhonePairing()}
                >
                  通过手机号连接
                </button>
              </>
            )}
          </div>
        )}
        {pending && (
          <button
            className={cancelClassName}
            type="button"
            disabled={controller.busy}
            onClick={() => void controller.disconnect()}
          >
            取消连接
          </button>
        )}
        {connected && showConnectedActions && (
          <button
            className="secondary-button"
            type="button"
            disabled={controller.busy}
            onClick={() => void controller.disconnect()}
          >
            断开本次连接
          </button>
        )}
        {(connection.hasSession || connection.phase === 'error') &&
          !pending &&
          (!connected || showConnectedActions) && (
            <button
              className="text-button danger-text"
              type="button"
              disabled={controller.busy}
              onClick={() => void controller.logout()}
            >
              <SignOut size={14} />
              登出并清除登录凭证
            </button>
          )}
      </ActionContainer>
    </>
  )
}
