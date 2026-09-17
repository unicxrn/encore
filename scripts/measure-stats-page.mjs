/**
 * Measure the Stats page in a real browser engine, at every width the shell supports.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-stats-page.mjs
 *     SIZE=1121x800 node_modules/electron/dist/electron scripts/measure-stats-page.mjs
 *
 * A sibling of `scripts/measure-play-stats.mjs` rather than more of it. That script measures the
 * app shell, the sidebar, Home, the rail and Installed as well, and this one has a single
 * subject and a set of widths to sweep it at; bolting a sweep onto a script that opens four
 * other screens would make every run of it four times as long for the other four's benefit.
 *
 * jsdom answers none of the questions below, because it applies no CSS and computes no layout.
 * The component test beside Stats.svelte pins which SENTENCE the page says in which state. What
 * cannot be pinned there, and is pinned here:
 *
 * 1. Does the lead block hold its figures without ellipsising the source tag beside each label?
 *    A label plus a nowrap tag plus a display-size number is three things in one narrow track,
 *    and the tag carries a date, which is the widest thing in it.
 * 2. Is every figure on the page drawn exactly once? The lead PROMOTES two figures out of the
 *    blocks below rather than copying them, and a promotion that failed to remove would put the
 *    same number under two headings with two different source tags.
 * 3. Do the reach bars draw their true share? They are the one place on this page where a bar
 *    has a denominator in the thousands, so a minimum-width stub would be most of the bar. The
 *    fill's painted width over its track's is compared against the count over the total.
 * 4. Does a count larger than its own denominator stay inside the track while its NUMBER stays
 *    whole? That is the shape of the long tail here: the frame clips, the figure never does.
 * 5. Does the charter row leave its name a readable box? At the 1121px window, where the rail
 *    appears and the content column is at its narrowest, the four-column row left the name 34px
 *    before this step.
 * 6. How tall is the page? The complaint the redesign answers is that it was a scroll, and a
 *    scroll is a measurement.
 * 7. Does anything scroll sideways, or overflow a tile?
 *
 * NOPLAYS=1 is a library with charts and no play of either kind, which is the state of every
 * user on the day they install Encore. OVERFLOW=1 is the awkward-data run: a lifetime count
 * larger than the charts Encore can match, an instrument name the app has never heard of, and a
 * difficulty key outside the four the game usually writes.
 *
 * Touches nothing real: the preload written below answers every call from memory, from a
 * throwaway user-data directory, with no network and no catalogue.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { clickNav, evalIn, exitOnFailure, sleep, waitFor } from './harness-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Every width the shell supports, and the two either side of its one breakpoint.
 *
 * 960 is the window's own minimum (main/index.ts). 1120 is the last width at which the rail is
 * hidden and 1121 the first at which it is not, which is where the content column is NARROWEST
 * on the whole range: 1121 less a 238px sidebar less a 374px rail is 509px, against 882px one
 * pixel earlier. A page measured only at round numbers never meets it.
 */
const WIDTHS = (process.env.WIDTHS || '960,1120,1121,1280,1440,1920').split(',').map(Number)

const lifetimeOn = process.env.LIFETIME !== '0'
const logOn = process.env.EMPTYLOG !== '1'
/** Neither record has anything, which is the ordinary state rather than a failure. */
const noPlays = process.env.NOPLAYS === '1'
/** Data that does not fit the frame the page draws it in. */
const awkward = process.env.OVERFLOW === '1'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-statspage-'))
const preloadPath = path.join(scratch, 'preload.cjs')

