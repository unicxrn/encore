// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { takeFocus, wrapTab } from './focus-trap'

/**
 * A modal's worth of DOM: a container with two controls, and an opener outside it. Built by hand
 * rather than rendered, because the helper is what is under test here and the three dialogs that
 * use it each pin their own behaviour in their own files.
 */
function modal(): {
  opener: HTMLButtonElement
  card: HTMLDivElement
  controls: HTMLButtonElement[]
} {
  const opener = document.createElement('button')
  const card = document.createElement('div')
  card.tabIndex = -1
  const controls = [document.createElement('button'), document.createElement('button')]
  for (const control of controls) card.appendChild(control)
  document.body.append(opener, card)
  return { opener, card, controls }
}

/** Dispatches a real Tab keydown and reports whether the handler claimed it. */
function tab(target: HTMLElement, shiftKey = false): boolean {
  return !target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  )
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('takeFocus', () => {
  it('moves focus in, and the returned function hands it back to whatever had it', () => {
    const { opener, card } = modal()
    opener.focus()

    const restore = takeFocus(card)
    expect(document.activeElement).toBe(card)

    restore()
    expect(document.activeElement).toBe(opener)
  })

  it('does not fight for focus when the opener has since left the document', () => {
    const { opener, card, controls } = modal()
    opener.focus()
    const restore = takeFocus(card)
    opener.remove()
    controls[0].focus()

    restore()

    // An element that is no longer in the document cannot take focus; the restore must not throw
    // and must not blur whatever has focus now.
    expect(document.activeElement).toBe(controls[0])
  })
})

describe('wrapTab', () => {
  it('wraps Tab off the last control to the first', () => {
    const { card, controls } = modal()
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    controls[1].focus()

    expect(tab(controls[1])).toBe(true)
    expect(document.activeElement).toBe(controls[0])
  })

  it('wraps Shift+Tab off the first control to the last', () => {
    const { card, controls } = modal()
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    controls[0].focus()

    expect(tab(controls[0], true)).toBe(true)
    expect(document.activeElement).toBe(controls[1])
  })

  it('wraps Shift+Tab off the container itself, which is what has focus when a card opens', () => {
    const { card, controls } = modal()
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    card.focus()

    expect(tab(card, true)).toBe(true)
    expect(document.activeElement).toBe(controls[1])
  })

  it('leaves a Tab in the middle to the browser', () => {
    const { card, controls } = modal()
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    controls[0].focus()

    expect(tab(controls[0])).toBe(false)
    expect(document.activeElement).toBe(controls[0])
  })

  it('skips disabled controls when deciding what the ends are', () => {
    const { card, controls } = modal()
    const disabled = document.createElement('button')
    disabled.disabled = true
    card.appendChild(disabled)
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    controls[1].focus()

    expect(tab(controls[1])).toBe(true)
    expect(document.activeElement).toBe(controls[0])
  })

  it('holds focus on an empty container rather than letting Tab out', () => {
    const { card, controls } = modal()
    for (const control of controls) control.remove()
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    card.focus()

    expect(tab(card)).toBe(true)
    expect(document.activeElement).toBe(card)
  })

  it('leaves every other key alone', () => {
    const { card, controls } = modal()
    card.addEventListener('keydown', (event) => wrapTab(event, card))
    controls[1].focus()

    const claimed = !controls[1].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )

    expect(claimed).toBe(false)
    expect(document.activeElement).toBe(controls[1])
  })
})
