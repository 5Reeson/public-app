import { useId, useState } from 'react'
import { InfoIcon as Info } from '@phosphor-icons/react/Info'
import { XIcon as X } from '@phosphor-icons/react/X'

import type { WechatDownloadMode } from '../../../shared/domain.js'
import { MenuSelect } from './MenuSelect.js'

const SPEED_OPTIONS: Array<{ value: WechatDownloadMode; label: string }> = [
  { value: 'default', label: '默认速度' },
  { value: 'fast', label: '快速获取' },
  { value: 'safe', label: '安全获取' },
]

export function WechatDownloadSettings({
  value,
  disabled,
  onChange,
}: {
  value: WechatDownloadMode
  disabled: boolean
  onChange(value: WechatDownloadMode): void
}) {
  const [showInfo, setShowInfo] = useState(false)
  const infoId = useId()

  return (
    <>
      <div className="wechat-download-settings">
        <label>下载速度</label>
        <div>
          <MenuSelect
            value={value}
            options={SPEED_OPTIONS}
            ariaLabel="选择微信素材下载速度"
            disabled={disabled}
            onChange={onChange}
          />
          <button
            type="button"
            className="wechat-speed-info-button"
            aria-label="查看下载速度说明"
            aria-expanded={showInfo}
            aria-controls={infoId}
            onClick={() => setShowInfo(true)}
          >
            <Info size={17} />
          </button>
        </div>
      </div>

      {showInfo && (
        <aside id={infoId} className="wechat-speed-info" role="note">
          <div>
            <strong>下载速率说明</strong>
            <p>
              速度设置将影响从微信 CDN
              下载表情包的速度。微信没有公开此接口的频率阈值，过快的请求有可能触发限制或封禁。降低请求频率只能减少风险，不能保证避免上述风险。
            </p>
          </div>
          <button
            type="button"
            className="panel-close"
            onClick={() => setShowInfo(false)}
            aria-label="关闭下载速度说明"
          >
            <X size={15} />
          </button>
          <dl>
            <div>
              <dt>默认速度</dt>
              <dd>较为安全，间隔约为 1 秒</dd>
            </div>
            <div>
              <dt>快速获取</dt>
              <dd>并发加载，间隔较短</dd>
            </div>
            <div>
              <dt>安全获取</dt>
              <dd>更为安全，间隔约为 3 秒</dd>
            </div>
          </dl>
        </aside>
      )}
    </>
  )
}
