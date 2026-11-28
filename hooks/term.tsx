// The terminal's drawing of what draw.ts paints as SVG: the same rows, pills, rings and
// chips, built from boxes, block characters and background colors. Pure functions of their
// inputs; `ui` is the surface's element table.
import { ago, INK } from './draw'
import type { BarRow, BranchRow, Gauge, StackRow } from './draw'

type Ui = { Box: any; Text: any }

// A darker shade of a color, for a chip's ground.
function tint(hex: string, amount = 0.28): string {
  const base = [0x1e, 0x22, 0x28]
  const mixed = [1, 3, 5].map((at, i) => Math.round(parseInt(hex.slice(at, at + 2), 16) * amount + base[i] * (1 - amount)))

  return `#${mixed.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function ring(percent: number): string {
  return percent >= 87 ? '●' : percent >= 62 ? '◕' : percent >= 37 ? '◑' : percent >= 12 ? '◔' : '○'
}

function meterColor(percent: number): string {
  return percent < 50 ? INK.green : percent < 80 ? INK.amber : INK.red
}

/** The model's name, then a ring for each meter. */
export function termGauges(ui: Ui, model: string, gauges: Gauge[]) {
  const { Box, Text } = ui

  return (
    <Box flexWrap="wrap" columnGap={4}>
      <Text color={INK.orange} bold>
        {model}
      </Text>
      {gauges.map(g => (
        <Text key={g.caption}>
          <Text color={meterColor(g.percent)}>{ring(g.percent)} </Text>
          <Text bold>{Math.round(g.percent)}%</Text>
          <Text color={INK.muted}> {g.caption}</Text>
        </Text>
      ))}
    </Box>
  )
}

// The bar: a fill that thickens from left to right, the pill at its end, then the empty track
// with a mark at each part's edge.
function bar(ui: Ui, row: BarRow, width: number) {
  const { Text } = ui
  const fraction = Math.max(0, Math.min(1, row.fraction))
  const icon = row.pillIcon === 'tick' ? '✓ ' : row.pillIcon === 'cross' ? '✕ ' : ''
  const full = ` ${icon}${row.pillWord}${row.pillCount === '' ? '' : ` ${row.pillCount}`} `
  const pill = full.length > width ? full.slice(0, width) : full
  const filled = Math.round(fraction * width)
  const start = Math.max(0, Math.min(filled - pill.length, width - pill.length))
  const end = start + pill.length
  const edges = new Set(Array.from({ length: Math.max(0, row.parts - 1) }, (_, i) => Math.round(((i + 1) * width) / row.parts)))
  const cells = (from: number, to: number) => {
    let out = ''

    for (let i = from; i < to; i += 1) {
      if (i >= filled) out += edges.has(i) ? '╵' : '·'
      else if (edges.has(i)) out += '│'
      else out += i < filled * 0.34 ? '░' : i < filled * 0.7 ? '▒' : '▓'
    }

    return out
  }
  // Cells before and after the pill, each split where the fill stops.
  const run = (from: number, to: number, key: string) => {
    const cut = Math.max(from, Math.min(to, filled))

    return [
      <Text key={`${key}f`} color={row.color}>
        {cells(from, cut)}
      </Text>,
      <Text key={`${key}e`} color={INK.faint}>
        {cells(cut, to)}
      </Text>,
    ]
  }

  return (
    <Text wrap="truncate-end">
      {run(0, start, 'a')}
      <Text backgroundColor={row.color} color="#ffffff" bold>
        {pill}
      </Text>
      {run(end, width, 'b')}
    </Text>
  )
}

function mark(ui: Ui, row: BarRow) {
  const { Text } = ui
  const color = row.mark === 'bang' ? INK.red : row.mark === 'tick' ? INK.green : row.color

  return (
    <Text color={color} bold>
      {row.mark === 'dot' ? '●' : row.mark === 'tick' ? '✓' : '!'}{' '}
    </Text>
  )
}

/** One line per row: mark and name, the bar, the value at the right. */
export function termRows(ui: Ui, rows: BarRow[], columns: number) {
  const { Box, Text } = ui
  const rightW = 9
  const labelW = Math.max(14, Math.min(28, Math.floor(columns * 0.26)))
  const barW = Math.max(14, columns - labelW - rightW - 4)

  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box key={row.label}>
          {mark(ui, row)}
          <Box width={labelW} flexShrink={0}>
            <Text bold wrap="truncate-end">
              {row.label}
            </Text>
          </Box>
          <Box width={barW + 1} flexShrink={0}>
            {bar(ui, row, barW)}
          </Box>
          <Box width={rightW} justifyContent="flex-end" flexShrink={0}>
            <Text color={INK.muted} wrap="truncate-end">
              {row.right ?? `${Math.round(row.fraction * 100)}%`}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** Bordered tiles side by side, such as Cost, Tokens and Time. */
export function termTiles(ui: Ui, tiles: { label: string; value: string }[]) {
  const { Box, Text } = ui

  return (
    <Box columnGap={1}>
      {tiles.map(tile => (
        <Box key={tile.label} flexDirection="column" flexGrow={1} borderStyle="round" borderColor={INK.faint} paddingX={1}>
          <Text color={INK.muted} wrap="truncate-end">
            {tile.label}
          </Text>
          <Text bold wrap="truncate-end">
            {tile.value}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** Rows for a narrow pane: name, status, steps, then a full-width bar with its pill. */
export function termStack(ui: Ui, rows: StackRow[], columns: number) {
  const { Box, Text } = ui
  const rightW = 7
  const barW = Math.max(12, columns - rightW - 3)

  return (
    <Box flexDirection="column" rowGap={1}>
      {rows.map(row => (
        <Box key={row.label} flexDirection="column">
          <Box>
            {mark(ui, row)}
            <Text bold wrap="truncate-end">
              {row.label}
            </Text>
          </Box>
          <Box flexDirection="column" paddingLeft={2}>
            {(row.status !== undefined || row.details !== undefined) && (
              <Text wrap="truncate-end">
                <Text color={row.status?.color}>{row.status?.text}</Text>
                <Text color={INK.muted}> {row.details}</Text>
              </Text>
            )}
            {(row.lines ?? []).slice(0, 4).map((line, i) => (
              <Text key={`l${i}`} color={INK.muted} wrap="truncate-end">
                · {line}
              </Text>
            ))}
            {row.criteria !== undefined && (
              <Text wrap="truncate-end">
                <Text color={INK.amber} bold>
                  เกณฑ์ผ่าน{' '}
                </Text>
                <Text color={INK.muted}>{row.criteria}</Text>
              </Text>
            )}
            <Box>
              <Box width={barW + 1} flexShrink={0}>
                {bar(ui, row, barW)}
              </Box>
              <Box width={rightW} justifyContent="flex-end" flexShrink={0}>
                <Text color={INK.muted} wrap="truncate-end">
                  {row.right ?? `${Math.round(row.fraction * 100)}%`}
                </Text>
              </Box>
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** The branch list: name and age, then status chips and the last commit's subject. */
export function termBranches(ui: Ui, rows: BranchRow[], nowMs: number) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column">
      {rows.map(row => (
        <Box key={row.name} flexDirection="column">
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">
              <Text color={row.isCurrent ? INK.purple : INK.faint}>{row.isCurrent ? '● ' : '○ '}</Text>
              <Text bold={row.isCurrent}>{row.name}</Text>
            </Text>
            <Text color={INK.muted}> {ago(row.committedAt, nowMs)}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text wrap="truncate-end">
              {row.chips.map((chip, i) => (
                <Text key={String(i)}>
                  <Text backgroundColor={tint(chip.color)} color={chip.color} bold>
                    {` ${chip.text} `}
                  </Text>{' '}
                </Text>
              ))}
              <Text color={INK.faint}>{row.subject}</Text>
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
