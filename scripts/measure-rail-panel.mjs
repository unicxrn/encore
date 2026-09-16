/**
 * Measure the preview rail's panel in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-rail-panel.mjs
 *     STATE=broken node_modules/electron/dist/electron scripts/measure-rail-panel.mjs
 *     SIZE=1280x800 STATE=long node_modules/electron/dist/electron scripts/measure-rail-panel.mjs
 *
 * The jsdom tests cannot answer any of this. They apply no CSS and compute no layout, so the
 * ring is not a circle, the eight statistics are not in two columns, and every card is zero
 * pixels tall. This runs the built renderer in an offscreen window, which is never shown on any
 * desktop but keeps producing frames, and reads the geometry back out.
 *
 * The questions, and why each one is here rather than in a test:
 *
 *   fold        Whether the action is reachable without scrolling. The rail is a fixed 374px
 *               column between the top bar and the player, so at an 800px window it gets around
 *               680px of height and the panel is taller than that. What matters is not that it
 *               scrolls but WHERE it scrolls from: the action and the two selects have to be
 *               above the fold, and the two cards are what may fall below it.
 *   ring        The arc inside its own 56px box. An SVG stroke is centred on the path, so half
 *               the stroke width sits outside the radius and a radius chosen without that in
 *               mind is a ring clipped flat at four points. Nothing in jsdom can see that.
 *   columns     The eight statistics landing in two columns of four. A grid track with an
 *               automatic minimum collapses to one column the moment a value is wider than its
 *               share, and the failure looks like a card that grew rather than like a bug.
 *   clipped     Text cut off by its own box: `scrollWidth > clientWidth` on an element that
 *               declares an ellipsis. STATE=long is what that case exists for.
 *   wraps       The health checklist running onto a second line, which is the one thing that
 *               makes the health card taller than the ring beside it for a reason nobody chose.
 *
 * The states, because the happy one is not the one that breaks:
 *
 *   clean    every asset present and the notes read: five of five, a full ring.
 *   broken   a cover and nothing else: one of five, and four amber rows in the checklist.
 *   unread   a chart scanned before the catalog stored note counts. Half the statistics card
 *            dashes out and the note-counts check is unknown rather than missing.
 *   long     the longest title measured on api.enchor.us on 2026-09-16 (47 characters,
 *            "Untouched (live for Like A Version) (Harmonies)") against an eight-digit note
 *            count. The note count is synthetic and deliberately so: the largest seen in that
 *            same sample was 54,823, so eight digits is roughly three orders of magnitude past
 *            anything real and is here to find the column that gives way first.
 *   remote   a chart from Chorus, where two of the five health checks are unknown rather than
 *            missing and the ring's denominator is therefore not five. Reached through Explore
 *            with `fetch` stubbed, so it makes no network request and reads no real catalog.
 *
 * What it touches: a throwaway user-data directory and nothing else. The preload it writes
 * answers every call from memory, and the one leg that would otherwise reach api.enchor.us
 * answers its own search.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const state = process.env.STATE || 'clean'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-rail-measure-'))
const preloadPath = path.join(scratch, 'preload.cjs')

fs.writeFileSync(
  preloadPath,
  `const settings = {
  libraryFolders: [{ path: '/library', isDefault: true }],
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  tourSeen: true,
  lastSeenVersion: '9.9.9'
}

const COUNTS = [
  { instrument: 'guitar', difficulty: 'expert', count: 2487 },
  { instrument: 'guitar', difficulty: 'hard', count: 1610 },
  { instrument: 'guitar', difficulty: 'medium', count: 980 },
  { instrument: 'bass', difficulty: 'expert', count: 1204 },
  { instrument: 'drums', difficulty: 'expert', count: 3311 }
]
const NPS = [
  { instrument: 'guitar', difficulty: 'expert', nps: 14.1 },
  { instrument: 'guitar', difficulty: 'hard', nps: 9.4 },
  { instrument: 'bass', difficulty: 'expert', nps: 6.2 },
  { instrument: 'drums', difficulty: 'expert', nps: 11.8 }
]
const base = {
  chartType: 'folder',
  artist: 'Linkin Park',
  album: 'From Zero',
  genre: 'Rock',
  year: 2024,
  charter: 'SucreMondes',
  diffGuitar: 4,
  diffBass: 3,
  diffDrums: 5,
  songLength: 196000,
  albumArtMd5: null,
  instruments: ['guitar', 'bass', 'drums'],
  noteCounts: COUNTS,
  maxNps: NPS,
  hasSoloSections: true,
  has2xKick: false,
  hasVideo: true,
  hasBackground: true,
  hasAlbumArt: true,
  hasLyrics: true
}
// One row per state, so a single stubbed catalog serves every leg and the Preview button that
// fills the rail is found by the row's own title.
const records = [
  { ...base, path: '/library/clean', name: 'clean' },
  {
    ...base,
    path: '/library/broken',
    name: 'broken',
    hasVideo: false,
    hasBackground: false,
    hasLyrics: false
  },
  {
    ...base,
    path: '/library/unread',
    name: 'unread',
    instruments: [],
    noteCounts: [],
    maxNps: [],
    hasVideo: false,
    hasBackground: false,
    hasAlbumArt: false,
    hasLyrics: false
  },
  {
    ...base,
    path: '/library/long',
    name: 'Untouched (live for Like A Version) (Harmonies)',
    artist: 'The Veronicas And A Deliberately Overlong Credited Guest Artist',
    album: 'A Studio Album With A Title Nobody Would Choose For A Narrow Column',
    charter: 'ACharterWhoseHandleIsAlsoUnreasonablyLong',
    noteCounts: [{ instrument: 'guitar', difficulty: 'expert', count: 12345678 }],
    maxNps: [{ instrument: 'guitar', difficulty: 'expert', nps: 132.5 }],
    instruments: ['guitar']
  }
]

// One search result, so the Explore leg never leaves the machine. Shaped the way
// api.enchor.us shapes one, verified against a live response on 2026-09-16: the cover and the
// video background are reported, a still background and a lyrics track are not, which is the
// whole reason the remote ring has a denominator of three rather than five.
const REMOTE = {
  chartId: 1,
  songId: 1,
  md5: 'a'.repeat(32),
  albumArtMd5: null,
  hasVideoBackground: true,
  name: 'The Emptiness Machine',
  artist: 'Linkin Park',
  album: 'From Zero',
  genre: 'Rock',
  year: '2024',
  charter: 'SucreMondes',
  song_length: 196000,
  diff_guitar: 4,
  diff_bass: 3,
  diff_drums: 5,
  diff_keys: -1,
  diff_vocals: -1,
  modifiedTime: '2026-01-01T00:00:00.000Z',
  notesData: {
    instruments: ['guitar', 'bass', 'drums'],
    noteCounts: COUNTS,
    maxNps: NPS,
    hasSoloSections: false
  },
  folderIssues: [],
  metadataIssues: []
}
const realFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = String(typeof input === 'string' ? input : (input && input.url) || '')
  if (url.includes('api.enchor.us')) {
    return Promise.resolve(
      new Response(JSON.stringify({ found: 1, out_of: 1, page: 1, data: [REMOTE] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  }
  return realFetch(input, init)
}

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => records,
  catalogCount: () => records.length,
  issuesLast: () => [],
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  favouritesList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' })
}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      if (key === 'platform') return process.platform
      if (key.startsWith('on')) return () => () => {}
      return (...args) => Promise.resolve(answers[key] ? answers[key](...args) : undefined)
    }
  }
)
`
)
app.setPath('userData', path.join(scratch, 'userdata'))
app.commandLine.appendSwitch('disable-gpu')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evalIn = (win, code) => win.webContents.executeJavaScript(code, true)

async function waitFor(win, expression, timeoutMs = 40000) {
  const started = Date.now()
  for (;;) {
    const ok = await evalIn(
      win,
      `(() => { try { return !!(${expression}) } catch (e) { return false } })()`
    )
    if (ok) return true
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${expression}`)
    await sleep(200)
  }
}

/**
 * The panel, as layout has it.
 *
 * Every offset is measured from the rail's own content top rather than from the viewport, so
 * `fold` compares like with like: `clientHeight` is the height the column was given and a block
 * whose bottom exceeds it is a block somebody has to scroll to reach.
 */
