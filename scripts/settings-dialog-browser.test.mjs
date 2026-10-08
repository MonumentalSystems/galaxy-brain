import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { once } from "node:events"
import test from "node:test"

const candidates = process.platform === "win32"
  ? [
      process.env.CHROME_PATH,
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
  : [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]

async function findBrowser() {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error("A Chromium browser is required for settings dialog geometry tests. Set CHROME_PATH when it is not installed in a standard location.")
}

async function waitForDevtoolsPort(profile, process, getStderr) {
  const activePortPath = join(profile, "DevToolsActivePort")
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const [port, browserPath] = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/)
      if (port && browserPath) return { port, browserUrl: `ws://127.0.0.1:${port}${browserPath}` }
    } catch {}
    if (process.exitCode !== null) {
      throw new Error(`Chromium exited with ${process.exitCode} before exposing DevTools. ${getStderr()}`.trim())
    }
    await delay(50)
  }
  throw new Error(`Chromium did not expose a DevTools endpoint within 15 seconds. ${getStderr()}`.trim())
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true })
    socket.addEventListener("error", rejectOpen, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const { resolve: resolveCommand, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolveCommand(message.result)
  })
  return {
    close: () => socket.close(),
    command(method, params = {}) {
      const id = nextId
      nextId += 1
      return new Promise((resolveCommand, reject) => {
        pending.set(id, { resolve: resolveCommand, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

const browser = await findBrowser()
const fixtureDirectory = await mkdtemp(join(tmpdir(), "galaxy-brain-settings-dialog-"))
const profile = join(fixtureDirectory, "profile")
const fixturePath = join(fixtureDirectory, "fixture.html")
const globalsUrl = pathToFileURL(resolve("app/globals.css")).href

await writeFile(fixturePath, `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0}.viewport{height:100vh;display:grid;place-items:center}.dialog{box-sizing:border-box;display:grid;width:680px;max-height:88vh}.header{height:120px}.tabs{height:60px}.body-content{height:1000px}.footer{height:70px}
</style><link rel="stylesheet" href="${globalsUrl}"></head><body><div class="viewport"><section class="dialog settings-dialog-content"><header class="header"></header><nav class="tabs"></nav><main class="settings-dialog-body"><div class="body-content"></div></main><footer class="footer"></footer></section></div>
<pre id="result"></pre><script>
function measure(){const dialog=document.querySelector('.dialog');const body=document.querySelector('.settings-dialog-body');const footer=document.querySelector('.footer');const beforeFooterBottom=footer.getBoundingClientRect().bottom;dialog.scrollTop=dialog.scrollHeight;return {innerHeight,dialogClientHeight:dialog.clientHeight,dialogScrollHeight:dialog.scrollHeight,dialogOverflow:getComputedStyle(dialog).overflowY,dialogDisplay:getComputedStyle(dialog).display,bodyClientHeight:body.clientHeight,bodyScrollHeight:body.scrollHeight,bodyOverflow:getComputedStyle(body).overflowY,beforeFooterBottom,afterFooterBottom:footer.getBoundingClientRect().bottom,dialogBottom:dialog.getBoundingClientRect().bottom}}
</script></body></html>`, "utf8")

const browserArguments = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--allow-file-access-from-files", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"]
if (process.env.CI) browserArguments.unshift("--no-sandbox")
const browserProcess = spawn(browser, browserArguments, { stdio: ["ignore", "ignore", "pipe"] })
let browserStderr = ""
browserProcess.stderr.on("data", (chunk) => {
  browserStderr = `${browserStderr}${chunk}`.slice(-8_000)
})
const { port, browserUrl } = await waitForDevtoolsPort(profile, browserProcess, () => browserStderr)

async function measure(height) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
  assert.equal(response.ok, true, `Could not create Chromium target: ${response.status}`)
  const target = await response.json()
  const client = await connectCdp(target.webSocketDebuggerUrl)
  try {
    await client.command("Emulation.setDeviceMetricsOverride", { width: 1000, height, deviceScaleFactor: 1, mobile: false })
    await client.command("Page.navigate", { url: pathToFileURL(fixturePath).href })
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await client.command("Runtime.evaluate", { expression: "document.readyState === 'complete' && typeof measure === 'function' ? measure() : null", returnByValue: true })
      if (result.result.value) return result.result.value
      await delay(25)
    }
    throw new Error("Browser fixture did not emit geometry")
  } finally {
    await client.command("Page.close").catch(() => {})
    client.close()
  }
}

test("settings dialog keeps a usable middle scroller at ordinary viewport height", async () => {
  const geometry = await measure(800)
  assert.equal(geometry.dialogDisplay, "grid")
  assert.equal(geometry.dialogOverflow, "hidden")
  assert.equal(geometry.bodyOverflow, "auto")
  assert.ok(geometry.bodyClientHeight > 0)
  assert.ok(geometry.bodyScrollHeight > geometry.bodyClientHeight)
  assert.ok(geometry.beforeFooterBottom <= geometry.dialogBottom + 1)
})

test("settings dialog falls back to whole-dialog scrolling at short viewport height", async () => {
  const geometry = await measure(175)
  assert.equal(geometry.innerHeight, 175)
  assert.equal(geometry.dialogDisplay, "block")
  assert.equal(geometry.dialogOverflow, "auto")
  assert.equal(geometry.bodyOverflow, "visible")
  assert.ok(geometry.bodyClientHeight > 0)
  assert.ok(geometry.dialogScrollHeight > geometry.dialogClientHeight)
  assert.ok(geometry.beforeFooterBottom > geometry.dialogBottom)
  assert.ok(geometry.afterFooterBottom <= geometry.dialogBottom + 1)
})

test.after(async () => {
  const browserClient = await connectCdp(browserUrl).catch(() => null)
  if (browserClient) {
    await browserClient.command("Browser.close").catch(() => {})
    browserClient.close()
  }
  if (browserProcess.exitCode === null) {
    await Promise.race([once(browserProcess, "exit"), delay(5_000)])
  }
  if (browserProcess.exitCode === null) {
    browserProcess.kill()
  }
  if (browserProcess.exitCode === null) {
    await Promise.race([once(browserProcess, "exit"), delay(5_000)])
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(fixtureDirectory, { recursive: true, force: true })
      break
    } catch (error) {
      if (error.code !== "EBUSY" || attempt === 19) throw error
      await delay(250)
    }
  }
})
