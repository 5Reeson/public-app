import { WorkspaceHeading } from './WorkspaceHeading.js'

export function AboutPage() {
  return (
    <div className="page-workspace narrow-page about-page">
      <WorkspaceHeading
        title="关于与安全"
        description="图渡是一款本地优先的 macOS 表情整理与传输工具。"
      />
      <section>
        <h3>微信数据怎么读取？</h3>
        <p>
          本应用只在你明确授权后读取微信表情相关数据。在从新版微信 (4.0 及以上版本)
          时会创建临时的隔离微信环境并请你扫码登录，此过程不会修改任何微信数据。你可以随时退出临时环境，或通过系统权限设置撤销访问。
        </p>
      </section>
      <section>
        <h3>数据会被上传吗？</h3>
        <p>
          本机图片与数据库在本地处理。只有当需要将「我的表情包」内的素材导入到其他 App, 如 WhatsApp
          时，才会将数据向互联网传输。任何您的个人数据、表情包素材，都不会被我们上传到服务器或记录在日志中。
        </p>
      </section>
      <section>
        <h3>WhatsApp 凭证如何保存？</h3>
        <p>
          默认存储在 macOS 钥匙串中，由 macOS
          进行保护。您也可选择保存到本地明文文件中来避免可能的系统授权，但安全性可能因此降低。
        </p>
      </section>
      <section>
        <h3>独立项目与公开审查</h3>
        <p>
          本项目不是腾讯或 Meta / WhatsApp
          官方产品，仅供个人学习交流使用。任何在使用本应用中过程中可能产生的潜在问题，如封
          IP、封号等，本项目及其开发者概不负责。本项目源码开源、构建配置和依赖可公开审查。
        </p>
      </section>
    </div>
  )
}
