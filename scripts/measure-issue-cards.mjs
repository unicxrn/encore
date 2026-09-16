/**
 * Measure the Issues view's health cards and its rows in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-issue-cards.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-issue-cards.mjs
 *     PLATFORM=win32 node_modules/electron/dist/electron scripts/measure-issue-cards.mjs
 *     DUPES=open node_modules/electron/dist/electron scripts/measure-issue-cards.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so every
 * card is zero pixels tall, nothing ellipsises and nothing can overflow. This runs the built
 * renderer in an offscreen window, which is never shown on any desktop but keeps producing frames,
 * and reads the geometry back out. Earlier steps found a title box at 0px and labels ellipsised at
 * 71px this way, and neither was visible to a test.
 *
 * The five questions, and why each one is here rather than in a test:
 *
 *   cards      Every card a readable box. Three across the strip at a wide window and one at a
 *              narrow one, with the count, the title and the sentence all inside it.
 *   clipped    Text cut off by its own box. `scrollWidth > clientWidth` on an element that
 *              declares `text-overflow: ellipsis` is what an ellipsis actually is.
 *   headroom   **The question this view is most likely to fail.** The cards sit above the rows in
 *              one scroller, so a strip that grew would push the list off the bottom of a default
 *              1280x800 window and leave a screen of summary with nothing under it. What is
 *              printed is where the first chart lands and how many are on screen with it.
 *   sticky     The category chips holding the top of the scroller once the cards scroll past. They
 *              are the control for the rows, so they travel with the rows.
 *   sideways   The body scrolling horizontally, which is what a grid track with an automatic
 *              minimum does to a card holding a long word.
 *
 * The widths worth passing are the ones the shell supports. The window minimum is 960px and the
 * preview rail is 374px wide and appears above 1120px, so the view column is 722px at a 960px
 * window, 882px at 1120px, and then drops to 509px at 1121px when the rail takes its share back.
 * 1121 is the narrowest this view is ever asked to be, and it is not the smallest window.
 *
 * `PLATFORM` matters because one card only exists off Linux: `badVideo` is breakage there and a
 * portability note everywhere else, so Linux draws two state cards and Windows draws three. The
 * strip has to hold both.
 *
 * What it touches: nothing. No network, no catalogue, no library, no settings. The preload written
 * below answers every call from memory, including the issue report itself, so the shape measured
 * is chosen here rather than read off whatever library the machine happens to have.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
const platform = process.env.PLATFORM || process.platform
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-measure-'))
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

// A report shaped like the reference library's, scaled down: a handful of blocking rows, a great
// many charting notes, and the four repairable codes among them. The long paths and the long
// chart names are the point of the fixture; a report of "chart 1" would never truncate anything.
const LONG = '/library/An Artist With A Reasonably Long Name - A Very Long Chart Title Indeed'
const rows = []
for (let i = 0; i < 14; i++) {
  rows.push({
    chartPath: LONG + ' (' + i + ')',
    kind: 'folder',
    code: i % 2 === 0 ? 'noAudio' : 'noAlbumArt',
    description: i % 2 === 0 ? 'No audio files were found.' : 'There is no album art.'
  })
}
rows.push({
  chartPath: LONG + ' (0)',
  kind: 'chart',
  code: 'multipleChart',
  description: 'This chart has both notes.mid and notes.chart.'
})
for (let i = 0; i < 40; i++) {
  rows.push({
    chartPath: LONG + ' (' + (i % 12) + ')',
    kind: 'chart',
    code: 'badSustainGap',
    description:
      '[instrument: guitar, difficulty: expert] The note at 1:23.450 is too close to the end of the previous sustain.'
  })
}
for (let i = 0; i < 9; i++) {
  rows.push({
    chartPath: LONG + ' (' + i + ')',
    kind: 'folder',
    code: 'albumArtSize',
    description: 'The album art is 1024x1024 instead of 512x512.'
  })
}
for (let i = 0; i < 5; i++) {
  rows.push({
    chartPath: LONG + ' (' + i + ')',
    kind: 'metadata',
    code: 'extraValue',
    description: 'Metadata contains "diff_bass", but bass is not charted.'
  })
}
for (let i = 0; i < 6; i++) {
  rows.push({
    chartPath: LONG + ' (' + i + ')',
    kind: 'metadata',
    code: 'missingValue',
    description: 'Metadata is missing a "diff_drums" value.'
  })
}
// The one whose card only exists off Linux.
for (let i = 0; i < 3; i++) {
  rows.push({
    chartPath: LONG + ' (' + i + ')',
    kind: 'folder',
    code: 'badVideo',
    description: '"video.mp4" will not work on Linux and should be converted to .webm.'
  })
}
rows.push({
  chartPath: LONG + ' (2)',
  kind: 'folder',
  code: 'invalidIni',
  description: '"desktop.ini" is not named "song.ini".'
})

const dupeCopy = (p, extra) =>
  Object.assign(
    {
      path: p,
      chartType: p.endsWith('.sng') ? 'sng' : 'folder',
      name: 'A Very Long Chart Title Indeed',
      artist: 'An Artist With A Reasonably Long Name',
      charter: 'SomeCharterName',
      album: null,
      songLength: 250000,
      modifiedTime: 1,
      cloneHeroChecksum: 'a'.repeat(32),
      hasAlbumArt: true,
      hasVideo: false,
      hasBackground: false,
      hasLyrics: false,
      sizeBytes: 42000000
    },
    extra || {}
  )

const duplicates = {
  identical: Array.from({ length: 3 }, (_, i) => ({
    checksum: String(i).padStart(32, '0'),
    copies: [
      dupeCopy(LONG + ' (dup ' + i + ')'),
      dupeCopy(LONG + ' (dup ' + i + ') copy.sng', { hasVideo: true })
    ]
  })),
  versions: [
    {
      artist: 'An Artist With A Reasonably Long Name',
      name: 'A Very Long Chart Title Indeed',
      charter: 'SomeCharterName',
      copies: [dupeCopy(LONG + ' v1'), dupeCopy(LONG + ' v2', { cloneHeroChecksum: 'b'.repeat(32) })],
      versionCount: 2,
      unknownCount: 0,
      identicalCopies: 0
    }
  ],
  alternates: [
    {
      artist: 'An Artist With A Reasonably Long Name',
      name: 'A Very Long Chart Title Indeed',
      charters: [
        { charter: 'SomeCharterName', copies: [dupeCopy(LONG + ' (a)')] },
        { charter: 'AnotherCharterEntirely', copies: [dupeCopy(LONG + ' (b).sng', { charter: 'AnotherCharterEntirely' })] }
      ]
    }
  ],
  totalCharts: 219,
  unidentifiedCharts: 4
}

const ONE_BACKUP = [
  {
    id: 'b1',
    chartPath: LONG + ' (0)',
    describe: 'Put back the album art this fix replaced',
    sizeBytes: 1200000,
    createdAt: 1
  }
]

const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => 219,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  catalogDuplicates: () => duplicates,
  issuesLast: () => rows,
  issuesScan: () => rows,
  issuesFixable: () => [
    { code: 'badVideo', available: true, reason: null },
    { code: 'extraValue', available: true, reason: null },
    { code: 'albumArtSize', available: true, reason: null },
    { code: 'invalidIni', available: true, reason: null }
  ],
  // One entry, so the undo card is drawn and counted in the headroom below. UNDO=none takes it
  // away, which is the state of a library nobody has repaired yet and the common case.
  backupsList: () => ({
    backups: ${process.env.UNDO === 'none' ? '[]' : 'ONE_BACKUP'},
    totalBytes: 1200000
  }),
  saveTextFile: () => null,
  playSummaries: () => [],
  playLifetime: () => ({ available: false, reason: 'noFile', entries: [] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  favouritesList: () => [],
  setlistsList: () => [],
  playStatus: () => ({ available: false, reason: 'noFile', path: null, playCount: 0 }),
  appUpdateStatus: () => ({ state: 'idle' })
}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      // A value rather than a call: the view reads this one synchronously to decide whether a
      // badVideo row is breakage here or a note about somewhere else, which is the whole of why
      // the strip holds two cards on one platform and three on another.
      if (key === 'platform') return ${JSON.stringify(platform)}
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
 * What the view is, as layout has it.
 *
 * `clipped` counts only elements that declare an ellipsis, because an element that wraps is not
 * clipped by being taller than one line, and one with `overflow: hidden` and no ellipsis has made
 * its own decision. The 1px tolerance is for subpixel text metrics: a box 140.4px wide holding
 * 140.9px of text is not a truncation anybody can see.
 */
