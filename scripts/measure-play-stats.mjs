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
 * 10. Does the rail's content still fit the column once the art, the stats and the action are in
 *    it, and how much room is left for the blocks that only appear sometimes? Documented at
 *    `RAIL`, which reads every one of them per element rather than taking the column's word for
 *    it, and at `RAIL_EMPTY` for the state a cold start opens in.
 * 11. Does Installed's second row action leave the title enough width to be a title? The row is a
 *    fixed grid whose only flexible track is the name, so anything added beside it comes out of
 *    that. `LIST` reports the button; `scripts/measure-explore-row.mjs` with VIEW=installed is
 *    what measures the title itself.
 *
 * The five questions above those, about the app shell's frame rather than about any one page,
 * are documented at `FRAME` below. They run first, on Home, because a frame that has collapsed
 * makes every measurement after it meaningless.
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
import { clickNav, evalIn, exitOnFailure, sleep, waitFor } from './harness-lib.mjs'

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
  // Chart 0 is the one the rail is measured on, and it runs long on purpose: 10:34 is the widest
  // string the LENGTH cell can realistically hold, and a five-character time is what would push
  // the three stat cells past the column if they were sized too tightly.
  songLength: i === 0 ? 634000 : 273000,
  chartType: 'folder',
  // The chart page prints short forms of all three and reads them without a guard, so a record
  // missing one crashes the page to the error screen rather than drawing it.
  folderHash: ('chart-' + i).padEnd(40, 'f'),
  chartHash: ('chart-' + i).padEnd(43, 'c'),
  tempoMapHash: ('chart-' + i).padEnd(32, 't'),
  modifiedTime: 0,
  cloneHeroChecksum: sum,
  instruments: ['guitar', 'bass', 'drums'],
  diffGuitar: 4,
  diffBass: 3,
  diffDrums: 5,
  // What the rail's stats strip reads. Five digits on the drum chart for the same reason the
  // length runs long: a thousands separator is the widest a note count gets in practice, and a
  // peak rate with a decimal is the widest the rate gets.
  noteCounts: [
    { instrument: 'guitar', difficulty: 'expert', count: 1420 },
    { instrument: 'guitar', difficulty: 'hard', count: 980 },
    { instrument: 'bass', difficulty: 'expert', count: 611 },
    { instrument: 'drums', difficulty: 'expert', count: 12345 }
  ],
  maxNps: [
    { instrument: 'guitar', difficulty: 'expert', nps: 12.25 },
    { instrument: 'drums', difficulty: 'expert', nps: 24.6 }
  ],
  // Only on the chart the rail is opened with, so the flag beside the three cells is measured
  // in the row it has to fit into rather than assumed to fit.
  has2xKick: i === 0,
  albumArtMd5: null
}))
const answers = {
  settingsGet: () => settings,
  catalogQuery: () => charts,
  catalogCount: () => charts.length,
  catalogFacets: () => ({ artists: ['Rush'], genres: ['Rock'], charters: ['someone'], years: [1981] }),
  existsByMeta: (keys) => (Array.isArray(keys) ? keys.map(() => false) : []),
  // main's own words for the one way a reveal is refused, so the line the rail draws for it is
  // measured at the length it will really be. Read only by the last step of the run, after every
  // ordinary measurement has been taken.
  chartReveal: (path) => {
    throw new Error('Refusing to open a path outside the library folders: ' + path)
  },
  downloadList: () => [],
  favouritesList: () => [],
  setlistsList: () => [],
  updatesLast: () => [],
  // The real shape main pushes: state is an object with a kind, not a bare string. It was a
  // bare string here until the sidebar started drawing this, and the footer measured empty.
  appUpdateStatus: () => ({
    currentVersion: '0.3.1',
    target: 'appimage',
    canApply: true,
    note: 'This AppImage can update itself.',
    state: { kind: 'current' }
  }),
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

exitOnFailure('measure-play-stats')

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
  // Heading tags only. The lead block renders the same tag beside each of its own figures,
  // because those come from different records and the heading above them cannot say which; those
  // are not on a heading line and reading them here would answer \`onHeadingLine\` with null for a
  // tag that was never meant to be on one. scripts/measure-stats-page.mjs measures the lead's.
  const tags = [...document.querySelectorAll('h2 .src')]
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

/**
 * The app shell's five regions, as layout has them.
 *
 * The one check in this repository that can see the window frame at all. jsdom applies no CSS
 * and computes no layout, so every component test in the suite answers zero for all of this and
 * would pass against a window that paints as a black void.
 *
 * What it is looking for is one specific failure. `.app` is a three by three grid and a grid
 * with fewer explicit rows than children auto-places the rest: the content pane lands in the
 * player's row, the player is pushed into an implicit fourth row below the window, and the
 * result is a black band with everything crushed at the bottom. Nothing warns, nothing throws,
 * and no test in the node or renderer projects can tell. It has happened twice.
 *
 * Five questions, and the failure above shows up in at least three of them:
 *
 * 1. Does every region have a box with real width and height? A region auto-placed into an
 *    implicit row collapses to zero height against `grid-auto-rows: 0`.
 * 2. Does any pair of regions overlap? Two things in one cell is the symptom of a placement
 *    that was never written down.
 * 3. Is the content column taller than the player bar? The specific shape of the bug was the
 *    view squeezed into the player's 70px row.
 * 4. Does the page scroll sideways? Three fixed tracks plus a view that cannot shrink is how a
 *    fixed-width column pushes the window wider than the window.
 * 5. Do the regions tile the window: sidebar from the top edge to the bottom, top bar and
 *    player spanning the two columns beside it, content and rail filling the middle row?
 */
const FRAME = `(() => {
  const round = (n) => Math.round(n)
  const app = document.querySelector('.app')
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }
  }
  const regions = {
    sidebar: pick('.app > nav.sidebar'),
    topbar: pick('.app > header.topbar'),
    content: pick('.app > main.view'),
    rail: pick('.app > aside.rail'),
    player: pick('.app > .foot')
  }
  // Below the shell's breakpoint the rail is deliberately not rendered, which is a fourth
  // region and not a collapsed fifth. Reported as its own fact so a zero-sized rail under a
  // wide window still reads as the failure it would be.
  const railCollapsed = window.innerWidth <= 1120
  const expected = railCollapsed
    ? Object.entries(regions).filter(([name]) => name !== 'rail')
    : Object.entries(regions)
  const named = expected.filter(([, box]) => box !== null)
  const missing = expected.filter(([, box]) => box === null).map(([name]) => name)
  const zero = named.filter(([, b]) => b.w === 0 || b.h === 0).map(([name]) => name)
  // Boxes that share pixels. Touching edges are not an overlap: two regions at x 238 and x 238
  // + width are adjacent, so the comparison is strict on both axes.
  const overlaps = []
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [an, a] = named[i]
      const [bn, b] = named[j]
      const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (dx > 0 && dy > 0) overlaps.push(an + '/' + bn + ' ' + dx + 'x' + dy)
    }
  }
  const content = regions.content
  const player = regions.player
  const sidebar = regions.sidebar
  return {
    regions,
    railCollapsed,
    missing,
    zeroSized: zero,
    overlaps,
    // The bug's own signature: the view no taller than the bar it was auto-placed beside.
    contentTallerThanPlayer: content && player ? content.h > player.h : null,
    contentHeight: content ? content.h : null,
    playerHeight: player ? player.h : null,
    // The sidebar spans all three rows, so it starts at the window's top edge, not under the
    // top bar. A sidebar that lost its row span starts at 50.
    sidebarTop: sidebar ? sidebar.y : null,
    sidebarFullHeight: sidebar ? sidebar.h === round(window.innerHeight) : null,
    // Nothing may be placed in an implicit row: grid-auto-rows 0 collapses one, so the sum
    // of the three explicit row heights is the window height exactly.
    rowsCoverWindow:
      regions.topbar && content && player
        ? regions.topbar.h + content.h + player.h === round(window.innerHeight)
        : null,
    appScrollsSideways: app ? app.scrollWidth > app.clientWidth + 1 : null,
    bodyScrollsSideways: document.body.scrollWidth > document.body.clientWidth + 1,
    windowWidth: round(window.innerWidth),
    windowHeight: round(window.innerHeight)
  }
})()`

/**
 * The sidebar's new blocks, which are all narrower than they want to be.
 *
 * Column 1 is 238px and the padding leaves 214, into which go two game tiles side by side and
 * a three-segment source switcher whose longest label is "Chorus Encore". A segment that has
 * run out of room ellipsises, and an ellipsised source name is a source the user cannot read;
 * a tile that has run out of room overflows its own box. Neither is visible to jsdom.
 */
const SIDEBAR = `(() => {
  const round = (n) => Math.round(n)
  const bar = document.querySelector('.sidebar')
  if (!bar) return { present: false }
  const box = (el) => el.getBoundingClientRect()
  // scrollWidth against clientWidth is the usual test and it is wrong on these: a button's
  // client box excludes its padding, so every one of them reported clipped, including a 39px
  // "Both" with 25px of text in it. A Range over the element's own contents measures the text
  // and nothing else, which is the number that decides whether an ellipsis appears.
  const textWidth = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getBoundingClientRect().width
  }
  const clipped = (el) => textWidth(el) > el.clientWidth + 1
  const segs = [...bar.querySelectorAll('.seg')]
  const tiles = [...bar.querySelectorAll('.game')]
  return {
    present: true,
    width: round(box(bar).width),
    segments: segs.map((el) => ({
      text: el.textContent.trim(),
      width: round(box(el).width),
      clipped: clipped(el)
    })),
    tiles: tiles.map((el) => ({
      text: el.textContent.replace(/\\s+/g, ' ').trim(),
      width: round(box(el).width),
      height: round(box(el).height),
      clipped: clipped(el)
    })),
    quickButtons: [...bar.querySelectorAll('.quick-btn')].map((el) => ({
      text: el.textContent.trim(),
      clipped: clipped(el)
    })),
    // The footer's two mono lines carry a version and an update state, both of which can run
    // long. They ellipsise rather than wrapping the card taller.
    statusLines: [...bar.querySelectorAll('.status-line')].map((el) => el.textContent.trim()),
    navRows: [...bar.querySelectorAll('.section button')].map((el) => el.textContent.trim()),
    scrollsSideways: bar.scrollWidth > bar.clientWidth + 1,
    scrollsDown: bar.scrollHeight > bar.clientHeight + 1
  }
})()`

/**
 * The rail with a chart in it.
 *
 * The column is fixed at 374px and its content is not, so the questions are whether anything
 * inside it overflows that width, whether the art box stayed square once the column decided its
 * size, and whether the whole column fits its own height or scrolls. jsdom answers all four
 * with zero.
 *
 * Three things in this column are each a way to break it. The art box draws a letter, which can
 * overflow a box it is too large for. The statistics card puts eight labelled cells in two
 * columns of 346px of usable width, so a value wider than its share is what collapses the grid
 * to one column. And the action row has a full-width button whose word is longer than the button
 * is when the column narrows. All three are read below, per element, with the clipping measured
 * rather than eyeballed: an ellipsised label and a label that fits look identical in a
 * screenshot, and only one of them is readable.
 *
 * This leg answers those four questions about the column. `scripts/measure-rail-panel.mjs`
 * answers the panel's own: where each block falls against the fold, the health ring's arc inside
 * its box, and the checklist wrapping, in each of the five states a chart can reach the rail in.
 */
const RAIL = `(() => {
  const round = (n) => Math.round(n)
  const rail = document.querySelector('.rail')
  if (!rail) return { present: false }
  const box = (el) => el.getBoundingClientRect()
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null)
  // Clipped, whichever way it is clipped: an ellipsis, an overflow:hidden crop, or a line clamp
  // all leave the scroll box larger than the painted one.
  const clipped = (el) => el.scrollWidth > el.clientWidth + 1
  const art = rail.querySelector('.art')
  const viewport = rail.querySelector('.viewport')
  const health = [...rail.querySelectorAll('.health-row')]
  const wide = [...rail.querySelectorAll('*')].filter(
    (el) => round(box(el).right) > round(box(rail).right)
  )
  const placeholder = rail.querySelector('.art.placeholder')
  // Beside the statistics card's heading, not in a ninth cell: the grid is eight and stays
  // eight, and a flag that appeared only on a drum chart would otherwise make a drum chart
  // taller than every other chart.
  const flag = rail.querySelector('.stats .chip')
  return {
    present: true,
    width: round(box(rail).width),
    // A square art box: the aspect-ratio only holds if the column gave it a width to square.
    artWidth: art ? round(box(art).width) : null,
    artHeight: art ? round(box(art).height) : null,
    // The letter an artless chart shows. It must sit inside the 76px box, not overflow it.
    monogram: text(placeholder),
    monogramOverflows: placeholder
      ? placeholder.scrollWidth > placeholder.clientWidth + 1 ||
        placeholder.scrollHeight > placeholder.clientHeight + 1
      : null,
    // The action this chart has, and the way through to its page beside it. The action takes
    // the width left over and the route is sized to its own word; both words have to fit
    // inside their button whole, and the row has to stay one row.
    actions: [...rail.querySelectorAll('.actions button')].map((b) => ({
      label: text(b),
      width: round(box(b).width),
      height: round(box(b).height),
      clipped: clipped(b)
    })),
    // Eight cells, and on a drum chart with a double pedal a chip beside the card's heading. A
    // cell whose label is clipped has stopped saying which number it is.
    stats: [...rail.querySelectorAll('.stats .stat')].map((s) => ({
      label: text(s.querySelector('.stat-label')),
      value: text(s.querySelector('.stat-value')),
      width: round(box(s).width),
      labelClipped: clipped(s.querySelector('.stat-label')),
      valueClipped: clipped(s.querySelector('.stat-value'))
    })),
    statsHeight: rail.querySelector('.stats')
      ? round(box(rail.querySelector('.stats')).height)
      : null,
    flag: flag ? { text: text(flag), width: round(box(flag).width), clipped: clipped(flag) } : null,
    viewportWidth: viewport ? round(box(viewport).width) : null,
    viewportHeight: viewport ? round(box(viewport).height) : null,
    // The one block whose height this run cannot observe directly: the state line is empty while
    // nothing is playing, and nothing can play here (no network, no chart files). Computed from
    // its own resolved font metrics plus the gap it would reclaim, so the figure is read off the
    // stylesheet rather than guessed, and \`spare\` above can be checked against it.
    stateLineCost: (() => {
      const st = rail.querySelector('.state')
      if (!st) return null
      const cs = getComputedStyle(st)
      const lh = cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight)
      const gap = parseFloat(getComputedStyle(st.parentElement).rowGap) || 0
      return round(lh + gap)
    })(),
    healthRows: health.length,
    healthStates: health.map((r) => r.getAttribute('data-state')),
    title: (rail.querySelector('.title')?.textContent ?? '').trim(),
    // Anything sticking out past the column's right edge is content the user cannot read.
    childrenPastRightEdge: wide.length,
    // Every block in the column with the height it took, in order. The total is what decides
    // whether the rail scrolls, and this is the only way to see which block to spend on.
    sections: [...rail.children].map((el) => ({
      name: el.className || el.tagName.toLowerCase(),
      height: round(box(el).height)
    })),
    // What the blocks actually use, and what is left. \`scrollHeight\` cannot answer this: it
    // never reports less than the client height, so a column with room to spare and one filled
    // exactly to the brim both read as the same number. The last child's bottom edge plus the
    // column's own bottom padding is the real figure, and \`spare\` is the headroom the transient
    // blocks (a refused reveal's reason, the state line once something is playing) have to fit
    // into before the column starts scrolling.
    usedHeight: (() => {
      const last = rail.children[rail.children.length - 1]
      if (!last) return 0
      const pad = parseFloat(getComputedStyle(rail).paddingBottom) || 0
      return round(box(last).bottom - box(rail).top + pad)
    })(),
    spare: (() => {
      const last = rail.children[rail.children.length - 1]
      if (!last) return null
      const pad = parseFloat(getComputedStyle(rail).paddingBottom) || 0
      return round(box(rail).top + rail.clientHeight - box(last).bottom - pad)
    })(),
    clientHeight: rail.clientHeight,
    scrollsSideways: rail.scrollWidth > rail.clientWidth + 1,
    scrollsDown: rail.scrollHeight > rail.clientHeight + 1
  }
})()`

/**
 * The rail before the first chart of the session, which is the only time the empty state shows.
 *
 * It is the state every cold start opens in, and the one thing that can go wrong with it is that
 * the three sections added around it push it off centre or out of the column. Read on Home,
 * before anything has been clicked.
 */
const RAIL_EMPTY = `(() => {
  const round = (n) => Math.round(n)
  const rail = document.querySelector('.rail')
  if (!rail) return { present: false }
  const empty = rail.querySelector('.empty')
  const line = rail.querySelector('.empty-line')
  const note = rail.querySelector('.empty-note')
  const b = (el) => (el ? el.getBoundingClientRect() : null)
  const eb = b(empty)
  const rb = b(rail)
  return {
    present: true,
    width: round(rb.width),
    line: line ? line.textContent.trim() : null,
    note: note ? note.textContent.trim() : null,
    // No chart, so none of the three new blocks may be drawn at all.
    actions: rail.querySelectorAll('.actions').length,
    stats: rail.querySelectorAll('.stats').length,
    art: rail.querySelectorAll('.art').length,
    // The empty block is centred by \`margin: auto 0\`, so its top gap and bottom gap match.
    gapAbove: eb ? round(eb.top - rb.top) : null,
    gapBelow: eb ? round(rb.bottom - eb.bottom) : null,
    scrollsSideways: rail.scrollWidth > rail.clientWidth + 1,
    scrollsDown: rail.scrollHeight > rail.clientHeight + 1
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
  // Step five put a second action on every row. The row is a fixed six-column grid and the two
  // buttons are its siblings, so the thing to watch is whether the pair takes width off the
  // grid and whether the row got taller for it.
  const preview = [...document.querySelectorAll('.to-rail')]
  const wrap = document.querySelector('.row-wrap')
  return {
    rows: rows.length,
    badgedRows: badged.length,
    badges,
    previewButtons: preview.length,
    previewWidth: preview.length ? round(preview[0].getBoundingClientRect().width) : null,
    // Hidden with the column it feeds, by App.svelte's own media query and no second copy of
    // the number. Zero here under a narrow window is the pass, not a missing control.
    previewVisible: preview.length
      ? getComputedStyle(preview[0]).display !== 'none'
      : null,
    // The two actions plus the grid have to add up to the wrapper, or one of them is overflowing
    // it and the row is scrolling sideways inside the list.
    wrapWidth: wrap ? round(wrap.getBoundingClientRect().width) : null,
    rowGridWidth: rows.length ? round(rows[0].getBoundingClientRect().width) : null,
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

  await waitFor(win, `document.querySelector('.home')`, { what: 'Home' })
  await sleep(300)
  console.log('frame      ', JSON.stringify(await evalIn(win, FRAME), null, 1))
  console.log('sidebar    ', JSON.stringify(await evalIn(win, SIDEBAR), null, 1))
  console.log('home       ', JSON.stringify(await evalIn(win, HOME), null, 1))
  // Before anything has been opened, which is the only moment the rail's empty state exists.
  console.log('rail/empty ', JSON.stringify(await evalIn(win, RAIL_EMPTY), null, 1))

  // The row is called Statistics. It was called Stats, and this waited forty seconds for that.
  await clickNav(win, 'Statistics')
  await waitFor(win, `document.querySelector('.tile')`, { what: "the Stats page's first tile" })
  await sleep(500)
  console.log('stats page ', JSON.stringify(await evalIn(win, PAGE), null, 1))

  await clickNav(win, 'Installed')
  await waitFor(win, `document.querySelector('.badge.plays')`, { what: "Installed's play badge" })
  await sleep(500)
  console.log('installed  ', JSON.stringify(await evalIn(win, LIST), null, 1))

  // Installed's per-row Preview button, which fills the rail without leaving the list. Measured
  // here rather than after the click below, because the click is what takes the list away.
  await evalIn(win, `document.querySelector('.to-rail').click(), 1`)
  await waitFor(win, `document.querySelector('.rail .art')`, { what: "the rail's art box" })
  await sleep(400)
  console.log('rail/listed', JSON.stringify(await evalIn(win, RAIL), null, 1))

  // Opening a chart is what fills the rail, and a rail with something in it is the case where
  // it can push the frame around: the art box is square and sized off the column, the title
  // wraps, and the health list grows. Measured after the empty case for that reason.
  await evalIn(win, `document.querySelector('.table .row').click(), 1`)
  await waitFor(win, `document.querySelector('.detail')`, { what: 'the chart page' })
  await sleep(400)
  console.log('rail       ', JSON.stringify(await evalIn(win, RAIL), null, 1))
  console.log('frame/chart', JSON.stringify(await evalIn(win, FRAME), null, 1))

  // The drum track, which is the widest the stats strip gets: five digits of notes, a peak rate
  // with a decimal, and the 2X KICK flag beside all three on the same line.
  await evalIn(
    win,
    `(() => {
      const sel = document.querySelectorAll('.rail .picks select')[0]
      sel.value = 'drums'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return 1
    })()`
  )
  await sleep(300)
  console.log('rail/drums ', JSON.stringify(await evalIn(win, RAIL), null, 1))

  // Last, because it is the only state that adds height the column had not already accounted
  // for: a refused reveal wraps its reason over as many lines as the reason needs. \`spare\` in
  // the reads above is what this has to fit inside before the column starts scrolling.
  await evalIn(win, `[...document.querySelectorAll('.rail .actions button')][0].click(), 1`)
  await waitFor(win, `document.querySelector('.rail .act-error')`, {
    what: "the rail's error line"
  })
  await sleep(200)
  console.log('rail/error ', JSON.stringify(await evalIn(win, RAIL), null, 1))

  app.exit(0)
})
