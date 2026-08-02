// Shared behaviour for the config sub-editors.
//
// Every write goes through apply(), so backup, atomicity and the "never
// overwrite a malformed file" guarantee hold no matter which editor is open.

import { S } from '../../tui/theme.mjs'
import { confirm, showText } from '../../tui/widgets.mjs'
import * as Settings from '../../data/settings.mjs'
import { diffLines } from '../../data/json.mjs'

export class Editor {
  constructor(scope = 'user') {
    this.scope = scope
  }

  reload() {
    this.doc = Settings.load(this.scope)
  }

  get data() {
    return this.doc?.data || {}
  }

  // mutate(draft) → void. When `preview` is set the change is shown as a diff
  // and confirmed before anything is written.
  async apply(app, mutate, message, { preview = false, title = 'Confirm change' } = {}) {
    try {
      if (preview) {
        const { before, after } = Settings.preview(this.scope, mutate)
        if (before === after) { app.toast('no change'); return false }
        const lines = diffLines(before, after)
          .filter((d, i, arr) => d.kind !== ' ' || nearChange(arr, i))
          .map((d) => ({
            text: d.kind + ' ' + d.text,
            style: d.kind === '+' ? S.ok : d.kind === '-' ? S.err : S.dim,
          }))
        await showText(app, { title: title + ' — diff', lines })
        const ok = await confirm(app, { title, message: 'Write this change?', yes: 'Write' })
        if (!ok) return false
      }
      Settings.update(this.scope, (d) => { mutate(d); return d })
      this.reload()
      if (message) app.toast(message)
      return true
    } catch (err) {
      app.error(err.message)
      return false
    }
  }
}

// Keep three lines of context around each change in a diff.
function nearChange(arr, i) {
  for (let j = Math.max(0, i - 3); j <= Math.min(arr.length - 1, i + 3); j++) {
    if (arr[j].kind !== ' ') return true
  }
  return false
}