fs.writeFileSync(
  preloadPath,
  `const settings = {
  libraryFolders: ['/nonexistent'],
  downloadFormat: 'sng',
  downloadConcurrency: 3,
  downloadVideos: false,
  chartFolderName: '{artist} - {name} ({charter})',
  previewVolume: 50,
  tourSeen: true,
  lastSeenVersion: '9.9.9'
}
const lifetimeOn = ${lifetimeOn}
const logOn = ${logOn}
const noPlays = ${noPlays}
const awkward = ${awkward}

/**
 * The owner's real figures: 101 charts in Clone Hero's table, 144 lifetime plays, 21 of them
 * carrying a row nobody has decoded, best 665,629, against a library of 4,210 charts.
 */
const totals = {
  charts: 101,
  lifetimePlays: 144,
  // Larger than \`identified\` under OVERFLOW, which is a count that does not fit its own frame.
  chartsInLibrary: awkward ? 5200 : 84,
  chartsNotInLibrary: 17,
  chartsWithUnconfirmedRows: 21,
  bestScore: 665629,
  observedPlays: 15,
  observedCharts: 9
}
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => [],
  catalogCount: () => 0,
  catalogFacets: () => ({ artists: [], genres: [], charters: [], years: [] }),
  existsByMeta: () => [],
  downloadList: () => [],
  favouritesList: () => [],
  setlistsList: () => [],
  updatesLast: () => [],
  appUpdateStatus: () => ({
    currentVersion: '0.3.1',
    target: 'appimage',
    canApply: true,
    note: 'This AppImage can update itself.',
    state: { kind: 'current' }
  }),
  playStatus: () => ({
    available: logOn && !noPlays,
    reason: 'ok',
    path: '/home/player/.clonehero/scorestats.json',
    playCount: logOn && !noPlays ? 412 : 0
  }),
  playSummaries: () => [],
  playInsights: () => ({
    days: Array.from({ length: 60 }, (_, i) => ({
      day: new Date(Date.now() - (119 - i * 2) * 86400000).toISOString().slice(0, 10),
      plays: 1 + ((i * 7) % 9)
    })),
    coverage: { inLibrary: 4210, identified: 4000, withPlay: 177, playsOffLibrary: 6 },
    topCharters: Array.from({ length: 12 }, (_, i) => ({
      charter: i === 0 ? 'A charter with a deliberately long name that has to ellipsise' : 'Charter ' + i,
      owned: 40 - i,
      played: 12 - i,
      plays: 31 - i * 2
    })),
    recent: Array.from({ length: 8 }, (_, i) => ({
      checksum: String(i).repeat(32).slice(0, 32),
      playedAt: new Date(Date.now() - i * 3600000).toISOString(),
      songName: i === 0 ? 'A song with a deliberately long title that has to ellipsise' : 'Chart ' + i,
      artistName: 'Rush',
      charterName: 'someone',
      instrument: 'Guitar',
      difficulty: 'Expert',
      score: 1234567 - i * 1000,
      accuracy: 0.9812,
      isFc: i % 3 === 0,
      isPfc: i === 0
    }))
  }),
  playLifetime: () => ({
    status: {
      available: lifetimeOn && !noPlays,
      reason: lifetimeOn && !noPlays ? 'ok' : 'noFile',
      scoreDataPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoredata.bin',
      scoresExtPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoresext.bin',
      lastImportAt: lifetimeOn && !noPlays ? '2026-09-12T10:00:00.000Z' : null,
      usedBackup: false,
      pairRefused: false,
      folderSource: 'probe'
    },
    totals,
    charts: []
  }),
  playStats: () => ({
    totalPlays: 412,
    chartsPlayed: 177,
    fcCount: 58,
    pfcCount: 4,
    notesHit: 1043998,
    totalNotes: 1102771,
    bestScore: 1234567,
    longestStreak: 2048,
    firstPlayedAt: '2026-03-03T18:04:11.1234567Z',
    lastPlayedAt: '2026-09-01T20:00:00.0000000Z',
    // Under OVERFLOW these carry names the app has never met: an instrument key that maps to no
    // colour and a difficulty outside the four the game usually writes.
    byInstrument: awkward
      ? [
          { key: 'Guitar', plays: 300 },
          { key: 'Drums', plays: 80 },
          { key: 'Bass', plays: 20 },
          { key: 'Pro Drums (Real)', plays: 12 }
        ]
      : [
          { key: 'Guitar', plays: 300 },
          { key: 'Drums', plays: 80 },
          { key: 'Bass', plays: 32 }
        ],
    byDifficulty: awkward
      ? [
          { key: 'Expert', plays: 400 },
          { key: 'Expert+', plays: 12 }
        ]
      : [
          { key: 'Expert', plays: 380 },
          { key: 'Hard', plays: 32 }
        ],
    topCharts: Array.from({ length: 10 }, (_, i) => ({
      checksum: String(i).repeat(32).slice(0, 32),
      songName: i === 0 ? 'A song with a deliberately long title that has to ellipsise' : 'Chart ' + i,
      artistName: 'Rush',
      charterName: 'someone',
      timesPlayed: 137 - i * 12,
      bestScore: 1234567 - i * 1000
    }))
  })
}
window.encore = new Proxy(
  {},
  {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      if (key.startsWith('on')) return () => () => {}
      return (...args) => Promise.resolve(answers[key] ? answers[key](...args) : undefined)
    }
  }
)
`
)

