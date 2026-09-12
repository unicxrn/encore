/**
 * Measure the Stats page and Installed's play badge in a real browser engine, without a window.
 *
 *     npm run build
 *     node_modules/electron/dist/electron scripts/measure-play-stats.mjs
 *     SIZE=1280x800 node_modules/electron/dist/electron scripts/measure-play-stats.mjs
 *
 * The jsdom tests cannot answer any of this: they apply no CSS and compute no layout, so the tile
 * grid has no columns, the activity bars have no height, the caveat has no position on a page and
 * a badged row has no height to compare against an unbadged one. This runs the built renderer in
 * an offscreen window, which is never shown on any desktop, and reads the boxes back out. Same
 * technique, and same reasons, as measure-explore-append.mjs.
 *
 * Nine questions, all of which jsdom answers wrongly by answering zero:
 *
 * 1. Does the caveat sit above every figure in LAYOUT, not just in the DOM? DOM order is what the
 *    component test pins; a float or a grid could still paint it under the tiles.
 * 2. Do five tiles fit the width, and how do they wrap when they do not?
 * 3. Do the activity bars have height in proportion to their counts, and does the busiest one
 *    reach the top of the chart box?
 * 4. Do the two lists sit side by side at a normal window and stack under a narrow one? That is a
 *    container query, which answers about the pane rather than the window.
 * 5. Is Home free of the panel that used to sit under its hero, and does it still not scroll
 *    sideways without it?
 * 6. Does a row that gained a play badge stay exactly as tall as one that did not? The badge is
 *    inside the title line, and a badge that grows the line grows every row in the list.
 * 7. Does every section heading's source tag stay on the heading's own line, inside the section's
 *    box, and whole? The tag is how the page says which record a block came from, and a tag that
 *    is clipped or broken across two lines by a narrow pane says it badly or not at all. The date
 *    it carries is the widest thing in it, so this is a real risk and not a theoretical one.
 * 8. Do the lifetime tiles and the observed tiles read as two blocks rather than one run of eight?
 *    They are separate sections in the DOM, which jsdom can see, but whether the reader sees two
 *    groups is a question about painted boxes.
 * 9. Does a row badged from Clone Hero's table stay exactly as tall as one badged from Encore's
 *    log and one with no badge at all? A lifetime count has more digits, and the badge lives
 *    inside the title line.
 *
 * LIFETIME=0 answers the lifetime channel as unavailable, which is the state most users are in
 * and the one where the page must fall back to a single source and drop its tags. EMPTYLOG=1 is
 * the other way round: a full score table and nothing Encore has watched.
 *
 * Touches nothing real: the preload written below answers every call from memory, from a
 * throwaway user-data directory, with no network and no catalogue.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const [width, height] = (process.env.SIZE || '1280x800').split('x').map(Number)
/**
 * How many days of history the fake bridge answers with, so the chart can be measured at each
 * block length it chooses: 120 days is a bar per week, 40 is a bar per day, 2000 is longer.
 */
const spanDays = Number(process.env.SPAN || 120)
/** Whether Clone Hero's own score files answer at all. Off is the ordinary state for most users. */
const lifetimeOn = process.env.LIFETIME !== '0'
/**
 * EMPTYLOG=1 empties Encore's own log while leaving the score files full, which is the state of
 * every user who installs Encore today having played Clone Hero for years. Half the page has no
 * source, and what is left has to look like a page rather than a gap.
 */
const logOn = process.env.EMPTYLOG !== '1'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'encore-playstats-'))
const preloadPath = path.join(scratch, 'preload.cjs')

/** Four installed charts, two of which have a play on record. */
const CHECKSUMS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)]

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
const checksums = ${JSON.stringify(CHECKSUMS)}
const lifetimeOn = ${lifetimeOn}
const logOn = ${logOn}
/**
 * Clone Hero's own table, using the owner's real totals: 101 charts, 144 lifetime plays, 21 of
 * them carrying a row nobody has decoded, best 665,629.
 *
 * Per chart it covers three of the four rows on Installed, one each of the states a row can be
 * in: chart 0 has a lifetime count AND plays Encore watched, chart 1 has a lifetime count and an
 * unreadable score with nothing Encore saw, chart 2 has only what Encore saw, and chart 3 has
 * nothing at all. Four rows, four badge states, one list to measure them against each other in.
 */
