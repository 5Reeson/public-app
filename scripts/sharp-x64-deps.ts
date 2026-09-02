/**
 * Packaging helper for sharp's platform-specific binaries.
 *
 * sharp resolves its native code from platform-specific optional packages. On an Apple Silicon
 * host, npm only installs the arm64 ones. For an Intel (x64) build, electron-builder bundles every
 * platform package it finds on disk — it does not filter by target architecture. Therefore:
 *
 * - `node --import tsx scripts/sharp-x64-deps.ts ensure`
 *   moves the host arm64 packages aside and installs the darwin-x64 packages, without touching
 *   package.json or package-lock.json. Run this before an x64 build.
 * - `node --import tsx scripts/sharp-x64-deps.ts build-x64`
 *   prepares x64 dependencies, builds the DMG/ZIP, and always restores arm64 dependencies even if
 *   electron-builder fails.
 * - `node --import tsx scripts/sharp-x64-deps.ts clean`
 *   removes the x64 packages and restores the host arm64 packages. Run this after an x64 build
 *   (the arm64 packaging script also runs it defensively).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeModules = join(projectRoot, 'node_modules')

const arm64PackageNames = ['@img/sharp-darwin-arm64', '@img/sharp-libvips-darwin-arm64']
const x64PackageNames = ['@img/sharp-darwin-x64', '@img/sharp-libvips-darwin-x64']

function packageDirectory(name: string): string {
  return join(nodeModules, name)
}

function x64Specs(): string[] {
  const sharpPackage = JSON.parse(
    readFileSync(join(nodeModules, 'sharp/package.json'), 'utf8'),
  ) as { optionalDependencies?: Record<string, string> }
  return x64PackageNames.map((name) => {
    const version = sharpPackage.optionalDependencies?.[name]
    if (!version) throw new Error(`sharp no longer declares optional dependency ${name}`)
    return `${name}@${version}`
  })
}

function isX64Present(): boolean {
  const binaryDirectory = join(packageDirectory('@img/sharp-darwin-x64'), 'lib')
  const libvipsDirectory = join(packageDirectory('@img/sharp-libvips-darwin-x64'), 'lib')
  const hasBinary =
    existsSync(binaryDirectory) &&
    readdirSync(binaryDirectory).some(
      (file) => file.startsWith('sharp-darwin-x64') && file.endsWith('.node'),
    )
  const hasLibvips =
    existsSync(libvipsDirectory) &&
    readdirSync(libvipsDirectory).some((file) => file.startsWith('libvips-cpp'))
  return hasBinary && hasLibvips
}

function isArm64Present(): boolean {
  const binaryDirectory = join(packageDirectory('@img/sharp-darwin-arm64'), 'lib')
  const libvipsDirectory = join(packageDirectory('@img/sharp-libvips-darwin-arm64'), 'lib')
  const hasBinary =
    existsSync(binaryDirectory) &&
    readdirSync(binaryDirectory).some(
      (file) => file.startsWith('sharp-darwin-arm64') && file.endsWith('.node'),
    )
  const hasLibvips =
    existsSync(libvipsDirectory) &&
    readdirSync(libvipsDirectory).some((file) => file.startsWith('libvips-cpp'))
  return hasBinary && hasLibvips
}

function npmInstall(specs: string[]): void {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // --no-save keeps package.json and package-lock.json untouched; --force allows npm to
      // install packages whose os/cpu do not match the build host.
      execFileSync('npm', ['install', '--no-save', '--force', ...specs], {
        cwd: projectRoot,
        stdio: 'inherit',
      })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === maxAttempts) {
        throw new Error(`npm install failed after ${maxAttempts} attempts: ${message}`, {
          cause: error,
        })
      }
      console.warn(`npm install attempt ${attempt} failed (${message}); retrying`)
    }
  }
}

function npmRestoreArm64(): void {
  // The arm64 packages are declared in package-lock.json, so a plain install restores them from
  // the local cache and prunes nothing else we care about.
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      execFileSync('npm', ['install', '--prefer-offline'], {
        cwd: projectRoot,
        stdio: 'inherit',
      })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt === maxAttempts) {
        throw new Error(`npm install failed after ${maxAttempts} attempts: ${message}`, {
          cause: error,
        })
      }
      console.warn(`npm install attempt ${attempt} failed (${message}); retrying`)
    }
  }
}

function stashArm64Packages(): void {
  for (const name of arm64PackageNames) {
    const source = packageDirectory(name)
    if (existsSync(source)) {
      const stashed = join(nodeModules, '.sharp-arch-stash', name)
      if (existsSync(stashed)) {
        // npm may restore host-architecture optional dependencies while installing the explicit
        // x64 packages. Preserve the original stash and remove this new duplicate.
        rmSync(source, { recursive: true, force: true })
        console.log(`removed npm-restored duplicate ${name} from the x64 build`)
      } else {
        mkdirSync(dirname(stashed), { recursive: true })
        renameSync(source, stashed)
        console.log(`moved ${name} aside for the x64 build`)
      }
    }
  }
}

function ensure(): void {
  stashArm64Packages()
  if (!isX64Present()) {
    npmInstall(x64Specs())
  }
  // Installing optional packages on an Apple Silicon host can restore arm64 packages. Remove those
  // second copies before electron-builder scans node_modules.
  stashArm64Packages()
  if (!isX64Present()) {
    throw new Error('sharp darwin-x64 binaries are still missing after npm install')
  }
  if (isArm64Present()) {
    throw new Error('sharp darwin-arm64 binaries are still present before the x64 build')
  }
  console.log('sharp darwin-x64 binaries ready for the x64 build')
}

function clean(): void {
  for (const name of x64PackageNames) {
    rmSync(packageDirectory(name), { recursive: true, force: true })
  }
  if (!isArm64Present()) {
    for (const name of arm64PackageNames) {
      const stashed = join(nodeModules, '.sharp-arch-stash', name)
      if (existsSync(stashed)) {
        mkdirSync(dirname(packageDirectory(name)), { recursive: true })
        renameSync(stashed, packageDirectory(name))
        console.log(`restored ${name} from stash`)
      }
    }
    if (!isArm64Present()) {
      npmRestoreArm64()
    }
  }
  rmSync(join(nodeModules, '.sharp-arch-stash'), { recursive: true, force: true })
  if (!isArm64Present()) {
    throw new Error('sharp darwin-arm64 binaries could not be restored')
  }
  console.log('sharp darwin-x64 binaries removed; host arm64 binaries intact')
}

function buildX64(): void {
  try {
    ensure()
    const configPath = process.argv[3]
    execFileSync(
      join(nodeModules, '.bin', 'electron-builder'),
      [
        ...(configPath === undefined ? [] : ['--config', configPath]),
        '--mac',
        'dmg',
        'zip',
        '--x64',
        '--publish',
        'never',
      ],
      {
        cwd: projectRoot,
        stdio: 'inherit',
      },
    )
  } finally {
    clean()
  }
}

const mode = process.argv[2]
if (mode === 'ensure') {
  ensure()
} else if (mode === 'clean') {
  clean()
} else if (mode === 'build-x64') {
  buildX64()
} else {
  throw new Error(`Unknown mode "${String(mode)}"; expected "ensure", "clean", or "build-x64"`)
}