app.setPath('userData', path.join(scratch, 'userdata'))
app.commandLine.appendSwitch('disable-gpu')

exitOnFailure('measure-stats-page')

const PAGE = `(() => {
  const round = (n) => Math.round(n)
  const box = (el) => el.getBoundingClientRect()
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null)
  // A Range over the element's own contents measures the text and nothing else, which is the
  // number that decides whether an ellipsis appears. scrollWidth against clientWidth answers
  // wrongly on a padded inline box: see the sidebar block in measure-play-stats.mjs.
  const textWidth = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getBoundingClientRect().width
  }
  const clipped = (el) => textWidth(el) > el.clientWidth + 1
  const page = document.querySelector('.stats')
  const view = document.querySelector('main.view')
  const lead = document.querySelector('.standing')
  const tiles = [...document.querySelectorAll('.tile')]
  const leadTiles = [...document.querySelectorAll('.tile.big')]
  const sections = [...document.querySelectorAll('.stats section')]
  const panes = [...document.querySelectorAll('.stats > .columns > section')]
  const charters = [...document.querySelectorAll('.ch-row')]
  const caveat = document.querySelector('.caveat')
  const figures = [...document.querySelectorAll('.tile, .chart, .top, .charters')]
  const lowestFigureTop = figures.length ? Math.min(...figures.map((f) => round(box(f).top))) : null

  // Every figure's label, so a promotion that failed to remove shows up as a repeat rather than
  // as a number a reader has to spot twice.
  const labels = tiles.map((t) => text(t.querySelector('.t-label')))
  const labelsWithoutTag = labels.map((l) => (l ?? '').replace(/(ALL TIME|SINCE .*|BOTH RECORDS)$/, '').trim())
  const repeated = labelsWithoutTag.filter((l, i) => labelsWithoutTag.indexOf(l) !== i)

  // The reach bars. A fill's painted share of its track against the share the numbers state:
  // the two agree, or the bar is not drawing the data.
  const reach = document.querySelector('.tile.reach')
  const reachRows = reach
    ? [...reach.querySelectorAll('.r-row')].map((row) => {
        const track = row.querySelector('.r-track')
        const fill = row.querySelector('.r-fill')
        const countEl = row.querySelector('.r-count')
        return {
          key: text(row.querySelector('.r-key')),
          count: text(countEl),
          countClipped: clipped(countEl),
          trackWidth: round(box(track).width),
          fillWidth: Number(box(fill).width.toFixed(2)),
          paintedShare: Number((box(fill).width / box(track).width).toFixed(5)),
          // A fill wider than its track is data past the frame. The track hides its overflow, so
          // the bar stops at the end and the number beside it is still the real one.
          fillPastTrack: round(box(fill).right) > round(box(track).right)
        }
      })
    : null

  return {
    viewWidth: view ? round(box(view).width) : null,
    pageWidth: page ? round(box(page).width) : null,
    // The complaint the lead block answers. Reported in pixels and in viewports.
    pageHeight: page ? round(page.scrollHeight) : null,
    viewportsOfScroll: page && view ? Number((page.scrollHeight / box(view).height).toFixed(2)) : null,
    sections: sections.length,
    sectionsTagged: sections.filter((el) => el.querySelector('.src')).length,
    leadPresent: lead !== null,
    leadWidth: lead ? round(box(lead).width) : null,
    leadHeight: lead ? round(box(lead).height) : null,
    // The lead must be the first thing under the caveat and above every other figure.
    leadTop: lead ? round(box(lead).top) : null,
    caveatClearsFiguresBy:
      caveat && lowestFigureTop !== null ? lowestFigureTop - round(box(caveat).bottom) : null,
    leadFigures: leadTiles.map((t) => {
      const label = t.querySelector('.t-label')
      const tag = t.querySelector('.src')
      const value = t.querySelector('.t-value')
      return {
        label: text(label),
        value: text(value),
        width: round(box(t).width),
        height: round(box(t).height),
        // The tag is nowrap and carries a date, so this is the first thing to give way.
        tagText: text(tag),
        tagWidth: tag ? round(box(tag).width) : null,
        tagInsideTile: tag ? round(box(tag).right) <= round(box(t).right) : null,
        labelWrapped: label ? round(box(label).height) > 20 : null,
        valueClipped: value ? clipped(value) : null,
        overflows: t.scrollWidth > t.clientWidth + 1
      }
    }),
    reachRows,
    reachNote: reach ? text(reach.querySelector('.t-note')) : null,
    tiles: tiles.length,
    tileRows: [...new Set(tiles.map((t) => round(box(t).top)))].length,
    tilesOverflowing: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
    repeatedFigureLabels: repeated,
    // The instrument bars, which take the instrument's own colour so this page and the
    // difficulty pips agree about what a guitar looks like.
    instrumentBars: [...document.querySelectorAll('.breakdown')]
      .filter((b) => text(b.querySelector('h3')) === 'Instrument')
      .flatMap((b) =>
        [...b.querySelectorAll('.bd-row')].map((row) => ({
          key: text(row.querySelector('.bd-key')),
          keyClipped: clipped(row.querySelector('.bd-key')),
          color: getComputedStyle(row.querySelector('.bd-fill')).backgroundColor,
          width: Number(box(row.querySelector('.bd-fill')).width.toFixed(2)),
          trackWidth: round(box(row.querySelector('.bd-track')).width)
        }))
      ),
    difficultyBars: [...document.querySelectorAll('.breakdown')]
      .filter((b) => text(b.querySelector('h3')) === 'Difficulty')
      .flatMap((b) =>
        [...b.querySelectorAll('.bd-row')].map((row) => ({
          key: text(row.querySelector('.bd-key')),
          keyClipped: clipped(row.querySelector('.bd-key')),
          color: getComputedStyle(row.querySelector('.bd-fill')).backgroundColor
        }))
      ),
    charterRows: charters.length,
    meterShown: charters.length
      ? getComputedStyle(charters[0].querySelector('.bd-track')).display !== 'none'
      : null,
    narrowestCharterName: charters.length
      ? Math.min(...charters.map((r) => round(box(r.querySelector('.name')).width)))
      : null,
    charterNamesClipped: charters.filter((r) => clipped(r.querySelector('.name'))).length,
    narrowestSongName: (() => {
      const names = [...document.querySelectorAll('.top-row .name, .recent-row .name')]
      return names.length ? Math.min(...names.map((n) => round(box(n).width))) : null
    })(),
    listsSideBySide: panes.length === 2 && round(box(panes[0]).top) === round(box(panes[1]).top),
    pageScrollsSideways: page ? page.scrollWidth > page.clientWidth + 1 : null,
    // Anything at all sticking out past the page's own right edge.
    childrenPastRightEdge: page
      ? [...page.querySelectorAll('*')].filter((el) => round(box(el).right) > round(box(page).right) + 1).length
      : null
  }
})()`