const lifetimeCharts = [
  { checksum: checksums[0], lifetimePlays: 412, observedPlays: 137, everPlayed: true,
    best: { variant: 2, difficulty: 3, difficultyName: 'Expert', percent: 98, stars: 5,
      isFullCombo: false, playbackSpeed: 100, score: 665629, scoreWithoutCleanPlayBonus: 664629 },
    unconfirmedRows: 0 },
  { checksum: checksums[1], lifetimePlays: 1337, observedPlays: 0, everPlayed: true,
    best: null, unconfirmedRows: 1 }
]
const charts = checksums.map((sum, i) => ({
  path: '/library/Rush - Chart ' + i,
  name: 'Chart ' + i,
  artist: 'Rush',
  album: 'Moving Pictures',
  genre: 'Rock',
  charter: 'someone',
  year: 1981,
  songLength: 273000,
  chartType: 'folder',
  folderHash: 'chart-' + i,
  modifiedTime: 0,
  cloneHeroChecksum: sum,
  instruments: ['guitar', 'bass', 'drums'],
  diffGuitar: 4,
  diffBass: 3,
  diffDrums: 5,
  albumArtMd5: null
}))
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => charts,
  catalogCount: () => charts.length,
  catalogFacets: () => ({ artists: ['Rush'], genres: ['Rock'], charters: ['someone'], years: [1981] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  downloadList: () => [],
  updatesLast: () => [],
  appUpdateStatus: () => ({ state: 'idle' }),
  playStatus: () => ({
    available: logOn,
    reason: 'ok',
    path: '/home/player/.clonehero/scorestats.json',
    playCount: logOn ? 412 : 0
  }),
  playSummaries: (list) =>
    (logOn ? list || [] : [])
      .filter((sum) => sum === checksums[0] || sum === checksums[2])
      .map((sum, i) => ({
        checksum: sum,
        timesPlayed: i === 0 ? 137 : 1,
        bestScore: 1234567,
        bestStars: 5,
        bestAccuracy: 0.9812,
        everFc: true,
        lastPlayedAt: '2026-09-01T20:00:00.0000000Z'
      })),
  playInsights: () => ({
    // 120 days of history ending today, so the chart is drawn at week blocks with a partial
    // last one, which is the shape most users will see.
    days: Array.from({ length: Math.ceil(${spanDays} / 2) }, (_, i) => ({
      day: new Date(Date.now() - (${spanDays} - 1 - i * 2) * 86400000).toISOString().slice(0, 10),
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
  playLifetime: (list) => ({
    status: {
      available: lifetimeOn,
      reason: lifetimeOn ? 'ok' : 'noFile',
      scoreDataPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoredata.bin',
      scoresExtPath: '/home/player/.config/unity3d/srylain Inc_/Clone Hero/scoresext.bin',
      lastImportAt: lifetimeOn ? '2026-09-12T10:00:00.000Z' : null
    },
    totals: {
      charts: 101,
      lifetimePlays: 144,
      chartsInLibrary: 84,
      chartsNotInLibrary: 17,
      chartsWithUnconfirmedRows: 21,
      bestScore: 665629,
      observedPlays: 15,
      observedCharts: 9
    },
    charts: lifetimeOn ? lifetimeCharts.filter((c) => (list || []).includes(c.checksum)) : []
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
    byInstrument: [{ key: 'guitar', plays: 400 }],
    byDifficulty: [{ key: 'expert', plays: 400 }],
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evalIn = (win, code) => win.webContents.executeJavaScript(code, true)

async function waitFor(win, expression, timeoutMs = 20000) {
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

/** The Stats page, as layout has it. */
const PAGE = `(() => {
  const round = (n) => Math.round(n)
  const box = (el) => el.getBoundingClientRect()
  const caveat = document.querySelector('.caveat')
  const tiles = [...document.querySelectorAll('.tile')]
  const rows = [...document.querySelectorAll('.top-row')]
  const recent = [...document.querySelectorAll('.recent-row')]
  const charters = [...document.querySelectorAll('.ch-row')]
  const page = document.querySelector('.stats')
  const chart = document.querySelector('.chart')
  const fills = [...document.querySelectorAll('.chart .fill')]
  const tops = [...new Set(tiles.map((t) => round(box(t).top)))]
  // Every figure on the page, not only the tiles: the caveat has to clear all of them.
  const figures = [...document.querySelectorAll('.tile, .chart, .top, .charters')]
  const lowestFigureTop = figures.length ? Math.min(...figures.map((f) => round(box(f).top))) : null
  const heights = fills.map((f) => round(box(f).height))
  // The two lists live in one .columns grid. Their SECTIONS are what the grid places; the
  // lists inside them start at different heights because their notes wrap differently, so
  // asking the lists would answer about the prose above them.
  const panes = [...document.querySelectorAll('.stats > .columns > section')]
  const paneTops = panes.map((el) => round(box(el).top))
  const paneWidths = panes.map((el) => round(box(el).width))
  // The source tags: the whole of how this page says which record a block is drawn from. A tag
  // is only doing its job if it is on its heading's line, inside its section, and whole.
  const sections = [...document.querySelectorAll('.stats section')]
  const tagged = sections.filter((el) => el.querySelector('.src'))
  const tags = [...document.querySelectorAll('.src')]
  const tagState = tags.map((tag) => {
    const heading = tag.closest('h2')
    const section = tag.closest('section')
    return {
      text: tag.textContent.replace(/\\s+/g, ' ').trim(),
      // Same top as the heading box means the tag is on the heading's first line. A heading that
      // wrapped its tag to a second line sits lower than the heading's own top.
      onHeadingLine: heading ? round(box(tag).top) === round(box(heading).top) : null,
      // The tag carries a date and is nowrap, so the pane running out of room clips it rather
      // than breaking it. Positive means it fits with room to spare.
      clearsSectionEdgeBy: section ? round(box(section).right - box(tag).right) : null,
      // A heading whose tag dropped to its own line is about twice as tall as the tag. Reported
      // raw rather than as a verdict, because at a narrow pane wrapping is the RIGHT answer and
      // the thing to check is that the tag stayed whole when it did.
      tagHeight: round(box(tag).height),
      headingHeight: heading ? round(box(heading).height) : null
    }
  })
  // The two tile blocks. Same tile geometry in both, and two boxes rather than one run of eight.
  const lifeTiles = [...document.querySelectorAll('.tile.lifetime')]
  const plainTiles = tiles.filter((t) => !t.classList.contains('lifetime'))
  const blockOf = (el) => (el ? round(box(el.closest('section')).top) : null)
  return {
    sections: sections.length,
    sectionsTagged: tagged.length,
    sectionsUntagged: sections.length - tagged.length,
    tags: tagState,
    lifetimeTiles: lifeTiles.length,
    observedTiles: plainTiles.length,
    // Different section tops means the reader sees two groups, not one run of tiles.
    lifetimeBlockTop: blockOf(lifeTiles[0]),
    observedBlockTop: blockOf(plainTiles[0]),
    // Both blocks' tiles are the same width, so the two are read as comparable figures.
    lifetimeTileWidth: lifeTiles.length ? round(box(lifeTiles[0]).width) : null,
    caveatBottom: caveat ? round(box(caveat).bottom) : null,
    // Positive means the caveat finishes before the first figure begins, in painted pixels.
    caveatClearsFiguresBy:
      caveat && lowestFigureTop !== null ? lowestFigureTop - round(box(caveat).bottom) : null,
    tiles: tiles.length,
    tileRows: tops.length,
    tileWidth: tiles.length ? round(box(tiles[0]).width) : null,
    // Any tile whose text spills its box is a number the user cannot read.
    tilesOverflowing: tiles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
    chartHeight: chart ? round(box(chart).height) : null,
    bars: fills.length,
    barWidth: fills.length ? Number(box(fills[0]).width.toFixed(2)) : null,
    tallestBar: heights.length ? Math.max(...heights) : null,
    shortestBar: heights.length ? Math.min(...heights) : null,
    // Two panes at the same y are side by side; two different tops are stacked.
    paneTops,
    paneWidths,
    listsSideBySide: paneTops.length === 2 && paneTops[0] === paneTops[1],
    topRows: rows.length,
    topRowHeight: rows.length ? round(box(rows[0]).height) : null,
    recentRows: recent.length,
    charterRows: charters.length,
    // A row whose name column has run out of room is a row of ellipses.
    narrowestName: charters.length
      ? Math.min(...charters.map((r) => round(box(r.querySelector('.name')).width)))
      : null,
    pageScrollsSideways: page ? page.scrollWidth > page.clientWidth + 1 : null
  }
})()`

/** Home, which used to carry the panel and now carries none of it. */
const HOME = `(() => {
  const home = document.querySelector('.home')
  const first = home ? home.children[1] : null
  return {
    playTiles: document.querySelectorAll('.tile').length,
    caveats: document.querySelectorAll('.caveat').length,
    firstBlockUnderHero: first ? (first.querySelector('h2')?.textContent ?? '').trim() : null,
    blocks: home ? home.children.length : null,
    pageScrollsSideways: home ? home.scrollWidth > home.clientWidth + 1 : null
  }
})()`

/** The Installed list, comparing a badged row against an unbadged one. */
const LIST = `(() => {
  const round = (n) => Math.round(n)
  const rows = [...document.querySelectorAll('.row')]
  const heights = rows.map((r) => round(r.getBoundingClientRect().height))
  const badged = rows.filter((r) => r.querySelector('.badge.plays'))
  const bare = rows.filter((r) => !r.querySelector('.badge.plays'))
  const titleOf = (r) => r.querySelector('.title')
  const badgeOf = (r) => r.querySelector('.badge.plays')
  // The badge a row carries, whichever record answered for it, with the width it took. A
  // lifetime count has more digits than an observed one, and the badge sits inside the title
  // line, so this is where a wider count would start eating the song title.
  const badges = badged.map((r) => ({
    text: badgeOf(r).textContent.replace(/\\s+/g, ' ').trim(),
    width: round(badgeOf(r).getBoundingClientRect().width),
    height: round(badgeOf(r).getBoundingClientRect().height),
    rowHeight: round(r.getBoundingClientRect().height),
    titleWidth: round(titleOf(r).getBoundingClientRect().width),
    // Two badges on one row is the thing this feature must not do. One, or none.
    badgesOnRow: r.querySelectorAll('.badge.plays').length,
    // Clone Hero's own count says so in the hover; Encore's log says so in its own words.
    fromCloneHero: (badgeOf(r).getAttribute('title') ?? '').includes("Clone Hero's own count")
  }))
  return {
    rows: rows.length,
    badgedRows: badged.length,
    badges,
    distinctRowHeights: [...new Set(heights)],
    badgedHeight: badged.length ? round(badged[0].getBoundingClientRect().height) : null,
    bareHeight: bare.length ? round(bare[0].getBoundingClientRect().height) : null,
    // The title is what gives way to a badge; it must still have width to show something.
    titleWidthBadged: badged.length ? round(titleOf(badged[0]).getBoundingClientRect().width) : null,
    titleWidthBare: bare.length ? round(titleOf(bare[0]).getBoundingClientRect().width) : null,
    caveat: (document.querySelector('.caveat')?.textContent ?? '').replace(/\\s+/g, ' ').trim()
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

  console.log(
    `window ${width}x${height}, ${spanDays} days of history, lifetime ${lifetimeOn ? 'on' : 'off'}, log ${logOn ? 'on' : 'off'}`
  )

  await waitFor(win, `document.querySelector('.home')`)
  await sleep(300)
  console.log('home       ', JSON.stringify(await evalIn(win, HOME), null, 1))

  const statsTab = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Stats')`
  await waitFor(win, statsTab)
  await evalIn(win, `${statsTab}.click(), 1`)
  await waitFor(win, `document.querySelector('.tile')`)
  await sleep(500)
  console.log('stats page ', JSON.stringify(await evalIn(win, PAGE), null, 1))

  const installed = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Installed')`
  await waitFor(win, installed)
  await evalIn(win, `${installed}.click(), 1`)
  await waitFor(win, `document.querySelector('.badge.plays')`)
  await sleep(500)
  console.log('installed  ', JSON.stringify(await evalIn(win, LIST), null, 1))

  app.exit(0)
})
