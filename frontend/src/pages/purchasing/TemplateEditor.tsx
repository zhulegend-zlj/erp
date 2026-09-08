import { useMemo, useState } from 'react'
import { Button, Dropdown, Select, Space } from 'antd'
import {
  BoldOutlined,
  MergeCellsOutlined,
  SplitCellsOutlined,
  InsertRowAboveOutlined,
  DeleteRowOutlined,
  InsertRowRightOutlined,
  DeleteColumnOutlined,
  BorderOutlined,
  BgColorsOutlined,
} from '@ant-design/icons'

/** C 方案模板编辑器（2026-09-07）：模板=网页表格，像 Word 一样直接编辑，所见即所得 */
export interface TmplCell {
  rs?: number
  cs?: number
  text?: string
  bold?: boolean
  fs?: number
  ha?: 'l' | 'c' | 'r'
  va?: 't' | 'm' | 'b'
  bg?: string
  border?: boolean
}
export interface TmplModel {
  version: 2
  cols: number[]
  rows: number[]
  cells: Record<string, TmplCell>
  detailRow?: number
}

const PLACEHOLDER_GROUPS: Array<{ group: string; items: Array<{ token: string; label: string }> }> = [
  {
    group: '表头字段',
    items: [
      { token: '单号', label: '采购单号' },
      { token: '下单日期', label: '下单日期' },
      { token: '供应商名称', label: '供应商名称' },
      { token: '联系人', label: '联系人' },
      { token: '电话', label: '电话' },
      { token: '传真', label: '传真' },
      { token: '邮箱', label: '邮箱' },
      { token: '机型', label: '适用机型' },
      { token: '付款方式', label: '付款方式' },
      { token: '预计交货', label: '预计交货日期' },
      { token: '备注条款', label: '备注条款' },
      { token: '公司抬头', label: '公司抬头' },
    ],
  },
  {
    group: '明细字段（放在明细行里）',
    items: [
      { token: '序号', label: '序号' },
      { token: '料号', label: '产品编号' },
      { token: '名称', label: '产品名称' },
      { token: '规格', label: '规格' },
      { token: '材质', label: '材质' },
      { token: '表面处理', label: '表面处理' },
      { token: '单位', label: '单位' },
      { token: '用量', label: '用量' },
      { token: '数量', label: '数量' },
      { token: '单价', label: '单价（不含税）' },
      { token: '含税单价', label: '单价（含税）' },
      { token: '金额', label: '金额' },
      { token: '备注', label: '备注' },
    ],
  },
  {
    group: '合计字段',
    items: [
      { token: '合计', label: '合计金额' },
      { token: '合计大写', label: '合计金额（大写）' },
    ],
  },
]

function keyOf(r: number, c: number): string {
  return r + ':' + c
}

interface Props {
  model: TmplModel
  onChange: (m: TmplModel) => void
}