/** The page with nothing to draw, which is the state a fresh install opens in. */
const EMPTY = `(() => {
  const page = document.querySelector('.stats')
  return {
    text: (page?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    tiles: document.querySelectorAll('.tile').length,
    sections: document.querySelectorAll('.stats section').length,
    lead: document.querySelectorAll('.standing').length,
    chart: document.querySelectorAll('.chart').length,
    scrollsSideways: page ? page.scrollWidth > page.clientWidth + 1 : null
  }
})()`

/**
 * One window, resized between reads, rather than one window per width.
 *
 * Both of the things that change with width here answer to the live box: the shell's rail is a
 * media query and the page's two-column rules are container queries, so a resize re-runs them.
 * A window per width also failed in practice: tearing down an offscreen window while the next
 * one starts loading makes the next `loadFile` reject with ERR_FAILED.
 */
const height = Number(process.env.HEIGHT || 800)

app.whenReady().then(async () => {
  console.log(
    `lifetime ${lifetimeOn ? 'on' : 'off'}, log ${logOn ? 'on' : 'off'}` +
      `${noPlays ? ', NO PLAYS' : ''}${awkward ? ', AWKWARD DATA' : ''}`
  )
  const win = new BrowserWindow({
    width: Math.max(...WIDTHS),
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
  await waitFor(win, `document.querySelector('.home')`, { what: 'Home' })
  // The row is called Statistics. It was called Stats, and this waited forty seconds for that.
  await clickNav(win, 'Statistics')
  await waitFor(
    win,
    `document.querySelector('.stats') && !/LOADING/.test(document.querySelector('.stats').textContent)`,
    { what: 'the Stats page with its figures in' }
  )

  const probe = noPlays ? EMPTY : PAGE
  for (const width of WIDTHS) {
    win.setContentSize(width, height)
    await waitFor(win, `window.innerWidth === ${width}`, { what: `a ${width}px viewport` })
    await sleep(400)
    console.log(`\n=== ${width}px ===`)
    console.log(JSON.stringify(await evalIn(win, probe), null, 1))
  }
  app.exit(0)
})
