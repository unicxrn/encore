/**
 * The changelog, as the app has it.
 *
 * This is the one line in the project that reads CHANGELOG.md, and it reads it as text at build
 * time. `?raw` makes the file a module dependency of the renderer bundle, so its bytes are inlined
 * into `out/renderer` by the same build that produces the rest of the app.
 *
 * Three things follow from that, and they are the reason it is an import rather than a fetch, a
 * generated module or a file copied beside the executable:
 *
 * - It works with no network, which matters most for the one screen whose whole job is to explain
 *   an app that has just replaced itself.
 * - It cannot describe a build it is not. The text in the bundle is the text that was on disk when
 *   that bundle was built, so there is no window in which the app ships one version and reads
 *   another version's notes.
 * - There is nothing to keep in sync. A generated `changelog.generated.ts` would be a second copy
 *   in the tree, committed or gitignored, and either way something a contributor can forget to
 *   regenerate. Vite also treats the markdown as a watched dependency, so editing it during
 *   `npm run dev` reloads the panel.
 *
 * Parsed once, at module scope. The file is a few kilobytes and the result is immutable, so every
 * caller shares one array rather than re-reading the same string per mount.
 */
import changelogSource from '../../../../CHANGELOG.md?raw'
import { parseChangelog, type ChangelogRelease } from '../../../shared/changelog'

/** Every release in CHANGELOG.md, newest first. */
export const CHANGELOG: readonly ChangelogRelease[] = parseChangelog(changelogSource)
