// SVG drawings for the band: progress rows with a dotted fill and a pill, and ring gauges.
// Pure functions of their inputs, returning markup for the Svg element. Colors are raw hex
// (an SVG cannot read theme keys), tuned for dark themes.

export const INK = {
  track: '#2a2e36',
  text: '#e6e9ef',
  muted: '#9aa3b2',
  faint: '#5c6370',
  purple: '#9d8cfa',
  green: '#34b27d',
  red: '#f0566a',
  amber: '#f2a24a',
  blue: '#5b8def',
  orange: '#e8835f',
} as const

const FONT = "Inter, 'Segoe UI', system-ui, sans-serif"
const WIDTH = 900

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// A rough text width in pixels, good enough to size a pill and lay out a row.
function textWidth(text: string, size: number, bold = false): number {
  let units = 0

  for (const ch of text) {
    units += /[฀-๿]/.test(ch) ? 0.5 : /[ilI.,:'·|]/.test(ch) ? 0.32 : /[mwMW%]/.test(ch) ? 0.85 : 0.58
  }

  return units * size * (bold ? 1.06 : 1)
}

function clip(text: string, size: number, max: number): string {
  if (textWidth(text, size, true) <= max) return text
  let out = text

  while (out.length > 1 && textWidth(`${out}…`, size, true) > max) out = out.slice(0, -1)

  return `${out}…`
}

export type BarRow = {
  /** The row's name, left of the bar. */
  label: string
  /** The mark before the name: a dot while running, a tick when done, a bang when something failed. */
  mark: 'dot' | 'tick' | 'bang'
  /** 0 to 1. */
  fraction: number
  /** The pill: a bold word, then a count such as "3/5". */
  pillWord: string
  pillCount: string
  pillIcon?: 'tick' | 'cross'
  color: string
  /** How many equal parts the bar is cut into, drawn as tick marks. */
  parts: number
  /** The text at the far right; a percentage by default. */
  right?: string
}

let serial = 0

export function barRows(rows: BarRow[]): string {
  const rowH = 46
  const height = rows.length * rowH + 8
  const x0 = 300
  const x1 = 790
  const span = x1 - x0
  const body: string[] = []
  const defs: string[] = []

  rows.forEach((row, i) => {
    const id = `p${(serial += 1)}`
    const y = 8 + i * rowH
    const mid = y + 19
    const f = Math.max(0, Math.min(1, row.fraction))
    const fillW = Math.max(f > 0 ? 28 : 0, span * f)
    const markColor = row.mark === 'bang' ? INK.red : row.mark === 'tick' ? INK.green : row.color

    defs.push(
      `<pattern id="${id}d" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="3.4" height="3.4" rx="0.6" fill="${row.color}"/></pattern>`,
      `<linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="1" stop-color="#fff" stop-opacity="0.95"/></linearGradient>`,
      `<mask id="${id}m"><rect x="${x0}" y="${y + 6}" width="${fillW}" height="26" fill="url(#${id}g)"/></mask>`,
      `<clipPath id="${id}c"><rect x="${x0}" y="${y + 6}" width="${span}" height="26" rx="13"/></clipPath>`,
    )

    // The mark and the name.
    if (row.mark === 'dot') body.push(`<circle cx="16" cy="${mid}" r="5" fill="${markColor}"/>`)
    else if (row.mark === 'tick')
      body.push(`<path d="M10 ${mid} l4.5 4.5 l8 -9" fill="none" stroke="${markColor}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`)
    else body.push(`<text x="14" y="${mid + 6}" font-size="18" font-weight="800" fill="${markColor}">!</text>`)
    body.push(
      `<text x="34" y="${mid + 6}" font-size="17" font-weight="600" fill="${INK.text}">${esc(clip(row.label, 17, x0 - 50))}</text>`,
    )

    // The track, the dotted fill fading in from the left, and the tick marks.
    body.push(`<rect x="${x0}" y="${y + 6}" width="${span}" height="26" rx="13" fill="${INK.track}"/>`)
    body.push(
      `<g clip-path="url(#${id}c)"><rect x="${x0}" y="${y + 6}" width="${fillW}" height="26" fill="url(#${id}d)" mask="url(#${id}m)"/></g>`,
    )

    for (let k = 1; k < row.parts; k += 1) {
      const tx = x0 + (span * k) / row.parts
      const inside = tx < x0 + fillW
      body.push(
        `<line x1="${tx}" y1="${y + 12}" x2="${tx}" y2="${y + 26}" stroke="${inside ? '#ffffff' : INK.faint}" stroke-opacity="${inside ? 0.55 : 0.8}" stroke-width="${inside ? 2 : 1.5}"/>`,
      )
    }

    // The pill sits at the end of the fill.
    const icon = row.pillIcon === undefined ? 0 : 20
    const pillW = 26 + icon + textWidth(row.pillWord, 16, true) + 8 + textWidth(row.pillCount, 16)
    const px = Math.max(x0, Math.min(x0 + fillW - pillW, x1 - pillW))
    body.push(`<rect x="${px}" y="${y + 4}" width="${pillW}" height="30" rx="15" fill="${row.color}"/>`)
    let tx = px + 13

    if (row.pillIcon === 'tick')
      body.push(`<path d="M${tx} ${mid} l4 4 l7.5 -8.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`)
    if (row.pillIcon === 'cross')
      body.push(`<path d="M${tx + 1} ${mid - 5} l9 9 M${tx + 10} ${mid - 5} l-9 9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`)
    tx += icon
    body.push(
      `<text x="${tx}" y="${mid + 6}" font-size="16" fill="#fff"><tspan font-weight="700">${esc(row.pillWord)}</tspan><tspan dx="8" fill-opacity="0.85">${esc(row.pillCount)}</tspan></text>`,
    )

    body.push(
      `<text x="${WIDTH - 14}" y="${mid + 6}" font-size="17" text-anchor="end" fill="${INK.muted}">${esc(row.right ?? `${Math.round(f * 100)}%`)}</text>`,
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="100%" font-family="${FONT}">` +
    `<defs>${defs.join('')}</defs>${body.join('')}</svg>`
  )
}

export type Gauge = {
  /** 0 to 100. */
  percent: number
  /** What is measured, after the percentage, such as "5h · resets in 4h 3m". */
  caption: string
  icon: 'clock' | 'calendar' | 'stack'
}

function gaugeColor(percent: number): string {
  return percent < 50 ? INK.green : percent < 80 ? INK.amber : INK.red
}

function iconPath(kind: Gauge['icon'], cx: number, cy: number): string {
  const s = `stroke="${INK.muted}" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"`

  if (kind === 'clock') return `<circle cx="${cx}" cy="${cy}" r="7" ${s}/><path d="M${cx} ${cy - 4} V${cy} l3 2" ${s}/>`
  if (kind === 'calendar')
    return `<rect x="${cx - 7}" y="${cy - 6}" width="14" height="13" rx="2.5" ${s}/><path d="M${cx - 7} ${cy - 1.5} H${cx + 7} M${cx - 3.5} ${cy - 8} V${cy - 4} M${cx + 3.5} ${cy - 8} V${cy - 4}" ${s}/>`

  return `<path d="M${cx - 7} ${cy - 4} L${cx} ${cy - 7.5} L${cx + 7} ${cy - 4} L${cx} ${cy - 0.5} Z M${cx - 7} ${cy + 0.5} L${cx} ${cy + 4} L${cx + 7} ${cy + 0.5} M${cx - 7} ${cy + 4.5} L${cx} ${cy + 8} L${cx + 7} ${cy + 4.5}" ${s}/>`
}

/** One row: the model's name, then a ring gauge for each meter. */
export function gaugeRow(model: string, gauges: Gauge[]): string {
  const height = 64
  const cy = 32
  const body: string[] = []
  let x = 14

  body.push(`<text x="${x}" y="${cy + 6}" font-size="17" font-weight="700" fill="${INK.orange}">${esc(model)}</text>`)
  x += textWidth(model, 17, true) + 30

  for (const g of gauges) {
    const pct = Math.max(0, Math.min(100, g.percent))
    const r = 17
    const cx = x + r + 4
    const length = 2 * Math.PI * r
    const color = gaugeColor(pct)

    body.push(
      `<circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="${INK.track}"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a3f48" stroke-width="3.2"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" ` +
        `stroke-dasharray="${((length * pct) / 100).toFixed(1)} ${length.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>`,
      iconPath(g.icon, cx, cy),
    )
    x = cx + r + 16

    const pctText = `${Math.round(pct)}%`
    body.push(
      `<text x="${x}" y="${cy + 6}" font-size="18"><tspan font-weight="700" fill="${INK.text}">${pctText}</tspan>` +
        `<tspan dx="9" fill="${INK.muted}">${esc(g.caption)}</tspan></text>`,
    )
    x += textWidth(pctText, 18, true) + 9 + textWidth(g.caption, 18) + 40
  }

  // A row longer than the slot is drawn smaller rather than cut off.
  const width = Math.max(WIDTH, Math.ceil(x - 20))

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" font-family="${FONT}">` +
    `${body.join('')}</svg>`
  )
}

/** "4h 3m", "6d 19h", "12m": the time left until an ISO timestamp. */
export function timeLeft(iso: string | undefined, now: number): string {
  if (iso === undefined) return ''
  const ms = Date.parse(iso) - now

  if (Number.isNaN(ms) || ms <= 0) return ''
  const minutes = Math.floor(ms / 60000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`

  return `${minutes}m`
}
