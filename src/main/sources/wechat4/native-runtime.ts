import { lstat } from 'node:fs/promises'

export interface Wechat4NativeArtifacts {
  helperPath: string
  interposerPath: string
}

async function assertRegularExecutable(path: string, label: string): Promise<void> {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error })
  }
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o111) === 0) {
    throw new Error(`${label} is not a regular executable file`)
  }
}

export async function assertWechat4NativeArtifacts(
  artifacts: Wechat4NativeArtifacts,
): Promise<void> {
  await Promise.all([
    assertRegularExecutable(artifacts.helperPath, 'WeChat 4 helper'),
    assertRegularExecutable(artifacts.interposerPath, 'WeChat 4 interposer'),
  ])
}
