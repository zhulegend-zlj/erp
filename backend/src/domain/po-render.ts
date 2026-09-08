/**
 * 采购单真渲染（2026-09-07 老板：预览=打印效果）：
 * 填好数据的工作簿 → Excel 常驻守护进程导出 PDF（scripts/xlsx2pdf-daemon.ps1）→ pdfjs 渲染 PNG。
 * 2026-09-08：改为常驻 Excel 实例（无窗口闪现、无进程启动开销）；按缓存键落盘，重复预览直接命中。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js') as {
  getDocument: (opts: { data: Uint8Array; useSystemFonts: boolean; isEvalSupported: boolean; canvasFactory: unknown }) => { promise: Promise<PdfDoc> }
}
interface PdfDoc {
  numPages: number
  getPage: (i: number) => Promise<PdfPage>
}
interface PdfPage {
  getViewport: (o: { scale: number }) => { width: number; height: number }
  render: (o: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> }
}
const { createCanvas } = require('@napi-rs/canvas') as { createCanvas: (w: number, h: number) => NapiCanvas }
interface NapiCanvas {
  width: number
  height: number
  getContext: (kind: '2d') => unknown
  toBuffer: (mime: string) => Buffer
}

export const PO_RENDER_DIR = resolve(process.cwd(), 'uploads/po-render')

/** 渲染缓存指纹：PO 数据 + 模板来源任一变化即失效（数据无 updatedAt 字段） */
export function renderKey(parts: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

const XLSX2PDF_DAEMON_PS = resolve(process.cwd(), 'scripts/xlsx2pdf-daemon.ps1')
const NL = String.fromCharCode(10)
const CR = String.fromCharCode(13)

// Excel COM 单实例：渲染串行化
let excelQueue: Promise<unknown> = Promise.resolve()
function withExcelLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = excelQueue.then(fn, fn)
  excelQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// —— Excel 常驻守护进程（2026-09-08 老板：左上角总有窗口闪现 + 预览慢）——
// 只启动一次 PowerShell+Excel（隐藏窗口），之后所有渲染走 stdin/stdout 行协议。
interface Waiter {
  resolve: (v: string) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}
interface DaemonState {
  proc: ChildProcessWithoutNullStreams
  buf: string
  ready: Promise<void>
  waiters: Waiter[]
  dead: boolean
}
let daemon: DaemonState | null = null

function spawnDaemon(): DaemonState {
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', XLSX2PDF_DAEMON_PS],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  const state: DaemonState = { proc, buf: '', ready: Promise.resolve(), waiters: [], dead: false }
  let reader: (() => void) | null = null
  state.ready = new Promise<void>((res) => {
    reader = res
  })
  proc.stdout.on('data', (chunk: Buffer) => {
    state.buf += chunk.toString('utf8')
    let idx: number
    while ((idx = state.buf.indexOf(NL)) >= 0) {
      const line = state.buf.slice(0, idx).replace(new RegExp(CR + '$'), '')
      state.buf = state.buf.slice(idx + 1)
      if (line === 'READY') {
        if (reader) {
          reader()
          reader = null
        }
        continue
      }
      const w = state.waiters.shift()
      if (w) {
        clearTimeout(w.timer)
        w.resolve(line)
      }
    }
  })
  proc.on('error', () => {
    state.dead = true
    state.waiters.forEach((w) => w.reject(new Error('Excel 渲染守护进程启动失败')))
    state.waiters = []
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    console.error('[xlsx2pdf-daemon]', chunk.toString('utf8').trim())
  })
  proc.on('exit', (code) => {
    console.error('[xlsx2pdf-daemon] exited code=' + code)
    state.dead = true
    state.waiters.forEach((w) => w.reject(new Error('Excel 渲染守护进程已退出')))
    state.waiters = []
    if (daemon === state) daemon = null
  })
  return state
}

async function ensureDaemon(): Promise<DaemonState> {
  if (daemon && !daemon.dead) {
    await daemon.ready
    return daemon
  }
  daemon = spawnDaemon()
  await daemon.ready
  return daemon
}

function askDaemon(d: DaemonState, line: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const waiter: Waiter = {
      resolve: (v) => resolve(v),
      reject: (e) => reject(e),
      timer: setTimeout(() => {
        const i = d.waiters.indexOf(waiter)
        if (i >= 0) d.waiters.splice(i, 1)
        reject(new Error('Excel 渲染超时'))
      }, timeoutMs),
    }
    d.waiters.push(waiter)
    d.proc.stdin.write(line + NL)
  })
}

export interface RenderOpts {
  orientation?: 'landscape' | 'portrait'
  dpi?: number
  printArea?: string // 显式打印区域（缺省用文件自身或 UsedRange）
}

// 直连渲染计数：预热队列在用户主动预览时暂停让路（2026-09-08 老板嫌预览慢）
let directRenders = 0
export function markDirectRenderStart() {
  directRenders++
}
export function markDirectRenderEnd() {
  directRenders = Math.max(0, directRenders - 1)
}
export function warmPauseNeeded() {
  return directRenders > 0
}

export function xlsxToPdf(src: string, dst: string, opts: RenderOpts = {}): Promise<void> {
  return withExcelLock(async () => {
    const d = await ensureDaemon()
    const line = [src, dst, String(opts.orientation === 'landscape' ? 2 : 1), opts.printArea ?? ''].join('|')
    const answer = await askDaemon(d, line, 120000)
    if (answer.startsWith('ERR')) throw new Error('Excel 渲染 PDF 失败：' + answer.slice(4).trim())
    if (!existsSync(dst)) throw new Error('Excel 渲染 PDF 失败：未生成文件')
  })
}

const canvasFactory = {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  },
  reset(cac: { canvas: NapiCanvas }, width: number, height: number) {
    cac.canvas.width = width
    cac.canvas.height = height
  },
  destroy(cac: { canvas: NapiCanvas }) {
    cac.canvas.width = 0
    cac.canvas.height = 0
  },
}

export async function pdfToPng(pdf: Buffer, dpi = 130): Promise<Buffer> {
  const doc = await pdfjsLib
    .getDocument({ data: new Uint8Array(pdf), useSystemFonts: true, isEvalSupported: false, canvasFactory })
    .promise
  const page = await doc.getPage(1) // 模板 fitToPage 1×1，恒为单页
  const viewport = page.getViewport({ scale: dpi / 72 })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toBuffer('image/png')
}

/** 工作簿缓冲 → 缓存文件（.xlsx/.pdf/.png），命中缓存直接返回 */
export async function renderPoToFiles(
  xlsxBuffer: Buffer,
  cacheKey: string,
  opts: RenderOpts = {},
): Promise<{ pdfPath: string; pngPath: string }> {
  mkdirSync(PO_RENDER_DIR, { recursive: true })
  const xlsxPath = resolve(PO_RENDER_DIR, cacheKey + '.xlsx')
  const pdfPath = resolve(PO_RENDER_DIR, cacheKey + '.pdf')
  const pngPath = resolve(PO_RENDER_DIR, cacheKey + '.png')
  if (existsSync(pngPath) && existsSync(pdfPath)) return { pdfPath, pngPath }
  writeFileSync(xlsxPath, xlsxBuffer)
  await xlsxToPdf(xlsxPath, pdfPath, opts)
  const png = await pdfToPng(readFileSync(pdfPath), opts.dpi ?? 130)
  writeFileSync(pngPath, png)
  return { pdfPath, pngPath }
}
