// Single access point for the preload API so store tests can stub `window`.
export type Encore = typeof window.encore

export function encore(): Encore {
  return window.encore
}