const SHAPE = `(() => {
  const round = (n) => Math.round(n)
  const body = document.querySelector('.tools .body')
  const cards = document.querySelector('.tools .cards')
  const strip = document.querySelector('.tools .strip')
  const filters = document.querySelector('.tools .filters')
  const groups = [...document.querySelectorAll('.tools .chart-group')]
  const bodyBox = body.getBoundingClientRect()

  const boxOf = (el) => {
    const b = el.getBoundingClientRect()
    return { w: round(b.width), h: round(b.height) }
  }

  // Every card on screen, named by the heading inside it, so a card that lost its box shows up
  // as a name with a zero beside it rather than as an absence nobody notices.
  const cardBoxes = [...document.querySelectorAll('.tools .card, .tools .dupes')].map((el) => {
    const title = el.querySelector('.s-title, .fx-title, .d-title')
    // What the card's height is made of, so a card that is taller than it looks says which of
    // its own lines did it rather than leaving the reader to guess at padding.
    const parts = [...el.children].map((c) => {
      const cls = c.className.toString().split(' ')[0] || c.tagName.toLowerCase()
      return cls + ' ' + round(c.getBoundingClientRect().height)
    })
    return Object.assign(
      { name: title ? (title.textContent || '').trim().slice(0, 34) : '(untitled)', parts },
      boxOf(el)
    )
  })

  // How many columns the strip resolved to, read off the cards' own left edges rather than off
  // the media query, since auto-fit is what decides it.
  const stripCols = strip
    ? new Set([...strip.children].map((c) => round(c.getBoundingClientRect().left))).size
    : 0

  // Grouped by class, with the narrowest box any of them got. An ellipsis on a 90-character path
  // in a 580px box is the feature working; the same ellipsis on a two-word label in a 147px box is
  // the defect, and only the box width and the class separate the two.
  const byClass = {}
  for (const el of document.querySelectorAll('.tools .cards *, .tools .results *')) {
    if (getComputedStyle(el).textOverflow !== 'ellipsis') continue
    const cls = el.className.toString().split(' ')[0]
    const seen = byClass[cls] || (byClass[cls] = { cls, of: 0, clipped: 0, narrowest: Infinity, says: '' })
    seen.of++
    if (el.scrollWidth - el.clientWidth > 1) {
      seen.clipped++
      if (el.clientWidth < seen.narrowest) {
        seen.narrowest = el.clientWidth
        seen.says = (el.textContent || '').trim().slice(0, 30)
      }
    }
  }
  const clipped = Object.values(byClass).filter((c) => c.clipped > 0)

  // Anything wider than the column it sits in, ellipsis or not. A card whose sentence forces the
  // grid track wider is how this view would scroll sideways, and it would do it silently.
  const wider = [...document.querySelectorAll('.tools .cards *')]
    .filter((el) => el.scrollWidth - el.clientWidth > 1 && getComputedStyle(el).overflowX === 'visible')
    .map((el) => el.className.toString().split(' ')[0])

  return {
    viewWidth: round(document.querySelector('.tools').getBoundingClientRect().width),
    bodyHeight: round(bodyBox.height),
    cardsHeight: cards ? round(cards.getBoundingClientRect().height) : 0,
    stripCols,
    cards: cardBoxes,
    clipped,
    wider: [...new Set(wider)],
    // The headroom question: where the first chart lands inside the scroller, and how many are
    // on screen with it before anybody scrolls.
    firstRowTop: groups.length ? round(groups[0].getBoundingClientRect().top - bodyBox.top) : null,
    rowsOnScreen: groups.filter((g) => g.getBoundingClientRect().top < bodyBox.bottom).length,
    rowsInAll: groups.length,
    groupHeights: [...new Set(groups.map((g) => round(g.getBoundingClientRect().height)))].slice(0, 6),
    filtersTop: filters ? round(filters.getBoundingClientRect().top - bodyBox.top) : null,
    bodyScrolls: body.scrollHeight > body.clientHeight,
    sidewaysBy: body.scrollWidth - body.clientWidth,
    docSidewaysBy: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }
})()`

