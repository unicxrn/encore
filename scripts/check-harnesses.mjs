/**
 * Read every harness in this folder and refuse the ones that could fail quietly.
 *
 *     node scripts/check-harnesses.mjs          the static checks, about a tenth of a second
 *     node scripts/check-harnesses.mjs --run    the same, then run every harness for real
 *
 * A harness is not in the test suite and cannot easily be: it needs a built renderer, a real
 * browser engine and a virtual framebuffer, and the slowest of them takes two minutes. So nothing
 * noticed when the sidebar's nav rows gained counts and half of these stopped finding the row
 * they navigate by. They went on printing something, or waited out forty seconds and blamed the
 * wrong thing, or sat with a rejected promise and no reason to quit until somebody killed them.
 *
 * The static half is what would have caught that in a second, and is cheap enough to run on a
 * whim. It is not wired into any of the gates: the gates are for the app, and these are tools.
 *
 * What it checks, and what each one is standing in for:
 *
 *   parses        `node --check`. A syntax error here is not caught by anything else: Electron
 *                 fails to load the module, puts up a dialog nobody can see, and hangs. Found
 *                 that way once, after a backtick in a comment closed a preload template.
 *   shares        the harness imports `harness-lib.mjs`. Every check below is about something
 *                 that file owns, and a copy of it in the harness is how they drifted apart.
 *   reports       the harness calls `exitOnFailure`, which is what turns a rejected wait into a
 *                 message and a non-zero exit instead of a process that never ends.
 *   addresses     no selector matches a nav row or a quick action by the whole button's text.
 *                 That is the exact fault: a row is "Installed 1,204" to `textContent` now, and
 *                 was "Installed" when these were written.
 *   describes     every `waitFor` says what it is waiting for. The default is the selector, which
 *                 is true and unreadable; `what` is the sentence somebody reads at 2am.
 *   gpu           no harness that opens a preview also calls `appendSwitch('disable-gpu')`. The
 *                 switch wins over the invocation, so the ANGLE flags CLAUDE.md records do
 *                 nothing while it stands, and the preview renders nothing with no error
 *                 anywhere. A harness that never draws a lane may ask for no GPU.
 *
 * `--run` is the slow half: each harness under xvfb, with its output checked for an exit code and
 * for the markers a harness prints when it measured nothing. It takes a few minutes and it is the
 * only thing that can tell a harness that works from one that merely starts.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

const harnesses = fs
  .readdirSync(here)
  .filter((f) => f.startsWith('measure-') && f.endsWith('.mjs'))
  .sort()

/** The names that belong to a nav row or a quick action tile. */
const ROW_NAMES =
  /'(Installed|Explore|Home|Setlists|Downloads|Issues|Duplicates|Settings|Statistics|Stats|Asset Studio|Assets|Metadata editor|Surprise me)'/g
/** Reading the name out of the element that holds only the name, which is the way that survives. */
const NAME_ELEMENT = /querySelector\('\.label'\)|\.quick-text b/

/**
 * Names matched against a whole button's text, which is the fault this file exists for.
 *
 * The row draws its count inside itself and the tile draws a note under its name, so the whole
 * element's `textContent` is "Installed 1,204" and "Surprise me Five charts at random". Reading
 * the name element instead is the same question asked of the part that only ever holds the name,
 * so the lookback lets that spelling through.
 */
function wholeButtonText(source) {
  const found = []
  for (const m of source.matchAll(ROW_NAMES)) {
    const around = source.slice(Math.max(0, m.index - 260), m.index)
    if (!/textContent/.test(around)) continue
    if (NAME_ELEMENT.test(around)) continue
    found.push(m[1])
  }
  return found
}

const problems = []
const note = (file, check, said) => problems.push({ file, check, said })

