// Dashboard shell (P1): the v1.2.25 single-screen layout — top bar, slice pane + surface
// pane, right atlas-legend column, bottom info grid. P1 wires the top bar (Monkey across all
// sources, vol/surf selectors, montage layout), the 2-instance MultiView, and base
// volume + surface loading. The right column, info grid, and panel buttons are placeholders
// filled by later phases.
import type { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import type { SourceManager } from '@brainana/core-client/sourceManager.ts'
import type { FilesystemClient, MonkeySummary } from '@brainana/core-client/filesystemClient.ts'
import type { Manifest, ScanSummary, SurfacePair } from '../types.ts'
import { MultiView, MORPH_DEFAULT_COLORMAP, type SurfaceNode, type SurfacePairUrls, type MorphologyDisplay, type MorphologyDisplayMetric, type MorphologyMetric, type MorphologyShapePairs, type CurvatureStyle } from '../niivue/multiView.ts'
import { Marker } from '@brainana/niivue-kit/marker.ts'
import { OrientationGizmo } from '@brainana/niivue-kit/orientation.ts'
import { createViewerStore, type Layout } from '../state/store.ts'
import { groupScans, sameSpace, hasChoice, scanTooltip, scanPickerTooltip } from '../state/scan.ts'
import { FOV_MODES, resolveFovMode, fovTooltip, loadFovPreference, saveFovPreference, type FovMode } from '../state/fovMode.ts'
import { parseAtlasTsv, buildLabelColortable, type AtlasLabel } from '../data/atlas.ts'
import { ARM_SEED } from '../data/colors.ts'
import { finiteExtrema, createFunctionalSurfaceLut, quantizeFunctionalSurfaceValues, maskSurfaceBinsByF, maskSurfaceBinsByValue, maskSurfaceBinsByMagnitude, quantizeScalarToBins, type SurfaceFunctionMode } from '../data/functional.ts'
import { visualFieldStats } from '../data/visualField.ts'
import { parseGiftiFloat32 } from '../data/gifti.ts'
import { RoiLegend } from './roiLegend.ts'
import { createAtlasPanel, type AtlasPanel, type AtlasSelection } from './panels/atlas.ts'
import { createFunctionPanel, choiceKey, type FunctionPanel, type FunctionChoice } from './panels/function.ts'
import { createMorphologyPanel, type MorphologyPanel, type MarkerMode } from './panels/morphology.ts'
import { createLongitudinalPanel, changeKey, hasChangeMaps, type LongitudinalPanel, type ChangeChoice } from './panels/longitudinal.ts'
import { createRoiRateTable, type RoiRateTable } from './roiRateTable.ts'
import { symmetricRobustRange, robustRange, rateUnitLabel, parseSegmentationAgreement, parseRoiRatesCsv, isTimeInterpretable, type Measure, type Statistic } from '../data/longitudinal.ts'
import { drawVisualField } from './visualFieldPlot.ts'
import { h, errorText, selectField, asyncHandler } from '@brainana/ui/dom.ts'
import { createSlider } from '@brainana/ui/components/slider.ts'
import { mountSourcesDialog } from './dialogs/sources.ts'
import { buildColormapAssets, availableColormaps } from '../niivue/colormaps.ts'
import { baseColormapKey, buildColormapRegistry, isReversedKey, reversedKey, toggleReversedKey, type ColormapInfo } from '../data/colormap.ts'
import { surfaceLutFromColormap } from '../data/functional.ts'
import { createColorDisplay, type ColorDisplay, type ColorDisplayTarget } from './components/colorDisplay.ts'
import { collectAtlasRows, collectVertex, collectMorphology, collectRetinotopy, collectSomatotopy, collectVisualFieldPoints } from '../report/collect.ts'
import { BookmarkStore, bookmarkName, sameBookmarkIds } from '../report/bookmarks.ts'
import { mountReportDialog } from '../report/dialog.ts'
import { mountExportFigureDialog } from './dialogs/exportFigure.ts'
import type { LegendExportInfo } from '../export/svgExport.ts'
import type { LocationReadout, ViewState } from '../report/model.ts'
import type { ReportContext } from '../report/generate.ts'

const FALLBACK_GRADIENT = 'linear-gradient(90deg, rgb(20,18,13), rgb(236,230,216))'

interface Deps {
  client: RuntimeClient
  sources: SourceManager
  files: FilesystemClient
}

// 'veryinflated' is deliberately omitted: it has no real FreeSurfer source file (the server
// synthesizes it by puffing 'inflated'), so it isn't offered as a surface.
const SURFACE_ORDER = ['pial', 'white', 'smoothwm', 'inflated', 'sphere'] as const
const SURFACE_LABELS: Record<string, string> = {
  pial: 'pial',
  white: 'white',
  smoothwm: 'smoothwm',
  inflated: 'inflated',
  sphere: 'sphere',
}

const BRAINANA_ASCII_LOGO = `
                                                +++++++
                                       +++++++++++++++++++++++++
                                  +++++++++++++++++++++++++++++++++++
                              +++++++++++++++++++++++++++++++++++++++++++
                            +++++++++++++++++++++++++++++++++++++++++++++++
                         +++++++++++++++++++++++++++++++++++++++++++++++++++++
                       +++++++++++++++++++++++++       +++++++++++++++++++++++++
                     ++++++++++++++++++++                     ++++++++++++++++++++                    +++++++++++++++++++++++              +++++++++++++++++++++++                   +++++++++++++++++++                   ++++++++               +++                         ++++               ++++++++++++++++++              +++                         ++++               ++++++++++++++++++
                    +++++++++++++++++                             +++++++++++++++++                   +++++++++++++++++++++++++            +++++++++++++++++++++++++                +++++++++++++++++++++                  ++++++++               ++++                        ++++             +++++++++++++++++++++             +++++                       ++++             ++++++++++++++++++++++
                  ++++++++++++++++                                   ++++++++++++++++                 ++++++++++++++++++++++++++           ++++++++++++++++++++++++++              +++++++++++++++++++++++                 ++++++++               ++++++                      ++++            ++++++++++++++++++++++++           ++++++                      ++++            ++++++++++++++++++++++++
                 ++++++++++++++                                         ++++++++++++++                +++++++++       +++++++++++          +++++++++        ++++++++++            ++++++++++     ++++++++++                ++++++++               +++++++                     ++++           ++++++++++     ++++++++++           ++++++++                    ++++           ++++++++++      ++++++++++
                +++++++++++++              +++++++++++++++++             ++++++++++++++               +++++++++         +++++++++          +++++++++         ++++++++++          ++++++++++       ++++++++++               ++++++++               +++++++++                   ++++          ++++++++++        +++++++++          +++++++++                   ++++           +++++++++        +++++++++
               +++++++++++++            +++++++++++++++++++++++            +++++++++++++              +++++++++          ++++++++          +++++++++          +++++++++          +++++++++         +++++++++               ++++++++               ++++++++++                  ++++          +++++++++         +++++++++          ++++++++++                  ++++          +++++++++          +++++++++
              +++++++++++++           +++++++++++++++++++++++++++           +++++++++++++             +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++++++++++                ++++          +++++++++          +++++++++         ++++++++++++                ++++          +++++++++          +++++++++
             ++++++++++++           +++++++++++++++++++++++++++++++           ++++++++++++            +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               +++++++++++++               ++++          +++++++++          +++++++++         +++++++++++++               ++++          +++++++++          +++++++++
             +++++++++++           +++++++++++++++++++++++++++++++++           ++++++++++++           +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++++++++++++              ++++          +++++++++          +++++++++         +++++++++++++++             ++++          +++++++++          +++++++++
            +++++++++++           +++++++++  +++++++++++++  +++++++++          ++++++++++++           +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++++++++++++++            ++++          +++++++++          +++++++++         ++++++++++++++++            ++++          +++++++++          +++++++++
           ++++++++++++          +++++++         +++++         +++++++          ++++++++++++          +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               +++++++++++++++++           ++++          +++++++++          +++++++++         ++++++++++++++++++          ++++          +++++++++          +++++++++
           +++++++++++           ++++++            +            ++++++           +++++++++++          +++++++++          ++++++++          +++++++++          ++++++++           +++++++++          ++++++++               ++++++++               +++++++++++++++++++         ++++          +++++++++          +++++++++         +++++++++++++++++++         ++++          +++++++++          +++++++++
           +++++++++++     +++++++++++                           +++++++++++     ++++    +++          +++++++++         ++++++++           +++++++++         ++++++++            +++++++++          ++++++++               ++++++++               ++++++++++++++++++++        ++++          +++++++++          +++++++++         +++++++++++++++++++++       ++++          +++++++++          +++++++++
           ++++++++++     ++ +++++++++                           +++++++++ ++    ++++++++++++         +++++++++        ++++++++            +++++++++        +++++++++            +++++++++          ++++++++               ++++++++               ++++++++++++++++++++++      ++++          +++++++++          +++++++++         ++++++++++++++++++++++      ++++          +++++++++          +++++++++
          +++++++++++     ++    ++++++     +++        +++        ++++++    ++     +++    ++++         +++++++++++++++++++++++              ++++++++++++++++++++++++              +++++++++++++++++++++++++++               ++++++++               ++++  +++++++++++++++++     ++++          ++++++++++++++++++++++++++++         ++++  +++++++++++++++++     ++++          ++++++++++++++++++++++++++++
          +++++++++++      +++++++++++     +++  +     ++++ +     +++++++++++      +++++++++++         ++++++++++++++++++++                 +++++++++++++++++++++                 +++++++++++++++++++++++++++               ++++++++               ++++   ++++++++++++++++++   ++++          ++++++++++++++++++++++++++++         ++++   ++++++++++++++++++   ++++          ++++++++++++++++++++++++++++
          +++++++++++            ++++++     +++         +++     ++++++            +++    ++++         +++++++++++++++++++++++              ++++++++++++++++++++++++++            +++++++++++++++++++++++++++               ++++++++               ++++     +++++++++++++++++  ++++          ++++++++++++++++++++++++++++         ++++     +++++++++++++++++  ++++          ++++++++++++++++++++++++++++
          +++++++++++            +++++                           +++++           ++++++++++++         +++++++++       +++++++++            +++++++++       ++++++++++++          +++++++++         +++++++++               ++++++++               ++++      ++++++++++++++++++++++          +++++++++          +++++++++         ++++      ++++++++++++++++++++++          +++++++++          +++++++++
           +++++++++++          +++                                 +++          +++++++++++          +++++++++         ++++++++           +++++++++         ++++++++++          +++++++++          ++++++++               ++++++++               ++++       +++++++++++++++++++++          +++++++++          +++++++++         ++++        ++++++++++++++++++++          +++++++++          +++++++++
           +++++++++++         +++                 +                 +++         +++++++++++          +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++         +++++++++++++++++++          +++++++++          +++++++++         ++++         +++++++++++++++++++          +++++++++          +++++++++
           ++++++++++++        +++                 +  +              +++        ++++++++++++          +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++          ++++++++++++++++++          +++++++++          +++++++++         ++++          ++++++++++++++++++          +++++++++          +++++++++
            +++++++++++         ++              +++++++              +++        +++++++++++           +++++++++          ++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++            ++++++++++++++++          +++++++++          +++++++++         ++++            ++++++++++++++++          +++++++++          +++++++++
            ++++++++++++        +++                                 +++        ++++++++++++           +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++             +++++++++++++++          +++++++++          +++++++++         ++++             +++++++++++++++          +++++++++          +++++++++
             ++++++++++++        ++++                             ++++        ++++++++++++            +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++               +++++++++++++          +++++++++          +++++++++         ++++               +++++++++++++          +++++++++          +++++++++
              ++++++++++++         ++++                         ++++         ++++++++++++             +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                ++++++++++++          +++++++++          +++++++++         ++++                ++++++++++++          +++++++++          +++++++++
               ++++++++++++          ++++++                 ++++++          +++++++++++++             +++++++++          +++++++++         +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                 +++++++++++          +++++++++          +++++++++         ++++                  ++++++++++          +++++++++          +++++++++
               ++++++++++++++            ++++++++++++++++++++++           +++++++++++++               +++++++++         +++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                   +++++++++          +++++++++          +++++++++         ++++                   +++++++++          +++++++++          +++++++++
                 ++++++++++++++              +++++++++++++              ++++++++++++++                +++++++++        ++++++++++          +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                    ++++++++          +++++++++          +++++++++         ++++                    ++++++++          +++++++++          +++++++++
                  +++++++++++++++                                     +++++++++++++++                 ++++++++++++++++++++++++++           +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                      ++++++          +++++++++          +++++++++         ++++                      ++++++          +++++++++          +++++++++
                   ++++++++++++++                                     ++++++++++++++                  +++++++++++++++++++++++++            +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                       +++++          +++++++++          +++++++++         ++++                       +++++          +++++++++          +++++++++
                     +++++++++++     ++                         ++     +++++++++++                    ++++++++++++++++++++++++             +++++++++          +++++++++          +++++++++          ++++++++               ++++++++               ++++                         +++          +++++++++          +++++++++         ++++                         +++          +++++++++          +++++++++
                       ++++++++     ++++++++               ++++++++     ++++++++                      +++++++++++++++++++++                +++++++++          +++++++++          ++++++++           ++++++++               ++++++++               ++++                          ++          +++++++++          +++++++++         ++++                          ++          +++++++++          +++++++++
                        ++++++     +++++++++++++++++++++++++++++++++     ++++++
                           ++     +++++++++++++++++++++++++++++++++++     ++
                                 +++++++++++++++++++++++++++++++++++++
`.slice(1).trimEnd()

// Build a <dl> of <dt>/<dd> label:value rows for the info panel.
function dlRows(pairs: Array<[string, string | Node]>): HTMLDListElement {
  const dl = h('dl')
  for (const [label, value] of pairs) dl.append(h('dt', {}, [label]), h('dd', {}, [value]))
  return dl
}
function layoutIcon(k: Layout): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 18')
  svg.setAttribute('aria-hidden', 'true')
  const r = (x: number, y: number, w: number, h: number): SVGRectElement => {
    const rect = document.createElementNS(ns, 'rect')
    rect.setAttribute('x', String(x))
    rect.setAttribute('y', String(y))
    rect.setAttribute('width', String(w))
    rect.setAttribute('height', String(h))
    rect.setAttribute('rx', '0.5')
    return rect
  }
  if (k === 'grid') {
    svg.append(r(1, 1, 10, 7), r(13, 1, 10, 7), r(1, 10, 10, 7), r(13, 10, 10, 7))
  } else if (k === 'row') {
    svg.append(r(1, 1, 22, 8), r(1, 11, 6, 6), r(9, 11, 6, 6), r(17, 11, 6, 6))
  } else {
    svg.append(r(1, 1, 8, 4.5), r(1, 6.75, 8, 4.5), r(1, 12.5, 8, 4.5), r(11, 1, 12, 16))
  }
  return svg
}
// Hand-written inline SVG (the project carries no icon library — see layoutIcon above and the
// folder glyph in ui/dialogs/fsPicker.ts). currentColor strokes let an icon inherit its button's
// hover and disabled treatment. A fresh element per call: a Node can only be in one place at a time,
// and the point rows each need their own.
function strokeIcon(size: number, paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}
// Arrow into a tray: marks the report button as something that writes a file out, rather than
// another control that rearranges the view.
function downloadIcon(): SVGSVGElement {
  return strokeIcon(13, ['M12 3v11', 'M7.5 10l4.5 4.5L16.5 10', 'M4 20h16'])
}
// Image icon for SVG figure export.
function exportSvgIcon(): SVGSVGElement {
  return strokeIcon(13, ['M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'])
}
// Crosshair: "move the crosshair here", on a bookmarked point's row.
function crosshairIcon(): SVGSVGElement {
  return strokeIcon(12, ['M12 2.5v5', 'M12 16.5v5', 'M2.5 12h5', 'M16.5 12h5', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'])
}
const LAYOUTS: Array<{ k: Layout; icon: SVGSVGElement; title: string }> = [
  { k: 'grid', icon: layoutIcon('grid'), title: '2×2 grid (3 planes + surface)' },
  { k: 'row', icon: layoutIcon('row'), title: 'Surface on top, planes in a row' },
  { k: 'column', icon: layoutIcon('column'), title: 'Surface on top, planes in a column' },
]
// Only the wired category tabs are shown. Imported/Import/Export are deferred Phase-3 work and
// were previously rendered permanently-disabled (reading as broken) — hidden until implemented.
const PANEL_BUTTONS = ['atlas', 'morphology', 'func map', 'change']
// Camera view presets shown in the surf row (Req 4). Lateral/Medial are hemisphere-aware.
const VIEW_PRESETS: Array<{ k: 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior'; label: string }> = [
  { k: 'lateral', label: 'lat' },
  { k: 'medial', label: 'med' },
  { k: 'ventral', label: 'vent' },
  { k: 'dorsal', label: 'dor' },
  { k: 'anterior', label: 'ant' },
  { k: 'posterior', label: 'pos' },
]

// Prefer a FreeSurfer volume (norm.mgz) as the default base — same space as the surfaces.
function defaultVolumeIndex(volumes: Manifest['volumes']): number {
  const norm = volumes.findIndex((v) => v.key === 'mri/norm.mgz' || v.label.toLowerCase() === 'norm')
  if (norm >= 0) return norm
  const mri = volumes.findIndex((v) => v.key.startsWith('mri/'))
  return mri >= 0 ? mri : 0
}

// Prefer the derived .shape.gii pairs for surface shading; both hemispheres must be present.
function shapePair(pair: SurfacePair | undefined): SurfacePairUrls | undefined {
  return pair?.left && pair?.right ? { left: pair.left, right: pair.right } : undefined
}

function morphologyShapePairs(manifest: Manifest): MorphologyShapePairs {
  const shape = manifest.morphology?.shape
  return { curvature: shapePair(shape?.curvature), sulc: shapePair(shape?.sulc), thickness: shapePair(shape?.thickness) }
}

// Full value domain + default colour range per metric (v1.2.25). Binary curvature is forced ±1.
const MORPH_DOMAIN: Record<MorphologyMetric, { min: number; max: number }> = {
  curvature: { min: -1, max: 1 },
  sulc: { min: -6, max: 6 },
  thickness: { min: 0, max: 4 },
}
const MORPH_DEFAULT_RANGE: Record<MorphologyMetric, { min: number; max: number }> = {
  curvature: { min: -0.2, max: 0.2 },
  sulc: { min: -3, max: 3 },
  thickness: { min: 1, max: 3 },
}

export function mountDashboard(root: HTMLElement, deps: Deps): void {
  const { client, files, sources } = deps
  const { store } = createViewerStore()
  root.innerHTML = ''

  // --- top bar: two rows (vol row + surf row), surf field aligned under the vol field ---
  const monkeySelect = h('select', { id: 'monkey-select' }, [h('option', { value: '' }, ['select sub…'])])
  // Which reconstruction of the selected monkey is on screen. A subject has more than one only
  // when brainana ran at synthesis_level "session" or "session_longitudinal"; with one it stays
  // visible but disabled, so "this dataset has a single reconstruction" is distinguishable from
  // "this build has no scan picker".
  const scanSelect = h('select', { id: 'scan-select', title: scanPickerTooltip(null) }) as HTMLSelectElement
  scanSelect.disabled = true
  const datasetBtn = h('button', { type: 'button', class: 'primary' }, ['dataset'])
  const volCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  volCheck.checked = true
  const volSelect = h('select', { title: 'Base volume (FreeSurfer mri/)', class: 'narrow' })
  // Field-of-view switch: 'full' swaps the underlay to the uncropped conform so a chamber or
  // head-post outside the processing box becomes visible. Same segmented idiom as the view presets.
  const fovBtns = FOV_MODES.map((m) => {
    const b = h('button', { type: 'button', class: 'view-btn', title: m.title }, [m.label]) as HTMLButtonElement
    b.dataset.fov = m.mode
    return b
  })
  const fovGroup = h('div', { class: 'views fov-modes' }, fovBtns)
  const surfCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  surfCheck.checked = true
  const surfSelect = h('select', { title: 'Cortical surface', class: 'narrow' })
  const lhCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  lhCheck.checked = true
  const rhCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  rhCheck.checked = true
  const neighborhoodSelect = h(
    'select',
    { class: 'sm' },
    ['0', '1', '2', '3'].map((n) => h('option', { value: n }, [n])),
  ) as HTMLSelectElement
  // Single-voxel by default: a report quotes the value AT the crosshair, and averaging a 3x3x3 box
  // in (docs/design_guideline/theme.html still shows that as the default) blurs sharp retinotopic
  // gradients across an areal border. Widen it from the dropdown when a smoother estimate is wanted.
  neighborhoodSelect.value = '0'

  const layoutBtns = LAYOUTS.map((l) => {
    const b = h('button', { type: 'button', class: 'layout-btn', title: l.title }, [l.icon])
    b.dataset.layout = l.k
    return b
  })
  const panelBtns = PANEL_BUTTONS.map((name) => h('button', { type: 'button', class: 'panel-btn' }, [name]))
  // Report controls. They are mounted in the left rail's `points` block (assembled with volRail
  // below), not the top bar: the rail is a full-height column, so there is room to list every
  // bookmarked point with a jump-back button instead of reducing them to a count. Both buttons stay
  // disabled until a subject is loaded — there is nothing to sample or describe before that.
  const addPointBtn = h('button', { type: 'button', class: 'ghost rail-btn', title: 'Bookmark the current crosshair for the report' }, ['+ point']) as HTMLButtonElement
  const pointCount = h('span', { class: 'badge point-count', title: 'Bookmarked points' }, ['0'])
  const reportBtn = h(
    'button',
    { type: 'button', class: 'ghost rail-btn report-btn', title: 'Generate an HTML report and export it' },
    [downloadIcon(), h('span', {}, ['generate report…'])],
  ) as HTMLButtonElement
  addPointBtn.disabled = true
  reportBtn.disabled = true

  const exportSvgRailBtn = h(
    'button',
    { type: 'button', class: 'ghost rail-btn export-svg-btn', title: 'Export publication figure (.svg)…' },
    [exportSvgIcon(), h('span', {}, ['export figure (.svg)…'])],
  ) as HTMLButtonElement
  exportSvgRailBtn.disabled = true

  let isWhiteBg = false
  try {
    localStorage.removeItem('brainana_canvas_bg')
  } catch {
    // ignore
  }

  const whiteBgBtn = h(
    'button',
    {
      type: 'button',
      class: 'view-btn bg-toggle-btn',
      title: 'Toggle white background for publication',
    },
    ['white bg'],
  ) as HTMLButtonElement

  let mainEl: HTMLElement | null = null
  const setWhiteBg = (white: boolean): void => {
    isWhiteBg = white
    whiteBgBtn.classList.toggle('active', white)
    whiteBgBtn.title = white ? 'Switch to dark background' : 'Toggle white background for publication'
    if (mainEl) mainEl.dataset.canvasBg = white ? 'white' : 'dark'
    view?.setBackgroundColor(white)
  }
  whiteBgBtn.addEventListener('click', () => setWhiteBg(!isWhiteBg))

  const viewBtns = VIEW_PRESETS.map((v) => {
    const b = h('button', { type: 'button', class: 'view-btn', title: `${v.label} view` }, [v.label])
    b.dataset.view = v.k
    return b
  })

  // --- Marker / Crosshair toolbar controls: show/hide toggles, size, and placement mode ---
  const markerCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  markerCheck.checked = true
  const crosshairCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  crosshairCheck.checked = true
  const orientCheck = h('input', { type: 'checkbox' }) as HTMLInputElement
  orientCheck.checked = true
  markerCheck.addEventListener('change', () => {
    marker?.setVisible(markerCheck.checked)
    if (markerCheck.checked) placeMarker()
  })
  crosshairCheck.addEventListener('change', () => view?.setCrosshairVisible(crosshairCheck.checked))
  orientCheck.addEventListener('change', () => view?.setSliceOrientationVisible(orientCheck.checked))
  const markerSize = createSlider({
    label: 'size',
    min: 0.3,
    max: 3,
    step: 0.1,
    value: 1,
    hideBox: true, // tight toolbar slot; the number box overflowed onto the mode select
    onInput: (v) => {
      marker?.setSize(v)
      placeMarker()
    },
  })
  const markerModeSel = selectField(
    'mode',
    [
      { value: 'crosshair3d', label: '3D crosshair' },
      { value: 'nearestNode', label: 'nearest vertex' },
    ],
    (value) => {
      markerMode = value as MarkerMode
      placeMarker()
    },
  )
  markerModeSel.setValue('nearestNode')
  // Apply the current toolbar states to the freshly-created view/marker (called on subject load).
  const syncMarkerControls = (): void => {
    marker?.setSize(markerSize.value())
    marker?.setVisible(markerCheck.checked)
    view?.setCrosshairVisible(crosshairCheck.checked)
    view?.setSliceOrientationVisible(orientCheck.checked)
    markerMode = markerModeSel.value() as MarkerMode
  }

  // The bar is a WRAPPING ROW OF CLUSTERS. Each `tb-group` is its own two-row grid holding the two
  // stacked cells that belong together, separated from its neighbour by a leading hairline (CSS).
  // Grouping them this way is what makes the bar safe at any width: when the window is too narrow a
  // whole cluster drops to the next bar row, instead of a single cell re-wrapping and splitting a
  // button group down the middle (which is how the four category tabs ended up 3 + 1).
  // At the compact tier the marker field labels are clipped, so name them for the mouse too — the
  // words stay in the <label>s, so the accessible names are unaffected either way.
  markerSize.element.title = 'Marker size'
  markerModeSel.element.title = 'Marker placement mode'
  const tbGroup = (cls: string, cells: HTMLElement[]): HTMLElement =>
    h('div', { class: cls ? `tb-group ${cls}` : 'tb-group' }, cells)
  const toolbar = h('header', { class: 'toolbar' }, [
    // title (row 1) · version + dataset (row 2)
    tbGroup('', [
      h('div', { class: 'tb-cell brand' }, ['Brainana Viewer']),
      h('div', { class: 'tb-cell' }, [h('span', { class: 'tb-version' }, [`v${__APP_VERSION__}`]), datasetBtn]),
    ]),
    // sub (row 1) · ses / reconstruction (row 2)
    tbGroup('', [
      h('div', { class: 'tb-cell' }, [h('label', { class: 'tb-field inline' }, [h('span', {}, ['sub']), monkeySelect])]),
      h('div', { class: 'tb-cell' }, [h('label', { class: 'tb-field inline' }, [h('span', {}, ['ses']), scanSelect])]),
    ]),
    // vol (row 1) · surf (row 2). LH/RH live in the hemisphere/marker cluster (freed by the underlay rail).
    tbGroup('', [
      h('div', { class: 'tb-cell' }, [
        h('label', { class: 'tb-field inline tb-layer-row' }, [volCheck, h('span', { class: 'tb-layer-name' }, ['vol']), volSelect]),
        h('label', { class: 'tb-field inline' }, [h('span', {}, ['FOV']), fovGroup]),
      ]),
      h('div', { class: 'tb-cell' }, [
        h('label', { class: 'tb-field inline tb-layer-row' }, [surfCheck, h('span', { class: 'tb-layer-name' }, ['surf']), surfSelect]),
      ]),
    ]),
    // view section — slice montage layouts + white bg (row 1) · surface view presets (row 2)
    tbGroup('', [
      h('div', { class: 'tb-cell' }, [h('div', { class: 'montage' }, layoutBtns), h('div', { class: 'tb-view-tools' }, [whiteBgBtn])]),
      h('div', { class: 'tb-cell' }, [h('div', { class: 'views' }, viewBtns)]),
    ]),
    // LH/RH hemisphere toggles in the vol row (row 1) — occupying the slot vacated by the crosshair +
    // AP/SI/LR toggles, which now live in the right-hand underlay rail; surface marker + size +
    // placement mode in the surf row (row 2).
    tbGroup('', [
      h('div', { class: 'tb-cell' }, [
        h('label', { class: 'tb-field inline' }, [lhCheck, h('span', {}, ['LH'])]),
        h('label', { class: 'tb-field inline' }, [rhCheck, h('span', {}, ['RH'])]),
      ]),
      h('div', { class: 'tb-cell marker-controls' }, [
        h('label', { class: 'tb-field inline' }, [markerCheck, h('span', {}, ['marker'])]),
        markerSize.element,
        markerModeSel.element,
      ]),
    ]),
    // Category tabs, as a 2x2 block across both rows — the report controls that used to fill the
    // second row moved to the left rail's `points` block, which has room to show the points
    // themselves, and four tabs on one line is the single widest thing in the bar.
    h('div', { class: 'tb-group tb-tabs' }, panelBtns),
  ])
  // Flex wrapping is invisible to CSS, so a cluster that starts a NEW bar row would draw an orphan
  // leading hairline against the bar's left padding. Tag the row-starters by offsetTop and let the
  // stylesheet drop the rule there.
  const tbGroups = [...toolbar.querySelectorAll<HTMLElement>('.tb-group')]
  const markToolbarRowStarts = (): void => {
    let prevTop = -1
    for (const g of tbGroups) {
      g.classList.toggle('tb-row-start', g.offsetTop !== prevTop)
      prevTop = g.offsetTop
    }
  }
  new ResizeObserver(markToolbarRowStarts).observe(toolbar)

  // --- main grid ---
  const slicesCanvas = h('canvas', { id: 'slices', class: 'nv-canvas' }) as HTMLCanvasElement
  const surfaceCanvas = h('canvas', { id: 'surface', class: 'nv-canvas' }) as HTMLCanvasElement
  const slicePane = h('div', { class: 'slice-pane' }, [slicesCanvas])
  const surfacePane = h('div', { class: 'surface-pane' }, [surfaceCanvas])
  const viewerArea = h('div', { class: 'viewer-area' }, [slicePane, surfacePane])
  // Splitter for the surf-pane / side-panel boundary. It's a direct child of `main` (not the
  // aside) anchored to the column seam via CSS, so it's reliably on top and grabbable (Req 4).
  const panelResizer = h('div', { class: 'panel-resizer', title: 'Drag to resize the panel' })
  const infoResizer = h('div', { class: 'info-resizer', title: 'Drag to resize the info panel' })
  // Splitter on the underlay rail's right edge — drags --rail-w, sizing the rail column only. The
  // Coordinates info column starts at its own 168px and is independent (its own --info-c1 seam).
  const railResizer = h('div', { class: 'rail-resizer', title: 'Drag to resize the underlay rail' })
  // The side panel docks the active category's picker at the top (`sidePicker`) with
  // category-specific content below (`sideContent`): the atlas ROI legend, or a light caption for
  // function / morphology. Exactly one content slot is visible at a time (driven by `updateTabUI`).
  const sidePicker = h('div', { class: 'side-picker' })
  const legendSlot = h('div', { class: 'side-slot', hidden: true })
  // Function/morphology side-content slots carry no caption — the active selection is already shown
  // by the highlighted chip in the docked panel above, so a descriptive caption is redundant.
  const funcSlot = h('div', { class: 'side-slot', hidden: true })
  const changeSlot = h('div', { class: 'side-slot change-slot', hidden: true })
  const morphSlot = h('div', { class: 'side-slot', hidden: true })
  const sidePlaceholder = h('div', { class: 'legend-title muted' }, ['Select atlas, morphology, or function above.'])
  const sideContent = h('div', { class: 'side-content' }, [legendSlot, funcSlot, changeSlot, morphSlot, sidePlaceholder])
  // Docked at the bottom of the side panel: the shared "Color display" section (colormap + legend +
  // display range + clip), mounted once the view/colormaps exist. Applies to the active overlay.
  const colorDock = h('div', { class: 'color-dock' })
  const atlasLegend = h('aside', { class: 'atlas-legend' }, [sidePicker, sideContent, colorDock])
  // Each column is a flex box: a fixed (non-scrolling) header + an `.info-scroll` region that owns
  // the overflow, so the title stays put while only its content scrolls.
  const infoPanel = h('section', { class: 'info-panel' }, [
    h('div', { class: 'info-col' }, [h('h3', {}, ['Coordinates']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-coordinates', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Atlas']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-anatomy', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Surface']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-surface', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [h('h3', {}, ['Func Map']), h('div', { class: 'info-scroll' }, [h('div', { id: 'report-function', class: 'muted' }, ['—'])])]),
    h('div', { class: 'info-col' }, [
      h('div', { class: 'vf-header' }, [
        h('h3', {}, ['Visual field']),
        h('label', { class: 'neighborhood-control' }, [h('span', {}, ['neighborhood']), neighborhoodSelect]),
      ]),
      h('div', { class: 'info-scroll' }, [
        h('canvas', { id: 'visual-field-canvas', class: 'vf-canvas' }),
        h('div', { id: 'report-visual-note', class: 'muted' }, ['Add retinotopy in FUNC MAP first']),
      ]),
    ]),
  ])
  const placeholderText = h('p', { class: 'placeholder-text' }, ['Select a dataset, then choose a sub to begin'])
  const asciiEl = h('pre', { class: 'monkey-ascii' }, [BRAINANA_ASCII_LOGO])
  const placeholderContent = h('div', { class: 'placeholder-content' }, [asciiEl, placeholderText])
  const placeholder = h('div', { class: 'monkey-placeholder' }, [placeholderContent])
  {
    const fitAsciiLogo = (): void => {
      asciiEl.style.fontSize = '1px'
      const width = placeholder.clientWidth
      if (width <= 0 || asciiEl.scrollWidth <= 0) return
      const ratio = width / asciiEl.scrollWidth
      asciiEl.style.fontSize = `${Math.min(ratio * 0.88, 4)}px`
    }
    const ro = new ResizeObserver(fitAsciiLogo)
    ro.observe(placeholder)
    requestAnimationFrame(fitAsciiLogo)
  }
  const loadingText = h('div', { class: 'loading-text' }, ['Loading…'])
  const loadingOverlay = h('div', { class: 'loading-overlay', hidden: true }, [h('div', { class: 'spinner' }), loadingText])
  const main = h('main', { class: 'dashboard' }, [viewerArea, atlasLegend, panelResizer, infoResizer, railResizer, infoPanel, placeholder, loadingOverlay])
  mainEl = main
  if (isWhiteBg) main.dataset.canvasBg = 'white'

  // --- right underlay rail: base-volume intensity window (brightness/contrast ↔ display min/max),
  // value clip, montage zoom, plus the crosshair + AP/SI/LR toggles moved out of the top bar. All
  // four intensity controls drive the same cal_min/cal_max window (NiiVue has no separate brightness);
  // brightness=center, contrast=width, display boxes=ends — edits on either side mirror to the other.
  let volGlobalMin = 0
  let volGlobalMax = 1
  let volRobustMin = 0
  let volRobustMax = 1
  let volCalLo = 0
  let volCalHi = 1
  let volClipLo: number | null = null
  let volClipHi: number | null = null
  let volSyncing = false // suppress the slider→box→slider feedback loop while mirroring

  const fmtVol = (v: number): string => v.toFixed(4)
  const numBox = (): HTMLInputElement => h('input', { type: 'number', class: 'range-num' }) as HTMLInputElement
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))
  const volSpan = (): number => volGlobalMax - volGlobalMin || 1

  const f2 = (v: number): string => v.toFixed(2)
  const briSlider = createSlider({ label: 'brightness', min: 0, max: 1, step: 0.01, value: 0.5, format: f2, onInput: () => onBriConInput() })
  const conSlider = createSlider({ label: 'contrast', min: 0, max: 1, step: 0.01, value: 0.5, format: f2, onInput: () => onBriConInput() })
  const zoomSlider = createSlider({ label: 'zoom', min: 0.5, max: 4, step: 0.1, value: 1, format: f2, onInput: (v) => view?.setVolumeZoom(v) })
  const dispMinBox = numBox()
  const dispMaxBox = numBox()
  const clipMinBox = numBox()
  const clipMaxBox = numBox()

  const applyVolumeWindow = (): void => view?.setVolumeWindow(volCalLo, volCalHi, volClipLo, volClipHi)
  const setDisplayBoxes = (): void => {
    dispMinBox.value = fmtVol(volCalLo)
    dispMaxBox.value = fmtVol(volCalHi)
  }
  // Window ends → brightness/contrast sliders. brighter = lower window center; more contrast = narrower.
  const windowToSliders = (): void => {
    const s = volSpan()
    const width = volCalHi - volCalLo
    const center = (volCalLo + volCalHi) / 2
    volSyncing = true
    conSlider.setValue(clamp01(1 - width / s))
    briSlider.setValue(clamp01(1 - (center - volGlobalMin) / s))
    volSyncing = false
  }
  // Brightness/contrast sliders → window ends, then reflect into the display boxes.
  const slidersToWindow = (): void => {
    const s = volSpan()
    let width = s * (1 - conSlider.value())
    const minWidth = s * 0.005 // guard: never a zero/negative window
    if (width < minWidth) width = minWidth
    const center = volGlobalMin + (1 - briSlider.value()) * s
    volCalLo = Math.max(volGlobalMin, center - width / 2)
    volCalHi = Math.min(volGlobalMax, center + width / 2)
    setDisplayBoxes()
    applyVolumeWindow()
  }
  const onBriConInput = (): void => {
    if (volSyncing) return
    slidersToWindow()
  }
  const onDisplayBoxEdit = (): void => {
    let lo = Number(dispMinBox.value)
    let hi = Number(dispMaxBox.value)
    if (!Number.isFinite(lo)) lo = volCalLo
    if (!Number.isFinite(hi)) hi = volCalHi
    if (lo > hi) [lo, hi] = [hi, lo] // swap an inverted entry so the window stays valid
    // Clamp to the volume's real extents so the derived brightness/contrast sliders (windowToSliders
    // maps the window into [0,1]) can represent the window — an out-of-range entry would otherwise
    // pin a slider to its rail and the next drag would snap the window back, discarding the typed value.
    volCalLo = Math.max(volGlobalMin, Math.min(volGlobalMax, lo))
    volCalHi = Math.max(volGlobalMin, Math.min(volGlobalMax, hi))
    setDisplayBoxes()
    windowToSliders()
    applyVolumeWindow()
  }
  const onClipBoxEdit = (): void => {
    const lo = clipMinBox.value.trim() === '' ? NaN : Number(clipMinBox.value)
    const hi = clipMaxBox.value.trim() === '' ? NaN : Number(clipMaxBox.value)
    let clipLo = Number.isFinite(lo) ? lo : null // empty / non-numeric = open on that side
    let clipHi = Number.isFinite(hi) ? hi : null
    // Swap an inverted [lo, hi] (matching onDisplayBoxEdit) so it never collapses to an empty window
    // that masks the whole underlay to black with no feedback. Only meaningful when both ends are set.
    if (clipLo !== null && clipHi !== null && clipLo > clipHi) {
      ;[clipLo, clipHi] = [clipHi, clipLo]
      clipMinBox.value = fmtVol(clipLo)
      clipMaxBox.value = fmtVol(clipHi)
    }
    volClipLo = clipLo
    volClipHi = clipHi
    applyVolumeWindow()
  }
  dispMinBox.addEventListener('change', onDisplayBoxEdit)
  dispMaxBox.addEventListener('change', onDisplayBoxEdit)
  clipMinBox.addEventListener('change', onClipBoxEdit)
  clipMaxBox.addEventListener('change', onClipBoxEdit)

  const setVolRailEnabled = (on: boolean): void => {
    briSlider.setDisabled(!on)
    conSlider.setDisabled(!on)
    zoomSlider.setDisabled(!on)
    for (const b of [dispMinBox, dispMaxBox, clipMinBox, clipMaxBox]) b.disabled = !on
  }
  // Seed (on load) or restore (Reset) the rail to the volume's defaults: display window = robust
  // range, clip cleared, zoom = 1. No-op with the controls disabled when no base volume is present.
  const syncVolumeControls = (): void => {
    const r = view?.baseVolumeRange()
    if (!r) {
      setVolRailEnabled(false)
      underlayBlock.hidden = true // no base volume — keep its controls out of the rail (points stay)
      return
    }
    underlayBlock.hidden = false
    setVolRailEnabled(true)
    volGlobalMin = r.globalMin
    volGlobalMax = r.globalMax
    volRobustMin = r.robustMin
    volRobustMax = r.robustMax
    volCalLo = volRobustMin
    volCalHi = volRobustMax
    volClipLo = null
    volClipHi = null
    clipMinBox.value = ''
    clipMaxBox.value = ''
    setDisplayBoxes()
    windowToSliders()
    zoomSlider.setValue(1)
    view?.resetVolumeZoom() // neutral centred pan+zoom (not a crosshair-anchored zoom-to-1)
    applyVolumeWindow()
  }

  const volResetBtn = h('button', { type: 'button', class: 'ghost sm' }, ['reset']) as HTMLButtonElement
  volResetBtn.addEventListener('click', () => syncVolumeControls())
  // Shared 3-column grid: [label (52px)] [min/max span (auto)] [number input (1fr)]
  // All four rows (display-min, display-max, clip-min, clip-max) share the same column edges.
  const volDisplayClipGrid = h('div', { class: 'vol-dc-grid' }, [
    h('span', { class: 'vol-dc-label' }, ['display']),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['min']), dispMinBox]),
    h('span', { class: 'vol-dc-label' }),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['max']), dispMaxBox]),
    h('span', { class: 'vol-dc-label' }, ['clip']),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['min']), clipMinBox]),
    h('span', { class: 'vol-dc-label' }),
    h('label', { class: 'vol-dc-row' }, [h('span', { class: 'vol-dc-mm' }, ['max']), clipMaxBox]),
  ])
  // The image-display half of the rail. Hidden on its own (not with the whole rail) when the subject
  // has no base volume, so the points block below it survives that case.
  const underlayBlock = h('div', { class: 'rail-block' }, [
    h('div', { class: 'vol-rail-head' }, [h('span', { class: 'vol-rail-title' }, ['underlay']), volResetBtn]),
    briSlider.element,
    conSlider.element,
    volDisplayClipGrid,
    h('div', { class: 'vol-rail-toggles' }, [
      zoomSlider.element,
      h('label', { class: 'tb-field inline' }, [crosshairCheck, h('span', {}, ['crosshair'])]),
      h('label', { class: 'tb-field inline' }, [orientCheck, h('span', {}, ['AP/SI/LR'])]),
    ]),
  ])
  // The points half: add button, a collapsible list of the bookmarked points (filled by
  // renderPoints() once the BookmarkStore exists), and the report export. Reuses the .group
  // collapsible from style.css — its caret is a ::before on .group-head.
  const pointList = h('div', { class: 'group-body point-list' })
  const pointListHead = h('button', { type: 'button', class: 'group-head', title: 'Show or hide the bookmarked points' }, ['bookmarked'])
  const pointListGroup = h('div', { class: 'group point-list-group' }, [pointListHead, pointList])
  pointListHead.addEventListener('click', () => pointListGroup.classList.toggle('collapsed'))
  const pointsBlock = h('div', { class: 'rail-block points-block' }, [
    h('div', { class: 'vol-rail-head' }, [h('span', { class: 'vol-rail-title' }, ['points']), pointCount]),
    addPointBtn,
    pointListGroup,
    exportSvgRailBtn,
    reportBtn,
  ])
  const volRail = h('aside', { class: 'vol-rail' }, [underlayBlock, pointsBlock])
  setVolRailEnabled(false) // disabled until a base volume loads
  volRail.hidden = true // hidden on the welcome screen; revealed by syncReportControls once a subject loads
  // Rail is col 1 / row 1 of the dashboard grid, so it stops at the info panel (row 2) and the
  // info panel — spanning grid-column 1/-1 — reaches under it to the far-left edge.
  main.insertBefore(volRail, main.firstChild)

  root.append(toolbar, h('div', { class: 'content-row' }, [main]))

  // The viewport height settles only after the fullscreen transition finishes — the initial
  // layout can be a few px short, leaving a first-paint artifact at the bottom edge that only
  // cleared when the user resized. Nudge one relayout after the browser has painted so it
  // self-corrects. (100dvh on #app handles the sizing; this repaints away any stale edge.)
  requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))))

  // #4 Draggable seams between the 5 bottom info subpanels. Each seam adjusts the px width of the
  // column to its left (cols 1..4, stored in --info-cN); the last column flexes to fill. The handles
  // float over the seams and are repositioned whenever the panel or a column resizes.
  {
    const cols = Array.from(infoPanel.querySelectorAll('.info-col')) as HTMLElement[]
    const MIN_COL = 90
    const handles: HTMLElement[] = []
    const reposition = (): void => {
      const base = infoPanel.getBoundingClientRect().left
      handles.forEach((handle, k) => {
        handle.style.left = `${cols[k].getBoundingClientRect().right - base}px`
      })
    }
    for (let k = 0; k < cols.length - 1; k++) {
      const handle = h('div', { class: 'info-vresizer', title: 'Drag to resize the subpanels' })
      let dragging = false
      handle.addEventListener('pointerdown', (e) => {
        dragging = true
        handle.setPointerCapture(e.pointerId)
        e.preventDefault()
      })
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return
        const left = cols[k].getBoundingClientRect().left
        const w = Math.max(MIN_COL, e.clientX - left)
        infoPanel.style.setProperty(`--info-c${k + 1}`, `${Math.round(w)}px`)
        reposition()
      })
      const end = (e: PointerEvent): void => {
        if (!dragging) return
        dragging = false
        try {
          handle.releasePointerCapture(e.pointerId)
        } catch {
          /* pointer already released */
        }
      }
      handle.addEventListener('pointerup', end)
      handle.addEventListener('pointercancel', end)
      handles.push(handle)
      infoPanel.append(handle)
    }
    reposition()
    new ResizeObserver(reposition).observe(infoPanel)
  }

  // Drag the boundary between the viewer area and the right atlas panel: update the
  // --legend-width grid track live (the dashboard grid is `minmax(0,1fr) var(--legend-width)`).
  {
    let dragging = false
    const setWidth = (clientX: number): void => {
      const rect = main.getBoundingClientRect()
      const w = Math.max(160, Math.min(rect.width - 320, rect.right - clientX))
      document.documentElement.style.setProperty('--legend-width', `${Math.round(w)}px`)
      view?.resize()
    }
    panelResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      panelResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    panelResizer.addEventListener('pointermove', (e) => {
      if (dragging) setWidth(e.clientX)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        panelResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    panelResizer.addEventListener('pointerup', end)
    panelResizer.addEventListener('pointercancel', end)
  }

  // Drag the underlay rail's right edge: update --rail-w (the shared base width of the rail column
  // and the Coordinates info column). Clamped so the rail never starves the viewer or collapses.
  {
    let dragging = false
    const setWidth = (clientX: number): void => {
      const rect = main.getBoundingClientRect()
      const w = Math.max(120, Math.min(rect.width - 360, clientX - rect.left))
      main.style.setProperty('--rail-w', `${Math.round(w)}px`)
      view?.resize()
    }
    railResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      railResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    railResizer.addEventListener('pointermove', (e) => {
      if (dragging) setWidth(e.clientX)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        railResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    railResizer.addEventListener('pointerup', end)
    railResizer.addEventListener('pointercancel', end)
  }

  // No more persistent "Ready · …" status (Req 5). Loading/errors surface in a centered overlay
  // over the viewer while a subject renders (Req 17); other transient progress is dropped.
  const showLoading = (text: string): void => {
    loadingText.textContent = text
    loadingText.classList.remove('error')
    loadingOverlay.classList.remove('is-error')
    loadingOverlay.hidden = false
  }
  const hideLoading = (): void => {
    loadingOverlay.hidden = true
  }
  const showError = (text: string): void => {
    loadingText.textContent = text
    loadingText.classList.add('error')
    loadingOverlay.classList.add('is-error')
    loadingOverlay.hidden = false
  }
  // --- state wiring ---
  let view: MultiView | null = null
  let marker: Marker | null = null
  let gizmo: OrientationGizmo | null = null
  let manifest: Manifest | null = null
  let currentNode: SurfaceNode | null = null

  // Editable crosshair coordinates: X/Y/Z (world mm) and I/J/K (base-volume voxel). Typing a value
  // moves the crosshair; the fields refresh from the crosshair on each move (except the one being
  // edited, so typing isn't clobbered). Built once; `update()` writes values, never rebuilds the DOM.
  const coordEditor = (() => {
    const num = (step: string): HTMLInputElement => h('input', { type: 'number', step, class: 'coord-num' }) as HTMLInputElement
    const xIn = num('0.1')
    const yIn = num('0.1')
    const zIn = num('0.1')
    const iIn = num('1')
    const jIn = num('1')
    const kIn = num('1')
    const hemiEl = h('dd', {}, ['—'])
    // Read-only probe of the active overlay's value at the crosshair. The <dt> label is the overlay
    // name/metric (set dynamically), the <dd> its formatted value; both driven by updateOverlayValue().
    const overlayDt = h('dt', {}, ['overlay'])
    const overlayEl = h('dd', {}, ['—'])
    const commitMm = (): void => {
      const mm: [number, number, number] = [Number(xIn.value), Number(yIn.value), Number(zIn.value)]
      if (mm.some((v) => Number.isNaN(v))) return
      view?.moveCrosshairToWorld(mm)
    }
    const commitVox = (): void => {
      const ijk: [number, number, number] = [Number(iIn.value), Number(jIn.value), Number(kIn.value)]
      if (ijk.some((v) => Number.isNaN(v))) return
      const mm = view?.voxToWorld(ijk)
      if (mm) view?.moveCrosshairToWorld(mm)
    }
    for (const inp of [xIn, yIn, zIn]) inp.addEventListener('change', commitMm)
    for (const inp of [iIn, jIn, kIn]) inp.addEventListener('change', commitVox)
    const row = (label: string, input: HTMLElement): Node[] => [h('dt', {}, [label]), h('dd', {}, [input])]
    const el = h('dl', { class: 'coord-dl' }, [
      ...row('X (mm)', xIn),
      ...row('Y (mm)', yIn),
      ...row('Z (mm)', zIn),
      ...row('I', iIn),
      ...row('J', jIn),
      ...row('K', kIn),
      h('dt', {}, ['hemi']),
      hemiEl,
      overlayDt,
      overlayEl,
    ])
    const put = (inp: HTMLInputElement, v: string): void => {
      if (document.activeElement !== inp) inp.value = v
    }
    const update = (mm: [number, number, number], ijk: [number, number, number] | null, hemi: string): void => {
      put(xIn, mm[0].toFixed(2))
      put(yIn, mm[1].toFixed(2))
      put(zIn, mm[2].toFixed(2))
      put(iIn, ijk ? String(ijk[0]) : '')
      put(jIn, ijk ? String(ijk[1]) : '')
      put(kIn, ijk ? String(ijk[2]) : '')
      hemiEl.textContent = hemi
    }
    // Set the overlay probe row's value ('—' when nothing is overlaid). The <dt> stays 'overlay'.
    const setOverlay = (value: string | null): void => {
      overlayEl.textContent = value ?? '—'
    }
    return { el, update, setOverlay }
  })()
  // Mount the editable editor into the Coordinates subpanel (built into the info panel above).
  {
    const coordHost = document.getElementById('report-coordinates')
    if (coordHost) {
      coordHost.classList.remove('muted')
      coordHost.replaceChildren(coordEditor.el)
    }
  }

  // Effective pane visibility (Req: hide vol/surf pane when unchecked). Never hide both: if both
  // boxes are off, keep the pane whose box was unchecked most recently (user's choice).
  let lastUnchecked: 'vol' | 'surf' = 'vol'
  const paneState = (): { vol: boolean; surf: boolean } => {
    let vol = volCheck.checked
    let surf = surfCheck.checked
    // Both panes off is not a state the layout can render, so the one unchecked LEAST recently
    // comes back on.
    if (!vol && !surf) {
      if (lastUnchecked === 'vol') vol = true
      else surf = true
    }
    return { vol, surf }
  }
  // Hide the unchecked pane's grid track and resize the remaining panel(s) to fill.
  const applyPaneVisibility = (): void => {
    const { vol, surf } = paneState()
    main.dataset.vol = vol ? 'on' : 'off'
    main.dataset.surf = surf ? 'on' : 'off'
    view?.resize()
  }
  // Hemisphere shown = surf pane visible AND that hemisphere's LH/RH checkbox.
  const applyHemiVisibility = (): void => {
    if (!view) return
    const surf = paneState().surf
    view.setHemisphereVisible(0, surf && lhCheck.checked)
    view.setHemisphereVisible(1, surf && rhCheck.checked)
  }
  // Which hemisphere Lat/Med orient to: left when LH is on, else right.
  const preferHemi = (): 0 | 1 => (lhCheck.checked ? 0 : 1)

  // --- morphology shading + yellow-marker state ---
  let morphPanel: MorphologyPanel | null = null
  let morphMetric: MorphologyDisplayMetric = 'curvature'
  let morphStyle: CurvatureStyle = 'binary'
  const morphRanges: Record<MorphologyMetric, { min: number; max: number }> = {
    curvature: { ...MORPH_DEFAULT_RANGE.curvature },
    sulc: { ...MORPH_DEFAULT_RANGE.sulc },
    thickness: { ...MORPH_DEFAULT_RANGE.thickness },
  }
  // Per-metric colormap override for the continuous morphology layers (binary curvature is fixed).
  const morphColormaps: Partial<Record<MorphologyMetric, string>> = { ...MORPH_DEFAULT_COLORMAP }
  // Per-metric two-sided clip (as in function): vertices outside [lo, hi] render transparent. Default
  // open (full domain).
  const morphClip: Record<MorphologyMetric, { lo: number | null; hi: number | null }> = {
    curvature: { lo: null, hi: null },
    sulc: { lo: null, hi: null },
    thickness: { lo: null, hi: null },
  }
  let markerMode: MarkerMode = 'nearestNode'
  let lastCrosshairMm: [number, number, number] | null = null
  const morphDisplay = (): MorphologyDisplay => ({ metric: morphMetric, curvatureStyle: morphStyle, ranges: morphRanges, colormaps: morphColormaps, clip: morphClip[morphActiveMetric()] })

  const placeMarker = (): void => {
    if (!view) return
    if (!paneState().surf) {
      marker?.setWorld(null) // no marker while the surface is hidden (Req 6)
      return
    }
    // crosshair3d pins the raw crosshair world coord; nearestNode snaps to the reference vertex.
    if (markerMode === 'crosshair3d' && lastCrosshairMm) {
      marker?.setWorld(lastCrosshairMm, null)
      return
    }
    if (!currentNode) return
    marker?.setWorld(view.nodeWorld(currentNode), view.nodeWorldNormal(currentNode))
  }

  // --- atlas state ---
  const legend = new RoiLegend(legendSlot, { onHiddenChange: (hidden) => applyHidden(hidden) })
  let atlasPanel: AtlasPanel | null = null
  let atlasEntries: AtlasLabel[] = []
  let atlasSeed = ARM_SEED
  let atlasOpacity = 0.7
  let atlasSurfacePair: { left: string; right: string } | null = null
  let atlasHidden = new Set<number>()

  // Which category's picker is docked at the top of the side panel (drives the button highlight and
  // the visible content slot). Atlas and Function are mutually-exclusive overlays; Morphology is an
  // always-on base underlay, so its tab leaves the active overlay untouched. `lastAtlasSel` /
  // `lastFuncChoice` remember each overlay's selection so re-entering its tab restores it.
  let dockedTab: 'atlas' | 'morphology' | 'function' | 'longitudinal' | null = null
  let lastAtlasSel: AtlasSelection | null = null
  let lastFuncChoice: FunctionChoice | null = null
  let lastChangeChoice: ChangeChoice | null = null

  function applyHidden(hidden: Set<number>): void {
    if (!view || atlasEntries.length === 0) return
    atlasHidden = hidden
    applyAtlasColormap()
  }

  // Apply the current atlas colormap to BOTH the volume slices and the 3D surface (Req: a colormap
  // change must recolor both). Categorical (`atlasColormap === null`, "none"): the per-ROI label
  // table; visibility is driven solely by the ROI list (atlasHidden) — labels mode has no display
  // range or clip. Continuous (a colormap key — default for float atlases, or forced onto a
  // parcellation): quantize values over the display window into a shared ramp LUT (identical on
  // volume + surface) and mask voxels/vertices outside the clip window.
  function applyAtlasColormap(): void {
    if (!view) return
    if (atlasColormap) {
      const cmapLut = colormapLuts[atlasColormap] ?? view.colormapLut(atlasColormap)
      if (!cmapLut) return
      const range = { min: atlasDisplayMin, max: atlasDisplayMax }
      const clip = { lo: atlasClipLo, hi: atlasClipHi }
      view.setAtlasContinuous(cmapLut, range, clip) // volume slices
      if (atlasSurfacePair) void view.setAtlasSurfaceContinuous(atlasSurfacePair, cmapLut, range, atlasOpacity, clip) // surface
    } else {
      if (atlasEntries.length) view.setAtlasColortable(buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden })) // slices (keeps negatives)
      void view.updateSurfaceOverlayTable(buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden, clipNegative: true })) // surface
    }
  }

  // Current atlas surface overlay descriptor (per-hemi .func.gii + colortable), or null.
  const buildSurfaceOverlay = () =>
    atlasSurfacePair && atlasEntries.length
      ? { left: atlasSurfacePair.left, right: atlasSurfacePair.right, table: buildLabelColortable(atlasEntries, { seed: atlasSeed, hidden: atlasHidden, clipNegative: true }) }
      : null
  // Swap ONLY the surface overlay layer in place — no base-mesh reload, so the surface doesn't
  // blank when the atlas/map changes (Req 7). Used for atlas selection; surface-type changes
  // still go through applySurface (which reloads geometry).
  const applyOverlay = async (): Promise<void> => {
    if (!view) return
    await view.setSurfaceOverlay(buildSurfaceOverlay())
  }

  let atlasToken = 0
  const selectAtlas = async (sel: AtlasSelection | null): Promise<void> => {
    if (!view || !manifest) return
    const token = ++atlasToken // latest-wins guard against rapid atlas switches
    atlasColormap = null // a new atlas selection starts categorical
    atlasPanel?.setActive(sel)
    if (!sel) {
      view.removeAtlas()
      legend.clear()
      atlasEntries = []
      atlasSurfacePair = null
      atlasHidden = new Set()
      atlasContinuous = false
      await applyOverlay() // drop the atlas surface layer in place (no reload)
      refreshColorDisplay()
      return
    }
    const entry = manifest.atlases.find((a) => a.name === sel.name)
    if (!entry) return
    atlasSeed = ARM_SEED
    const title = entry.label
    try {
      let parsed: AtlasLabel[] = []
      if (entry.labels) {
        const tsv = await (await client.apiFetch(entry.labels)).text()
        parsed = parseAtlasTsv(tsv)
      }
      await view.loadAtlasOverlay(entry.volume, atlasOpacity, entry.name)
      if (token !== atlasToken) return // a newer selection superseded this one
      atlasHidden = new Set()
      atlasSurfacePair = entry.surface ?? null
      atlasContinuous = view.atlasIsContinuous()
      atlasDomain = view.atlasValueRange()
      atlasDisplayMin = atlasDomain.min
      atlasDisplayMax = atlasDomain.max
      atlasClipLo = null
      atlasClipHi = null
      if (atlasContinuous) {
        // Continuous (float scalar) gradient: no discrete ROIs. Render with the default colormap on
        // BOTH volume + surface; the ROI list is meaningless, so clear it (COLOR DISPLAY shows the bar).
        atlasEntries = []
        atlasColormap = CONTINUOUS_DEFAULT
        legend.clear()
        applyAtlasColormap()
      } else {
        // Categorical parcellation. No .tsv sidecar: derive the label set from the volume itself so
        // it still renders categorically (procedural colors keyed by ID) with a legend + toolbar.
        atlasColormap = null
        atlasEntries = parsed.length ? parsed : view.atlasLabelIds().map((id) => ({ id, name: String(id), region: '', hemi: '' }))
        if (atlasEntries.length) {
          view.setAtlasColortable(buildLabelColortable(atlasEntries, { seed: atlasSeed }))
          legend.setAtlas(title, atlasEntries, atlasSeed)
        } else {
          legend.clear()
        }
        await applyOverlay() // load + color the surface .func.gii categorically (no base-surface reload)
      }
      refreshColorDisplay()
    } catch {
      // atlas load failure is non-fatal — leave the previous overlay in place
    }
  }

  const setActiveLayout = (layout: Layout): void => {
    store.set('layout', layout)
    for (const b of layoutBtns) b.classList.toggle('active', b.dataset.layout === layout)
    main.dataset.layout = layout
    view?.setLayout(layout)
    view?.resize()
  }
  for (const b of layoutBtns) b.addEventListener('click', () => setActiveLayout(b.dataset.layout as Layout))

  const applySurface = async (kind: string): Promise<void> => {
    if (!view || !manifest) return
    const pair = manifest.surfaces[kind as keyof Manifest['surfaces']]
    await view.setSurface(pair, morphologyShapePairs(manifest), buildSurfaceOverlay(), morphDisplay())
    // Note: no auto-fit here — the initial fit runs in the load flow (after the layout sizes the
    // pane); switching surface type keeps the current zoom/orientation (Req 11).
    applyHemiVisibility()
    placeMarker() // re-place the pin at the same node on the new surface geometry
  }

  // The vol checkbox toggles the base volume on/off and hides/shows the slice pane (Req 3).
  volCheck.addEventListener('change', () => {
    if (!volCheck.checked) lastUnchecked = 'vol'
    view?.setVolumeOpacity(paneState().vol ? 1 : 0)
    applyPaneVisibility()
  })
  // --- field of view -----------------------------------------------------------------------
  // fovPref is what the user chose (sticky, app-wide); fovMode is what is actually on screen. They
  // diverge on a subject with no full-FOV volume: the display degrades to 'best' while the
  // preference survives, so the next subject that has one comes up in full FOV again.
  let fovPref: FovMode = loadFovPreference()
  let fovMode: FovMode = 'best'

  const hasFullFov = (): boolean => manifest?.fullFov != null

  // Reflect mode + availability on the buttons. In 'full' the volume dropdown is disabled rather
  // than rewritten: the full-FOV conform is the only volume that exists at that extent, and leaving
  // volSelect's value intact is what lets 'best' restore the previous choice with no saved index.
  const syncFovControls = (): void => {
    const available = hasFullFov()
    const tip = fovTooltip(manifest?.fullFov ?? null, manifest?.scan?.stream ?? null)
    for (const b of fovBtns) {
      const mode = b.dataset.fov as FovMode
      b.classList.toggle('active', mode === fovMode)
      b.disabled = mode === 'full' && !available
      b.title = mode === 'full' ? tip : (FOV_MODES.find((m) => m.mode === mode)?.title ?? '')
    }
    volSelect.disabled = fovMode === 'full'
    volSelect.title =
      fovMode === 'full'
        ? 'Switch FOV back to best to choose a base volume — full FOV has only the uncropped conform.'
        : 'Base volume (FreeSurfer mri/)'
  }

  // The underlay url for a mode: the full-FOV conform, or whatever the dropdown currently names.
  const baseUrlFor = (mode: FovMode): string | null => {
    if (!manifest) return null
    if (mode === 'full') return manifest.fullFov?.url ?? null
    return manifest.volumes[Number(volSelect.value)]?.url ?? null
  }

  // Load the underlay for `mode`. Only the user's own click reaches this — a subject load applies the
  // preference inline instead — so the choice is always recorded. A failed load leaves the previous
  // underlay and displayed mode untouched; the recorded preference still reflects what was asked for.
  const applyFovMode = async (mode: FovMode): Promise<void> => {
    if (!view || !manifest) return
    fovPref = mode
    saveFovPreference(mode)
    const effective = resolveFovMode(mode, hasFullFov())
    const url = baseUrlFor(effective)
    if (!url) return
    try {
      // The full-FOV image is the conform stage, not the preproc one, so its intensity range differs;
      // syncVolumeControls() re-seeds the display window from the new volume rather than carrying the
      // old one over. Skipped when a newer load superseded this one.
      if (await view.setBaseVolume(url, paneState().vol ? 1 : 0)) syncVolumeControls()
      fovMode = effective
      syncFovControls()
    } catch (err) {
      // Non-fatal: the previous base volume and displayed mode stay in place. But it must not be
      // SILENT — the buttons are unchanged either way, so without this the control simply appears
      // to do nothing and the user has no way to tell a failure from a no-op.
      showError(errorText(err))
      syncFovControls() // put the buttons back on the mode still displayed
    }
  }

  for (const b of fovBtns) {
    b.addEventListener('click', () => {
      const mode = b.dataset.fov as FovMode
      if (mode === fovMode) return
      void applyFovMode(mode)
    })
  }
  syncFovControls() // welcome screen: 'best' reads as active and 'full' as unavailable until a subject loads

  volSelect.addEventListener(
    'change',
    asyncHandler(async () => {
      if (!view || !manifest) return
      const vol = manifest.volumes[Number(volSelect.value)]
      if (!vol) return
      try {
        // Only reachable in 'best' — the dropdown is disabled in 'full'.
        if (await view.setBaseVolume(vol.url, paneState().vol ? 1 : 0)) {
          syncVolumeControls() // re-seed the underlay rail for the switched volume's intensity range
        }
        store.set('volumeKey', vol.key)
      } catch (err) {
        // Non-fatal — the previous base volume stays loaded — but say so, for the same reason as
        // the fov switch above: a dropdown that silently keeps showing the old volume is
        // indistinguishable from one that worked.
        showError(errorText(err))
      }
    }),
  )
  surfSelect.addEventListener('change', () => {
    store.set('surfaceKind', surfSelect.value)
    void (async () => {
      await applySurface(surfSelect.value)
      // The mesh reload drops the function-on-surface layer; re-apply it so the overlay persists.
      await applyFunctionSurface()
    })()
  })
  surfCheck.addEventListener('change', () => {
    if (!surfCheck.checked) lastUnchecked = 'surf'
    applyHemiVisibility()
    applyPaneVisibility() // hide/show the surface pane and resize the rest (Req 3)
    placeMarker() // hide/show the pin with the surface (Req 6)
  })
  lhCheck.addEventListener('change', () => {
    applyHemiVisibility()
    placeMarker()
  })
  rhCheck.addEventListener('change', () => {
    applyHemiVisibility()
    placeMarker()
  })

  // Surf-row view presets replace the old single "Reset views" (Req 4). No rescale, no crosshair
  // reset — just re-orient the surface camera (Req 11).
  for (const b of viewBtns) {
    b.addEventListener('click', () => {
      view?.setView(b.dataset.view as 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior', preferHemi())
    })
  }

  // --- function state (retinotopy / somatotopy) ---
  let functionPanel: FunctionPanel | null = null
  let longPanel: LongitudinalPanel | null = null
  let roiRateTable: RoiRateTable | null = null
  let lastAgreement: Array<{ timepoint: string; dice: number }> = []
  let funcChoice: FunctionChoice | null = null
  let funcThreshold = 0
  let funcOpacity = 1
  let funcBrightness = 1
  let funcToken = 0
  // Colormap override (null = the active map's default), display range (cal clamp; defaults to the
  // map's mode range), and value-clip window (null = unbounded).
  let funcColormap: string | null = null
  let funcCalMin = 0
  let funcCalMax = 1
  let funcClipLo: number | null = null
  let funcClipHi: number | null = null
  // Colormap assets (gradient previews + raw LUTs) + registry, built once the view exists.
  let colormapGradients: Record<string, string> = {}
  let colormapLuts: Record<string, Uint8ClampedArray> = {}
  let reversibleColormaps = new Set<string>()
  const canReverse = (key: string | null | undefined): boolean =>
    !!key && key !== LABELS_KEY && reversibleColormaps.has(baseColormapKey(key))
  let colormapInfos: ColormapInfo[] = []
  // The unified bottom "Color display" section + which overlay it currently targets.
  let colorDisplay: ColorDisplay | null = null
  type ColorTarget = 'morphology' | 'function' | 'atlas' | 'longitudinal' | null
  // Atlas overlay colormap: null = the categorical label table; a key = a continuous colormap (the
  // default for float scalar atlases like CortHierarchy, or forced onto a parcellation via the
  // picker). The synthetic 'labels' picker entry restores the categorical table.
  let atlasColormap: string | null = null
  const LABELS_KEY = 'labels'
  const CONTINUOUS_DEFAULT = 'magma' // default colormap for continuous (float scalar) atlases
  // Atlas display state: whether the loaded atlas is a gradient, its fixed data-value (or label-id)
  // domain, and the current (draggable) display window + value clip. For a continuous atlas the window
  // remaps the ramp and the clip hides voxels outside [lo, hi]; for a categorical atlas the clip hides
  // ROIs whose id falls outside [lo, hi] (the display window is inert — colors come from the table).
  let atlasContinuous = false
  let atlasDomain = { min: 0, max: 1 }
  let atlasDisplayMin = 0
  let atlasDisplayMax = 1
  let atlasClipLo: number | null = null
  let atlasClipHi: number | null = null
  // Per-hemisphere parsed frames of the currently loaded function surface .func.gii, cached so a
  // threshold/brightness drag re-quantizes in place without re-fetching (keyed by choice.kind).
  let funcSurfaceFrames: { kind: string; left: Float32Array[]; right: Float32Array[] } | null = null

  // Map a function choice to the categorical surface-LUT mode.
  const surfaceModeFor = (choice: FunctionChoice): SurfaceFunctionMode =>
    choice.kind === 'somatotopy' ? 'somatotopy' : choice.mode.id === 'eccentricity' ? 'eccentricity' : 'polar'

  // Fetch + parse the function surface .func.gii pair (all frames) for the active choice. Cached.
  const ensureFunctionSurfaceFrames = async (choice: FunctionChoice): Promise<boolean> => {
    if (funcSurfaceFrames?.kind === choice.kind) return true
    const map = choice.kind === 'retinotopy' ? manifest?.function.retinotopy : manifest?.function.somatotopy
    const pair = map?.surface
    if (!pair?.left || !pair?.right) {
      funcSurfaceFrames = null
      return false
    }
    const [left, right] = await Promise.all([
      client.apiFetch(pair.left).then((x) => x.text()).then((t) => parseGiftiFloat32(t)),
      client.apiFetch(pair.right).then((x) => x.text()).then((t) => parseGiftiFloat32(t)),
    ])
    funcSurfaceFrames = { kind: choice.kind, left, right }
    return true
  }

  // (Re)build the function-on-surface categorical layer from the cached frames using the current
  // threshold + brightness. Removes the layer when surface display is off or no choice is active.
  // The function overlay is shown on the surface whenever a map is selected (no toggle). Removed
  // when the selection is cleared or the map has no precomputed surface pair.
  const applyFunctionSurface = async (): Promise<void> => {
    if (!view) return
    if (!funcChoice) {
      view.clearSurfaceFunctionLayers()
      return
    }
    const token = funcToken
    const ok = await ensureFunctionSurfaceFrames(funcChoice)
    if (token !== funcToken || !funcChoice || !funcSurfaceFrames) return
    const map = funcChoice.kind === 'retinotopy' ? manifest?.function.retinotopy : manifest?.function.somatotopy
    const pair = map?.surface
    if (!ok || !pair?.left || !pair?.right) {
      view.clearSurfaceFunctionLayers()
      return
    }
    const mode = surfaceModeFor(funcChoice)
    const { valueFrame, fFrame } = funcChoice.mode
    // Build the surface LUT from the ACTIVE colormap so the picker recolors the surface too. Prefer
    // the prebuilt asset, fall back to a live LUT lookup, and only then to the built-in retinotopy ramp.
    const cmapLut = colormapLuts[funcColormapKey()] ?? view.colormapLut(funcColormapKey())
    const lut = cmapLut ? surfaceLutFromColormap(cmapLut, funcBrightness).lut : createFunctionalSurfaceLut(mode, funcBrightness).lut
    // Quantize over the user display window for maps that expose one (somatotopy) so the surface
    // tracks the same contrast as the volume's display-range remap; retinotopy (polar/eccentricity)
    // has no display range, so it keeps its fixed cyclic/natural domain (range = undefined). Then
    // mask by both the F-threshold and the value clip (so clip hides the same vertices as voxels).
    const range = funcChoice.kind === 'retinotopy' ? undefined : { min: funcCalMin, max: funcCalMax }
    const binsFor = (frames: Float32Array[]): Float32Array => {
      const value = frames[valueFrame] ?? new Float32Array(0)
      let bins = quantizeFunctionalSurfaceValues(value, mode, range)
      if (fFrame != null && frames[fFrame]) bins = maskSurfaceBinsByF(bins, frames[fFrame], funcThreshold)
      if (funcClipLo != null || funcClipHi != null) bins = maskSurfaceBinsByValue(bins, value, funcClipLo, funcClipHi)
      return bins
    }
    await view.setFunctionSurface(funcChoice.kind, pair, binsFor(funcSurfaceFrames.left), binsFor(funcSurfaceFrames.right), lut, funcOpacity)
  }

  const num = (v: number, unit = ''): string => (Number.isFinite(v) ? `${v.toFixed(2)}${unit}` : '—')

  // Neighborhood radius (voxels) for the retinotopy sweep, shared by the plot and the readout.
  const neighborhood = (): number => Number(neighborhoodSelect.value)

  const updateFunctionReport = (): void => {
    const el = document.getElementById('report-function')
    if (!el || !view || !manifest) return
    const map = funcChoice ? (funcChoice.kind === 'retinotopy' ? manifest.function.retinotopy : manifest.function.somatotopy) : null
    const vox = funcChoice && view.functionCrosshairVox()
    if (!funcChoice || !map || !vox) {
      el.textContent = '—'
      return
    }
    const f = map.frames
    el.innerHTML = ''
    if (funcChoice.kind === 'retinotopy') {
      // The neighborhood counts are filled in by updateVisualField (which sweeps the same voxels to
      // draw the plot), so this pass skips that sweep rather than paying for it twice per move.
      const r = collectRetinotopy(view, f, neighborhood(), funcThreshold, false)
      if (!r) return
      // Single dl keeps every label:value pair aligned; the last two dds are filled by
      // updateVisualField from the sampled neighborhood (kept in sync via the crosshair order).
      const dl = h('dl', { class: 'dl-paired' })
      const rowPaired = (label1: string, val1: string, label2: string, val2: string): void => {
        dl.append(h('dt', {}, [label1]), h('dd', {}, [val1]), h('dt', {}, [label2]), h('dd', {}, [val2]))
      }
      rowPaired('polar angle (rad)', num(r.polar), 'F', num(r.polarF))
      rowPaired('eccentricity (°)', num(r.eccentricity), 'F', num(r.eccentricityF))
      rowPaired('visual X (°)', num(r.visualX), 'visual Y (°)', num(r.visualY))
      dl.append(h('dt', {}, ['valid voxels']), h('dd', { id: 'func-valid' }, ['—']), h('dt', {}, ['local spread (°)']), h('dd', { id: 'func-spread' }, ['—']))
      el.append(dl)
    } else {
      const som = collectSomatotopy(view, f)
      if (!som) return
      const dl = h('dl', { class: 'dl-paired' })
      dl.append(h('dt', {}, ['body position']), h('dd', {}, [num(som.bodyPosition)]), h('dt', {}, ['F']), h('dd', {}, [num(som.fStat)]))
      el.append(dl)
    }
  }

  const updateVisualField = (): void => {
    const canvas = document.getElementById('visual-field-canvas') as HTMLCanvasElement | null
    const note = document.getElementById('report-visual-note')
    if (!canvas || !view || !manifest) return
    if (funcChoice?.kind !== 'retinotopy') {
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
      if (note) note.textContent = 'Add retinotopy in FUNC MAP first'
      return
    }
    const vox = view.functionCrosshairVox()
    const dims = view.functionDims()
    const f = manifest.function.retinotopy!.frames
    if (!vox || !dims) return
    const { points, possible } = collectVisualFieldPoints(view, f, vox, dims, neighborhood(), funcThreshold)
    const stats = visualFieldStats(points)
    drawVisualField(canvas, points, stats)
    // Mirror the neighborhood stats into the Function column (dds built by updateFunctionReport).
    const setDd = (id: string, text: string): void => {
      const d = document.getElementById(id)
      if (d) d.textContent = text
    }
    setDd('func-valid', `${points.length} / ${possible}`)
    setDd('func-spread', points.length ? stats.spread.toFixed(2) : 'N/A')
    if (note) note.textContent = points.length ? '' : 'No valid retinotopic voxel here.'
  }

  // Active volume colormap for the function overlay: the user override, else the map's default.
  const funcColormapKey = (): string => funcColormap ?? funcChoice?.mode.colormap ?? 'gray'

  const applyFunctionNow = (): void => {
    if (view && funcChoice) {
      // Fixed cal range = the map's natural range (keeps index-0 transparent for masking); the user
      // display range (funcCalMin/Max) is applied as a color remap so it clamps instead of hiding.
      view.applyFunctional(funcChoice.mode.valueFrame, funcChoice.mode.fFrame, funcThreshold, funcColormapKey(), funcOpacity, funcChoice.mode.calMin, funcChoice.mode.calMax, funcCalMin, funcCalMax, funcClipLo, funcClipHi)
      refreshColorDisplay()
    }
  }

  // Single entry point that recolors BOTH the volume slices and the 3D surface for the function
  // overlay, so callers never have to remember to pair applyFunctional + applyFunctionSurface (a
  // missed pairing silently desyncs slices from mesh). Exactly one surface pass — safe against the
  // func-surface layer race (never fire a second applyFunctionSurface() alongside this).
  const applyFunctionColor = (): void => {
    applyFunctionNow()
    void applyFunctionSurface()
  }

  // Preserved function display settings, carried verbatim across a monkey switch (else recomputed to
  // this map's defaults). Passing these THROUGH selectFunction keeps the surface application a single
  // pass — applying it via a second applyFunctionSurface() would race the first (from inside
  // selectFunction) on the shared surface layer and can leave it with the default gray colormap,
  // painting every masked vertex opaque black.
  type FuncPreserve = { threshold: number; colormap: string | null; calMin: number; calMax: number; clipLo: number | null; clipHi: number | null }
  const selectFunction = async (choice: FunctionChoice | null, preserve?: FuncPreserve): Promise<void> => {
    if (!view || !manifest) return
    const token = ++funcToken
    funcChoice = choice
    funcSurfaceFrames = null // invalidate the cached surface frames for the previous choice
    // Reset per-map display overrides: default colormap, display range = the map's natural range,
    // clip nothing — unless a snapshot is being restored, in which case adopt its exact values.
    funcColormap = preserve ? preserve.colormap : null
    funcClipLo = preserve ? preserve.clipLo : null
    funcClipHi = preserve ? preserve.clipHi : null
    if (choice) {
      funcCalMin = preserve ? preserve.calMin : choice.mode.calMin
      funcCalMax = preserve ? preserve.calMax : choice.mode.calMax
    }
    functionPanel?.setActive(choice ? choiceKey(choice) : null)
    if (!choice) {
      view.removeFunctional()
      view.clearSurfaceFunctionLayers()
      refreshColorDisplay()
      updateFunctionReport()
      updateVisualField()
      return
    }
    const map = choice.kind === 'retinotopy' ? manifest.function.retinotopy : manifest.function.somatotopy
    if (!map) return
    try {
      await view.loadFunctional(map.combined, choice.mode.colormap, funcOpacity)
      if (token !== funcToken) return
      if (choice.mode.fFrame != null) {
        const { min, max } = finiteExtrema(view.scaledFrame(choice.mode.fFrame))
        // Restore keeps the carried threshold (clamped into this map's range); else default F ≥ 5.
        funcThreshold = preserve ? Math.min(Math.max(preserve.threshold, min), max) : Math.min(Math.max(min, 5), max)
        functionPanel?.setThresholdBounds(min, max, funcThreshold)
      } else {
        funcThreshold = preserve ? preserve.threshold : 0
        functionPanel?.setThresholdBounds(0, 0, 0)
      }
      applyFunctionColor() // single vol+surf pass (one applyFunctionSurface — see race note above)
      updateFunctionReport()
      updateVisualField()
    } catch (err) {
      showError(errorText(err))
    }
  }

  neighborhoodSelect.addEventListener('change', updateVisualField)

  // Drag the top boundary of the info panel: update --info-height and redraw the visual field.
  {
    let dragging = false
    const setInfoHeight = (clientY: number): void => {
      const rect = main.getBoundingClientRect()
      const height = Math.max(120, Math.min(rect.height - 200, rect.bottom - clientY))
      document.documentElement.style.setProperty('--info-height', `${Math.round(height)}px`)
      view?.resize()
      updateVisualField()
    }
    infoResizer.addEventListener('pointerdown', (e) => {
      dragging = true
      infoResizer.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    infoResizer.addEventListener('pointermove', (e) => {
      if (dragging) setInfoHeight(e.clientY)
    })
    const end = (e: PointerEvent): void => {
      if (!dragging) return
      dragging = false
      try {
        infoResizer.releasePointerCapture(e.pointerId)
      } catch {
        /* pointer already released */
      }
    }
    infoResizer.addEventListener('pointerup', end)
    infoResizer.addEventListener('pointercancel', end)
  }

  // --- longitudinal change maps -------------------------------------------------------------
  // A change map is a per-vertex scalar on the base mesh, painted through the SAME surface layer
  // slot as the functional map (see MultiView.setChangeSurface for why). It therefore needs the
  // same single-flight discipline: two overlapping applies race on that one layer and leave the
  // surface black.
  let changeChoice: ChangeChoice | null = null
  let changeOpacity = 1
  let changeThreshold = 0
  // Decoded per-vertex values, keyed by SCAN and map. Feeds the display window, the quantizer AND
  // the crosshair readout from one array, so the colour and the reported number cannot disagree.
  //
  // The scan is part of the key because a map key on its own ("thickness-rate") is identical for
  // every subject and every reconstruction. Keyed on that alone, picking the same measure after a
  // switch returned the PREVIOUS scan's vertex arrays -- painted on the new mesh, reported at the
  // crosshair, and carried into the report's display range, all without a visible symptom.
  const changeValues = new Map<string, [Float32Array, Float32Array]>()
  const changeCacheKey = (mapKey: string): string => `${manifest?.scan?.id ?? manifest?.id ?? '?'}::${mapKey}`
  const cachedChange = (mapKey: string): [Float32Array, Float32Array] | undefined => changeValues.get(changeCacheKey(mapKey))

  const changeMapFor = (choice: ChangeChoice | null) =>
    choice ? (manifest?.longitudinal?.changeMaps.find((m) => m.key === changeKey(choice)) ?? null) : null

  const loadChangeValues = async (key: string, left: string, right: string): Promise<[Float32Array, Float32Array] | null> => {
    // Resolved once, before the await, so the values are stored under the scan that asked for them
    // even if the manifest moves on mid-flight.
    const cacheKey = changeCacheKey(key)
    const cached = changeValues.get(cacheKey)
    if (cached) return cached
    try {
      const [l, r] = await Promise.all(
        [left, right].map((url) =>
          client
            .apiFetch(url)
            .then((x) => x.text())
            .then((t) => parseGiftiFloat32(t)[0]),
        ),
      )
      if (!l || !r) return null
      const pair: [Float32Array, Float32Array] = [l, r]
      changeValues.set(cacheKey, pair)
      return pair
    } catch (err) {
      // Surfaced rather than swallowed: the caller treats null as "nothing to paint" and leaves the
      // previous surface up, so a failed fetch was indistinguishable from a deliberate no-op.
      showError(`Could not load the ${key} change map. ${errorText(err)}`)
      return null
    }
  }

  // Signed maps get a diverging colormap so the neutral colour reads as "no change"; the unsigned
  // temporal mean is an ordinary sequential quantity. Either can be overridden from the colour dock.
  let changeColormap: string | null = null
  const changeColormapKey = (): string => changeColormap ?? (changeMapFor(changeChoice)?.signed ? 'bwr' : 'viridis')

  // The display window: symmetric for a signed map so zero lands on the diverging colormap's
  // neutral colour, one-sided for the unsigned temporal mean.
  const changeWindow = (values: [Float32Array, Float32Array], signed: boolean): { min: number; max: number } =>
    signed ? symmetricRobustRange(values) : robustRange(values)

  // Single-flight, with coalescing. The previous token only guarded the LOAD: on a cache hit
  // loadChangeValues resolves on a microtask, so a second call cleared the token check and entered
  // setChangeSurface while the first was still inside it -- and #ensureFunctionLayer splices the
  // layer out before re-adding it, so the two interleave on one slot and the surface goes black.
  // A slider drag during the first paint was enough to trigger it.
  //
  // Serialising the whole apply is the discipline the comment above promises. Coalescing keeps a
  // drag cheap: while one apply runs at most one more is pending, and it reads the latest state
  // when its turn comes, so N events repaint once rather than N times.
  let changeApplying: Promise<void> | null = null
  let changeApplyQueued = false

  const applyChangeSurface = (): Promise<void> => {
    if (changeApplying) {
      changeApplyQueued = true
      return changeApplying
    }
    changeApplying = (async () => {
      try {
        do {
          changeApplyQueued = false
          await applyChangeSurfaceOnce()
        } while (changeApplyQueued)
      } finally {
        changeApplying = null
      }
    })()
    return changeApplying
  }

  const applyChangeSurfaceOnce = async (): Promise<void> => {
    if (!view) return
    const map = changeMapFor(changeChoice)
    if (!map) {
      view.clearChangeSurface()
      return
    }
    const values = await loadChangeValues(map.key, map.left, map.right)
    // A newer apply is already waiting: skip this paint rather than flashing a superseded map,
    // and let the loop repaint from the latest state.
    if (changeApplyQueued || !values) return
    const window = changeWindow(values, map.signed)
    const cmapLut = colormapLuts[changeColormapKey()] ?? view.colormapLut(changeColormapKey())
    if (!cmapLut) {
      // No fallback ramp here on purpose. The functional overlay can fall back to its built-in
      // retinotopy ramp because that ramp IS its natural colouring; borrowing it for a signed
      // change map would put a cyclic hue wheel on a diverging quantity, which reads as structure
      // that is not there. Showing nothing is the honest failure.
      view.clearChangeSurface()
      return
    }
    const lut = surfaceLutFromColormap(cmapLut, 1).lut
    const binsFor = (v: Float32Array): Float32Array =>
      maskSurfaceBinsByMagnitude(quantizeScalarToBins(v, window.min, window.max), v, changeThreshold)
    await view.setChangeSurface(map.key, { left: map.left, right: map.right }, binsFor(values[0]), binsFor(values[1]), lut, changeOpacity)
  }

  // Base segmentation agreement — fetched for the report when a change map is shown, not the panel.
  // Called fire-and-forget from loadSubject, so it can resolve after a later scan has taken over:
  // every write is gated on `mf` still being the manifest on screen, or a stale Dice table ends up
  // in a report for a different reconstruction.
  const loadAgreement = async (mf: Manifest): Promise<void> => {
    const url = mf.longitudinal?.agreement
    lastAgreement = []
    if (!url) return
    try {
      const parsed = parseSegmentationAgreement(await client.apiFetch(url).then((r) => r.json()))
      if (manifest === mf) lastAgreement = parsed
    } catch (err) {
      if (manifest !== mf) return
      lastAgreement = []
      showError(`Could not read the base segmentation agreement — the report will omit it. ${errorText(err)}`)
    }
  }

  // The ROI fits, fetched as CSV (they are handed over as URLs rather than inlined: a few dozen
  // rows per hemisphere is not worth adding to every manifest for a panel that is usually closed).
  // Fire-and-forget from loadSubject, and `roiRateTable` is rebuilt on every load — so both the
  // success and the failure path check that `mf` is still the manifest on screen before touching
  // it, or one scan's fits land in the next scan's freshly-built table.
  const loadRoiRates = async (mf: Manifest): Promise<void> => {
    const rates = mf.longitudinal?.roiRates
    if (!rates?.left || !rates?.right) {
      roiRateTable?.clear()
      return
    }
    try {
      const [left, right] = await Promise.all(
        [rates.left, rates.right].map((url) => client.apiFetch(url).then((r) => r.text()).then(parseRoiRatesCsv)),
      )
      if (manifest === mf) roiRateTable?.setRows(left, right)
    } catch (err) {
      if (manifest !== mf) return
      roiRateTable?.clear()
      // An empty table otherwise reads as "this scan has no ROI fits", which is a different claim.
      showError(`Could not read the ROI fits for this scan. ${errorText(err)}`)
    }
  }

  // Keep the table's measure filter in step with the map on screen.
  const syncRoiRateTable = (): void => {
    if (!roiRateTable) return
    const map = changeMapFor(changeChoice)
    // No map selected means the panel is on `none`, so the table lists nothing with it. Returning
    // early instead would strand it on its own default measure, showing rates for a map nobody
    // picked. setMeasure(null) rather than clear() -- the fits stay loaded for the next selection.
    roiRateTable.setMeasure(map ? (map.measure as Measure) : null)
    // The table lists all three statistics; this just marks the one on the surface.
    if (map) roiRateTable.setStatistic(map.statistic as Statistic)
  }

  const selectChange = async (choice: ChangeChoice | null): Promise<void> => {
    changeChoice = changeMapFor(choice) ? choice : null
    if (changeChoice) lastChangeChoice = changeChoice
    longPanel?.setActive(changeChoice ? changeKey(changeChoice) : null)
    if (!changeChoice) {
      view?.clearChangeSurface()
      syncRoiRateTable() // empties the ROI list too, so panel, surface and table agree on "nothing"
      refreshColorDisplay()
      updateSurfaceReport()
      return
    }
    const map = changeMapFor(changeChoice)
    // Seed the threshold slider from the data actually loaded, not from a guess: a rate is ~0.01,
    // so a fixed 0..1 slider would be unusable.
    if (map) {
      const values = await loadChangeValues(map.key, map.left, map.right)
      if (values) {
        const window = changeWindow(values, map.signed)
        longPanel?.setThresholdBounds(Math.max(Math.abs(window.min), Math.abs(window.max)), changeThreshold)
      }
    }
    await applyChangeSurface()
    syncRoiRateTable()
    refreshColorDisplay()
    updateSurfaceReport()
  }

  // --- surface report (morphology at the crosshair vertex) ---
  let lastMm: [number, number, number] | null = null
  const morphShape: { curvature?: [Float32Array, Float32Array]; sulc?: [Float32Array, Float32Array]; thickness?: [Float32Array, Float32Array] } = {}

  // --- unified "Color display" section routing (colormap + legend + display range + clip) ---
  const morphActiveMetric = (): MorphologyMetric => (morphMetric === 'none' ? 'curvature' : morphMetric)
  // Morphology has color controls only for continuous shading (None + binary curvature are fixed).
  const morphColorable = (): boolean => morphMetric !== 'none' && !(morphMetric === 'curvature' && morphStyle === 'binary')

  // Which overlay the bottom color-display section targets, following the docked tab + selection.
  const colorTarget = (): ColorTarget => {
    if (dockedTab === 'function' && funcChoice) return 'function'
    if (dockedTab === 'longitudinal' && changeChoice) return 'longitudinal'
    if (dockedTab === 'morphology' && morphColorable()) return 'morphology'
    if (dockedTab === 'atlas' && lastAtlasSel != null) return 'atlas'
    return null
  }

  // Retinotopy legends are circular: polar angle → wheel, eccentricity → concentric rings.
  const legendShapeForFunc = (): 'bar' | 'wheel' | 'rings' => {
    if (!funcChoice || funcChoice.kind !== 'retinotopy') return 'bar'
    return funcChoice.mode.id === 'polar' ? 'wheel' : funcChoice.mode.id === 'eccentricity' ? 'rings' : 'bar'
  }

  // Every target goes through here so `showReverse` is ANDed with "this map has a twin" in one
  // place rather than at each of the four call sites below.
  const setColorTarget = (t: ColorDisplayTarget): void =>
    colorDisplay?.setTarget({ ...t, showReverse: (t.showReverse ?? t.showLegend !== false) && canReverse(t.colormap) })

  const refreshColorDisplay = (): void => {
    if (!colorDisplay) return
    const target = colorTarget()
    if (target === 'function' && funcChoice) {
      const key = funcColormapKey()
      setColorTarget({
        title: `${funcChoice.kind === 'retinotopy' ? 'Retinotopy' : 'Somatotopy'} · ${funcChoice.mode.label}`,
        colormap: key,
        legendShape: legendShapeForFunc(),
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        // Display range is hidden only for the fixed-domain cyclic retinotopy maps (polar/eccentricity);
        // somatotopy (body position) is a normal 0–100 map, so it gets the generic display-range control.
        displayDomain: { min: funcChoice.mode.calMin, max: funcChoice.mode.calMax },
        displayRange: { min: funcCalMin, max: funcCalMax },
        showDisplayRange: funcChoice.kind !== 'retinotopy',
        clip: 'range',
        clipDomain: { min: funcChoice.mode.calMin, max: funcChoice.mode.calMax },
        clipValue: { lo: funcClipLo, hi: funcClipHi },
        // Somatotopy's 0–100 axis is a body map (foot → hand → face); anchor the bar with those
        // parts so the numbers read as anatomy. Retinotopy uses wheel/rings legends (no bar ticks).
        barTicks: funcChoice.kind === 'somatotopy' ? ['foot', 'hand', 'face'] : undefined,
        reversed: isReversedKey(key),
        colormaps: colormapInfos.filter((i) => i.key !== LABELS_KEY), // "labels" is atlas-only
      })
    } else if (target === 'longitudinal' && changeChoice) {
      const map = changeMapFor(changeChoice)
      const key = changeColormapKey()
      const values = cachedChange(changeKey(changeChoice))
      const window = values && map ? changeWindow(values, map.signed) : { min: -1, max: 1 }
      const unit = map ? rateUnitLabel(manifest?.longitudinal ?? null, map) : ''
      setColorTarget({
        title: `change · ${changeChoice.measure} ${changeChoice.statistic}${unit ? ` (${unit})` : ''}`,
        colormap: key,
        legendShape: 'bar',
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        displayDomain: window,
        displayRange: window,
        // No clip control: this dock's clip KEEPS what is inside [lo, hi], and thresholding a
        // signed change map needs the complement -- hide the near-zero middle, keep both tails.
        // That lives on the panel's own "|change| >=" slider instead.
        clip: 'none',
        // A signed map's bar is anchored at its neutral middle, so the reader is told what the
        // centre colour means rather than inferring it from two numeric endpoints.
        barTicks: map?.signed ? ['decrease', 'no change', 'increase'] : undefined,
        reversed: isReversedKey(key),
        colormaps: colormapInfos.filter((i) => i.key !== LABELS_KEY),
      })
    } else if (target === 'morphology') {
      const metric = morphActiveMetric()
      const key = morphColormaps[metric] ?? 'gray'
      setColorTarget({
        title: `morphology · ${metric}`,
        colormap: key,
        legendShape: 'bar',
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        displayDomain: MORPH_DOMAIN[metric],
        displayRange: morphRanges[metric],
        clip: 'range',
        clipDomain: MORPH_DOMAIN[metric],
        clipValue: morphClip[metric],
        reversed: isReversedKey(key),
        colormaps: colormapInfos.filter((i) => i.key !== LABELS_KEY), // "labels" is atlas-only
      })
    } else if (target === 'atlas' && lastAtlasSel) {
      const key = atlasColormap ?? LABELS_KEY
      const continuous = atlasColormap !== null
      setColorTarget({
        title: `atlas · ${lastAtlasSel.name}`,
        colormap: key,
        legendShape: 'bar',
        // Categorical atlas has no meaningful colormap (colors come from the per-ROI label table, and
        // the picker shows "none"); a continuous legend bar over label ids is misleading, so hide it.
        // Continuous atlas: the gradient bar IS the legend, so keep it.
        showLegend: continuous,
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        // Range + clip belong to a CONTINUOUS colormap only. In labels mode (colormap "none") the
        // display window is inert (colors come from the label table) and a clip-by-id duplicates the
        // ROI list's per-ROI toggles — so hide both; they reappear when a real colormap is picked.
        displayDomain: atlasDomain,
        displayRange: { min: atlasDisplayMin, max: atlasDisplayMax },
        showDisplayRange: continuous,
        reversed: isReversedKey(key),
        // Labels mode has no ramp to flip; the toggle follows the legend's continuous gate.
        showReverse: continuous,
        // A continuous gradient has no categorical mode, so don't offer "none" in the picker.
        colormaps: atlasContinuous ? colormapInfos.filter((i) => i.key !== LABELS_KEY) : colormapInfos,
        clip: continuous ? 'range' : 'none',
        clipDomain: atlasDomain,
        clipValue: { lo: atlasClipLo, hi: atlasClipHi },
        // Categorical: the ROI list already shows the real palette, so start the section collapsed.
        // Continuous: the bar + range ARE the legend, so keep it open.
        collapsed: !continuous,
      })
    } else {
      colorDisplay.setTarget(null)
    }
    // The overlay-value probe in Coordinates tracks the same target — refresh it on overlay/tab change.
    updateOverlayValue()
  }

  // The colormap key the active overlay is currently painted with — the one the reverse toggle flips.
  const activeColormapKey = (): string | null => {
    const t = colorTarget()
    if (t === 'function') return funcColormapKey()
    if (t === 'longitudinal') return changeColormapKey()
    if (t === 'morphology') return morphColormaps[morphActiveMetric()] ?? 'gray'
    if (t === 'atlas') return atlasColormap
    return null
  }

  // Route the section's controls to whichever overlay is active.
  const colorDisplayCallbacks = {
    onColormap: (key: string): void => {
      const t = colorTarget()
      if (key === LABELS_KEY && t !== 'atlas') return // "Labels" only means anything for the atlas
      if (t === 'function') {
        funcColormap = key
        applyFunctionColor()
      } else if (t === 'longitudinal') {
        changeColormap = key
        void applyChangeSurface()
        refreshColorDisplay()
      } else if (t === 'morphology') {
        morphColormaps[morphActiveMetric()] = key
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        if (key === LABELS_KEY && atlasContinuous) return // a gradient has no categorical mode
        atlasColormap = key === LABELS_KEY ? null : key
        applyAtlasColormap() // recolors BOTH the volume slices and the 3D surface
        refreshColorDisplay()
      }
    },
    // Reversing is just a different colormap key (`<key>_r`), so it reuses onColormap wholesale --
    // no second state field, no second apply path, and the reversed key flows into the report and
    // the session snapshot the same way a forward one does.
    onReverse: (): void => {
      const key = activeColormapKey()
      if (!canReverse(key)) return
      colorDisplayCallbacks.onColormap(toggleReversedKey(key!))
    },
    onDisplayRange: (min: number, max: number): void => {
      const t = colorTarget()
      if (t === 'function') {
        funcCalMin = min
        funcCalMax = max
        applyFunctionColor() // range recolors both slices and surface
      } else if (t === 'morphology') {
        morphRanges[morphActiveMetric()] = { min, max }
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        atlasDisplayMin = min
        atlasDisplayMax = max
        // Continuous: re-quantize the volume + surface over the new window (no full refresh mid-drag).
        // Categorical: the window is inert (colors come from the label table), so nothing to re-apply.
        if (atlasColormap) applyAtlasColormap()
      }
    },
    onDisplayAuto: (): void => {
      const t = colorTarget()
      if (t === 'morphology') {
        const m = morphActiveMetric()
        morphRanges[m] = autoMorphRange(m)
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'function' && funcChoice) {
        funcCalMin = funcChoice.mode.calMin
        funcCalMax = funcChoice.mode.calMax
        applyFunctionNow()
      }
    },
    onClipRange: (lo: number | null, hi: number | null): void => {
      const t = colorTarget()
      if (t === 'function') {
        funcClipLo = lo
        funcClipHi = hi
        applyFunctionColor() // clip hides the same vertices on both slices and surface
      } else if (t === 'morphology') {
        morphClip[morphActiveMetric()] = { lo, hi }
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        atlasClipLo = lo
        atlasClipHi = hi
        // Continuous: mask voxels outside [lo, hi]. Categorical: hide ROIs whose id is outside
        // [lo, hi] by folding them into the colortable's hidden set (see applyAtlasColormap).
        applyAtlasColormap()
      }
    },
    onReset: (): void => {
      const t = colorTarget()
      if (t === 'function' && funcChoice) {
        funcColormap = null
        funcCalMin = funcChoice.mode.calMin
        funcCalMax = funcChoice.mode.calMax
        funcClipLo = null
        funcClipHi = null
        applyFunctionColor()
      } else if (t === 'morphology') {
        const m = morphActiveMetric()
        morphColormaps[m] = MORPH_DEFAULT_COLORMAP[m]
        morphRanges[m] = { ...MORPH_DEFAULT_RANGE[m] }
        morphClip[m] = { lo: null, hi: null }
        view?.applyMorphologyDisplay(morphDisplay())
        refreshColorDisplay()
      } else if (t === 'atlas') {
        // Continuous atlas resets to the default colormap + full data range; a parcellation resets
        // to its categorical labels.
        atlasColormap = atlasContinuous ? CONTINUOUS_DEFAULT : null
        atlasDisplayMin = atlasDomain.min
        atlasDisplayMax = atlasDomain.max
        atlasClipLo = null
        atlasClipHi = null
        applyAtlasColormap()
        refreshColorDisplay()
      }
    },
  }

  // 2.5–97.5 percentile of the loaded .shape.gii data across both hemispheres (thickness ignores
  // non-positive samples). Curvature is forced symmetric around zero.
  const autoMorphRange = (metric: MorphologyMetric): { min: number; max: number } => {
    const pair = morphShape[metric]
    if (!pair) return { ...MORPH_DEFAULT_RANGE[metric] }
    const all: number[] = []
    for (const arr of pair) for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (Number.isFinite(v) && (metric !== 'thickness' || v > 0)) all.push(v) }
    if (all.length === 0) return { ...MORPH_DEFAULT_RANGE[metric] }
    all.sort((a, b) => a - b)
    const at = (p: number): number => all[Math.min(all.length - 1, Math.max(0, Math.round((p / 100) * (all.length - 1))))]
    let min = at(2.5)
    let max = at(97.5)
    if (metric === 'curvature') { const m = Math.max(Math.abs(min), Math.abs(max)); min = -m; max = m }
    return { min, max }
  }

  const loadMorphology = (m: Manifest): void => {
    morphShape.curvature = undefined
    morphShape.sulc = undefined
    morphShape.thickness = undefined
    const shape = m.morphology?.shape
    if (!shape) return
    const load = async (key: 'curvature' | 'sulc' | 'thickness', pair: SurfacePair | undefined): Promise<void> => {
      if (!pair?.left || !pair?.right) return
      try {
        const [l, r] = await Promise.all([
          client.apiFetch(pair.left).then((x) => x.text()).then((t) => parseGiftiFloat32(t)[0]),
          client.apiFetch(pair.right).then((x) => x.text()).then((t) => parseGiftiFloat32(t)[0]),
        ])
        if (l && r) {
          morphShape[key] = [l, r]
          updateSurfaceReport()
        }
      } catch {
        /* morphology optional */
      }
    }
    void load('curvature', shape.curvature)
    void load('sulc', shape.sulc)
    void load('thickness', shape.thickness)
  }

  const updateSurfaceReport = (): void => {
    const el = document.getElementById('report-surface')
    if (!el || !view) return
    if (!currentNode) {
      el.textContent = '—'
      return
    }
    const vertex = collectVertex(view, currentNode, lastMm)
    const morph = collectMorphology(morphShape, currentNode)
    const rows: Array<[string, string]> = [
      ['nearest vertex', vertex ? String(vertex.index) : '—'],
      ['distance (mm)', vertex?.distanceMm != null ? vertex.distanceMm.toFixed(2) : '—'],
      ['curvature', num(morph?.curvature ?? NaN)],
      ['sulcal depth', num(morph?.sulc ?? NaN)],
      ['thickness (mm)', num(morph?.thickness ?? NaN)],
    ]
    // The active change map reads out at the same vertex, from the SAME array that produced the
    // colour on screen -- so the number and the picture cannot disagree. The unit is part of the
    // row label, never optional: a per-scan value labelled only "rate" is exactly the misreading
    // the whole time-source machinery exists to prevent.
    const changeMap = changeMapFor(changeChoice)
    if (changeMap && vertex) {
      const values = cachedChange(changeMap.key)
      const hemi = currentNode.hemi === 0 ? 0 : 1
      const value = values?.[hemi]?.[vertex.index]
      const unit = rateUnitLabel(manifest?.longitudinal ?? null, changeMap)
      rows.push([`${changeMap.measure} ${changeMap.statistic}${unit ? ` (${unit})` : ''}`, num(value ?? NaN)])
    }
    el.innerHTML = ''
    el.append(dlRows(rows))
  }

  // --- category tabs: an exclusive selector that docks one picker at the top of the side panel ---
  const atlasBtn = panelBtns[PANEL_BUTTONS.indexOf('atlas')]
  const morphBtn = panelBtns[PANEL_BUTTONS.indexOf('morphology')]
  const functionBtn = panelBtns[PANEL_BUTTONS.indexOf('func map')]
  // Hidden rather than disabled: change maps exist only on the base template of a longitudinal
  // run, so for most scans this tab would be permanently greyed out, which is noise. It is last in
  // the row, so hiding it shifts nothing.
  const changeBtn = panelBtns[PANEL_BUTTONS.indexOf('change')]
  changeBtn.hidden = true

  // Reflect the docked tab in the button highlight, the docked picker, and the content slot.
  const updateTabUI = (): void => {
    atlasBtn.classList.toggle('active', dockedTab === 'atlas')
    morphBtn.classList.toggle('active', dockedTab === 'morphology')
    functionBtn.classList.toggle('active', dockedTab === 'function')
    changeBtn.classList.toggle('active', dockedTab === 'longitudinal')
    if (atlasPanel) atlasPanel.element.hidden = dockedTab !== 'atlas'
    if (morphPanel) morphPanel.element.hidden = dockedTab !== 'morphology'
    if (functionPanel) functionPanel.element.hidden = dockedTab !== 'function'
    if (longPanel) longPanel.element.hidden = dockedTab !== 'longitudinal'
    legendSlot.hidden = dockedTab !== 'atlas'
    funcSlot.hidden = dockedTab !== 'function'
    changeSlot.hidden = dockedTab !== 'longitudinal'
    morphSlot.hidden = dockedTab !== 'morphology'
    sidePlaceholder.hidden = dockedTab !== null
    refreshColorDisplay() // the bottom color-display section follows the docked tab's overlay
  }

  // Atlas and Function are mutually-exclusive overlays: entering one clears the other (its last
  // selection is remembered, so re-entering restores it). Morphology is the always-on base layer, so
  // its tab leaves the active overlay alone — only the docked controls swap. Re-clicking the docked
  // tab toggles it off (an atlas/function overlay is cleared back to the bare morphology base).
  const selectTab = (tab: 'atlas' | 'morphology' | 'function' | 'longitudinal'): void => {
    if (dockedTab === tab) {
      dockedTab = null
      if (tab === 'atlas') void selectAtlas(null)
      else if (tab === 'function') void selectFunction(null)
      else if (tab === 'longitudinal') void selectChange(null)
      updateTabUI()
      return
    }
    dockedTab = tab
    // Atlas, function and change are three ways of painting the same surface, so entering any one
    // clears the other two. For change that is not merely tidiness: it shares the function map's
    // layer slot, and an atlas overlay fills every cortical vertex at full opacity anyway, so
    // "atlas + change" would render as "change" with extra loading.
    if (tab === 'atlas') {
      void selectFunction(null) // hide the function overlay (keeps lastFuncChoice)
      void selectChange(null)
      void selectAtlas(lastAtlasSel) // restore the atlas overlay
    } else if (tab === 'function') {
      void selectAtlas(null) // hide the atlas overlay (keeps lastAtlasSel)
      void selectChange(null)
      void selectFunction(lastFuncChoice) // restore the function overlay
    } else if (tab === 'longitudinal') {
      void selectAtlas(null)
      void selectFunction(null)
      void selectChange(lastChangeChoice)
    }
    // morphology: overlay unchanged — the base persists under any active atlas/function overlay.
    updateTabUI()
  }

  atlasBtn.addEventListener('click', () => selectTab('atlas'))
  morphBtn.addEventListener('click', () => selectTab('morphology'))
  functionBtn.addEventListener('click', () => selectTab('function'))
  changeBtn.addEventListener('click', () => selectTab('longitudinal'))

  // Atlas report: every discovered atlas at the crosshair (sampled from report-only volumes).
  let reportSpecs: Array<{ key: string; label: string; byId: Map<number, AtlasLabel> }> = []

  const updateAnatomyReport = (): void => {
    const el = document.getElementById('report-anatomy')
    if (!el || !view) return
    if (reportSpecs.length === 0) {
      el.textContent = '—'
      return
    }
    el.innerHTML = ''
    // Sampling lives in report/collect.ts so the HTML report reads the same numbers this panel
    // shows. Rendering rules stay here: a continuous float atlas (e.g. CortHierarchy) prints its
    // value with fixed decimals — a whole value must read as 1.000, never a bare 1, which would
    // look like a label id — and has no region name; a parcellation prints id + short · name.
    for (const row of collectAtlasRows(view, reportSpecs)) {
      const idText = row.continuous ? (row.value != null ? row.value.toFixed(3) : '') : row.id != null ? String(row.id) : ''
      const name = row.region ?? (row.unknown ? '(unlabeled)' : '')
      el.append(
        h('div', { class: 'atlas-report-row' }, [
          h('span', { class: 'atlas-report-name' }, [row.label]),
          h('span', { class: 'atlas-report-id' }, [idText]),
          h('span', { class: `atlas-report-label${row.unknown ? ' unknown' : ''}` }, [
            ...(row.shortName ? [h('span', { class: 'atlas-report-short' }, [row.shortName]), ' · '] : []),
            name,
          ]),
        ]),
      )
    }
  }

  // Overlay-value probe for the Coordinates section: the value of the currently overlaid map at the
  // crosshair. Follows the docked tab via colorTarget() and reuses the same per-kind samplers the
  // dedicated info sections already run each crosshair move (no extra sampling infrastructure).
  // Returns the probe as structured data so the report can carry the same value the Coordinates
  // panel shows, along with which overlay it came from.
  const overlayReadout = (): LocationReadout['overlay'] => {
    if (!view) return null
    const target = colorTarget()
    if (target === 'atlas' && lastAtlasSel) {
      const name = lastAtlasSel.name
      const raw = view.sampleReportVolume(name)
      if (raw == null) return null
      const value = view.reportVolumeContinuous(name)
        ? raw !== 0
          ? raw.toFixed(3) // float atlas: fixed decimals
          : null
        : Math.round(raw) !== 0
          ? String(Math.round(raw)) // parcellation: numeric id only
          : null
      return { target: 'atlas', label: name, value }
    }
    if (target === 'function' && funcChoice) {
      const vox = view.functionCrosshairVox()
      const v = vox ? view.sampleFunctionFrame(vox, funcChoice.mode.valueFrame) : NaN
      return { target: 'function', label: funcChoice.mode.label, value: num(v) }
    }
    if (target === 'morphology' && currentNode) {
      const metric = morphActiveMetric()
      const a = morphShape[metric]?.[currentNode.hemi]
      const v = a && currentNode.index < a.length ? a[currentNode.index] : NaN
      return { target: 'morphology', label: metric, value: num(v) }
    }
    return null // nothing overlaid on the docked tab
  }

  const updateOverlayValue = (): void => {
    coordEditor.setOverlay(overlayReadout()?.value ?? null)
  }

  const loadReportSpecs = (m: Manifest): void => {
    if (!view) return
    view.clearReportVolumes()
    const specEntries: Array<{ key: string; label: string; entry: { volume: string; labels: string | null } }> = []
    for (const e of m.atlases) specEntries.push({ key: e.name, label: e.label, entry: e })
    reportSpecs = specEntries.map((s) => ({ key: s.key, label: s.label, byId: new Map<number, AtlasLabel>() }))
    for (const s of specEntries) {
      view.loadReportVolume(s.key, s.entry.volume).then(updateAnatomyReport).catch(() => {})
      if (s.entry.labels) {
        client
          .apiFetch(s.entry.labels)
          .then((r) => r.text())
          .then((tsv) => {
            const spec = reportSpecs.find((x) => x.key === s.key)
            if (spec) {
              for (const e of parseAtlasTsv(tsv)) spec.byId.set(e.id, e)
              updateAnatomyReport()
            }
          })
          .catch(() => {})
      }
    }
  }

  // --- report: bookmarked points + HTML report generation ---
  const bookmarks = new BookmarkStore()
  // Build id lives server-side (it encodes the git describe of the running build), so fetch it once
  // and let the report fall back to "version only" if the call fails.
  let buildId: string | null = null
  void client
    .version()
    .then((info) => {
      buildId = info.buildId
    })
    .catch(() => {})

  // A one-line description of what is overlaid, recorded with each bookmark so a reader can tell
  // why (say) retinotopy values are present on one point and absent on another.
  const overlayDescription = (): string => {
    const parts: string[] = []
    if (lastAtlasSel) parts.push(`atlas · ${lastAtlasSel.name}`)
    if (funcChoice) parts.push(`${funcChoice.kind} · ${funcChoice.mode.label}`)
    if (morphMetric !== 'none') parts.push(`morphology · ${morphMetric}`)
    return parts.length ? parts.join(' + ') : 'none'
  }

  // The crosshair as a full readout — the same collectors the info panel renders from, plus the
  // sections the panel has no room for. Null until a subject is loaded and the crosshair has moved.
  const currentReadout = (): LocationReadout | null => {
    if (!view || !manifest || !lastMm) return null
    const kind = funcChoice?.kind ?? null
    const map = kind === 'retinotopy' ? manifest.function.retinotopy : kind === 'somatotopy' ? manifest.function.somatotopy : null
    return {
      mm: lastMm,
      voxel: view.baseVox(lastMm),
      hemisphere: currentNode ? (currentNode.hemi === 0 ? 'left' : 'right') : '—',
      vertex: collectVertex(view, currentNode, lastMm),
      atlases: collectAtlasRows(view, reportSpecs),
      morphology: collectMorphology(morphShape, currentNode),
      retinotopy: kind === 'retinotopy' && map ? collectRetinotopy(view, map.frames, neighborhood(), funcThreshold) : null,
      somatotopy: kind === 'somatotopy' && map ? collectSomatotopy(view, map.frames) : null,
      overlay: overlayReadout(),
    }
  }

  const viewState = (): ViewState => {
    const baseVol = manifest?.volumes[Number(volSelect.value)] ?? null
    return {
      layout: store.get('layout'),
      surfaceKind: surfSelect.value || null,
      panes: { volume: paneState().vol, surface: paneState().surf },
      hemispheres: { left: lhCheck.checked, right: rhCheck.checked },
      baseVolume: {
        key: baseVol?.key ?? null,
        label: baseVol?.label ?? null,
        window: { min: volCalLo, max: volCalHi },
        clip: { lo: volClipLo, hi: volClipHi },
      },
      atlas: lastAtlasSel
        ? {
            name: lastAtlasSel.name,
            colormap: atlasColormap ?? LABELS_KEY,
            opacity: atlasOpacity,
            continuous: atlasContinuous,
            // The display window only means something for a continuous colormap; in labels mode the
            // colors come from the ROI table, so reporting a range would be misleading.
            displayRange: atlasColormap ? { min: atlasDisplayMin, max: atlasDisplayMax } : null,
            clip: { lo: atlasClipLo, hi: atlasClipHi },
            hiddenRois: atlasHidden.size,
          }
        : null,
      morphology: {
        metric: morphMetric,
        curvatureStyle: morphStyle,
        // Binary curvature has a fixed 2-tone LUT that the colormap picker does not drive.
        colormap: morphColorable() ? (morphColormaps[morphActiveMetric()] ?? null) : null,
        range: morphColorable() ? morphRanges[morphActiveMetric()] : null,
        clip: morphColorable() ? morphClip[morphActiveMetric()] : null,
      },
      function: funcChoice
        ? {
            kind: funcChoice.kind,
            mode: funcChoice.mode.label,
            threshold: funcThreshold,
            opacity: funcOpacity,
            brightness: funcBrightness,
            colormap: funcColormapKey(),
            // Retinotopy is cyclic with a fixed domain and exposes no display range (see the panel).
            displayRange: funcChoice.kind === 'retinotopy' ? null : { min: funcCalMin, max: funcCalMax },
            clip: { lo: funcClipLo, hi: funcClipHi },
          }
        : null,
      longitudinal: (() => {
        const map = changeMapFor(changeChoice)
        if (!map || !changeChoice) return null
        const info = manifest?.longitudinal ?? null
        const values = cachedChange(map.key)
        return {
          measure: map.measure,
          statistic: map.statistic,
          colormap: changeColormapKey(),
          displayRange: values ? changeWindow(values, map.signed) : null,
          threshold: changeThreshold,
          opacity: changeOpacity,
          unit: rateUnitLabel(info, map),
          timeSource: info?.timeSource ?? null,
          timeInterpretable: isTimeInterpretable(info),
        }
      })(),
      camera: view?.getCamera() ?? null,
      markerMode,
    }
  }

  const reportContext = (): ReportContext => {
    return {
      apiFetch: (path) => client.apiFetch(path),
      app: { name: 'brainana-viewer', version: __APP_VERSION__, buildId },
      dataset: () => {
        // Resolved on each call: the dialog stays open across a monkey switch, and a report must
        // describe the subject it was generated from, not the one that was loaded when it opened.
        const current = store.get('sourceId')
        const entry = sources.list().find((s) => s.id === current) ?? null
        return {
          sourceId: current,
          sourceLabel: entry ? (entry.customLabel ?? entry.label) : null,
          sourceType: entry?.type ?? null,
          sourceRoot: entry?.root ?? null,
          subjectId: manifest?.id ?? null,
          subjectLabel: manifest?.label ?? null,
          session: manifest?.session ?? null,
          scan: manifest?.scan
            ? { id: manifest.scan.id, stream: manifest.scan.stream, session: manifest.scan.session, label: manifest.scan.label }
            : null,
          synthesisLevel: manifest?.synthesisLevel ?? null,
          relativePath: manifest?.relativePath ?? null,
        }
      },
      loadedAssets: () => view?.loadedAssets() ?? [],
      currentReadout,
      viewState,
      // Supplied as a closure so generate.ts stays ignorant of dashboard internals, and resolved
      // at generation time like dataset() -- the scan can change while the dialog is open.
      longitudinal: () => {
        const info = manifest?.longitudinal ?? null
        if (!info || !changeMapFor(changeChoice)) return null
        return {
          timepoints: info.timepoints,
          times: info.times,
          timeSource: info.timeSource,
          timeInterpretable: isTimeInterpretable(info),
          skipped: info.skipped,
          roiRates: (roiRateTable?.rows() ?? []).map((r) => ({
            roi: r.roi,
            hemi: r.hemi,
            measure: r.measure,
            slope: r.slope,
            mean: r.mean,
            spc: r.spc,
            nTimepoints: r.nTimepoints,
          })),
          agreement: lastAgreement,
        }
      },
      // A hidden pane has a zero-sized canvas; passing its visibility lets the report say the pane
      // was hidden rather than reporting a failed capture.
      panes: () => ({
        slices: { scene: view!.slices, canvas: slicesCanvas, visible: paneState().vol },
        surface: { scene: view!.render, canvas: surfaceCanvas, visible: paneState().surf },
      }),
      crosshair: () => lastCrosshairMm,
      moveCrosshair: (mm) => view?.moveCrosshairToWorld(mm),
    }
  }

  const syncReportControls = (): void => {
    const ready = Boolean(view && manifest)
    // A point can only be bookmarked once the crosshair has a position — on a fresh load NiiVue
    // emits nothing until the first interaction, and an enabled button that silently did nothing
    // would read as broken.
    addPointBtn.disabled = !ready || !lastMm
    reportBtn.disabled = !ready
    exportSvgRailBtn.disabled = !ready
    const count = bookmarks.count()
    pointCount.textContent = String(count)
    pointListHead.textContent = count === 0 ? 'bookmarked' : `bookmarked (${count})`
    // The rail is subject-scoped. Its underlay half hides itself when there is no base volume
    // (syncVolumeControls), so the rail's own visibility tracks "a subject is loaded" instead —
    // otherwise a volume-less subject would take the points block down with it.
    volRail.hidden = !ready
  }

  // The rail's point list. Rebuilt only when the set of rows changes, so a rename cannot detach the
  // edited row's buttons between mousedown and mouseup (see sameBookmarkIds).
  // What the last clear discarded, so the empty state can say so. Points are coordinates plus
  // values sampled from one reconstruction, and the scan picker makes clearing them far easier to
  // trigger than the monkey dropdown ever did -- silently emptying a hand-built list is the kind
  // of thing that reads as a bug.
  let clearedFrom: string | null = null
  let renderedPointIds: string[] | null = null
  const renderPoints = (): void => {
    const items = bookmarks.list()
    const ids = items.map((b) => b.id)
    if (sameBookmarkIds(renderedPointIds, ids)) return
    renderedPointIds = ids
    pointList.innerHTML = ''
    if (items.length === 0) {
      const note = clearedFrom
        ? `Points from ${clearedFrom} were cleared — a point belongs to the scan it was taken in.`
        : 'Use “+ point” to bookmark the crosshair.'
      pointList.append(h('p', { class: 'muted point-empty' }, [`No points yet. ${note}`]))
      return
    }
    items.forEach((bookmark, i) => {
      const name = h('input', { type: 'text', class: 'point-name', value: bookmark.label ?? '', placeholder: bookmarkName(bookmark, i) }) as HTMLInputElement
      name.addEventListener('change', () => bookmarks.rename(bookmark.id, name.value))
      // The whole "go back to that point": moveCrosshairToWorld re-emits through onCrosshair, so the
      // marker, the coordinate editor and every info column follow with no extra wiring.
      const go = h('button', { type: 'button', class: 'icon-btn point-go', title: 'Move the crosshair to this point' }, [crosshairIcon()])
      go.addEventListener('click', () => view?.moveCrosshairToWorld(bookmark.readout.mm))
      const del = h('button', { type: 'button', class: 'icon-btn point-del', title: 'Remove this point' }, ['×'])
      del.addEventListener('click', () => bookmarks.remove(bookmark.id))
      const mm = bookmark.readout.mm.map((v) => v.toFixed(1)).join(', ')
      pointList.append(
        h('div', { class: 'point-row' }, [
          h('span', { class: 'point-n' }, [`${i + 1}`]),
          name,
          go,
          del,
          h('span', { class: 'point-mm', title: `${mm} mm` }, [mm]),
        ]),
      )
    })
  }
  bookmarks.subscribe(() => {
    renderPoints()
    syncReportControls()
  })

  addPointBtn.addEventListener('click', () => {
    const readout = currentReadout()
    if (!readout) return
    bookmarks.add({ readout, activeOverlay: overlayDescription() })
  })

  reportBtn.addEventListener('click', () => {
    if (!view || !manifest) return
    const sourceId = store.get('sourceId')
    const source = sources.list().find((entry) => entry.id === sourceId) ?? null
    mountReportDialog({
      client,
      context: reportContext(),
      bookmarks,
      sourceId,
      sourceLabel: source ? (source.customLabel ?? source.label) : null,
    })
  })

  const openExportDialog = (): void => {
    if (!view || !manifest) return

    const target = colorTarget()
    let legendInfo: LegendExportInfo | null = null
    if (target === 'function' && funcChoice) {
      const key = funcColormapKey()
      legendInfo = {
        title: `${funcChoice.kind === 'retinotopy' ? 'Retinotopy' : 'Somatotopy'} · ${funcChoice.mode.label}`,
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        displayRange: { min: funcCalMin, max: funcCalMax },
        barTicks: funcChoice.kind === 'somatotopy' ? (['foot', 'hand', 'face'] as [string, string, string]) : undefined,
      }
    } else if (target === 'morphology') {
      const metric = morphActiveMetric()
      const key = morphColormaps[metric] ?? 'gray'
      legendInfo = {
        title: `Morphology · ${metric}`,
        gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
        lut: colormapLuts[key],
        displayRange: morphRanges[metric],
      }
    } else if (target === 'atlas' && lastAtlasSel) {
      const key = atlasColormap ?? LABELS_KEY
      if (atlasColormap !== null) {
        legendInfo = {
          title: `Atlas · ${lastAtlasSel.name}`,
          gradient: colormapGradients[key] ?? FALLBACK_GRADIENT,
          lut: colormapLuts[key],
          displayRange: { min: atlasDisplayMin, max: atlasDisplayMax },
        }
      }
    }

    mountExportFigureDialog({
      view,
      activeLayout: store.get('layout'),
      volEnabled: volCheck.checked,
      surfEnabled: surfCheck.checked,
      annotationsEnabled: crosshairCheck.checked || orientCheck.checked || markerCheck.checked,
      legendInfo,
      subjectId: manifest.id,
      isWhiteBackground: isWhiteBg,
    })
  }

  exportSvgRailBtn.addEventListener('click', openExportDialog)

  // --- subject loading ---
  // Snapshot of the current view, captured before a monkey OR scan switch so the incoming data
  // restores the exact same view (camera, overlays, settings) instead of resetting to defaults.
  // Null on the first-ever load. Goal: "keep the current view, just swap the data" so two monkeys
  // -- or two timepoints of one monkey -- compare 1:1.
  type ViewSnapshot = {
    // Which reconstruction the snapshot was taken in, so the crosshair is only restored into a
    // frame where its coordinate still means the same thing.
    scan: ScanSummary | null
    volumeKey: string | null
    surfaceKind: string | null
    camera: { azimuth: number; elevation: number; scale: number; baseScale: number }
    crosshairMm: [number, number, number] | null
    dockedTab: 'atlas' | 'morphology' | 'function' | 'longitudinal' | null
    // The overlay actually painted on the surface right now (at most one of atlas/function); plus the
    // "remembered" selections for tab toggling, restored best-effort.
    activeOverlay: 'atlas' | 'function' | null
    lastAtlasSel: AtlasSelection | null
    lastFuncChoice: FunctionChoice | null
    atlas: { opacity: number; colormap: string | null; hidden: Set<number> }
    func: { threshold: number; opacity: number; brightness: number; colormap: string | null; calMin: number; calMax: number; clipLo: number | null; clipHi: number | null }
    morph: {
      metric: MorphologyDisplayMetric
      style: CurvatureStyle
      ranges: Record<MorphologyMetric, { min: number; max: number }>
      colormaps: Partial<Record<MorphologyMetric, string>>
      clip: Record<MorphologyMetric, { lo: number | null; hi: number | null }>
    }
  }

  const MORPH_METRICS: MorphologyMetric[] = ['curvature', 'sulc', 'thickness']
  // Apply a snapshot's morphology shading state (or the defaults). Must run BEFORE applySurface, which
  // reads morphDisplay(). A restored metric whose shape is missing on the new subject falls back to
  // binary curvature (or 'none' if the subject has no curvature) so the surface still shades.
  const applyMorphSnapshot = (m: ViewSnapshot['morph'] | null, mf: Manifest): void => {
    for (const k of MORPH_METRICS) {
      morphRanges[k] = m ? { ...m.ranges[k] } : { ...MORPH_DEFAULT_RANGE[k] }
      morphColormaps[k] = m ? (m.colormaps[k] ?? MORPH_DEFAULT_COLORMAP[k]) : MORPH_DEFAULT_COLORMAP[k]
      morphClip[k] = m ? { ...m.clip[k] } : { lo: null, hi: null }
    }
    let metric: MorphologyDisplayMetric = m?.metric ?? 'curvature'
    if (metric !== 'none' && !mf.morphology?.shape?.[metric]) metric = mf.morphology?.shape?.curvature ? 'curvature' : 'none'
    morphMetric = metric
    morphStyle = m?.style ?? 'binary'
  }

  // One-time view construction and wiring, memoized as a promise.
  //
  // Creating a MultiView is async (attaching NiiVue to a canvas is), so an `if (!view)` check can no
  // longer decide this by itself: two rapid subject switches would both pass the check, each attach
  // a second NiiVue pair to the same two canvases, and re-run every subscription below. The promise
  // IS the guard — the first caller does the work, every later caller awaits the same result.
  let viewReady: Promise<MultiView> | null = null
  const ensureView = async (): Promise<MultiView> => {
    const created = await MultiView.create(slicesCanvas, surfaceCanvas, client)
    view = created
    if (isWhiteBg) created.setBackgroundColor(true)
    // The panes get their final flex/grid size only after this dashboard lays out; NiiVue
    // sized its canvases against the pre-layout dimensions, leaving a first-paint artifact
    // that only cleared when the user resized the window (fullscreen toggle, devtools). Observe
    // the panes so the view re-fits the instant they get their real size, and on any later
    // layout change — self-correcting, no manual resize needed.
    const paneObserver = new ResizeObserver(() => view?.resize())
    paneObserver.observe(slicePane)
    paneObserver.observe(surfacePane)
    // Colormap registry + assets are subject-independent — build once from every map NiiVue
    // offers (brainana maps + built-ins), then mount the shared color-display section. The
    // synthetic entry (categorical restore) is only meaningful for the atlas target. It is
    // labelled "none" — a categorical atlas has no continuous colormap; its colors come from the
    // per-ROI label table (the ROI list above), so the picker reads "none" with a neutral swatch.
    const built = buildColormapRegistry(availableColormaps(created.slices))
    colormapInfos = [{ key: LABELS_KEY, label: 'none', group: 'Brainana' }, ...built]
    // Reversed twins are registered and sampled, but deliberately NOT added to colormapInfos:
    // infos is what the picker LISTS, gradients/luts is what can be RENDERED. The reverse toggle
    // reaches the twins by key, so the dropdown stays one row per map instead of two.
    const baseKeys = built.map((c) => c.key)
    // Only the maps that actually gained a twin may be reversed. NiiVue substitutes `gray` for an
    // unregistered key instead of throwing, so an ungated toggle would silently repaint the
    // overlay in grayscale and look like a deliberate choice.
    reversibleColormaps = new Set(created.registerReversedColormaps(baseKeys))
    const assets = buildColormapAssets(created.slices, [...baseKeys, ...baseKeys.map(reversedKey)])
    colormapGradients = { ...assets.gradients, [LABELS_KEY]: 'linear-gradient(90deg, #6b6b6b, #6b6b6b)' }
    colormapLuts = assets.luts
    colorDisplay = createColorDisplay(colorDisplayCallbacks, colormapGradients, colormapInfos)
    colorDock.append(colorDisplay.element)
    marker = new Marker(created.render)
    // Orientation gizmo (R/L·A/P·S/I) is a permanent surface-pane widget, always shown.
    gizmo = new OrientationGizmo(surfacePane, created.render)
    gizmo.start()
    syncMarkerControls()
    created.onCrosshair((info) => {
      lastMm = info.mm
      lastCrosshairMm = info.mm
      // Map the crosshair to a reference-surface node, then pin it on the displayed surface.
      const node = created.nearestNode(info.mm)
      if (node) {
        currentNode = node
        placeMarker()
      }
      const ijk = created.baseVox(info.mm)
      const hemiNode = node ?? currentNode
      coordEditor.update(info.mm, ijk, hemiNode ? (hemiNode.hemi === 0 ? 'L' : 'R') : '—')
      updateAnatomyReport()
      updateFunctionReport()
      updateVisualField()
      updateSurfaceReport()
      updateOverlayValue()
      // Cheap no-op once enabled; this is what un-gates "+ point" on the first crosshair move.
      if (addPointBtn.disabled) syncReportControls()
    })
    return created
  }

  // The scan the user last chose, carried across a subject switch by stream when the new subject
  // has no scan with the same id.
  let lastScan: ScanSummary | null = null
  // Latest-wins guard. There used to be exactly one way in here (the monkey dropdown), and
  // switching monkeys is a slow deliberate act, so overlapping loads were not reachable. The scan
  // picker is a second, much faster entry point: without this, two runs both mutate `manifest`,
  // the dropdowns and every panel, and the result is a mix of two reconstructions.
  //
  // The check has to be repeated after EVERY await, not just the fetch. Everything below reads the
  // module-level `manifest`, so an overtaken run that only checked once carried on painting against
  // the winner's manifest while still holding its own snapshot.
  let loadRun = 0

  const loadSubject = async (sourceId: string, subjectId: string, wantScanId: string | null = null): Promise<void> => {
    const run = ++loadRun
    const stale = () => run !== loadRun
    const label = subjectId.replace(/^sub-/, '')
    showLoading(`Loading ${label}…`)
    // Capture the outgoing view before any state is overwritten, so it can be restored onto the new
    // subject. Only when a view already exists (the first load has nothing to preserve).
    const snap: ViewSnapshot | null =
      view && manifest
        ? {
            scan: manifest.scan ?? null,
            volumeKey: manifest.volumes[Number(volSelect.value)]?.key ?? null,
            surfaceKind: surfSelect.value || null,
            camera: view.getCamera(),
            crosshairMm: lastCrosshairMm,
            dockedTab,
            // lastAtlasSel (not atlasEntries.length) marks an active atlas: a continuous atlas has
            // no ROIs (atlasEntries === []) yet is still a painted overlay to restore. Matches colorTarget().
            activeOverlay: funcChoice ? 'function' : lastAtlasSel != null ? 'atlas' : null,
            lastAtlasSel,
            lastFuncChoice,
            atlas: { opacity: atlasOpacity, colormap: atlasColormap, hidden: new Set(atlasHidden) },
            func: { threshold: funcThreshold, opacity: funcOpacity, brightness: funcBrightness, colormap: funcColormap, calMin: funcCalMin, calMax: funcCalMax, clipLo: funcClipLo, clipHi: funcClipHi },
            morph: {
              metric: morphMetric,
              style: morphStyle,
              ranges: { curvature: { ...morphRanges.curvature }, sulc: { ...morphRanges.sulc }, thickness: { ...morphRanges.thickness } },
              colormaps: { ...morphColormaps },
              clip: { curvature: { ...morphClip.curvature }, sulc: { ...morphClip.sulc }, thickness: { ...morphClip.thickness } },
            },
          }
        : null
    try {
      const fetched = (await files.getManifest(sourceId, subjectId, wantScanId)) as unknown as Manifest
      if (stale()) return
      manifest = fetched
      // Points are coordinates in the OUTGOING reconstruction's space, carrying values sampled
      // from its volumes and overlays; keeping them would silently relabel them as points in the
      // incoming one. True across a scan switch as much as a subject switch -- even between the
      // base and one of its timepoints, where the frame matches but the values do not.
      // Cleared only once the manifest is in hand: a failed fetch leaves the previous scan on
      // screen, and its points must survive with it.
      const previous = snap?.scan ?? null
      clearedFrom =
        bookmarks.count() > 0
          ? previous
            ? `${previous.subjectId.replace(/^sub-/, '')} / ${previous.label}`
            : 'the previous scan'
          : null
      bookmarks.clear()
      renderedPointIds = null
      // Read the active scan back from the manifest rather than echoing what was asked for. The
      // server 404s an id it does not recognise (it never falls back to a different scan), so a
      // successful fetch has already agreed on the scan -- and on a request with no `?scan=` at
      // all, the manifest is the only thing that knows which default was chosen.
      lastScan = manifest.scan ?? null
      populateScanSelect(manifest)
      store.update({ sourceId, subjectId, scanId: lastScan?.id ?? null, scanStream: lastScan?.stream ?? null })

      // vol dropdown
      volSelect.innerHTML = ''
      manifest.volumes.forEach((v, i) => volSelect.append(h('option', { value: String(i) }, [v.label])))
      // Keep the same base volume across a switch when this subject has it; else default (norm.mgz).
      const snapVolIdx = snap?.volumeKey != null ? manifest.volumes.findIndex((v) => v.key === snap.volumeKey) : -1
      const volIdx = snapVolIdx >= 0 ? snapVolIdx : defaultVolumeIndex(manifest.volumes)
      volSelect.value = String(volIdx)

      // surf dropdown (only present surfaces)
      const available = SURFACE_ORDER.filter((k) => manifest!.surfaces[k])
      surfSelect.innerHTML = ''
      available.forEach((k) => surfSelect.append(h('option', { value: k }, [SURFACE_LABELS[k]])))
      // Keep the same surface type across a switch when this subject has it; else inflated / first.
      const surfDefault =
        snap?.surfaceKind && (available as string[]).includes(snap.surfaceKind)
          ? snap.surfaceKind
          : available.includes('inflated')
            ? 'inflated'
            : available[0]
      if (surfDefault) surfSelect.value = surfDefault

      // Decide morphology shading now — applySurface (below) builds the surface from morphDisplay().
      applyMorphSnapshot(snap?.morph ?? null, manifest)

      view = await (viewReady ??= ensureView())
      if (stale()) return

      // Apply the sticky fov preference to the incoming subject. It degrades to 'best' when this
      // dataset has no full-FOV volume, without clearing the preference, so a later subject that
      // does have one comes up in full FOV again.
      fovMode = resolveFovMode(fovPref, manifest.fullFov != null)
      const baseVol = manifest.volumes[volIdx]
      const baseUrl = fovMode === 'full' ? manifest.fullFov?.url : baseVol?.url
      // Honour setBaseVolume's latest-wins result here as the other two call sites do. Switching
      // subjects while one is still loading makes this load the LOSER, and re-seeding the underlay
      // rail from a volume that was never applied would set the window/clip for the wrong image.
      // A subject with NO volume still syncs, because that call is also what hides the rail —
      // skipping it would leave the previous subject's rail on screen.
      const superseded = baseUrl ? !(await view.setBaseVolume(baseUrl, 1)) : false
      if (stale()) return
      if (!superseded) syncVolumeControls() // seed the underlay rail (window/clip/zoom), or hide it
      syncFovControls() // reflect availability + mode for this subject on the fov switch
      // Reference surface for node lookup (pial in world space; fall back to white).
      await view.setReference(manifest.surfaces.pial ?? manifest.surfaces.white)
      if (stale()) return
      if (surfDefault) await applySurface(surfDefault)
      if (stale()) return
      setActiveLayout(store.get('layout')) // sizes the surface pane before we auto-fit
      // Fresh load: frame the mesh to this pane. A snapshot restore instead reapplies the saved
      // camera further below, so it wins over the fit (Req 11).
      if (!snap && surfDefault) view.fitSurface()

      // (re)build the atlas panel for this subject, restoring the prior opacity onto the slider.
      atlasPanel?.element.remove()
      if (snap) atlasOpacity = snap.atlas.opacity
      atlasPanel = createAtlasPanel(
        manifest,
        {
          onSelect: (sel) => {
            lastAtlasSel = sel
            void selectAtlas(sel)
          },
          onOpacity: (v) => {
            atlasOpacity = v
            view!.setAtlasOpacity(v) // slices volume
            view!.setSurfaceOverlayOpacity(v) // surface layer
          },
        },
        { opacity: atlasOpacity },
      )
      sidePicker.append(atlasPanel.element)
      // Restore the remembered atlas (for tab toggling) only if this subject has one of the same name.
      lastAtlasSel = snap?.lastAtlasSel && manifest.atlases?.some((a) => a.name === snap.lastAtlasSel!.name) ? snap.lastAtlasSel : null
      if (snap?.activeOverlay === 'atlas' && lastAtlasSel) {
        await selectAtlas(lastAtlasSel) // selectAtlas sets colormap (magma for float atlases, else categorical), hidden→∅
        if (stale()) return
        view!.setSurfaceOverlayOpacity(atlasOpacity)
        if (snap.atlas.colormap && snap.atlas.colormap !== atlasColormap) {
          atlasColormap = snap.atlas.colormap
          applyAtlasColormap() // re-apply the saved colormap override on vol + surf
        }
        if (snap.atlas.hidden.size) applyHidden(new Set(snap.atlas.hidden)) // restore hidden ROIs (also re-applies colormap)
        refreshColorDisplay()
      } else {
        await selectAtlas(null)
        if (stale()) return
      }
      loadReportSpecs(manifest)

      // (re)build the function panel for this subject, restoring the prior opacity/brightness sliders.
      functionPanel?.element.remove()
      if (snap) {
        funcOpacity = snap.func.opacity
        funcBrightness = snap.func.brightness
      }
      functionPanel = createFunctionPanel(
        manifest,
        {
          onSelect: (choice) => {
            lastFuncChoice = choice
            void selectFunction(choice)
          },
          onThreshold: (v) => {
            funcThreshold = v
            applyFunctionColor() // re-mask both slices and surface at the new threshold
            updateFunctionReport()
            updateVisualField()
          },
          onOpacity: (v) => {
            funcOpacity = v
            view!.setFunctionalOpacity(v)
            void applyFunctionSurface() // opacity also drives the surface layer
          },
          onBrightness: (v) => {
            funcBrightness = v
            void applyFunctionSurface()
          },
        },
        { opacity: funcOpacity, brightness: funcBrightness },
      )
      sidePicker.append(functionPanel.element)

      // --- longitudinal change maps (base template scans only) ---
      longPanel?.element.remove()
      longPanel = createLongitudinalPanel(
        manifest,
        {
          onSelect: (choice) => void selectChange(choice),
          onThreshold: (v) => {
            changeThreshold = v
            void applyChangeSurface()
            updateSurfaceReport()
          },
          onOpacity: (v) => {
            changeOpacity = v
            void applyChangeSurface()
          },
        },
        { opacity: changeOpacity },
      )
      sidePicker.append(longPanel.element)
      roiRateTable = createRoiRateTable()
      changeSlot.innerHTML = ''
      changeSlot.append(
        h('div', { class: 'legend-title' }, ['ROI fits']),
        roiRateTable.element,
      )
      void loadRoiRates(manifest)
      changeBtn.hidden = !hasChangeMaps(manifest)
      void loadAgreement(manifest)
      // Restore the remembered function map if this subject has the same map kind; else clear. Pass the
      // snapshot settings THROUGH selectFunction (single surface pass) for an exact "carry over" match.
      lastFuncChoice = snap?.lastFuncChoice ? functionPanel.getChoice(choiceKey(snap.lastFuncChoice)) : null
      if (snap?.activeOverlay === 'function' && lastFuncChoice) {
        await selectFunction(lastFuncChoice, snap.func)
        if (stale()) return
      } else {
        funcChoice = null
      }
      loadMorphology(manifest)

      // (re)build the morphology panel, reflecting the restored shading (set by applyMorphSnapshot).
      morphPanel?.element.remove()
      morphPanel = createMorphologyPanel(
        {
          onDisplay: (m) => {
            morphMetric = m
            view?.applyMorphologyDisplay(morphDisplay())
            refreshColorDisplay()
          },
          onCurvatureStyle: (s) => {
            morphStyle = s
            view?.applyMorphologyDisplay(morphDisplay())
            refreshColorDisplay()
          },
        },
        { metric: morphMetric, style: morphStyle },
      )
      sidePicker.append(morphPanel.element)
      refreshColorDisplay()

      // Restore the docked side tab (which picker is open); overlays were restored above.
      dockedTab = snap ? snap.dockedTab : null
      if (!hasChangeMaps(manifest) && dockedTab === 'longitudinal') dockedTab = null
      updateTabUI()

      // Restore the surface camera (zoom + orientation) and the crosshair coordinate, so the switch is
      // a pure data swap. Done last, after all mesh/volume loads that could otherwise reset the camera.
      if (snap) {
        // The camera is azimuth/elevation/scale, so it is meaningful in any frame. The crosshair
        // is a coordinate in millimetres, and carrying one into a different reconstruction's frame
        // lands it somewhere subtly, silently wrong -- worse than not restoring it at all. Only
        // the base template and its base-seeded timepoints share a frame.
        view!.setCamera(snap.camera)
        if (snap.crosshairMm && sameSpace(snap.scan, manifest.scan ?? null)) view!.moveCrosshairToWorld(snap.crosshairMm)
      }

      main.classList.add('monkey-loaded')
      syncReportControls()
      hideLoading()
    } catch (err) {
      showError(errorText(err))
    }
  }

  // Fill the scan picker from the manifest's own roster, grouped so the two families read as two
  // things rather than one long list: cross-sectional scans each have their own space and are what
  // the functional stream registered to; longitudinal ones share the base template's mesh.
  const populateScanSelect = (mf: Manifest): void => {
    const scans = mf.scans ?? (mf.scan ? [mf.scan] : [])
    const { cross, longitudinal } = groupScans(scans)
    scanSelect.innerHTML = ''
    const addGroup = (label: string, list: ScanSummary[]): void => {
      if (!list.length) return
      const group = h('optgroup', { label }) as HTMLOptGroupElement
      for (const scan of list) {
        group.append(h('option', { value: scan.id, title: scanTooltip(scan) }, [scan.label]))
      }
      scanSelect.append(group)
    }
    addGroup('cross-sectional', cross)
    addGroup('longitudinal', longitudinal)
    if (mf.scan) scanSelect.value = mf.scan.id
    scanSelect.disabled = !hasChoice(scans)
    scanSelect.title = scanPickerTooltip(mf)
  }

  // --- monkey dropdown across all sources ---
  // Overlapping invocations (sources.subscribe fires immediately, the boot chain, and the
  // Dataset dialog all trigger this near-simultaneously) used to each clear + append a full
  // set, duplicating every monkey. Guard with a run token: build into a detached fragment and
  // only the newest run swaps it in; stale runs bail after each await.
  let monkeyRun = 0
  const repopulateMonkeys = async (): Promise<void> => {
    const run = ++monkeyRun
    const list = sources.list()
    const frag = document.createDocumentFragment()
    frag.append(h('option', { value: '' }, ['select sub…']))
    for (const src of list) {
      let monkeys: MonkeySummary[] = []
      try {
        monkeys = await files.listMonkeys(src.id)
      } catch {
        continue
      }
      if (run !== monkeyRun) return // a newer run superseded this one
      const group = h('optgroup', { label: src.customLabel || src.label }) as HTMLOptGroupElement
      for (const m of monkeys) {
        const opt = h('option', { value: `${src.id}::${m.id}` }, [m.label]) as HTMLOptionElement
        group.append(opt)
      }
      frag.append(group)
    }
    if (run !== monkeyRun) return
    const prev = monkeySelect.value
    monkeySelect.innerHTML = ''
    monkeySelect.append(frag)
    if (prev && Array.from(monkeySelect.options).some((o) => o.value === prev)) monkeySelect.value = prev
  }
  monkeySelect.addEventListener('change', () => {
    const [sourceId, subjectId] = monkeySelect.value.split('::')
    if (!sourceId || !subjectId) return
    // Blank the picker while the manifest is in flight: the outgoing subject's sessions must never
    // be on offer against the incoming one, even briefly.
    scanSelect.innerHTML = ''
    scanSelect.append(h('option', { value: '' }, ['loading…']))
    scanSelect.disabled = true
    // Deliberately NOT carrying the current scan id: ids are subject-scoped, and the server
    // (rightly) 404s one that names no reconstruction of the subject asked for. A new subject
    // opens on its own default scan; the view snapshot still carries the camera and overlays,
    // which is what makes two subjects comparable.
    void loadSubject(sourceId, subjectId, null)
  })
  scanSelect.addEventListener('change', () => {
    const [sourceId, subjectId] = monkeySelect.value.split('::')
    if (sourceId && subjectId && scanSelect.value) void loadSubject(sourceId, subjectId, scanSelect.value)
  })

  datasetBtn.addEventListener('click', () =>
    mountSourcesDialog(deps, () => void repopulateMonkeys(), () => {
      // Guide the eye to the now-populated monkey picker after the Datasets dialog closes.
      monkeySelect.focus()
      monkeySelect.classList.add('pulse')
      setTimeout(() => monkeySelect.classList.remove('pulse'), 1200)
    }),
  )
  sources.subscribe(() => void repopulateMonkeys())

  // Arrow keys nudge the crosshair ±1.5 mm (Left/Right = x, Up/Down = superior/inferior).
  const NUDGE = 1.5
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
    const delta: Record<string, [number, number, number]> = {
      ArrowLeft: [-NUDGE, 0, 0],
      ArrowRight: [NUDGE, 0, 0],
      ArrowUp: [0, 0, NUDGE],
      ArrowDown: [0, 0, -NUDGE],
    }
    const d = delta[e.key]
    if (d && view) {
      e.preventDefault()
      view.nudgeCrosshair(d)
    }
  })

  // Drag the yellow marker on the surface to move the crosshair (Req 8). Listen in the CAPTURE
  // phase on the surface pane (the marker's parent) so a drag that starts on the marker is
  // intercepted before NiiVue's camera rotation; drags elsewhere fall through to rotate as usual.
  {
    let draggingMarker = false
    let rafPending = false
    let pending: { x: number; y: number } | null = null
    const HIT_PX = 26
    const nearMarker = (clientX: number, clientY: number): boolean => {
      if (!view || !currentNode || !paneState().surf) return false
      const world = view.nodeWorld(currentNode)
      if (!world) return false
      // The pin is DRAWN lifted outward along the surface normal (Marker.setWorld); grab-test that
      // same lifted centre, not the bare vertex, so the hit region tracks where the pin actually is.
      const normal = view.nodeWorldNormal(currentNode)
      const lift = marker?.liftAmount() ?? 0
      const target: [number, number, number] =
        normal && lift ? [world[0] + normal[0] * lift, world[1] + normal[1] * lift, world[2] + normal[2] * lift] : world
      const sp = view.projectToScreen(target, surfaceCanvas)
      if (!sp || !(sp.w > 0)) return false
      return Math.hypot(sp.x - clientX, sp.y - clientY) <= HIT_PX
    }
    const applyPick = (x: number, y: number): void => {
      if (!view) return
      // Constrain the drag to walk along mesh neighbours from the current vertex so it can't jump
      // across a thin cortical ribbon to the far wall. Fall back to the global pick only when there
      // is no current node yet (or no adjacency for its hemisphere).
      const node = (currentNode && view.walkNode(currentNode, x, y, surfaceCanvas)) || view.pickNodeAtScreen(x, y, surfaceCanvas)
      if (!node) return
      const refWorld = view.refNodeWorld(node)
      if (refWorld) {
        view.moveCrosshairToWorld(refWorld) // syncs slices + re-pins via onCrosshair
      } else {
        currentNode = node
        placeMarker()
      }
    }
    surfacePane.addEventListener(
      'pointerdown',
      (e) => {
        if (!nearMarker(e.clientX, e.clientY)) return
        draggingMarker = true
        surfacePane.setPointerCapture(e.pointerId)
        e.preventDefault()
        e.stopPropagation()
      },
      true,
    )
    surfacePane.addEventListener(
      'pointermove',
      (e) => {
        if (!draggingMarker) return
        e.preventDefault()
        e.stopPropagation()
        pending = { x: e.clientX, y: e.clientY }
        if (rafPending) return
        rafPending = true
        requestAnimationFrame(() => {
          rafPending = false
          if (pending) applyPick(pending.x, pending.y)
        })
      },
      true,
    )
    const endDrag = (e: PointerEvent): void => {
      if (!draggingMarker) return
      draggingMarker = false
      try {
        surfacePane.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }
    surfacePane.addEventListener('pointerup', endDrag, true)
    surfacePane.addEventListener('pointercancel', endDrag, true)
  }

  window.addEventListener('resize', () => {
    view?.resize()
    updateVisualField()
  })

  // Boot: ensure sources are loaded, then populate.
  sources
    .refresh()
    .then(() => repopulateMonkeys())
    .catch((err) => showError(errorText(err)))
}