/** Where the chips end up once the cards above them have been scrolled past. */
const STUCK = `(() => {
  const body = document.querySelector('.tools .body')
  const filters = document.querySelector('.tools .filters')
  body.scrollTop = body.scrollHeight
  return new Promise((resolve) =>
    requestAnimationFrame(() =>
      resolve({
        scrolled: Math.round(body.scrollTop),
        filtersTop: Math.round(
          filters.getBoundingClientRect().top - body.getBoundingClientRect().top
        ),
        chipsVisible: filters.getBoundingClientRect().bottom > body.getBoundingClientRect().top
      })
    )
  )
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

  const named = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`

  await waitFor(win, named('Issues'))
  await evalIn(win, `${named('Issues')}.click(), 1`)
  await waitFor(win, `document.querySelector('.tools .chart-group')`)
  // The cards need the report, `issues:fixable` and the backup list, which arrive separately.
  await waitFor(win, `document.querySelectorAll('.tools .card').length >= 3`)
  if (process.env.DUPES === 'open') {
    await waitFor(win, named('Show'))
    await evalIn(win, `${named('Show')}.click(), 1`)
  }
  await sleep(800)

  const shape = await evalIn(win, SHAPE)
  const dupes = process.env.DUPES === 'open' ? ' duplicates open' : ''
  console.log(`window ${width}x${height}  view ${shape.viewWidth}px  platform ${platform}${dupes}`)
  console.log(
    `  cards         ${shape.cardsHeight}px of ${shape.bodyHeight}px body, strip in ${shape.stripCols} column${shape.stripCols === 1 ? '' : 's'}`
  )
  for (const card of shape.cards) {
    console.log(`    ${card.w}x${card.h}  ${card.name}  [${card.parts.join(', ')}]`)
  }
  console.log(
    `  headroom      first chart at ${shape.firstRowTop}px, ${shape.rowsOnScreen} of ${shape.rowsInAll} on screen, heights ${JSON.stringify(shape.groupHeights)}`
  )
  console.log(`  sideways      body ${shape.sidewaysBy}px, document ${shape.docSidewaysBy}px`)
  console.log(
    shape.clipped.length === 0
      ? '  ellipsised    nothing'
      : `  ellipsised    ${shape.clipped.map((c) => `.${c.cls} ${c.clipped}/${c.of}, tightest ${c.narrowest}px: "${c.says}"`).join('; ')}`
  )
  if (shape.wider.length > 0) {
    console.log(`  overflowing   ${shape.wider.map((c) => '.' + c).join(', ')}`)
  }

  const stuck = await evalIn(win, STUCK)
  console.log(
    `  sticky        scrolled ${stuck.scrolled}px, chips at ${stuck.filtersTop}px from the top of the scroller, visible ${stuck.chipsVisible}`
  )

  app.exit(0)
})
