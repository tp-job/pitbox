import type { Register } from 'claude-code'

import { bandComplete, bandStart, bandSubmit, register as band } from './band'
import { register as sidebar, sidebarComplete, sidebarStart, sidebarSubmit } from './sidebar'

// Pitbox: the band above the prompt (band.tsx) and the sidebar pane (sidebar.tsx).
// A plugin hooks an event once without a matcher, so the events both halves need are hooked here.
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await bandStart($)
    await sidebarStart($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await bandSubmit($)
    await sidebarSubmit($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await sidebarComplete($, e.answer, e.agentId)
    await bandComplete($)

    return next(e)
  })

  band(on, options)
  sidebar(on, options)
}
