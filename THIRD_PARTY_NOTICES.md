# Third-Party Notices

图渡使用第三方开源软件。各组件仍由其原始作者持有版权，并适用各自许可证。本文件是便于审计的概要；精确版本由 `package-lock.json` 锁定，完整许可证文本随对应依赖包提供。

## Runtime dependencies

| Component                                            |                Version | License    |
| ---------------------------------------------------- | ---------------------: | ---------- |
| @dnd-kit/core, @dnd-kit/sortable, @dnd-kit/utilities | 6.3.1 / 10.0.0 / 3.2.2 | MIT        |
| @phosphor-icons/react                                |                 2.1.10 | MIT        |
| @whiskeysockets/baileys                              |             7.0.0-rc14 | MIT        |
| fflate                                               |                  0.8.2 | MIT        |
| pino                                                 |                 9.11.0 | MIT        |
| qrcode                                               |                  1.5.4 | MIT        |
| qrcode-terminal                                      |                 0.12.0 | Apache-2.0 |
| react, react-dom                                     |                 19.2.8 | MIT        |
| sharp                                                |                 0.35.3 | Apache-2.0 |

`sharp` distributions may include libvips and codecs under their own licenses. Refer to the license files included by the `sharp` platform packages for the exact binary distribution notices.

## Build and development dependencies

The project also uses Electron, electron-builder, Vite, Vitest, TypeScript, ESLint, Prettier and related transitive packages. Their exact versions and declared licenses are recorded in `package-lock.json`.

## Patched dependency

The repository contains a local patch for `@whiskeysockets/baileys`. Baileys remains licensed under the MIT License; the patch is distributed as part of this GPLv3-licensed application source.

## Optional Official plugin

Official application packages can include an optional native plugin built outside this public repository. That binary distribution includes SQLCipher-derived components and preserves the applicable SQLCipher notices in the private build source and release process. The plugin is not part of the Community source tree.
