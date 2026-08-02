import { spawn } from 'node:child_process'

const appExecutable = process.argv[2]
if (!appExecutable) throw new Error('Usage: node packaged-lifecycle-smoke.mjs <app-executable>')

const managerPort = Number(process.env.HOMERAIL_MIKO_MANAGER_PORT || 29491)
const uiPort = Number(process.env.HOMERAIL_MIKO_UI_HTTP_PORT || 29493)
const managerUrl = `http://127.0.0.1:${managerPort}`
const uiUrl = `http://127.0.0.1:${uiPort}`
const output = []

function record(chunk) {
  const text = String(chunk || '')
    .replace(/\s+/g, ' ')
    .replace(/(token|api[_-]?key|password|secret)=\S+/gi, '$1=[redacted]')
    .trim()
  if (text) output.push(text.slice(-1_000))
  if (output.length > 20) output.shift()
}

async function ready(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForReady(child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`packaged App exited before becoming healthy (code=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'none'})\n${output.join('\n')}`)
    }
    if (await ready(`${managerUrl}/health`) && await ready(uiUrl)) return
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`packaged App did not become healthy\n${output.join('\n')}`)
}

function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('packaged App did not exit after SIGTERM')), timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

const child = spawn(appExecutable, [], {
  env: {
    ...process.env,
    HOMERAIL_MIKO_MANAGER_PORT: String(managerPort),
    HOMERAIL_MIKO_UI_HTTPS_PORT: String(managerPort + 1),
    HOMERAIL_MIKO_UI_HTTP_PORT: String(uiPort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout?.on('data', record)
child.stderr?.on('data', record)

try {
  await waitForReady(child)
  const health = await fetch(`${managerUrl}/health`)
  if (!health.ok) throw new Error(`unexpected Manager health status ${health.status}`)
  const ui = await fetch(uiUrl)
  if (!ui.ok || !(await ui.text()).includes('HomeRail')) {
    throw new Error(`unexpected embedded UI response (${ui.status})`)
  }
  child.kill('SIGTERM')
  const exit = await waitForExit(child)
  if (await ready(`${managerUrl}/health`) || await ready(uiUrl)) {
    throw new Error('packaged App left a runtime endpoint listening after exit')
  }
  console.log(JSON.stringify({ healthy: true, exit }))
} catch (error) {
  child.kill('SIGKILL')
  await waitForExit(child).catch(() => undefined)
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