for (const file of harnesses) {
  const full = path.join(here, file)
  const source = fs.readFileSync(full, 'utf8')

  const parsed = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' })
  if (parsed.status !== 0) {
    note(file, 'parses', (parsed.stderr || '').split('\n').slice(0, 3).join(' ').trim())
    // Everything below reads the source as if it meant something, so stop here.
    continue
  }

  if (!source.includes("from './harness-lib.mjs'")) {
    note(file, 'shares', 'does not import harness-lib.mjs')
  }
  if (!/exitOnFailure\(/.test(source)) {
    note(file, 'reports', 'does not call exitOnFailure, so a failed wait would hang')
  }
  for (const name of new Set(wholeButtonText(source))) {
    note(
      file,
      'addresses',
      `matches "${name}" on a whole element's text; use navRow or quickAction`
    )
  }
  // Only where it contradicts the harness: the switch wins over the invocation, so a harness
  // that presses Play has turned off the WebGL its own preview needs and cannot be launched out
  // of it. The ones that never render a lane are entitled to ask for no GPU.
  if (
    /appendSwitch\('disable-gpu'\)/.test(source) &&
    /Play preview|track-name|preview button\.play/.test(source)
  ) {
    note(
      file,
      'gpu',
      "calls appendSwitch('disable-gpu') and then opens a preview, which needs the WebGL that switch takes away"
    )
  }

  // `waitFor(win, <expression>)` with nothing after the expression: the balance of brackets says
  // where the call ends, which a regular expression cannot.
  for (const at of [...source.matchAll(/\bwaitFor\(/g)].map((m) => m.index)) {
    let depth = 0
    let end = at + 'waitFor('.length
    let args = ''
    for (; end < source.length; end++) {
      const c = source[end]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break
        depth--
      }
      args += c
    }
    if (!/\bwhat:/.test(args)) {
      const line = source.slice(0, at).split('\n').length
      note(
        file,
        'describes',
        `line ${line}: a waitFor with no \`what\`, so its timeout names a selector`
      )
    }
  }
}

for (const p of problems) {
  console.log(`${p.file.padEnd(30)} ${p.check.padEnd(11)} ${p.said}`)
}
console.log(
  problems.length === 0
    ? `\n${harnesses.length} harnesses, all clean`
    : `\n${harnesses.length} harnesses, ${problems.length} problem${problems.length === 1 ? '' : 's'}`
)

if (!process.argv.includes('--run')) {
  process.exit(problems.length === 0 ? 0 : 1)
}

/**
 * The harnesses that need WebGL, and the flags that give them software WebGL.
 *
 * CLAUDE.md records both invocations. The everyday one turns the GPU off, which leaves no WebGL
 * at all, so anything drawing a lane has to be launched the other way.
 */
const NEEDS_WEBGL = new Set(['measure-lane-skin.mjs', 'measure-player-bar.mjs'])
const OFF = ['--disable-gpu', '--disable-software-rasterizer']
const SOFTWARE = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']

/** What a harness prints when it reached the end with nothing to say. */
const MEASURED_NOTHING = [/\brows\s+0\b/, /\bNO CHART PAGE OPENED\b/, /"items":\s*0\b/]

/**
 * The environment CLAUDE.md's invocation sets up.
 *
 * The two display variables are unset rather than overridden, so Chromium cannot find the
 * machine's own session and reach past xvfb to it. TMPDIR is a real disk because the packagers
 * need one and a harness may as well have the same.
 */
const environment = { ...process.env, TMPDIR: path.join(root, '.build-tmp') }
delete environment.WAYLAND_DISPLAY
delete environment.XDG_SESSION_TYPE

console.log('\nrunning each one\n')
let failed = 0
for (const file of harnesses) {
  const started = Date.now()
  const run = spawnSync(
    'xvfb-run',
    [
      '-a',
      '--server-args=-screen 0 1920x1080x24',
      'node_modules/electron/dist/electron',
      `scripts/${file}`,
      '--ozone-platform=x11',
      ...(NEEDS_WEBGL.has(file) ? SOFTWARE : OFF)
    ],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      env: environment
    }
  )
  const seconds = Math.round((Date.now() - started) / 1000)
  const said = `${run.stdout || ''}${run.stderr || ''}`
  const empty = MEASURED_NOTHING.filter((r) => r.test(said))
  const verdict =
    run.status !== 0
      ? `FAILED (exit ${run.status})`
      : empty.length > 0
        ? `MEASURED NOTHING (${empty.map((r) => r.source).join(', ')})`
        : 'ok'
  if (verdict !== 'ok') failed++
  console.log(`${file.padEnd(30)} ${String(seconds).padStart(4)}s  ${verdict}`)
  if (run.status !== 0) {
    console.log(
      said
        .split('\n')
        .filter((l) => /failed|timed out|Error/.test(l))
        .slice(0, 4)
        .map((l) => `    ${l.trim()}`)
        .join('\n')
    )
  }
}

process.exit(problems.length === 0 && failed === 0 ? 0 : 1)
