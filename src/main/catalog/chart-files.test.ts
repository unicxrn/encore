import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeFixtureSng } from '../../../test/helpers/make-sng'
import { readChartFiles } from './chart-files'
import { tmpDir } from '../../../test/helpers/tmp'

describe('readChartFiles', () => {
  it('reads all folder files including audio, excluding video', async () => {
    const dir = tmpDir('chart-files')
    const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00])
    writeFileSync(join(dir, 'song.ini'), '[song]\nname = Test\n')
    writeFileSync(join(dir, 'notes.chart'), '[Song]\n{\n}\n')
    writeFileSync(join(dir, 'song.ogg'), oggBytes)
    writeFileSync(join(dir, 'video.mp4'), new Uint8Array([1, 2, 3]))

    const files = await readChartFiles(dir, 'folder')
    const names = files.map((f) => f.fileName).sort()
    expect(names).toEqual(['notes.chart', 'song.ini', 'song.ogg'])
    const ogg = files.find((f) => f.fileName === 'song.ogg')
    expect(ogg?.data).toEqual(oggBytes)
  })

  it('extracts sng entries, excluding video', async () => {
    const dir = tmpDir('chart-sng')
    const sngPath = join(dir, 'fixture.sng')
    writeFileSync(sngPath, makeFixtureSng())

    const files = await readChartFiles(sngPath, 'sng')
    const names = files.map((f) => f.fileName).sort()
    expect(names).toEqual(['notes.chart', 'song.ini'])
    const ini = files.find((f) => f.fileName === 'song.ini')
    expect(new TextDecoder().decode(ini?.data)).toContain('name = Sng Song')
  })

  it('filters video entries out of sng archives', async () => {
    const { makeSng } = await import('../../../test/helpers/make-sng')
    const dir = tmpDir('chart-sng-video')
    const sngPath = join(dir, 'video.sng')
    writeFileSync(
      sngPath,
      makeSng([
        { fileName: 'song.ini', data: new TextEncoder().encode('[song]\nname = V\n') },
        { fileName: 'video.webm', data: new Uint8Array([9, 9, 9]) }
      ])
    )
    const files = await readChartFiles(sngPath, 'sng')
    expect(files.map((f) => f.fileName)).toEqual(['song.ini'])
  })

  it('rejects for a nonexistent path', async () => {
    await expect(readChartFiles('/nonexistent/nope', 'folder')).rejects.toThrow()
    await expect(readChartFiles('/nonexistent/nope.sng', 'sng')).rejects.toThrow()
  })
})
