
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body><div id="ls"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' })
const w = dom.window as unknown as Record<string, unknown>
function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
setGlobal('window', w)
setGlobal('document', w.document)
setGlobal('navigator', w.navigator)
setGlobal('HTMLElement', w.HTMLElement)
setGlobal('HTMLDivElement', w.HTMLDivElement)
setGlobal('HTMLCanvasElement', w.HTMLCanvasElement)
setGlobal('SVGElement', w.SVGElement)
setGlobal('Element', w.Element)
setGlobal('Node', w.Node)
setGlobal('getComputedStyle', w.getComputedStyle.bind(w))
setGlobal('requestAnimationFrame', (w as { requestAnimationFrame?: unknown }).requestAnimationFrame?.bind(w) ?? ((cb: (t: number) => void) => setTimeout(() => cb(0), 16)))
setGlobal('cancelAnimationFrame', (w as { cancelAnimationFrame?: unknown }).cancelAnimationFrame?.bind(w) ?? clearTimeout)
setGlobal('localStorage', w.localStorage)
setGlobal('sessionStorage', w.sessionStorage)
setGlobal('Image', w.Image)
setGlobal('DOMParser', w.DOMParser)
setGlobal('MutationObserver', w.MutationObserver)
Object.defineProperty(globalThis, 'jQuery', { get: () => w.$, configurable: true })
Object.defineProperty(globalThis, '$', { get: () => w.$, configurable: true })

// 官方演示的完整插件链：jquery → jquery-ui → plugin.js（含 mousewheel/spectrum 等）
await import('file:///D:/AI/erp/frontend/node_modules/luckysheet/dist/plugins/js/plugin.js')
console.log('after plugin.js | $.fn.spectrum:', typeof (w as { $?: { fn?: { spectrum?: unknown } } }).$?.fn?.spectrum, '| $.ui:', typeof (w as { $?: { ui?: unknown } }).$?.ui)
await import('file:///D:/AI/erp/frontend/node_modules/jquery-ui-dist/jquery-ui.min.js')
console.log('after jquery-ui | $.ui:', typeof (w as { $?: { ui?: unknown } }).$?.ui)

const mod = await import('file:///D:/AI/erp/frontend/node_modules/luckysheet/dist/luckysheet.esm.js')
const luckysheet = (mod as { default?: unknown }).default ?? (w as { luckysheet?: unknown }).luckysheet
console.log('luckysheet loaded:', typeof luckysheet)
try {
  luckysheet.create({
    container: 'ls',
    data: [{ name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: '测试' } }], config: {}, index: 0, order: 0, status: 1 }],
    lang: 'zh',
    showinfobar: false,
    showsheetbar: false,
  })
  console.log('create OK')
} catch (e) {
  console.log('create FAIL:', (e as Error).message)
}
