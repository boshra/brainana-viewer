// Modal dialog for publication SVG figure export.
// Allows researchers to export clean 2D vector & raster composite figures directly to the browser.
import { h, field, errorText, dismissOnBackdrop } from '@brainana/ui/dom.ts'
import { exportSvgFigure, type SvgExportDeps, type SvgExportOptions } from '../../export/svgExport.ts'

export interface ExportFigureDialogDeps extends SvgExportDeps {
  subjectId: string | null
  isWhiteBackground: boolean
  annotationsEnabled?: boolean
}

function defaultFilename(subjectId: string | null): string {
  const subject = (subjectId ?? 'subject').replace(/[^A-Za-z0-9_-]+/g, '-')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `brainana-figure_${subject}_${stamp}.svg`
}

export function mountExportFigureDialog(deps: ExportFigureDialogDeps): void {
  const { subjectId, isWhiteBackground, view, legendInfo } = deps

  const overlay = h('div', { class: 'overlay' })
  let busy = false
  const close = (force = false): void => {
    if (busy && !force) return
    window.removeEventListener('keydown', onKeyDown)
    overlay.remove()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  dismissOnBackdrop(overlay, () => close())

  const hasOverlay = view.hasActiveOverlay()

  // --- Layer options ---
  const separateOverlayCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  separateOverlayCheck.checked = hasOverlay
  separateOverlayCheck.disabled = !hasOverlay

  const annotationsCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  annotationsCheck.checked = deps.annotationsEnabled ?? true

  const legendCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  legendCheck.checked = !!legendInfo
  legendCheck.disabled = !legendInfo

  // --- Filename ---
  const filenameInput = h('input', {
    type: 'text',
    class: 'grow',
    value: defaultFilename(subjectId),
  }) as HTMLInputElement

  const closeBtn = h('button', { type: 'button', class: 'ghost', title: 'Close dialog' }, ['✕']) as HTMLButtonElement
  closeBtn.addEventListener('click', () => close())

  const msg = h('div', { class: 'msg' })
  const cancelBtn = h('button', { type: 'button', class: 'ghost' }, ['cancel']) as HTMLButtonElement
  cancelBtn.addEventListener('click', () => close())

  const exportBtn = h('button', { type: 'button', class: 'primary' }, ['download SVG']) as HTMLButtonElement

  const setBusy = (on: boolean): void => {
    busy = on
    exportBtn.disabled = on
    cancelBtn.disabled = on
    exportBtn.textContent = on ? 'Generating…' : 'download SVG'
  }

  const runExport = (): void => {
    const name = filenameInput.value.trim() || defaultFilename(subjectId)
    setBusy(true)
    msg.textContent = ''
    msg.className = 'msg'

    try {
      const options: SvgExportOptions = {
        background: isWhiteBackground ? 'white' : 'dark',
        scale: 1,
        separateOverlay: separateOverlayCheck.checked,
        includeAnnotations: annotationsCheck.checked,
        includeLegend: legendCheck.checked,
        filename: name,
      }
      exportSvgFigure(deps, options)
      setBusy(false)
      close(true)
    } catch (e) {
      setBusy(false)
      msg.textContent = errorText(e)
      msg.className = 'msg error'
    }
  }

  exportBtn.addEventListener('click', () => {
    runExport()
  })

  // Build the dialog DOM
  const dialog = h('div', { class: 'dialog export-figure-dialog' }, [
    h('div', { class: 'dialog-head' }, [
      h('div', { class: 'dialog-title-col' }, [
        h('h2', {}, ['Export Figure (.svg)']),
        h('p', { class: 'muted' }, ['Export 2D vector & raster composite.']),
      ]),
      h('span', { class: 'spacer' }),
      closeBtn,
    ]),
    h('div', { class: 'dialog-body' }, [
      field(
        'Layers',
        h('div', { class: 'stack-gap' }, [
          h('label', { class: 'tb-field inline' }, [
            separateOverlayCheck,
            h('span', {}, ['Separate overlay into removable layer']),
            ...(!hasOverlay ? [h('span', { class: 'muted text-sm' }, ['(no overlay active)'])] : []),
          ]),
          h('label', { class: 'tb-field inline' }, [
            annotationsCheck,
            h('span', {}, ['Include visual annotations (crosshairs & orientation)']),
          ]),
          h('label', { class: 'tb-field inline' }, [
            legendCheck,
            h('span', {}, ['Include vector colorbar / legend']),
            ...(!legendInfo ? [h('span', { class: 'muted text-sm' }, ['(no colormap active)'])] : []),
          ]),
        ]),
      ),
      field(
        'Filename',
        h('div', { class: 'stack-gap' }, [
          filenameInput,
          h('span', { class: 'muted text-sm' }, ['Downloads directly to your browser as an .svg file']),
        ]),
      ),
      msg,
    ]),
    h('div', { class: 'dialog-foot' }, [cancelBtn, exportBtn]),
  ])

  overlay.append(dialog)
  document.body.append(overlay)
}