export default function TemplateEditor({ model, onChange }: Props) {
  const [sel, setSel] = useState<{ r: number; c: number; rs: number; cs: number } | null>(null)
  const [ctxCell, setCtxCell] = useState<{ r: number; c: number } | null>(null)
  const [zoom, setZoom] = useState(0.9)
  const dragRef = useMemo(() => ({ start: { r: 0, c: 0 }, on: false }), [])

  const colX = useMemo(() => {
    const arr: number[] = []
    let x = 0
    for (const w of model.cols) {
      arr.push(x)
      x += w
    }
    return { arr, total: x }
  }, [model.cols])
  const rowY = useMemo(() => {
    const arr: number[] = []
    let y = 0
    for (const h of model.rows) {
      arr.push(y)
      y += h
    }
    return { arr, total: y }
  }, [model.rows])

  function mut(fn: (m: TmplModel) => void) {
    const next: TmplModel = JSON.parse(JSON.stringify(model))
    fn(next)
    onChange(next)
  }

  function cellAt(r: number, c: number): TmplCell {
    return model.cells[keyOf(r, c)] ?? {}
  }

  function coveredMap(): Set<string> {
    const covered = new Set<string>()
    for (const [key, cell] of Object.entries(model.cells)) {
      if (!cell.rs || !cell.cs || cell.rs * cell.cs <= 1) continue
      const [r, c] = key.split(':').map(Number)
      for (let i = 0; i < cell.rs; i++) {
        for (let j = 0; j < cell.cs; j++) {
          if (i !== 0 || j !== 0) covered.add(keyOf(r + i, c + j))
        }
      }
    }
    return covered
  }
  const covered = useMemo(coveredMap, [model.cells])

  function setCellText(r: number, c: number, text: string) {
    mut((m) => {
      const k = keyOf(r, c)
      const cell = m.cells[k] ?? {}
      if (text === '') {
        const { text: _t, ...rest } = cell
        if (Object.keys(rest).length === 0) delete m.cells[k]
        else m.cells[k] = rest
      } else {
        m.cells[k] = { ...cell, text }
      }
    })
  }

  function mergeSelection() {
    if (!sel || sel.rs * sel.cs <= 1) return
    const texts: string[] = []
    for (let r = sel.r; r < sel.r + sel.rs; r++) {
      for (let c = sel.c; c < sel.c + sel.cs; c++) {
        const t = cellAt(r, c).text
        if (t) texts.push(t)
      }
    }
    mut((m) => {
      const merged: TmplCell = { ...(m.cells[keyOf(sel.r, sel.c)] ?? {}), rs: sel.rs, cs: sel.cs }
      merged.text = texts.join(' ')
      for (let r = sel.r; r < sel.r + sel.rs; r++) {
        for (let c = sel.c; c < sel.c + sel.cs; c++) {
          if (r === sel.r && c === sel.c) continue
          delete m.cells[keyOf(r, c)]
        }
      }
      m.cells[keyOf(sel.r, sel.c)] = merged
    })
  }

  function splitSelection() {
    if (!ctxCell) return
    const cell = cellAt(ctxCell.r, ctxCell.c)
    if (!cell.rs && !cell.cs) return
    mut((m) => {
      const k = keyOf(ctxCell.r, ctxCell.c)
      const { rs: _r, cs: _c, ...rest } = m.cells[k] ?? {}
      if (Object.keys(rest).length === 0) delete m.cells[k]
      else m.cells[k] = rest
    })
  }

  function insertRow(before: boolean, atRow?: number) {
    const at = atRow ?? sel?.r ?? model.rows.length
    mut((m) => {
      m.rows.splice(before ? at : at + 1, 0, 24)
      const next: Record<string, TmplCell> = {}
      for (const [key, cell] of Object.entries(m.cells)) {
        const [r, c] = key.split(':').map(Number)
        next[keyOf(r >= (before ? at : at + 1) ? r + 1 : r, c)] = cell
      }
      m.cells = next
      if (m.detailRow != null && m.detailRow >= (before ? at : at + 1)) m.detailRow++
    })
  }

  function deleteRow(atRow: number) {
    if (model.rows.length <= 1) return
    mut((m) => {
      const at = atRow
      m.rows.splice(at, 1)
      const next: Record<string, TmplCell> = {}
      for (const [key, cell] of Object.entries(m.cells)) {
        const [r, c] = key.split(':').map(Number)
        if (r === at) continue
        next[keyOf(r > at ? r - 1 : r, c)] = cell
      }
      m.cells = next
      if (m.detailRow === at) m.detailRow = undefined
      else if (m.detailRow != null && m.detailRow > at) m.detailRow--
    })
    setSel(null)
  }

  function insertCol(before: boolean, atCol?: number) {
    const at = atCol ?? sel?.c ?? model.cols.length
    mut((m) => {
      m.cols.splice(before ? at : at + 1, 0, 64)
      const next: Record<string, TmplCell> = {}
      for (const [key, cell] of Object.entries(m.cells)) {
        const [r, c] = key.split(':').map(Number)
        next[keyOf(r, c >= (before ? at : at + 1) ? c + 1 : c)] = cell
      }
      m.cells = next
    })
  }

  function deleteCol(atCol: number) {
    if (model.cols.length <= 1) return
    mut((m) => {
      const at = atCol
      m.cols.splice(at, 1)
      const next: Record<string, TmplCell> = {}
      for (const [key, cell] of Object.entries(m.cells)) {
        const [r, c] = key.split(':').map(Number)
        if (c === at) continue
        next[keyOf(r, c > at ? c - 1 : c)] = cell
      }
      m.cells = next
    })
    setSel(null)
  }

  function styleCell(r: number, c: number, patch: Partial<TmplCell>) {
    mut((m) => {
      const k = keyOf(r, c)
      m.cells[k] = { ...(m.cells[k] ?? {}), ...patch }
    })
  }

  function resizeCol(idx: number, delta: number) {
    mut((m) => {
      m.cols[idx] = Math.max(20, (m.cols[idx] ?? 64) + delta)
    })
  }

  function resizeRow(idx: number, delta: number) {
    mut((m) => {
      m.rows[idx] = Math.max(16, (m.rows[idx] ?? 24) + delta)
    })
  }

  function insertTokenAt(r: number, c: number, token: string) {
    setCellText(r, c, (cellAt(r, c).text ?? '') + '{{' + token + '}}')
  }

  const ctxCellData = ctxCell ? cellAt(ctxCell.r, ctxCell.c) : null
  const ctxItems = ctxCell
    ? {
        items: [
          {
            key: 'tokens',
            label: '插入数据字段…',
            children: PLACEHOLDER_GROUPS.map((g) => ({
              key: 'g-' + g.group,
              label: g.group,
              children: g.items.map((i) => ({ key: i.token, label: i.label })),
            })),
          },
          { type: 'divider' as const },
          { key: 'merge', label: '合并单元格（先拖动框选多格）', disabled: !sel || sel.rs * sel.cs <= 1 },
          { key: 'split', label: '拆分单元格', disabled: !ctxCellData?.rs && !ctxCellData?.cs },
          { type: 'divider' as const },
          { key: 'ir-above', label: '在上方插入行' },
          { key: 'ir-below', label: '在下方插入行' },
          { key: 'del-row', label: '删除本行' },
          { type: 'divider' as const },
          { key: 'ic-left', label: '在左侧插入列' },
          { key: 'ic-right', label: '在右侧插入列' },
          { key: 'del-col', label: '删除本列' },
          { type: 'divider' as const },
          { key: 'detail', label: model.detailRow === ctxCell.r ? '取消明细行标记' : '把本行标记为明细行' },
        ],
        onClick: ({ key }: { key: string }) => {
          if (!ctxCell) return
          if (key === 'merge') mergeSelection()
          else if (key === 'split') splitSelection()
          else if (key === 'ir-above') insertRow(true, ctxCell.r)
          else if (key === 'ir-below') insertRow(false, ctxCell.r)
          else if (key === 'del-row') deleteRow(ctxCell.r)
          else if (key === 'ic-left') insertCol(true, ctxCell.c)
          else if (key === 'ic-right') insertCol(false, ctxCell.c)
          else if (key === 'del-col') deleteCol(ctxCell.c)
          else if (key === 'detail') {
            mut((m) => {
              m.detailRow = m.detailRow === ctxCell.r ? undefined : ctxCell.r
            })
          } else if (PLACEHOLDER_GROUPS.some((g) => g.items.some((i) => i.token === key))) {
            insertTokenAt(ctxCell.r, ctxCell.c, key)
          }
        },
      }
    : null

  return (
    <div>
      <Space wrap style={{ marginBottom: 8 }}>
        <Button icon={<MergeCellsOutlined />} disabled={!sel || sel.rs * sel.cs <= 1} onClick={mergeSelection}>
          合并
        </Button>
        <Button icon={<SplitCellsOutlined />} disabled={!ctxCellData?.rs && !ctxCellData?.cs} onClick={splitSelection}>
          拆分
        </Button>
        <Button icon={<InsertRowAboveOutlined />} onClick={() => insertRow(true, sel?.r)}>
          插行
        </Button>
        <Button icon={<DeleteRowOutlined />} disabled={sel == null} onClick={() => sel && deleteRow(sel.r)}>
          删行
        </Button>
        <Button icon={<InsertRowRightOutlined />} onClick={() => insertCol(false, sel?.c)}>
          插列
        </Button>
        <Button icon={<DeleteColumnOutlined />} disabled={sel == null} onClick={() => sel && deleteCol(sel.c)}>
          删列
        </Button>
        <Button
          icon={<BoldOutlined />}
          type={ctxCellData?.bold ? 'primary' : 'default'}
          disabled={!ctxCell}
          onClick={() => ctxCell && styleCell(ctxCell.r, ctxCell.c, { bold: !ctxCellData?.bold })}
        >
          加粗
        </Button>
        <Select
          value={ctxCellData?.fs ?? 12}
          style={{ width: 76 }}
          disabled={!ctxCell}
          onChange={(v: number) => ctxCell && styleCell(ctxCell.r, ctxCell.c, { fs: v })}
          options={[9, 10, 11, 12, 14, 16, 18, 22, 26, 32].map((n) => ({ value: n, label: n + '号' }))}
        />
        <Select
          value={ctxCellData?.ha ?? 'c'}
          style={{ width: 80 }}
          disabled={!ctxCell}
          onChange={(v: 'l' | 'c' | 'r') => ctxCell && styleCell(ctxCell.r, ctxCell.c, { ha: v })}
          options={[
            { value: 'l', label: '左对齐' },
            { value: 'c', label: '居中' },
            { value: 'r', label: '右对齐' },
          ]}
        />
        <Button
          icon={<BorderOutlined />}
          type={ctxCellData?.border ? 'primary' : 'default'}
          disabled={!ctxCell}
          onClick={() => ctxCell && styleCell(ctxCell.r, ctxCell.c, { border: !ctxCellData?.border })}
        >
          边框
        </Button>
        <Button
          icon={<BgColorsOutlined />}
          disabled={!ctxCell}
          onClick={() => ctxCell && styleCell(ctxCell.r, ctxCell.c, { bg: ctxCellData?.bg ? undefined : '#f5f5f5' })}
        >
          底色
        </Button>
        <Button
          type={model.detailRow === ctxCell?.r ? 'primary' : 'default'}
          disabled={!ctxCell}
          onClick={() =>
            ctxCell &&
            mut((m) => {
              m.detailRow = m.detailRow === ctxCell.r ? undefined : ctxCell.r
            })
          }
        >
          {model.detailRow === ctxCell?.r ? '取消明细行' : '标记为明细行'}
        </Button>
        <Select
          value={zoom}
          style={{ width: 80 }}
          onChange={setZoom}
          options={[
            { value: 0.6, label: '60%' },
            { value: 0.75, label: '75%' },
            { value: 0.9, label: '90%' },
            { value: 1, label: '100%' },
          ]}
        />
      </Space>
      <div style={{ marginBottom: 8, padding: '6px 10px', background: '#e6f4ff', borderRadius: 6, fontSize: 13 }}>
        <b>像 Word 表格一样用：</b>① <b>点进格子直接打字</b>；② <b>右键</b>格子 → 插行/插列/删行删列/合并/拆分/插入数据字段/标记明细行；③ 合并：先按住鼠标<b>拖动框选</b>多个格子再点「合并」；④ 拖动顶部/左侧<b>蓝色细线</b>调宽高
      </div>

      <div style={{ overflow: 'auto', background: '#525659', padding: 16, borderRadius: 8 }}>
        <div style={{ position: 'relative', width: (colX.total + 28) * zoom, margin: '0 auto' }}>
          {/* 列宽标尺 */}
          <div style={{ height: 20 * zoom, marginLeft: 28 * zoom, position: 'relative' }}>
            {model.cols.map((_, c) => (
              <div
                key={'ch' + c}
                style={{ position: 'absolute', left: colX.arr[c]! * zoom, width: model.cols[c]! * zoom, height: '100%', background: '#e8e8e8', border: '1px solid #bbb', boxSizing: 'border-box', fontSize: 10, textAlign: 'center', lineHeight: 20 * zoom + 'px', color: '#666' }}
              >
                {String.fromCharCode(65 + (c % 26))}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex' }}>
            <div style={{ width: 28 * zoom, position: 'relative', flexShrink: 0 }}>
              {model.rows.map((_, r) => (
                <div key={'rh' + r} style={{ height: model.rows[r]! * zoom, background: '#e8e8e8', border: '1px solid #bbb', boxSizing: 'border-box', fontSize: 10, textAlign: 'center', lineHeight: model.rows[r]! * zoom + 'px', color: '#666' }}>
                  {r + 1}
                </div>
              ))}
            </div>
            <div style={{ position: 'relative', width: colX.total * zoom, height: rowY.total * zoom, background: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.4)', flexShrink: 0 }}>
              {/* 列分隔线 */}
              {model.cols.map((_, c) => (
                <div
                  key={'csep' + c}
                  className="tpl-csep"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const sx = e.clientX
                    const move = (ev: MouseEvent) => resizeCol(c, (ev.clientX - sx) / zoom)
                    const up = () => {
                      window.removeEventListener('mousemove', move)
                      window.removeEventListener('mouseup', up)
                    }
                    window.addEventListener('mousemove', move)
                    window.addEventListener('mouseup', up)
                  }}
                  style={{ position: 'absolute', left: (colX.arr[c]! + model.cols[c]!) * zoom - 3, top: 0, width: 6, height: '100%', cursor: 'col-resize', zIndex: 6 }}
                />
              ))}
              {model.rows.map((_, r) => (
                <div
                  key={'rsep' + r}
                  className="tpl-rsep"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const sy = e.clientY
                    const move = (ev: MouseEvent) => resizeRow(r, (ev.clientY - sy) / zoom)
                    const up = () => {
                      window.removeEventListener('mousemove', move)
                      window.removeEventListener('mouseup', up)
                    }
                    window.addEventListener('mousemove', move)
                    window.addEventListener('mouseup', up)
                  }}
                  style={{ position: 'absolute', top: (rowY.arr[r]! + model.rows[r]!) * zoom - 3, left: 0, width: '100%', height: 6, cursor: 'row-resize', zIndex: 6 }}
                />
              ))}
              {/* 表格 */}
              <Dropdown menu={ctxItems ?? { items: [] }} trigger={['contextMenu']}>
                <table
                  style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%', position: 'relative', zIndex: 2 }}
                  onMouseDown={(e) => {
                    if ((e.target as HTMLElement).closest('td') == null) return
                  }}
                >
                  <colgroup>
                    {model.cols.map((w, i) => (
                      <col key={i} style={{ width: w * zoom }} />
                    ))}
                  </colgroup>
                  <tbody>
                    {model.rows.map((h, r) => (
                      <tr key={r} style={{ height: h * zoom }}>
                        {model.cols.map((_, c) => {
                          if (covered.has(keyOf(r, c))) return null
                          const cell = cellAt(r, c)
                          const inSel = sel && r >= sel.r && r < sel.r + sel.rs && c >= sel.c && c < sel.c + sel.cs
                          return (
                            <td
                              key={c}
                              rowSpan={cell.rs && cell.rs > 1 ? cell.rs : undefined}
                              colSpan={cell.cs && cell.cs > 1 ? cell.cs : undefined}
                              contentEditable
                              suppressContentEditableWarning
                              onMouseDown={(e) => {
                                if (e.button !== 0) return
                                dragRef.on = true
                                dragRef.start = { r, c }
                                setCtxCell({ r, c })
                                setSel({ r, c, rs: 1, cs: 1 })
                                const move = (ev: MouseEvent) => {
                                  const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
                                  const td = el?.closest('td')
                                  if (!td) return
                                  const tr = td.closest('tr')
                                  const tbody = tr?.parentElement
                                  if (!tr || !tbody) return
                                  const rr = Array.from(tbody.children).indexOf(tr)
                                  const cc = Array.from(tr.children).indexOf(td)
                                  const r0 = Math.min(dragRef.start.r, rr)
                                  const r1 = Math.max(dragRef.start.r, rr)
                                  const c0 = Math.min(dragRef.start.c, cc)
                                  const c1 = Math.max(dragRef.start.c, cc)
                                  setSel({ r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 })
                                }
                                const up = () => {
                                  dragRef.on = false
                                  window.removeEventListener('mousemove', move)
                                  window.removeEventListener('mouseup', up)
                                }
                                window.addEventListener('mousemove', move)
                                window.addEventListener('mouseup', up)
                              }}
                              onContextMenu={(e) => {
                                e.preventDefault()
                                setCtxCell({ r, c })
                                if (!sel || !(r >= sel.r && r < sel.r + sel.rs && c >= sel.c && c < sel.c + sel.cs)) {
                                  setSel({ r, c, rs: 1, cs: 1 })
                                }
                              }}
                              onBlur={(e) => {
                                const text = (e.target as HTMLElement).innerText.replace(/\n+$/, '')
                                setCellText(r, c, text)
                              }}
                              style={{
                                border: cell.border === false ? '1px solid transparent' : '1px solid #999',
                                background: model.detailRow === r ? '#fff7e6' : cell.bg ?? '#fff',
                                fontWeight: cell.bold ? 700 : 400,
                                fontSize: (cell.fs ?? 12) * zoom,
                                textAlign: cell.ha === 'l' ? 'left' : cell.ha === 'r' ? 'right' : 'center',
                                verticalAlign: cell.va === 't' ? 'top' : cell.va === 'b' ? 'bottom' : 'middle',
                                padding: 2,
                                wordBreak: 'break-all',
                                cursor: 'cell',
                                outline: inSel ? '2px solid #1677ff' : 'none',
                                outlineOffset: -2,
                                minWidth: 8,
                              }}
                            >
                              {cell.text ?? ''}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Dropdown>
            </div>
          </div>
        </div>
      </div>
      <style>{'.tpl-csep:hover{background:rgba(22,119,255,0.35)!important}.tpl-rsep:hover{background:rgba(22,119,255,0.35)!important}.tpl-csep{background:rgba(22,119,255,0.15)}.tpl-rsep{background:rgba(22,119,255,0.15)}'}</style>
    </div>
  )
}