const PANEL = `(() => {
  const round = (n) => Math.round(n)
  const rail = document.querySelector('.rail')
  if (!rail) return { railDisplay: 'absent' }
  const style = getComputedStyle(rail)
  if (style.display === 'none') return { railDisplay: 'none' }
  const top = rail.getBoundingClientRect().top - rail.scrollTop

  const block = (sel, label) => {
    const el = rail.querySelector(sel)
    if (!el) return null
    const box = el.getBoundingClientRect()
    return {
      label,
      top: round(box.top - top),
      height: round(box.height),
      bottom: round(box.bottom - top)
    }
  }
  const blocks = [
    block('.head', 'head'),
    block('.hw', 'highway'),
    block('.transport', 'transport'),
    block('.picks', 'selects'),
    block('.actions', 'actions'),
    block('.stats', 'statistics card'),
    block('.health', 'health card')
  ].filter(Boolean)

  // Everything in the column that declares an ellipsis, with the narrowest box that actually
  // ran out of room. A roomy box holding a short string reports nothing and means nothing.
  const clipped = []
  for (const el of rail.querySelectorAll('*')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    if (el.scrollWidth - el.clientWidth > 1) {
      clipped.push({
        cls: el.className.toString().split(' ')[0],
        box: round(el.clientWidth),
        says: (el.textContent || '').trim().slice(0, 44)
      })
    }
  }

  // The eight cells against the grid they are supposed to land in. Distinct left edges is the
  // column count as drawn, which is the number that gives way, not the one in the stylesheet.
  const cells = [...rail.querySelectorAll('.kv .stat')]
  const lefts = [...new Set(cells.map((c) => round(c.getBoundingClientRect().left)))]
  const stats = cells.map((c) => ({
    label: (c.querySelector('.stat-label') || {}).textContent || '',
    value: ((c.querySelector('.stat-value') || {}).textContent || '').trim(),
    // Positive means the label and the value together are wider than the cell holding them,
    // which is the eight-digit note count pushing its own label out of the card.
    overBy: round(
      (c.querySelector('.stat-label') || { scrollWidth: 0 }).scrollWidth +
        (c.querySelector('.stat-value') || { scrollWidth: 0 }).scrollWidth +
        8 -
        c.clientWidth
    )
  }))

  // The ring's stroke against the box it is drawn in. An SVG stroke straddles its path, so the
  // outer edge of the arc is r + strokeWidth / 2 from the centre and anything past 28 in a 56px
  // viewBox is flattened by the edge.
  const ringEl = rail.querySelector('.ring')
  const arc = rail.querySelector('.ring circle:nth-of-type(2)')
  const ring = ringEl
    ? {
        box: round(ringEl.getBoundingClientRect().width),
        tall: round(ringEl.getBoundingClientRect().height),
        r: arc ? Number(arc.getAttribute('r')) : null,
        stroke: arc ? Number(getComputedStyle(arc).strokeWidth.replace('px', '')) : null,
        value: (rail.querySelector('.ring-value') || { textContent: '' }).textContent.trim(),
        swept: arc
          ? Math.round(
              ((Number(arc.getAttribute('stroke-dasharray')) -
                Number(arc.getAttribute('stroke-dashoffset'))) /
                Number(arc.getAttribute('stroke-dasharray'))) *
                100
            )
          : null,
        color: arc ? getComputedStyle(arc).stroke : null
      }
    : null

  // One line each, or not. A checklist row that wrapped is what makes the health card taller
  // than its own ring for a reason nobody chose.
  const rows = [...rail.querySelectorAll('.health-row')].map((r) => {
    const label = r.querySelector('.health-label')
    const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 16
    return {
      state: r.getAttribute('data-state'),
      says: (label.textContent || '').trim(),
      height: round(r.getBoundingClientRect().height),
      lines: Math.round(label.getBoundingClientRect().height / lineHeight)
    }
  })

  const titleEl = rail.querySelector('.title')
  const actions = [...rail.querySelectorAll('.actions button')].map((b) => ({
    label: (b.textContent || '').trim(),
    width: round(b.getBoundingClientRect().width),
    height: round(b.getBoundingClientRect().height),
    clipped: b.scrollWidth > b.clientWidth + 1
  }))

  return {
    railDisplay: style.display,
    railWidth: round(rail.getBoundingClientRect().width),
    given: rail.clientHeight,
    needs: rail.scrollHeight,
    scrolls: rail.scrollHeight > rail.clientHeight + 1,
    blocks,
    titleLines: titleEl
      ? Math.round(
          titleEl.getBoundingClientRect().height /
            (parseFloat(getComputedStyle(titleEl).lineHeight) || 18)
        )
      : null,
    context: (rail.querySelector('.context') || { textContent: '' }).textContent.trim(),
    badge: (rail.querySelector('.hwt') || { textContent: '' }).textContent.trim(),
    actions,
    statColumns: lefts.length,
    statCount: cells.length,
    stats,
    ring,
    rows,
    clipped,
    sidewaysBy: rail.scrollWidth - rail.clientWidth,
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: true
    }
  })
  win.webContents.setFrameRate(30)
  await win.loadFile(path.join(here, '..', 'out', 'renderer', 'index.html'))

  // The sidebar draws a count inside the row it belongs to, so "Installed" is "Installed 4" as
  // far as textContent is concerned. Matching the word and whatever follows it is what keeps this
  // harness working when a row gains or loses a badge; an exact match timed out for 40 seconds
  // and reported it as the rail never appearing.
  const named = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}' || b.textContent.trim().startsWith('${label} '))`

  if (state === 'remote') {
    await waitFor(win, named('Explore'))
    await evalIn(win, `${named('Explore')}.click(), 1`)
    await waitFor(win, `document.querySelectorAll('.table .row, .table .card').length > 0`)
    await evalIn(win, `document.querySelector('.table .row, .table .card').click(), 1`)
  } else {
    await waitFor(win, named('Installed'))
    await evalIn(win, `${named('Installed')}.click(), 1`)
    const preview = `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').startsWith('Preview ') && (b.getAttribute('aria-label') || '').includes('${state === 'long' ? 'Untouched' : state}'))`
    await waitFor(win, preview)
    await evalIn(win, `${preview}.click(), 1`)
  }
  await waitFor(win, `document.querySelector('.rail .head')`)
  await sleep(1500)

  const p = await evalIn(win, PANEL)
  if (p.railDisplay !== 'flex') {
    console.log(
      `window ${width}x${height}  state ${state}  rail ${p.railDisplay}, nothing to measure`
    )
    app.exit(0)
    return
  }

  console.log(`window ${width}x${height}  state ${state}  rail ${p.railWidth}px`)
  console.log(
    `  column        needs ${p.needs}px of the ${p.given}px it was given, scrolls ${p.scrolls}`
  )
  console.log(`  title         ${p.titleLines} line(s), context "${p.context}", badge "${p.badge}"`)
  for (const b of p.blocks) {
    const over = b.bottom > p.given
    console.log(
      `    ${String(b.top).padStart(4)}..${String(b.bottom).padStart(4)}  ${b.label.padEnd(16)} ${String(b.height).padStart(4)}px${over ? '   BELOW THE FOLD' : ''}`
    )
  }
  console.log(
    `  actions       ${p.actions.map((a) => `${a.label} ${a.width}x${a.height}${a.clipped ? ' CLIPPED' : ''}`).join(', ')}`
  )
  console.log(`  statistics    ${p.statCount} cells in ${p.statColumns} column(s)`)
  for (const s of p.stats) {
    console.log(
      `    ${s.label.padEnd(13)} ${s.value.padStart(12)}${s.overBy > 0 ? `   OVER BY ${s.overBy}px` : ''}`
    )
  }
  if (p.ring) {
    const outer = p.ring.r + p.ring.stroke / 2
    console.log(
      `  ring          ${p.ring.value} drawn as ${p.ring.swept}% of the circle, r ${p.ring.r} + stroke ${p.ring.stroke}/2 = ${outer} in a ${p.ring.box}x${p.ring.tall} box${outer > 28 ? '   CLIPPED BY ITS VIEWBOX' : ''}`
    )
    console.log(`                stroke ${p.ring.color}`)
  } else {
    console.log('  ring          none: nothing about this chart was measured either way')
  }
  console.log('  checklist')
  for (const r of p.rows) {
    console.log(
      `    ${(r.state || '').padEnd(8)} ${r.says.padEnd(24)} ${r.height}px${r.lines > 1 ? `   WRAPS TO ${r.lines} LINES` : ''}`
    )
  }
  console.log(
    p.clipped.length === 0
      ? '  clipped       nothing'
      : `  clipped       ${p.clipped.map((c) => `.${c.cls} at ${c.box}px: "${c.says}"`).join('\n                ')}`
  )
  console.log(`  sideways      column ${p.sidewaysBy}px, document ${p.docSidewaysBy}px`)

  app.exit(0)
})
