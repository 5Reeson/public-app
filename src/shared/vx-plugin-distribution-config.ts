/**
 * Provider-independent native plugin distribution settings.
 *
 * Keep indexUrl undefined for builds that only support selecting a local ZIP.
 * For R2 or another static host, point it at a fixed HTTPS index.json URL.
 * The renderer never receives this URL.
 */
export const VX_PLUGIN_DISTRIBUTION_CONFIG: {
  indexUrl?: string
  installPageUrl?: string
} = {
  indexUrl: 'https://plugins.tudu-stickers.com/index.json',
}
