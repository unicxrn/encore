import { mount } from 'svelte'

import '@fontsource/archivo/400.css'
import '@fontsource/archivo/500.css'
import '@fontsource/archivo/600.css'
import '@fontsource/archivo/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './lib/tokens.css'

import App from './App.svelte'
import { installGlobalErrorHandlers } from './lib/stores/runtime-errors'

// Installed BEFORE the mount, deliberately: `initSettings()` and the other `void`-ed promises in
// App's onMount fire immediately, and a rejection from one of them during startup is exactly the
// kind of silent failure this exists to surface. Nothing tears it down. The renderer only stops
// listening when the window goes away and takes the listener with it.
installGlobalErrorHandlers()

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
