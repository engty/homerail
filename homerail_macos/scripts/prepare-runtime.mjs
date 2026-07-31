import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(packageRoot, '..')
const stagingRoot = path.join(packageRoot, '.runtime-staging')
const runtimeRoot = path.join(stagingRoot, 'homerail-runtime')
const nodeVersion = '24.18.0'
const nodeArchiveName = `node-v${nodeVersion}-darwin-arm64.tar.gz`
const nodeArchiveSha256 = 'e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1'
const cacheRoot = path.join(packageRoot, '.build-cache')
const runtimePackages = [
  'homerail_protocol',
  'homerail_plugin_sdk',
  'homerail_manager',
  'homerail_node',
  'homerail_worker',
  'homerail_cli',
]

function copyRequired(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required runtime path is missing: ${source}`)
  fs.cpSync(source, destination, { recursive: true, dereference: false })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`)
}

function sha256(filePath) {
  const digest = crypto.createHash('sha256')
  digest.update(fs.readFileSync(filePath))
  return digest.digest('hex')
}

function prepareNodeRuntime() {
  fs.mkdirSync(cacheRoot, { recursive: true })
  const archivePath = path.join(cacheRoot, nodeArchiveName)
  if (!fs.existsSync(archivePath) || sha256(archivePath) !== nodeArchiveSha256) {
    const temporaryPath = `${archivePath}.${process.pid}.tmp`
    run('curl', ['--fail', '--location', '--retry', '3', '--output', temporaryPath, `https://nodejs.org/dist/v${nodeVersion}/${nodeArchiveName}`])
    if (sha256(temporaryPath) !== nodeArchiveSha256) {
      fs.rmSync(temporaryPath, { force: true })
      throw new Error(`Node ${nodeVersion} archive checksum mismatch`)
    }
    fs.renameSync(temporaryPath, archivePath)
  }
  const nodeRoot = path.join(runtimeRoot, 'node')
  fs.mkdirSync(nodeRoot, { recursive: true })
  run('tar', ['-xzf', archivePath, '-C', nodeRoot, '--strip-components=1'])
  if (!fs.existsSync(path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))) {
    throw new Error('Bundled Node npm runtime is missing before native rebuild')
  }
}

function rebuildNativeRuntime() {
  const nodeRoot = path.join(runtimeRoot, 'node')
  const nodeBinary = path.join(nodeRoot, 'bin', 'node')
  const npmCli = path.join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  for (const packageName of ['homerail_manager', 'homerail_node', 'homerail_worker']) {
    run(nodeBinary, [npmCli, 'rebuild', '--build-from-source', '--prefix', path.join(runtimeRoot, packageName), '--foreground-scripts', '--loglevel=warn'], {
      env: {
        ...process.env,
        npm_config_cache: path.join(cacheRoot, 'npm-cache'),
        npm_config_nodedir: nodeRoot,
        npm_config_target: nodeVersion,
        npm_config_runtime: 'node',
        npm_config_build_from_source: 'true',
      },
    })
  }
}

function stripNodeRuntime() {
  const nodeRoot = path.join(runtimeRoot, 'node')
  for (const relativePath of ['include', 'share', 'lib/node_modules/npm', 'lib/node_modules/corepack', 'bin/npm', 'bin/npx', 'bin/corepack']) {
    fs.rmSync(path.join(nodeRoot, relativePath), { recursive: true, force: true })
  }
  if (!fs.existsSync(path.join(nodeRoot, 'bin', 'node'))) throw new Error('Bundled Node binary is missing')
}

function prepareCodexRuntime() {
  const sourceRoot = path.join(packageRoot, 'node_modules', '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin')
  const destinationRoot = path.join(runtimeRoot, 'codex')
  copyRequired(sourceRoot, destinationRoot)
  const binary = path.join(destinationRoot, 'bin', 'codex')
  if (!fs.existsSync(binary)) throw new Error('Bundled Codex arm64 binary is missing')
  fs.chmodSync(binary, 0o755)
}

fs.rmSync(stagingRoot, { recursive: true, force: true })
fs.mkdirSync(runtimeRoot, { recursive: true })
prepareNodeRuntime()

for (const packageName of runtimePackages) {
  const sourceRoot = path.join(repositoryRoot, packageName)
  const destinationRoot = path.join(runtimeRoot, packageName)
  fs.mkdirSync(destinationRoot, { recursive: true })
  for (const fileName of ['package.json', 'package-lock.json']) {
    copyRequired(path.join(sourceRoot, fileName), path.join(destinationRoot, fileName))
  }
  for (const directoryName of ['dist', 'node_modules']) {
    copyRequired(path.join(sourceRoot, directoryName), path.join(destinationRoot, directoryName))
  }
}
rebuildNativeRuntime()
stripNodeRuntime()
prepareCodexRuntime()

const uiRoot = path.join(runtimeRoot, 'agent-ui')
fs.mkdirSync(path.join(uiRoot, 'icons'), { recursive: true })
copyRequired(path.join(repositoryRoot, 'agent-ui', 'package.json'), path.join(uiRoot, 'package.json'))
copyRequired(path.join(repositoryRoot, 'agent-ui', 'dist'), path.join(uiRoot, 'dist'))
copyRequired(path.join(repositoryRoot, 'agent-ui', 'public', 'icons', 'homerail-icon-32.png'), path.join(uiRoot, 'icons', 'homerail-icon-32.png'))

for (const packageName of runtimePackages) {
  const packagePath = path.join(runtimeRoot, packageName)
  const result = spawnSync('npm', ['prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: packagePath,
    stdio: 'inherit',
  })
  if (result.status !== 0) throw new Error(`Failed to prune production dependencies for ${packageName}`)
}

const manifest = {
  generatedAt: new Date().toISOString(),
  node: { version: nodeVersion, archive: nodeArchiveName, sha256: nodeArchiveSha256 },
  codex: { version: '0.146.0', path: 'codex/bin/codex', target: 'aarch64-apple-darwin' },
  packages: Object.fromEntries(runtimePackages.map(packageName => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(runtimeRoot, packageName, 'package.json'), 'utf8'))
    return [packageName, { name: packageJson.name, version: packageJson.version }]
  })),
}
fs.writeFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
console.log(`Prepared HomeRail runtime at ${runtimeRoot}`)
