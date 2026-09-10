import { fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ErrorFallback from './ErrorFallback.svelte'

const noop = (): void => {}

function boom(message = 'Detail.svelte exploded'): Error {
  const err = new Error(message)
  err.stack = `Error: ${message}\n    at Detail.svelte:12:3`
  return err
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ErrorFallback', () => {
  it('shows what broke rather than a blank screen', () => {
    render(ErrorFallback, {
      error: boom(),
      where: 'Detail view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    expect(screen.getByText('Detail.svelte exploded')).toBeTruthy()
  })

  it('puts the stack on screen, because a packaged build has no DevTools', () => {
    render(ErrorFallback, {
      error: boom(),
      where: 'Detail view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    expect(screen.getByText(/at Detail\.svelte:12:3/)).toBeTruthy()
  })

  it('names the context and version in the on-screen report', () => {
    render(ErrorFallback, {
      error: boom(),
      where: 'Tools view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    expect(screen.getByText(/Encore \d.*Tools view/)).toBeTruthy()
  })

  it('offers Try again, which re-runs the boundary', async () => {
    const onRetry = vi.fn()
    render(ErrorFallback, {
      error: boom(),
      where: 'Tools view',
      scope: 'view',
      onRetry,
      onLeave: noop
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers a way out as well as a retry, since a deterministic error never clears', async () => {
    const onLeave = vi.fn()
    render(ErrorFallback, {
      error: boom(),
      where: 'Tools view',
      scope: 'view',
      onRetry: noop,
      onLeave
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Go to Home' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('names the shell-level escape hatch a reload, not a navigation', async () => {
    // With the shell broken there is no sidebar left to navigate with.
    const onLeave = vi.fn()
    render(ErrorFallback, {
      error: boom(),
      where: 'app shell',
      scope: 'app',
      onRetry: noop,
      onLeave
    })

    expect(screen.queryByRole('button', { name: 'Go to Home' })).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Reload Encore' }))
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('copies the full report and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(ErrorFallback, {
      error: boom(),
      where: 'Tools view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Copy details' }))

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain('at Detail.svelte:12:3')
    expect(await screen.findByText('COPIED')).toBeTruthy()
  })

  it('admits a failed copy and points at the selectable text instead', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('not focused')) }
    })
    render(ErrorFallback, {
      error: boom(),
      where: 'Tools view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Copy details' }))

    expect(await screen.findByText(/COPY FAILED/)).toBeTruthy()
  })

  it('announces the message and only the message, so a screen reader is not read a trace', () => {
    render(ErrorFallback, {
      error: boom(),
      where: 'Tools view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    // role="alert" reads its contents the moment it appears. The message is what the user needs
    // to hear; a 260px stack trace read aloud, assertively, is not how anyone should learn that a
    // screen crashed.
    const alert = screen.getByRole('alert')
    expect(alert.textContent?.trim()).toBe('Detail.svelte exploded')

    // The stack is still on screen, outside the alert, where it is reached on purpose.
    const stack = screen.getByText(/at Detail\.svelte:12:3/)
    expect(alert.contains(stack)).toBe(false)
  })

  it('renders a headline for a thrown non-Error', () => {
    render(ErrorFallback, {
      error: 'just a string',
      where: 'Tools view',
      scope: 'view',
      onRetry: noop,
      onLeave: noop
    })

    // Present twice (as the headline and inside the report), so query for all of them.
    expect(screen.getAllByText(/just a string/).length).toBeGreaterThan(0)
  })
})
