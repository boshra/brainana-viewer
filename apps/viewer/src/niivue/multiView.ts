// Two NiiVue instances (audit decision): one MULTIPLANAR for the slice montage, one RENDER
// for the surface + marker. Crosshair is coupled with NiiVue's native broadcastTo({crosshair})
// (independent cameras). The base volume is loaded once and cloned into both instances.
import { Niivue, NVImage, NVMesh, SLICE_TYPE, MULTIPLANAR_TYPE, SHOW_RENDER, NVMeshLayerDefaults } from '@niivue/niivue'
import type { RuntimeClient } from '@brainana/core-client/runtimeClient.ts'
import type { Layout } from '../state/store.ts'
import { registerColormaps, registerReversed } from './colormaps.ts'
import { mapFunctionalDisplay, surfaceLutFromColormap, quantizeScalarToBins, maskSurfaceBinsByValue } from '../data/functional.ts'

// Surface auto-fit: instead of hand-tuned per-surface/per-view zoom constants, we measure the
// mesh's projected on-screen bounds and rescale volScaleMultiplier so it fills a consistent
// fraction of the pane — independent of monitor/window shape (see #fitSurfaceToView).
const SURFACE_FIT_FRACTION = 0.9 // mesh fills 90% of the binding (limiting) pane dimension
const SURFACE_SCALE_MIN = 0.25 // clamp so a hidden/degenerate pane can't produce absurd zoom
const SURFACE_SCALE_MAX = 12

// NIfTI codes used to flip an atlas volume into NiiVue's discrete label shader (see #setAtlasVolumeImage).
const NII_DT_UINT8 = 2 // datatypeCode for 8-bit unsigned integer voxels (continuous-atlas bins)
const NII_DT_UINT16 = 512 // datatypeCode for 16-bit unsigned integer voxels
const NII_INTENT_LABEL = 1002 // intent_code NIFTI_INTENT_LABEL — selects the non-interpolating atlas shader
const ATLAS_LABEL_MAX = 65535 // largest id representable in u16; atlases exceeding it stay on the float path

export interface SurfacePairUrls {
  left: string
  right: string
}

export interface LabelColortable {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  labels: string[]
}

// Precomputed surface atlas/function layer (per-hemisphere .func.gii) + its colortable.
export interface SurfaceOverlay {
  left: string
  right: string
  table: LabelColortable
}

export type MorphologyMetric = 'curvature' | 'sulc' | 'thickness'
export type MorphologyDisplayMetric = MorphologyMetric | 'none'
export type CurvatureStyle = 'binary' | 'continuous'

// The single source of truth for per-metric default morphology colormaps (continuous shading).
// Imported by the dashboard for its state init + reset; used here as the layer fallback. Binary
// curvature always keeps its dedicated 2-tone LUT (brainana_curvature) and is not overridable.
export const MORPH_DEFAULT_COLORMAP: Record<MorphologyMetric, string> = { curvature: 'gray', sulc: 'blue2red', thickness: 'viridis' }

// The three per-hemisphere morphology shading sources (.shape.gii pairs). Any may be absent.
export interface MorphologyShapePairs {
  curvature?: SurfacePairUrls
  sulc?: SurfacePairUrls
  thickness?: SurfacePairUrls
}

export interface MorphologyDisplay {
  metric: MorphologyDisplayMetric
  curvatureStyle: CurvatureStyle
  ranges: Record<MorphologyMetric, { min: number; max: number }>
  /** Optional per-metric colormap override (binary curvature keeps its dedicated LUT). */
  colormaps?: Partial<Record<MorphologyMetric, string>>
  /** Two-sided value clip on the surface (as in function): vertices outside [lo, hi] render
   * transparent (masked to NaN), independent of the display colour range. null = open on that side. */
  clip?: { lo: number | null; hi: number | null }
}

export interface CrosshairInfo {
  mm: [number, number, number]
}

export interface SurfaceNode {
  hemi: 0 | 1
  index: number
}

/** Flat geometry arrays as NVMesh stores them (3 floats per vertex, 3 indices per face). */
export interface MeshArrays {
  pts?: ArrayLike<number>
  tris?: ArrayLike<number>
}

/** One loaded asset, as reported by MultiView.loadedAssets(). `hdr` is the raw NIfTI header for a
 *  volume; `mesh` the geometry arrays for a surface. Never both. */
export interface LoadedAsset {
  role: string
  url: string | null
  hdr: unknown | null
  mesh: MeshArrays | null
}

// Per-hemisphere vertex adjacency in CSR (compressed sparse row) form, built once per subject from
// the reference mesh triangles. Vertex v's neighbours are neighbors[offsets[v] .. offsets[v + 1]].
// `visited` is generation-stamped scratch for the drag walk (see walkNode) so no per-frame clearing
// is needed. Topology is shared across pial/white/inflated/sphere by the same index convention that
// nearestNode relies on, so one graph is valid for every displayed surface.
interface VertexAdjacency {
  offsets: Uint32Array
  neighbors: Uint32Array
  visited: Int32Array
}

function niivue(): Niivue {
  return new Niivue({ backColor: [0, 0, 0, 1], show3Dcrosshair: false, isColorbar: false, dragAndDropEnabled: false })
}

/**
 * Attach a slices/render NiiVue pair to their canvases and apply the viewer's display settings.
 *
 * Both attachments are awaited BEFORE anything is configured. attachToCanvas establishes the GL
 * context; writing `opts` or calling setSliceType against an unattached instance is undefined
 * territory that merely happens to work today.
 *
 * Takes the instances rather than creating them so the ordering is testable without a GL context.
 */
export async function initNiivuePair(
  slices: Niivue,
  render: Niivue,
  slicesCanvas: HTMLCanvasElement,
  renderCanvas: HTMLCanvasElement,
): Promise<void> {
  // In parallel: they are independent contexts and this is the slow part of startup.
  await Promise.all([slices.attachToCanvas(slicesCanvas), render.attachToCanvas(renderCanvas)])

  slices.setSliceType(SLICE_TYPE.MULTIPLANAR)
  // The surface lives in its own RENDER instance; keep the slice montage to pure planes.
  slices.opts.multiplanarShowRender = SHOW_RENDER.NEVER
  render.setSliceType(SLICE_TYPE.RENDER)
  render.opts.isOrientCube = false
  // Never draw NiiVue's on-canvas mesh legend (hundreds of ARM labels = far too busy).
  render.opts.showLegend = false
  slices.opts.showLegend = false
  // Crosshair tinted green (--ok #8bbf6e) rather than NiiVue's default red: legible against the
  // warm/gold overlays and distinct from the gold surface marker.
  slices.opts.crosshairColor = [0.545, 0.749, 0.431, 1]
  render.opts.crosshairColor = [0.545, 0.749, 0.431, 1]
  registerColormaps(slices)
  registerColormaps(render)
}

export class MultiView {
  readonly slices: Niivue
  readonly render: Niivue
  readonly slicesCanvas: HTMLCanvasElement
  readonly renderCanvas: HTMLCanvasElement
  #client: RuntimeClient
  #baseVol: NVImage | null = null
  // Pristine copy of the base volume's raw voxels, captured lazily the first time a clip is applied.
  // Clip masking mutates #baseVol.img in place (sentinel-below-cal_min → transparent index-0), so the
  // original must be preserved to rebuild the image on every clip/window change and to restore it when
  // the clip is cleared. Reset to null on each base-volume load so the cache re-captures per volume.
  #baseOrig: Float32Array | null = null
  // Clip bounds the current #baseVol.img mask was built for. The mask depends ONLY on these bounds (+
  // the pristine voxels), never on the display window, so a pure cal_min/cal_max change can skip the
  // O(voxels) re-mask loop. undefined = no mask currently applied. Reset on each base-volume load.
  #baseClip: { lo: number | null; hi: number | null } | undefined = undefined
  #atlasVol: NVImage | null = null
  // Discrete-label-shader state for the atlas volume. NiiVue's generic float shader can't cleanly
  // hide background (voxel 0) for label maps with >64 ids (an internal 2/256 "opaque floor" bleeds
  // the first ROI's color over the whole volume). We render eligible atlases through NiiVue's atlas
  // shader (integer datatype + NIFTI_INTENT_LABEL), which discards id 0 and looks up each id exactly.
  // #atlasFloat remembers the original float datatype so a forced continuous colormap can restore it.
  #atlasFloat: { img: ArrayLike<number>; datatypeCode: number; intentCode: number; bitpix: number } | null = null
  #atlasLabelImg: Uint16Array | null = null
  // Continuous (float scalar) atlases like CortHierarchy are NOT parcellations: rendered as a
  // continuous colormap by quantizing values into 256 bins + the discrete label shader (bin 0 =
  // background, transparent), the SAME quantization the surface uses so the two stay consistent.
  #atlasContinuous = false
  #atlasValueRange: { min: number; max: number } = { min: 0, max: 1 }
  #displayMeshes: NVMesh[] = [] // [left, right] currently displayed surface (render instance)
  #refMeshes: NVMesh[] = [] // [left, right] reference surface in WORLD space (not displayed)
  #adjacency: (VertexAdjacency | null)[] = [] // [left, right] vertex neighbours for the drag walk
  #walkGen = 0 // increments per walkNode call to stamp the BFS visited scratch without clearing it
  #crosshairCb: ((info: CrosshairInfo) => void) | null = null
  #syncing = false
  // Source URLs of everything currently loaded, recorded at load time. NiiVue's NVImage/NVMesh
  // do not retain the URL they were fetched from, and the report has to name the files it
  // describes — so each loader stamps its URL here. Purely descriptive; nothing renders from it.
  #urls: { base: string | null; atlas: string | null; atlasName: string | null; functional: string | null; change: SurfacePairUrls | null; changeName: string | null; surface: SurfacePairUrls | null; report: Map<string, string> } = {
    base: null,
    atlas: null,
    atlasName: null,
    functional: null,
    change: null,
    changeName: null,
    surface: null,
    report: new Map(),
  }

  /**
   * Build a MultiView. Async because attaching to a canvas is.
   *
   * Replaces `new MultiView(...)`: a constructor cannot await, and the attachment genuinely has to
   * complete before anything is configured or loaded.
   */
  static async create(slicesCanvas: HTMLCanvasElement, renderCanvas: HTMLCanvasElement, client: RuntimeClient): Promise<MultiView> {
    const slices = niivue()
    const render = niivue()
    await initNiivuePair(slices, render, slicesCanvas, renderCanvas)
    return new MultiView(slices, render, client, slicesCanvas, renderCanvas)
  }

  /**
   * Private: instances arrive already attached and configured, from create(). Everything here is
   * pure wiring that needs no GL context.
   */
  private constructor(slices: Niivue, render: Niivue, client: RuntimeClient, slicesCanvas: HTMLCanvasElement, renderCanvas: HTMLCanvasElement) {
    this.#client = client
    this.slices = slices
    this.render = render
    this.slicesCanvas = slicesCanvas
    this.renderCanvas = renderCanvas

    // Manual crosshair coupling (Align pattern): each instance mirrors the world coord to the
    // other via mm2frac; a suppress flag cleared on the next rAF prevents feedback loops.
    this.slices.onLocationChange = (d: unknown) => this.#handleLoc(this.slices, this.render, d)
    this.render.onLocationChange = (d: unknown) => this.#handleLoc(this.render, this.slices, d)
  }

  #handleLoc(_source: Niivue, target: Niivue, data: unknown): void {
    const mm = (data as { mm?: number[] })?.mm
    if (!mm || mm.length < 3) return
    const v3: [number, number, number] = [mm[0], mm[1], mm[2]]
    // Only act on a genuine, source-initiated change. When the mirror write below drives the
    // OTHER instance's onLocationChange, #syncing is set, so we neither re-mirror nor re-emit —
    // this keeps the (heavy) dashboard crosshair handler firing exactly once per interaction.
    if (this.#syncing) return
    this.#syncing = true
    try {
      target.scene.crosshairPos = target.mm2frac(v3)
      target.drawScene()
    } catch {
      // target may have no volume yet
    }
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16)
    raf(() => {
      this.#syncing = false
    })
    this.#crosshairCb?.({ mm: v3 })
  }

  onCrosshair(cb: (info: CrosshairInfo) => void): void {
    this.#crosshairCb = cb
  }

  // Show/hide the VOLUME crosshair only (zero its line width — alpha alone isn't honoured). The
  // surface render never shows a 3D crosshair. (Marker pin visibility is handled by the dashboard.)
  #crosshairWidth = 1
  setCrosshairVisible(on: boolean): void {
    const nv = this.slices as unknown as { setCrosshairWidth?: (w: number) => void; opts: { crosshairWidth: number } }
    if (on && this.#crosshairWidth <= 0) this.#crosshairWidth = 1
    else if (!on) this.#crosshairWidth = nv.opts.crosshairWidth || this.#crosshairWidth
    if (nv.setCrosshairWidth) nv.setCrosshairWidth(on ? this.#crosshairWidth : 0)
    else nv.opts.crosshairWidth = on ? this.#crosshairWidth : 0
    this.slices.drawScene()
  }

  // Show/hide the anatomical orientation letters (R/L·A/P·S/I) on the VOLUME slice montage.
  setSliceOrientationVisible(on: boolean): void {
    this.slices.opts.isOrientationTextVisible = on
    this.slices.drawScene()
  }

  #whiteBackground = false
  setBackgroundColor(white: boolean): void {
    this.#whiteBackground = white
    const bg: [number, number, number, number] = white ? [1, 1, 1, 1] : [0, 0, 0, 1]
    this.slices.opts.backColor = bg
    this.render.opts.backColor = bg
    // Contrast-tuned crosshair: on dark background use light green (#8bbf6e), on white use deep forest green
    const cross: [number, number, number, number] = white ? [0.14, 0.45, 0.14, 1] : [0.545, 0.749, 0.431, 1]
    this.slices.opts.crosshairColor = cross
    this.render.opts.crosshairColor = cross
    this.slices.drawScene()
    this.render.drawScene()
  }

  isWhiteBackground(): boolean {
    return this.#whiteBackground
  }

  hasActiveOverlay(): boolean {
    return this.#atlasVol !== null || this.#funcVol !== null || this.#atlasLayerIndex >= 0 || this.#funcLayerIndex >= 0
  }

  activeOverlayTitle(): string | null {
    if (this.#urls.atlasName) return this.#urls.atlasName
    if (this.#urls.atlas) return 'Atlas'
    if (this.#urls.functional) return 'Function'
    return null
  }

  /**
   * Synchronously capture the slices pane as both underlay (no overlay) and composite (with overlay) 2D canvases.
   * Restores all original opacities and crosshairs in a finally block so the viewer state is never corrupted.
   */
  captureSlicesCanvases(scale = 1, whiteBg = false, hideAnnotations = true, transparent = true): { underlay: HTMLCanvasElement; composite: HTMLCanvasElement; annotations?: HTMLCanvasElement } | null {
    const canvas = this.slicesCanvas
    if (!canvas || !canvas.width || !canvas.height) return null

    const origBackColor = [...(this.slices.opts.backColor || [0, 0, 0, 1])] as [number, number, number, number]
    const origCrossWidth = (this.slices as unknown as { opts: { crosshairWidth: number } }).opts.crosshairWidth
    const origOrient = this.slices.opts.isOrientationTextVisible

    const atlasIdx = this.#atlasVol ? this.slices.getVolumeIndexByID(this.#atlasVol.id) : -1
    const funcIdx = this.#funcVol ? this.slices.getVolumeIndexByID(this.#funcVol.id) : -1
    const origAtlasOpacity = atlasIdx >= 0 ? this.slices.volumes[atlasIdx].opacity : 0
    const origFuncOpacity = funcIdx >= 0 ? this.slices.volumes[funcIdx].opacity : 0

    const w = Math.max(1, Math.round(canvas.width * scale))
    const h = Math.max(1, Math.round(canvas.height * scale))
    const underlay = document.createElement('canvas')
    underlay.width = w
    underlay.height = h
    const uCtx = underlay.getContext('2d')
    const composite = document.createElement('canvas')
    composite.width = w
    composite.height = h
    const cCtx = composite.getContext('2d')
    if (!uCtx || !cCtx) return null

    let annotations: HTMLCanvasElement | undefined

    try {
      const exportBg: [number, number, number, number] = transparent
        ? (whiteBg ? [1, 1, 1, 0] : [0, 0, 0, 0])
        : (whiteBg ? [1, 1, 1, 1] : [0, 0, 0, 1])
      this.slices.opts.backColor = exportBg

      // Always keep annotations hidden for underlay and composite so base anatomy is pristine
      const nv = this.slices as unknown as { setCrosshairWidth?: (w: number) => void; opts: { crosshairWidth: number } }
      if (nv.setCrosshairWidth) nv.setCrosshairWidth(0)
      else nv.opts.crosshairWidth = 0
      this.slices.opts.isOrientationTextVisible = false

      // Step A: Underlay (mute overlays, hide annotations)
      if (atlasIdx >= 0) this.slices.setOpacity(atlasIdx, 0)
      if (funcIdx >= 0) this.slices.setOpacity(funcIdx, 0)
      this.slices.drawScene()
      uCtx.drawImage(canvas, 0, 0, w, h)

      // Step B: Composite (restore overlays, hide annotations)
      if (atlasIdx >= 0) this.slices.setOpacity(atlasIdx, origAtlasOpacity)
      if (funcIdx >= 0) this.slices.setOpacity(funcIdx, origFuncOpacity)
      this.slices.drawScene()
      cCtx.drawImage(canvas, 0, 0, w, h)

      // Step C: Annotations layer (overlays muted, annotations enabled)
      if (!hideAnnotations) {
        if (atlasIdx >= 0) this.slices.setOpacity(atlasIdx, 0)
        if (funcIdx >= 0) this.slices.setOpacity(funcIdx, 0)
        if (nv.setCrosshairWidth) nv.setCrosshairWidth(origCrossWidth)
        else nv.opts.crosshairWidth = origCrossWidth
        this.slices.opts.isOrientationTextVisible = origOrient
        this.slices.drawScene()

        const aCanvas = document.createElement('canvas')
        aCanvas.width = w
        aCanvas.height = h
        const aCtx = aCanvas.getContext('2d')
        if (aCtx) {
          aCtx.drawImage(canvas, 0, 0, w, h)
          annotations = aCanvas
        }
      }

      return { underlay, composite, annotations }
    } finally {
      this.slices.opts.backColor = origBackColor
      const nv = this.slices as unknown as { setCrosshairWidth?: (w: number) => void; opts: { crosshairWidth: number } }
      if (nv.setCrosshairWidth) nv.setCrosshairWidth(origCrossWidth)
      else nv.opts.crosshairWidth = origCrossWidth
      this.slices.opts.isOrientationTextVisible = origOrient
      if (atlasIdx >= 0) this.slices.setOpacity(atlasIdx, origAtlasOpacity)
      if (funcIdx >= 0) this.slices.setOpacity(funcIdx, origFuncOpacity)
      this.slices.drawScene()
    }
  }

  /**
   * Synchronously capture the surface pane as both underlay (no overlay) and composite (with overlay) 2D canvases.
   * Restores all original opacities and mesh state in a finally block so the viewer state is never corrupted.
   */
  captureSurfaceCanvases(scale = 1, whiteBg = false, hideAnnotations = true, transparent = true): { underlay: HTMLCanvasElement; composite: HTMLCanvasElement; annotations?: HTMLCanvasElement } | null {
    const canvas = this.renderCanvas
    if (!canvas || !canvas.width || !canvas.height) return null

    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    const origBackColor = [...(this.render.opts.backColor || [0, 0, 0, 1])] as [number, number, number, number]

    const atlasIdx = this.#atlasLayerIndex
    const funcIdx = this.#funcLayerIndex
    let origAtlasOpacity = 1
    let origFuncOpacity = 1

    for (const mesh of this.#displayMeshes) {
      const m = mesh as unknown as { layers?: Array<{ opacity: number }> }
      if (atlasIdx >= 0 && m.layers?.[atlasIdx]) origAtlasOpacity = m.layers[atlasIdx].opacity
      if (funcIdx >= 0 && m.layers?.[funcIdx]) origFuncOpacity = m.layers[funcIdx].opacity
    }

    const markerMesh = (this.render.meshes as NVMesh[]).find((m) => m.name === 'selected-location')
    const origMarkerVisible = markerMesh?.visible ?? false

    const w = Math.max(1, Math.round(canvas.width * scale))
    const h = Math.max(1, Math.round(canvas.height * scale))
    const underlay = document.createElement('canvas')
    underlay.width = w
    underlay.height = h
    const uCtx = underlay.getContext('2d')
    const composite = document.createElement('canvas')
    composite.width = w
    composite.height = h
    const cCtx = composite.getContext('2d')
    if (!uCtx || !cCtx) return null

    let annotations: HTMLCanvasElement | undefined

    try {
      const exportBg: [number, number, number, number] = transparent
        ? (whiteBg ? [1, 1, 1, 0] : [0, 0, 0, 0])
        : (whiteBg ? [1, 1, 1, 1] : [0, 0, 0, 1])
      this.render.opts.backColor = exportBg

      // Always hide marker on underlay and composite so surface anatomy is pristine
      if (markerMesh) markerMesh.visible = false

      // Step A: Underlay (mute overlay layers, hide marker)
      if (atlasIdx >= 0 || funcIdx >= 0) {
        for (const mesh of this.#displayMeshes) {
          const m = mesh as unknown as { layers?: Array<{ opacity: number }>; updateMesh?: (gl: WebGL2RenderingContext) => void }
          if (atlasIdx >= 0 && m.layers?.[atlasIdx]) m.layers[atlasIdx].opacity = 0
          if (funcIdx >= 0 && m.layers?.[funcIdx]) m.layers[funcIdx].opacity = 0
          m.updateMesh?.(gl)
        }
      }
      this.render.drawScene()
      uCtx.drawImage(canvas, 0, 0, w, h)

      // Step B: Composite (restore overlay layers, hide marker)
      if (atlasIdx >= 0 || funcIdx >= 0) {
        for (const mesh of this.#displayMeshes) {
          const m = mesh as unknown as { layers?: Array<{ opacity: number }>; updateMesh?: (gl: WebGL2RenderingContext) => void }
          if (atlasIdx >= 0 && m.layers?.[atlasIdx]) m.layers[atlasIdx].opacity = origAtlasOpacity
          if (funcIdx >= 0 && m.layers?.[funcIdx]) m.layers[funcIdx].opacity = origFuncOpacity
          m.updateMesh?.(gl)
        }
      }
      this.render.drawScene()
      cCtx.drawImage(canvas, 0, 0, w, h)

      // Step C: Surface marker layer (overlays muted, marker visible)
      if (!hideAnnotations && markerMesh && origMarkerVisible) {
        if (atlasIdx >= 0 || funcIdx >= 0) {
          for (const mesh of this.#displayMeshes) {
            const m = mesh as unknown as { layers?: Array<{ opacity: number }>; updateMesh?: (gl: WebGL2RenderingContext) => void }
            if (atlasIdx >= 0 && m.layers?.[atlasIdx]) m.layers[atlasIdx].opacity = 0
            if (funcIdx >= 0 && m.layers?.[funcIdx]) m.layers[funcIdx].opacity = 0
            m.updateMesh?.(gl)
          }
        }
        markerMesh.visible = true
        this.render.drawScene()
        const aCanvas = document.createElement('canvas')
        aCanvas.width = w
        aCanvas.height = h
        const aCtx = aCanvas.getContext('2d')
        if (aCtx) {
          aCtx.drawImage(canvas, 0, 0, w, h)
          annotations = aCanvas
        }
      }

      return { underlay, composite, annotations }
    } finally {
      this.render.opts.backColor = origBackColor
      if (markerMesh) markerMesh.visible = origMarkerVisible
      if (atlasIdx >= 0 || funcIdx >= 0) {
        for (const mesh of this.#displayMeshes) {
          const m = mesh as unknown as { layers?: Array<{ opacity: number }>; updateMesh?: (gl: WebGL2RenderingContext) => void }
          if (atlasIdx >= 0 && m.layers?.[atlasIdx]) m.layers[atlasIdx].opacity = origAtlasOpacity
          if (funcIdx >= 0 && m.layers?.[funcIdx]) m.layers[funcIdx].opacity = origFuncOpacity
          m.updateMesh?.(gl)
        }
      }
      this.render.drawScene()
    }
  }

  // Load (or switch) the base volume. The volume lives ONLY in the slices instance — the
  // surface pane shows the cortical surface + marker, never 3D volume slices.
  //
  // Two controls drive this (the volume dropdown and the fov switch), so overlapping loads are
  // reachable: without a token, a slow loser's removeVolume() would delete the winner's volume and
  // leave #urls.base describing the wrong file. Latest wins; a superseded load is discarded.
  // Returns whether this load was actually applied, so callers can skip re-seeding the underlay rail.
  #baseToken = 0
  async setBaseVolume(url: string, opacity = 1): Promise<boolean> {
    const token = ++this.#baseToken
    const img = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url), colormap: 'gray', opacity })
    if (token !== this.#baseToken) return false // a newer switch already landed
    if (this.#baseVol) this.slices.removeVolume(this.#baseVol)
    this.slices.addVolume(img)
    this.slices.setVolume(img, 0)
    this.#baseVol = img
    this.#urls.base = url
    this.#baseOrig = null // drop the previous volume's clip cache; re-captured on first clip
    this.#baseClip = undefined // no mask applied to the freshly loaded voxels
    return true
  }

  setVolumeOpacity(opacity: number): void {
    if (this.#baseVol) this.slices.setOpacity(this.slices.getVolumeIndexByID(this.#baseVol.id), opacity)
  }

  // ---- underlay (base volume) display controls: intensity window + clip mask + montage zoom ----

  // The base volume's calibrated intensity extents (scaled units — the same space as cal_min/cal_max),
  // used to seed the display window (robust) and bound the sliders/boxes (global). null = no volume.
  baseVolumeRange(): { globalMin: number; globalMax: number; robustMin: number; robustMax: number } | null {
    const v = this.#baseVol as unknown as { global_min?: number; global_max?: number; robust_min?: number; robust_max?: number } | null
    if (!v || v.global_min == null || v.global_max == null) return null
    return {
      globalMin: v.global_min,
      globalMax: v.global_max,
      // robust_min/max are the percentile window NiiVue auto-picks; fall back to global if absent.
      robustMin: v.robust_min ?? v.global_min,
      robustMax: v.robust_max ?? v.global_max,
    }
  }

  // Apply the underlay intensity window [calLo, calHi] (colormap clamp) plus an optional value clip:
  // voxels whose scaled value falls outside [clipLo, clipHi] are masked to the volume's global minimum
  // so they clamp to the bottom (black) of the gray LUT (hidden against the black background). null
  // bound = open on that side. When the clip is fully open the pristine voxels are restored (no
  // per-voxel loop). NOTE: the mask value must stay within the volume's real [global_min, global_max]
  // range — a value far below (e.g. cal_min-1000) overflows the normalized GPU texture and wraps to
  // the TOP of the colormap (white) instead of clamping to black.
  setVolumeWindow(calLo: number, calHi: number, clipLo: number | null, clipHi: number | null): void {
    const vol = this.#baseVol as unknown as (NVImage & { img?: Float32Array; hdr?: { scl_slope?: number; scl_inter?: number }; global_min?: number }) | null
    if (!vol?.img) return
    vol.cal_min = calLo
    vol.cal_max = calHi
    const slope = vol.hdr?.scl_slope || 1
    const inter = vol.hdr?.scl_inter ?? 0
    const img = vol.img
    const clipping = clipLo !== null || clipHi !== null
    if (clipping) {
      // The mask is a pure function of (clip bounds, pristine voxels) — independent of the display
      // window — so a window-only change (brightness/contrast drag) whose clip bounds are unchanged
      // reuses the already-masked img and only re-uploads for the new cal_min/cal_max below. Skipping
      // the per-voxel loop here is the difference between an O(voxels) pass and none on every drag frame.
      const clipChanged = !this.#baseClip || this.#baseClip.lo !== clipLo || this.#baseClip.hi !== clipHi
      if (clipChanged) {
        if (!this.#baseOrig) this.#baseOrig = Float32Array.from(img) // capture pristine raw voxels once
        const orig = this.#baseOrig
        // Mask to the darkest in-range value (global_min → colormap bottom = black), NOT a far-below
        // sentinel: staying in range avoids the texture-normalization overflow that renders as white.
        const floorScaled = vol.global_min ?? calLo
        const rawFloor = (floorScaled - inter) / slope
        for (let i = 0; i < img.length; i++) {
          const val = orig[i] * slope + inter // scaled value (clip bounds are in scaled units)
          const pass = Number.isFinite(val) && (clipLo === null || val >= clipLo) && (clipHi === null || val <= clipHi)
          img[i] = pass ? orig[i] : rawFloor
        }
        this.#baseClip = { lo: clipLo, hi: clipHi }
      }
    } else {
      if (this.#baseOrig) {
        img.set(this.#baseOrig) // clip cleared — restore pristine voxels
        this.#baseOrig = null
      }
      this.#baseClip = undefined
    }
    this.slices.updateGLVolume()
  }

  // Zoom the slice montage (multiplanar) only; the surface pane owns its own camera zoom. 2D zoom
  // lives in scene.pan2Dxyzmm[3] (volScaleMultiplier only affects the 3D render). Anchor the zoom on
  // the crosshair — the standard neuroimaging-viewer behaviour, matching NiiVue's own scroll-zoom:
  // shift the pan by (oldZoom - newZoom) × crosshair-mm so the crosshair stays fixed on screen
  // instead of the view zooming about the volume centre and pushing the crosshair out of view.
  setVolumeZoom(scale: number): void {
    const nv = this.slices as unknown as {
      scene: { pan2Dxyzmm: number[]; crosshairPos: number[] }
      frac2mm?: (frac: number[]) => ArrayLike<number>
      setPan2Dxyzmm?: (v: number[]) => void
    }
    const cur = nv.scene.pan2Dxyzmm
    const dz = (cur[3] || 1) - scale
    const mm = nv.frac2mm ? nv.frac2mm(nv.scene.crosshairPos) : [0, 0, 0]
    const next = [cur[0] + dz * mm[0], cur[1] + dz * mm[1], cur[2] + dz * mm[2], scale]
    if (nv.setPan2Dxyzmm) nv.setPan2Dxyzmm(next)
    else {
      nv.scene.pan2Dxyzmm = next
      this.slices.drawScene()
    }
  }

  // Reset the montage pan+zoom to the neutral centred view (pan2Dxyzmm default is [0,0,0,1]).
  resetVolumeZoom(): void {
    const nv = this.slices as unknown as { scene: { pan2Dxyzmm: number[] }; setPan2Dxyzmm?: (v: number[]) => void }
    const next = [0, 0, 0, 1]
    if (nv.setPan2Dxyzmm) nv.setPan2Dxyzmm(next)
    else {
      nv.scene.pan2Dxyzmm = next
      this.slices.drawScene()
    }
  }

  // ---- atlas volume overlay (colored label map on the slices) ----
  // `name` is descriptive only (the report names which atlas is overlaid); nothing renders from it.
  async loadAtlasOverlay(url: string, opacity: number, name: string | null = null): Promise<void> {
    const vol = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url), opacity })
    vol.trustCalMinMax = false
    if (this.#atlasVol) this.slices.removeVolume(this.#atlasVol)
    this.slices.addVolume(vol)
    this.#atlasVol = vol
    this.#urls.atlas = url
    this.#urls.atlasName = name
    this.#prepareAtlasLabelState(vol)
  }

  // Inspect the loaded atlas once: remember its original float img/datatype (for the ARM float
  // fallback + continuous quantization source), classify it as continuous (any non-integer voxel)
  // vs categorical, record the nonzero value range (for the continuous display window), and cache a
  // u16 id-image for non-negative integer parcellations (the discrete-label-shader categorical path).
  #prepareAtlasLabelState(vol: NVImage): void {
    this.#atlasFloat = null
    this.#atlasLabelImg = null
    this.#atlasContinuous = false
    this.#atlasValueRange = { min: 0, max: 1 }
    const v = vol as unknown as { img?: ArrayLike<number>; hdr?: { datatypeCode: number; intent_code: number; numBitsPerVoxel?: number } }
    const img = v.img
    const hdr = v.hdr
    if (!img || !hdr) return
    let min = Infinity
    let max = -Infinity
    let minNonZero = Infinity
    let hasNonInteger = false
    for (let i = 0; i < img.length; i++) {
      const x = img[i]
      if (!Number.isFinite(x)) continue
      if (!Number.isInteger(x)) hasNonInteger = true
      if (x < min) min = x
      if (x > max) max = x
      if (x !== 0 && x < minNonZero) minNonZero = x
    }
    if (!Number.isFinite(min)) return // empty/all-non-finite
    this.#atlasFloat = { img, datatypeCode: hdr.datatypeCode, intentCode: hdr.intent_code, bitpix: hdr.numBitsPerVoxel ?? 64 }
    this.#atlasContinuous = hasNonInteger
    // Continuous display window spans the nonzero data (0 is background) so the ramp isn't wasted on
    // an empty 0..min gap; fall back to [min,max] when every value is 0/nonzero-absent.
    const lo = Number.isFinite(minNonZero) ? minNonZero : min
    this.#atlasValueRange = { min: lo, max: max > lo ? max : lo + 1 }
    // Non-negative integer parcellation → cache the u16 id-image for the discrete categorical path.
    if (!hasNonInteger && min >= 0 && max <= ATLAS_LABEL_MAX) {
      this.#atlasLabelImg = img instanceof Uint16Array ? img : Uint16Array.from(img, (x) => Math.round(x))
    }
  }

  // Whether the loaded atlas is a continuous scalar map (render with a colormap, not ROI labels).
  atlasIsContinuous(): boolean {
    return this.#atlasContinuous
  }

  // The nonzero value range of the loaded atlas — the display window domain for continuous mode.
  atlasValueRange(): { min: number; max: number } {
    return { ...this.#atlasValueRange }
  }

  // Point the atlas volume at a given image + datatype/intent, so the next updateGLVolume() re-uploads
  // the 3D texture and re-selects the shader. Used to switch between the categorical id-image (u16 +
  // LABEL), the continuous bins image (u8 + LABEL), and the ARM float fallback.
  #setAtlasVolumeImage(img: ArrayLike<number>, datatypeCode: number, bitpix: number, intentCode: number): void {
    if (!this.#atlasVol) return
    const v = this.#atlasVol as unknown as { img: ArrayLike<number>; hdr: { datatypeCode: number; intent_code: number; numBitsPerVoxel?: number } }
    v.img = img
    v.hdr.datatypeCode = datatypeCode
    v.hdr.intent_code = intentCode
    v.hdr.numBitsPerVoxel = bitpix
  }

  // Unique integer label IDs present in the loaded atlas volume, sorted ascending. Used to render
  // a categorical label table for atlases that ship no .tsv LUT sidecar (IDs derived from data).
  atlasLabelIds(): number[] {
    const img = (this.#atlasVol as unknown as { img?: ArrayLike<number> })?.img
    if (!img) return []
    const ids = new Set<number>()
    for (let i = 0; i < img.length; i++) {
      const v = Math.round(img[i])
      if (Number.isFinite(v)) ids.add(v)
    }
    return [...ids].sort((a, b) => a - b)
  }

  /**
   * Register a reversed twin for each colormap on BOTH instances, so the colour dock's reverse
   * toggle works on the slices and the mesh alike (docs §4: one colour change recolours both).
   * Called once after the view exists, before the gradients/LUTs are sampled.
   */
  /** Returns the keys that gained a reversed twin on BOTH instances — the rest cannot be reversed. */
  registerReversedColormaps(keys: string[]): string[] {
    const onSlices = new Set(registerReversed(this.slices, keys))
    const onRender = new Set(registerReversed(this.render, keys))
    return keys.filter((k) => onSlices.has(k) && onRender.has(k))
  }

  // The flat 256×4 RGBA LUT for a registered colormap (live), or null if unavailable.
  colormapLut(name: string): Uint8ClampedArray | null {
    try {
      const rgba = (this.slices as unknown as { colormap: (id: string) => ArrayLike<number> }).colormap(name)
      if (!rgba || rgba.length < 4) return null
      return rgba instanceof Uint8ClampedArray ? rgba : Uint8ClampedArray.from(rgba as ArrayLike<number>)
    } catch {
      return null
    }
  }

  // Categorical parcellation on the volume. Non-negative integer atlases use the discrete label
  // shader (u16 id-image, background id 0 discarded, ids looked up exactly); atlases with negative
  // ids (ARM WM/CSF) fall back to the original float image + generic shader, where the transparent
  // id-0 slot sits mid-LUT clear of NiiVue's opaque floor.
  setAtlasColortable(table: { R: number[]; G: number[]; B: number[]; A: number[]; I: number[]; labels: string[] }): void {
    if (!this.#atlasVol) return
    if (this.#atlasLabelImg) {
      this.#setAtlasVolumeImage(this.#atlasLabelImg, NII_DT_UINT16, 16, NII_INTENT_LABEL)
    } else if (this.#atlasFloat) {
      this.#setAtlasVolumeImage(this.#atlasFloat.img, this.#atlasFloat.datatypeCode, this.#atlasFloat.bitpix, this.#atlasFloat.intentCode)
    }
    this.#atlasVol.setColormapLabel(table)
    this.slices.updateGLVolume()
  }

  // Render the atlas volume with a CONTINUOUS colormap: quantize values over [range] into u8 bins
  // 1..255 (value 0 / non-finite → bin 0, transparent) and apply a 256-entry ramp LUT via the
  // discrete label shader (bin 0 discarded). The SAME quantization + LUT feed the surface
  // (setAtlasSurfaceContinuous), so the slices and the 3D mesh stay pixel-consistent. Works for any
  // atlas (bins are non-negative). A colormap-only change rebuilds the LUT; a range change re-bins.
  setAtlasContinuous(cmapLut: ArrayLike<number>, range: { min: number; max: number }, clip?: { lo: number | null; hi: number | null }): void {
    if (!this.#atlasVol || !this.#atlasFloat) return
    let quant = quantizeScalarToBins(this.#atlasFloat.img, range.min, range.max)
    // Value clip: drop voxels outside [lo, hi] to the transparent background bin (0).
    if (clip && (clip.lo !== null || clip.hi !== null)) quant = maskSurfaceBinsByValue(quant, this.#atlasFloat.img, clip.lo, clip.hi)
    const bins = Uint8Array.from(quant)
    this.#setAtlasVolumeImage(bins, NII_DT_UINT8, 8, NII_INTENT_LABEL)
    this.#atlasVol.setColormapLabel(MultiView.#surfaceColortableFromColormap(cmapLut))
    this.slices.updateGLVolume()
  }

  setAtlasOpacity(opacity: number): void {
    if (this.#atlasVol) this.slices.setOpacity(this.slices.getVolumeIndexByID(this.#atlasVol.id), opacity)
  }

  removeAtlas(): void {
    if (this.#atlasVol) {
      this.slices.removeVolume(this.#atlasVol)
      this.#atlasVol = null
    }
    this.#urls.atlas = null
    this.#urls.atlasName = null
  }

  // ---- functional overlay (retinotopy/somatotopy 4D volume with F-threshold masking) ----
  #funcVol: NVImage | null = null
  #funcMeta: { frameSize: number; frames: number; slope: number; inter: number; originals: Map<number, Float32Array> } | null = null
  #funcSampler: NVImage | null = null // unmasked copy for the report + visual field

  async loadFunctional(url: string, colormap: string, opacity: number): Promise<number> {
    if (this.#funcVol) this.slices.removeVolume(this.#funcVol)
    const vol = await this.slices.addVolumeFromUrl({ url: this.#client.dataUrl(url), colormap, opacity })
    vol.trustCalMinMax = false
    this.#funcVol = vol
    this.#urls.functional = url
    const dims = vol.hdr?.dims ?? []
    const frameSize = (dims[1] || 1) * (dims[2] || 1) * (dims[3] || 1)
    const frames = dims[4] && dims[4] > 1 ? dims[4] : 1
    const slope = vol.hdr?.scl_slope && vol.hdr.scl_slope !== 0 ? vol.hdr.scl_slope : 1
    const inter = vol.hdr?.scl_inter ?? 0
    this.#funcMeta = { frameSize, frames, slope, inter, originals: new Map() }
    // A separate unmasked copy for crosshair sampling (report / visual field). applyFunctional
    // mutates #funcVol.img in place, so the sampler must hold pristine values — clone the volume
    // we just fetched (clone() deep-copies img via slice()) instead of downloading it a second time.
    this.#funcSampler = vol.clone()
    return frames
  }

  removeFunctional(): void {
    if (this.#funcVol) this.slices.removeVolume(this.#funcVol)
    this.#funcVol = null
    this.#funcMeta = null
    this.#funcSampler = null
    this.#urls.functional = null
  }

  setFunctionalOpacity(opacity: number): void {
    if (this.#funcVol) this.slices.setOpacity(this.slices.getVolumeIndexByID(this.#funcVol.id), opacity)
  }

  // Scaled voxel values of one 4D frame (copy) — for computing the F-threshold slider bounds.
  scaledFrame(frameIndex: number): Float32Array {
    const meta = this.#funcMeta
    if (!meta || !this.#funcVol?.img) return new Float32Array()
    const { frameSize, slope, inter } = meta
    const img = this.#funcVol.img
    const start = frameIndex * frameSize
    const out = new Float32Array(frameSize)
    for (let i = 0; i < frameSize; i++) out[i] = img[start + i] * slope + inter
    return out
  }

  // Display `valueFrame`, masked by `fFrame` >= threshold and by the [clipLow, clipHigh] value
  // window (either bound null = unbounded) — failing voxels get a sentinel BELOW cal_min → the
  // transparent index-0 of the LUT (hidden). SURVIVING voxels are remapped for DISPLAY: the window
  // [displayMin, displayMax] maps onto the colormap's opaque range so narrowing it only changes
  // contrast (voxels never disappear). cal_min/cal_max stay FIXED at the map's natural range.
  applyFunctional(valueFrame: number, fFrame: number | null, threshold: number, colormap: string, opacity: number, calMin: number, calMax: number, displayMin: number, displayMax: number, clipLow: number | null = null, clipHigh: number | null = null): void {
    const meta = this.#funcMeta
    const vol = this.#funcVol
    if (!meta || !vol?.img) return
    const { frameSize, slope, inter, originals } = meta
    const img = vol.img
    const toRaw = (scaled: number): number => (scaled - inter) / slope
    const rawSentinel = toRaw(calMin - 1000) // scaled sentinel below cal_min → transparent index-0
    const vStart = valueFrame * frameSize
    if (!originals.has(valueFrame)) originals.set(valueFrame, Float32Array.from(img.subarray(vStart, vStart + frameSize)))
    const original = originals.get(valueFrame) as Float32Array
    const hasF = fFrame != null
    const fStart = hasF ? (fFrame as number) * frameSize : 0
    for (let i = 0; i < frameSize; i++) {
      const val = original[i] * slope + inter // scaled original value (for masking + display remap)
      let pass = Number.isFinite(val)
      if (pass && hasF) {
        const f = img[fStart + i] * slope + inter
        pass = Number.isFinite(f) && f >= threshold
      }
      if (pass && (clipLow !== null || clipHigh !== null)) {
        pass = (clipLow === null || val >= clipLow) && (clipHigh === null || val <= clipHigh)
      }
      img[vStart + i] = pass ? toRaw(mapFunctionalDisplay(val, displayMin, displayMax, calMin, calMax)) : rawSentinel
    }
    this.slices.setColormap(vol.id, colormap)
    vol.cal_min = calMin // FIXED at the map's natural range; display range is applied via the remap
    vol.cal_max = calMax
    this.slices.setFrame4D(vol.id, valueFrame)
    const idx = this.slices.getVolumeIndexByID(vol.id)
    if (idx >= 0) this.slices.setOpacity(idx, opacity)
    this.slices.updateGLVolume()
  }

  // Crosshair voxel of the functional sampler (integer i,j,k) or null.
  functionCrosshairVox(): [number, number, number] | null {
    if (!this.#funcSampler) return null
    try {
      const mm = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const vox = this.#funcSampler.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      return [Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2])]
    } catch {
      return null
    }
  }

  // Anatomical (base volume) voxel index i,j,k for a world-mm point, or null.
  baseVox(mm: [number, number, number]): [number, number, number] | null {
    if (!this.#baseVol) return null
    try {
      const v = this.#baseVol.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      return [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])]
    } catch {
      return null
    }
  }

  // Inverse of baseVox: base-volume voxel index i,j,k → world-mm point, or null (for editing IJK).
  voxToWorld(ijk: [number, number, number]): [number, number, number] | null {
    const vol = this.#baseVol as unknown as { matRAS?: unknown; vox2mm?: (xyz: number[], mtx: unknown) => { [k: number]: number } }
    if (!vol?.matRAS || !vol.vox2mm) return null
    try {
      const mm = vol.vox2mm([ijk[0], ijk[1], ijk[2]], vol.matRAS)
      return [mm[0], mm[1], mm[2]]
    } catch {
      return null
    }
  }

  // Value of a functional frame at a voxel (unmasked sampler). NaN if unavailable.
  sampleFunctionFrame(vox: [number, number, number], frame: number): number {
    if (!this.#funcSampler) return NaN
    try {
      return this.#funcSampler.getValue(vox[0], vox[1], vox[2], frame)
    } catch {
      return NaN
    }
  }

  functionDims(): [number, number, number] | null {
    const d = this.#funcSampler?.hdr?.dims
    return d ? [d[1], d[2], d[3]] : null
  }

  // Sampling-only atlas volumes for the multi-level Atlas report (loaded but NOT displayed).
  #reportVols = new Map<string, NVImage>()
  // Whether each report volume is a continuous float map (report the raw value) vs an integer
  // parcellation (report a rounded label id). Same "any non-integer voxel" rule the display path
  // uses in #prepareAtlasLabelState.
  #reportContinuous = new Map<string, boolean>()

  async loadReportVolume(key: string, url: string): Promise<void> {
    const vol = await NVImage.loadFromUrl({ url: this.#client.dataUrl(url) })
    this.#reportVols.set(key, vol)
    this.#urls.report.set(key, url)
    this.#reportContinuous.set(key, this.#imgHasNonInteger(vol))
  }

  clearReportVolumes(): void {
    this.#reportVols.clear()
    this.#urls.report.clear()
    this.#reportContinuous.clear()
  }

  // True if any finite voxel is non-integer — i.e. the volume is a continuous scalar map rather
  // than an integer label parcellation. Mirrors the display-path classification.
  #imgHasNonInteger(vol: NVImage): boolean {
    const img = (vol as unknown as { img?: ArrayLike<number> }).img
    if (!img) return false
    for (let i = 0; i < img.length; i++) {
      const x = img[i]
      if (Number.isFinite(x) && !Number.isInteger(x)) return true
    }
    return false
  }

  #sampleVolume(vol: NVImage): number | null {
    try {
      const mm = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const vox = vol.mm2vox([mm[0], mm[1], mm[2]]) as number[]
      // Nearest-voxel sample; return the raw value. Callers round to an id only for categorical atlases.
      return vol.getValue(Math.round(vox[0]), Math.round(vox[1]), Math.round(vox[2]))
    } catch {
      return null
    }
  }

  sampleReportVolume(key: string): number | null {
    const vol = this.#reportVols.get(key)
    return vol ? this.#sampleVolume(vol) : null
  }

  // Whether a report atlas is a continuous float map (report its value) vs an integer parcellation.
  reportVolumeContinuous(key: string): boolean {
    return this.#reportContinuous.get(key) ?? false
  }

  // Descriptive inventory of everything currently loaded, for the HTML report: each asset's role,
  // the URL it came from, and its raw NIfTI header (volumes) or geometry arrays (surfaces).
  // Deliberately returns RAW headers rather than formatted ones — report/header.ts owns the
  // formatting so it stays pure and unit-testable, and this stays a plain read of existing state.
  loadedAssets(): LoadedAsset[] {
    const out: LoadedAsset[] = []
    const vol = (role: string, image: NVImage | null, url: string | null): void => {
      if (image) out.push({ role, url, hdr: (image as unknown as { hdr?: unknown }).hdr ?? null, mesh: null })
    }
    vol('base volume', this.#baseVol, this.#urls.base)
    vol(this.#urls.atlasName ? `atlas overlay: ${this.#urls.atlasName}` : 'atlas overlay', this.#atlasVol, this.#urls.atlas)
    // The unmasked clone is the one the report samples, so it is the one worth describing.
    vol('functional map', this.#funcSampler, this.#urls.functional)
    for (const [key, image] of this.#reportVols) vol(`atlas (sampled): ${key}`, image, this.#urls.report.get(key) ?? null)
    const hemi = ['left', 'right'] as const
    this.#displayMeshes.forEach((mesh, i) => {
      if (!mesh) return
      const url = i === 0 ? this.#urls.surface?.left : this.#urls.surface?.right
      out.push({ role: `surface (${hemi[i] ?? i})`, url: url ?? null, hdr: null, mesh: mesh as unknown as MeshArrays })
    })
    // Morphology shading sources are per-hemisphere .shape.gii layers on the display mesh; they
    // carry no separate geometry, so they are listed by URL alone.
    for (const [metric, pair] of Object.entries(this.#morphPairs)) {
      if (!pair) continue
      out.push({ role: `morphometry: ${metric} (left)`, url: pair.left, hdr: null, mesh: null })
      out.push({ role: `morphometry: ${metric} (right)`, url: pair.right, hdr: null, mesh: null })
    }
    // Same shape as the morphometry entries: per-hemisphere .shape.gii layers with no geometry of
    // their own. Listed so the report can name the change map it is showing.
    if (this.#urls.change) {
      const name = this.#urls.changeName ?? 'change'
      out.push({ role: `longitudinal: ${name} (left)`, url: this.#urls.change.left, hdr: null, mesh: null })
      out.push({ role: `longitudinal: ${name} (right)`, url: this.#urls.change.right, hdr: null, mesh: null })
    }
    return out
  }

  // Montage layouts: how the 3 slice planes arrange within the slice instance. The surface pane
  // is positioned alongside them by the dashboard CSS (grid = surface fills the empty 4th
  // quadrant; row/column = surface on top).
  setLayout(layout: Layout): void {
    this.slices.setSliceType(SLICE_TYPE.MULTIPLANAR)
    const type = layout === 'grid' ? MULTIPLANAR_TYPE.GRID : layout === 'row' ? MULTIPLANAR_TYPE.ROW : MULTIPLANAR_TYPE.COLUMN
    this.slices.setMultiplanarLayout(type)
  }

  // ---- surfaces ----
  #clearDisplayMeshes(): void {
    for (const m of [...(this.render.meshes as NVMesh[])]) {
      if (m.name !== 'selected-location') this.render.removeMesh(m) // keep the marker
    }
    this.#displayMeshes = []
    this.#funcLayerIndex = -1 // function-surface layer is gone with the old meshes
    this.#funcLayerKey = null
  }

  // Load the reference surface (typically pial) in WORLD space — used only to map the volume
  // crosshair to a vertex index. Not added to the render scene (won't affect framing).
  async setReference(pair: SurfacePairUrls | null): Promise<void> {
    this.#refMeshes = []
    this.#adjacency = []
    if (!pair) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    const left = await NVMesh.loadFromUrl({ url: this.#client.dataUrl(pair.left), gl })
    const right = await NVMesh.loadFromUrl({ url: this.#client.dataUrl(pair.right), gl })
    this.#refMeshes = [left, right]
    // Vertex adjacency for the constrained drag walk. Built once per subject from the reference
    // triangles; shared topology means it stays valid across every display-surface swap.
    this.#adjacency = [this.#buildAdjacency(left), this.#buildAdjacency(right)]
  }

  // Build a CSR vertex-adjacency graph from a mesh's triangle list. One pass counts each vertex's
  // (over-counted) degree, a prefix sum lays out the offsets, and a second pass fills both directions
  // of every triangle edge. Duplicate directed edges from shared triangles are harmless — the walk's
  // generation-stamped visited array dedups traversal. Returns null if the mesh has no usable tris.
  #buildAdjacency(mesh: NVMesh | undefined): VertexAdjacency | null {
    const tris = (mesh as unknown as { tris?: Uint32Array } | undefined)?.tris
    const pts = mesh?.pts
    if (!tris || tris.length < 3 || !pts) return null
    const nVerts = pts.length / 3
    const degree = new Uint32Array(nVerts)
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]
      const b = tris[t + 1]
      const c = tris[t + 2]
      degree[a] += 2
      degree[b] += 2
      degree[c] += 2
    }
    const offsets = new Uint32Array(nVerts + 1)
    for (let v = 0; v < nVerts; v++) offsets[v + 1] = offsets[v] + degree[v]
    const neighbors = new Uint32Array(offsets[nVerts])
    const cursor = offsets.slice(0, nVerts) // running write position per vertex
    const addEdge = (from: number, to: number): void => {
      neighbors[cursor[from]++] = to
    }
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t]
      const b = tris[t + 1]
      const c = tris[t + 2]
      addEdge(a, b)
      addEdge(a, c)
      addEdge(b, a)
      addEdge(b, c)
      addEdge(c, a)
      addEdge(c, b)
    }
    return { offsets, neighbors, visited: new Int32Array(nVerts) }
  }

  #atlasLayerIndex = -1
  // Cached raw per-vertex .func.gii values of the atlas surface overlay (one Float32Array per hemi)
  // and a key identifying the loaded pair. A continuous atlas re-quantizes these on colormap/range
  // change WITHOUT reloading the layer (so no reload race, cf. the func-surface path).
  #atlasSurfaceRaw: Float32Array[] = []
  #atlasSurfacePairKey: string | null = null
  #atlasSurfaceBins = false // true when layer.values hold continuous bins (must be restored for categorical)

  // Re-apply a label colortable to a layer AFTER load: NiiVue 0.69 drops the descriptor's
  // colormapLabel (it is processed before layer.global_max settles, collapsing all labels to one
  // colour). setLayerProperty re-runs makeLabelLut with the settled global_max, and requires the
  // colormapLabel key to already exist on the layer (seeded via the load descriptor).
  //
  // NiiVue builds the LUT via makeLabelLut(table, 255, layer.global_max), which CLAMPS every
  // colortable id above global_max down to it. A hemisphere whose per-vertex max value is below the
  // colortable's max id therefore collapses the higher ids to a single colour — e.g. MacBNA's split
  // scheme (left ids ≤152, right ids up to 304): the right surface washes to ~one colour. Force each
  // layer's global_max to span the colortable so BOTH hemispheres get the full LUT (extra, unused
  // entries on the low-id hemisphere are harmless).
  async #applyLabelLutAt(index: number, table: LabelColortable): Promise<void> {
    if (index < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    const maxId = table.I.length ? Math.max(...table.I) : 0
    for (const mesh of this.#displayMeshes) {
      const layer = (mesh as unknown as { layers?: Array<{ global_max?: number }> }).layers?.[index]
      if (layer) layer.global_max = Math.max(layer.global_max ?? 0, maxId)
      // Surface a failed LUT attach instead of swallowing it: if this no-ops the layer keeps its
      // gray/default colormap (bin 0 = opaque black), which blacks out or miscolors the overlay.
      await (mesh as unknown as { setLayerProperty: (i: number, k: string, v: unknown, gl: WebGL2RenderingContext) => Promise<void> }).setLayerProperty(index, 'colormapLabel', table, gl).catch((err) => console.warn('surface colormapLabel attach failed', err))
    }
  }

  async #applyOverlayLut(table: LabelColortable): Promise<void> {
    if (this.#atlasLayerIndex < 0) return
    await this.#applyLabelLutAt(this.#atlasLayerIndex, table)
    this.render.drawScene()
  }

  // Show a hemisphere-pair surface: binary curvature shading (layer 0) + an optional
  // precomputed atlas/function surface overlay (layer 1, colored by its label colortable).
  // ---- morphology shading (curvature binary/continuous · sulc · thickness) ----
  // Four categorical/continuous mesh layers are loaded per hemisphere (v1.2.25 model): binary
  // curvature (FreeSurfer sign LUT), continuous curvature (gray), sulc (blue2red), thickness
  // (viridis). Switching the displayed metric only toggles layer opacities — no reload. The
  // morphology layers occupy the LOW indices; the atlas overlay and function layer sit above.
  #morphPairs: MorphologyShapePairs = {}
  #morphDisplay: MorphologyDisplay | null = null
  #morphIndex: Partial<Record<string, number>> = {} // layer key -> layer index (same on both hemis)

  // Active colormap for a continuous morphology layer: the display override, else the shared
  // per-metric default. Binary curvature always keeps its dedicated 2-tone LUT (not overridable).
  #morphColormap(metric: MorphologyMetric): string {
    return this.#morphDisplay?.colormaps?.[metric] ?? MORPH_DEFAULT_COLORMAP[metric]
  }

  #morphSpecs(): Array<{ key: string; metric: MorphologyMetric; pair: SurfacePairUrls; colormap: string }> {
    const specs: Array<{ key: string; metric: MorphologyMetric; pair: SurfacePairUrls; colormap: string }> = []
    if (this.#morphPairs.curvature) {
      specs.push({ key: 'curvatureBinary', metric: 'curvature', pair: this.#morphPairs.curvature, colormap: 'brainana_curvature' })
      specs.push({ key: 'curvatureContinuous', metric: 'curvature', pair: this.#morphPairs.curvature, colormap: this.#morphColormap('curvature') })
    }
    if (this.#morphPairs.sulc) specs.push({ key: 'sulc', metric: 'sulc', pair: this.#morphPairs.sulc, colormap: this.#morphColormap('sulc') })
    if (this.#morphPairs.thickness) specs.push({ key: 'thickness', metric: 'thickness', pair: this.#morphPairs.thickness, colormap: this.#morphColormap('thickness') })
    return specs
  }

  #morphLayerVisible(key: string): boolean {
    const d = this.#morphDisplay
    if (!d || d.metric === 'none') return false
    if (key === 'curvatureBinary') return d.metric === 'curvature' && d.curvatureStyle === 'binary'
    if (key === 'curvatureContinuous') return d.metric === 'curvature' && d.curvatureStyle === 'continuous'
    return d.metric === key
  }

  // cal range for a morphology layer: binary curvature is forced to ±1; the rest come from the
  // display's per-metric range.
  #morphLayerCal(key: string, metric: MorphologyMetric): { min: number; max: number } {
    if (key === 'curvatureBinary') return { min: -1, max: 1 }
    const r = this.#morphDisplay?.ranges[metric]
    return r ? { min: r.min, max: r.max } : { min: -1, max: 1 }
  }

  async setSurface(pair: SurfacePairUrls | null, morphology: MorphologyShapePairs | null, overlay: SurfaceOverlay | null = null, display: MorphologyDisplay | null = null): Promise<void> {
    this.#clearDisplayMeshes()
    this.#urls.surface = pair
    if (!pair) return
    this.#morphPairs = morphology ?? {}
    this.#morphDisplay = display
    this.#morphIndex = {}
    const u = (url: string) => this.#client.dataUrl(url)
    const specs = this.#morphSpecs()
    specs.forEach((s, i) => (this.#morphIndex[s.key] = i))
    const layersFor = (hemi: 'left' | 'right'): Record<string, unknown>[] => {
      const arr: Record<string, unknown>[] = specs.map((s) => {
        const cal = this.#morphLayerCal(s.key, s.metric)
        return { ...NVMeshLayerDefaults, url: u(s.pair[hemi]), colormap: s.colormap, opacity: this.#morphLayerVisible(s.key) ? 1 : 0, cal_min: cal.min, cal_max: cal.max, isTransparentBelowCalMin: false, colorbarVisible: false, showLegend: false }
      })
      if (overlay) arr.push({ ...NVMeshLayerDefaults, url: u(overlay[hemi]), colormapLabel: overlay.table, opacity: 1, showLegend: false })
      return arr
    }
    this.#atlasLayerIndex = overlay ? specs.length : -1
    await this.render.loadMeshes([
      { url: u(pair.left), rgba255: [172, 172, 172, 255], layers: layersFor('left') as never },
      { url: u(pair.right), rgba255: [172, 172, 172, 255], layers: layersFor('right') as never },
    ])
    // Identify the two just-loaded hemisphere meshes (exclude the marker).
    this.#displayMeshes = (this.render.meshes as NVMesh[]).filter((m) => m.name !== 'selected-location').slice(-2)

    // Apply the initial clip (value masking) now that per-vertex values are loaded.
    if (display) this.applyMorphologyDisplay(display)

    // Re-apply the label LUT now that layer.global_max is settled (the load descriptor's
    // colormapLabel is processed too early, collapsing all labels to one color).
    if (overlay) await this.#applyOverlayLut(overlay.table)
  }

  // Live-switch the morphology shading: toggle layer opacities (only the active metric/style is
  // visible) and update cal ranges. No mesh reload.
  applyMorphologyDisplay(display: MorphologyDisplay): void {
    this.#morphDisplay = display
    if (this.#displayMeshes.length < 2) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const spec of this.#morphSpecs()) {
      const idx = this.#morphIndex[spec.key]
      if (idx == null) continue
      const cal = this.#morphLayerCal(spec.key, spec.metric)
      const visible = this.#morphLayerVisible(spec.key)
      const clip = display.clip
      const clipActive = spec.key !== 'curvatureBinary' && !!clip && (clip.lo != null || clip.hi != null)
      const lo = clip?.lo ?? -Infinity
      const hi = clip?.hi ?? Infinity
      for (const mesh of this.#displayMeshes) {
        const layer = (mesh as unknown as { layers?: Array<Record<string, unknown> & { __origValues?: Float32Array }> }).layers?.[idx]
        if (!layer) continue
        layer.opacity = visible ? 1 : 0
        layer.cal_min = cal.min
        layer.cal_max = cal.max
        layer.colormap = spec.colormap
        layer.isTransparentBelowCalMin = false
        // Two-sided clip (only for visible continuous layers): mask out-of-[lo,hi] vertices to NaN,
        // which the mesh colouring loop renders transparent — decoupled from the display cal range.
        if (visible) {
          const orig = (layer.__origValues ??= Float32Array.from(layer.values as ArrayLike<number>))
          if (clipActive) {
            const masked = Float32Array.from(orig)
            for (let i = 0; i < masked.length; i++) {
              const v = orig[i]
              if (v < lo || v > hi) masked[i] = NaN
            }
            layer.values = masked
          } else if (layer.__origValues) {
            layer.values = Float32Array.from(orig)
          }
        }
        ;(mesh as unknown as { updateMesh?: (gl: WebGL2RenderingContext) => void }).updateMesh?.(gl)
      }
    }
    this.render.drawScene()
  }

  // Update the atlas surface layer's colortable in place (ROI toggle) — no mesh reload.
  async updateSurfaceOverlayTable(table: LabelColortable): Promise<void> {
    // Categorical coloring indexes colormapLabel by the per-vertex value (= label id). If a
    // continuous colormap previously overwrote layer.values with bins, restore the raw ids first.
    if (this.#atlasSurfaceBins && this.#atlasLayerIndex >= 0) {
      const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
      for (let h = 0; h < 2; h++) {
        const m = this.#displayMeshes[h] as unknown as { layers?: Array<Record<string, unknown>>; updateMesh?: (gl: WebGL2RenderingContext) => void }
        const layer = m.layers?.[this.#atlasLayerIndex]
        if (layer && this.#atlasSurfaceRaw[h]) {
          layer.values = Float32Array.from(this.#atlasSurfaceRaw[h])
          m.updateMesh?.(gl)
        }
      }
      this.#atlasSurfaceBins = false
    }
    await this.#applyOverlayLut(table)
  }

  // Remove the atlas overlay layer from both hemispheres in place (no base-mesh reload).
  #removeAtlasSurfaceLayer(): void {
    if (this.#atlasLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes) {
      const m = mesh as unknown as { layers?: unknown[]; updateMesh?: (gl: WebGL2RenderingContext) => void }
      if (m.layers && m.layers.length > this.#atlasLayerIndex) m.layers.splice(this.#atlasLayerIndex, 1)
      m.updateMesh?.(gl)
    }
    this.#atlasLayerIndex = -1
    this.#atlasSurfacePairKey = null
    this.#atlasSurfaceRaw = []
    this.#atlasSurfaceBins = false
  }

  // Ensure the atlas .func.gii overlay layer is loaded for `pair` (append one layer per hemisphere),
  // caching each hemisphere's RAW per-vertex values before any bins overwrite. Reused for the same
  // pair (colormap/range/ROI changes don't reload); `seedTable` seeds the layer's colormapLabel key
  // so the post-load re-apply (global_max workaround) can attach the real LUT.
  async #ensureAtlasSurfaceLayer(pair: SurfacePairUrls, seedTable: LabelColortable): Promise<boolean> {
    if (this.#displayMeshes.length < 2) return false
    const key = `${pair.left}|${pair.right}`
    if (this.#atlasLayerIndex >= 0 && this.#atlasSurfacePairKey === key) return true
    this.#removeAtlasSurfaceLayer()
    const hemis: Array<'left' | 'right'> = ['left', 'right']
    let idx = -1
    this.#atlasSurfaceRaw = []
    for (let i = 0; i < 2; i++) {
      const mesh = this.#displayMeshes[i]
      idx = (mesh as unknown as { layers?: unknown[] }).layers?.length ?? 0 // appended layer's index
      const layer = { ...NVMeshLayerDefaults, url: this.#client.dataUrl(pair[hemis[i]]), colormapLabel: seedTable, opacity: 1, showLegend: false }
      await (NVMesh as unknown as { loadLayer: (layer: unknown, mesh: NVMesh) => Promise<void> }).loadLayer(layer, mesh)
      const loaded = (mesh as unknown as { layers?: Array<{ values?: ArrayLike<number> }> }).layers?.[idx]
      const vals = loaded?.values
      this.#atlasSurfaceRaw[i] = vals ? Float32Array.from(vals as ArrayLike<number>) : new Float32Array(0)
    }
    this.#atlasLayerIndex = idx
    this.#atlasSurfacePairKey = key
    this.#atlasSurfaceBins = false // freshly loaded values are the raw .func.gii scalars
    return true
  }

  // Swap the atlas overlay layer WITHOUT reloading the base surface meshes, so the surface never
  // blanks when the overlay changes (Req 7). Categorical path: per-vertex label ids → colormapLabel.
  async setSurfaceOverlay(overlay: SurfaceOverlay | null): Promise<void> {
    if (this.#displayMeshes.length < 2) return
    if (!overlay) {
      this.#removeAtlasSurfaceLayer()
      this.render.drawScene()
      return
    }
    const ok = await this.#ensureAtlasSurfaceLayer(overlay, overlay.table)
    if (ok) await this.#applyOverlayLut(overlay.table) // re-apply LUT once global_max has settled
    this.render.drawScene()
  }

  // Colour the atlas surface with a CONTINUOUS colormap: quantize the cached raw per-vertex values
  // over [range] into bins 1..255 (value 0 / non-finite → bin 0, transparent) and apply the same
  // 256-entry ramp LUT the volume uses (setAtlasContinuous). Mirrors setFunctionSurface; reuses the
  // already-loaded layer on colormap/range changes (no reload).
  async setAtlasSurfaceContinuous(pair: SurfacePairUrls, cmapLut: ArrayLike<number>, range: { min: number; max: number }, opacity: number, clip?: { lo: number | null; hi: number | null }): Promise<void> {
    const table = MultiView.#surfaceColortableFromColormap(cmapLut)
    const ok = await this.#ensureAtlasSurfaceLayer(pair, table)
    if (!ok || this.#atlasLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (let h = 0; h < 2; h++) {
      const mesh = this.#displayMeshes[h]
      const m = mesh as unknown as { layers?: Array<Record<string, unknown>>; updateMesh?: (gl: WebGL2RenderingContext) => void }
      const layer = m.layers?.[this.#atlasLayerIndex]
      if (!layer) continue
      const raw = this.#atlasSurfaceRaw[h] ?? new Float32Array(0)
      let vals = quantizeScalarToBins(raw, range.min, range.max)
      // Value clip: drop vertices outside [lo, hi] to the transparent background bin (0).
      if (clip && (clip.lo !== null || clip.hi !== null)) vals = maskSurfaceBinsByValue(vals, raw, clip.lo, clip.hi)
      layer.values = vals
      layer.nFrame4D = 1
      layer.frame4D = 0
      layer.opacity = opacity
      layer.global_min = 0
      layer.global_max = 255
      layer.cal_min = 0
      layer.cal_max = 255
      layer.isTransparentBelowCalMin = false
      m.updateMesh?.(gl)
    }
    this.#atlasSurfaceBins = true // layer.values now hold quantized bins, not raw ids
    await this.#applyLabelLutAt(this.#atlasLayerIndex, table)
    this.render.drawScene()
  }

  setSurfaceOverlayOpacity(opacity: number): void {
    if (this.#atlasLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes) {
      const m = mesh as unknown as { layers?: Array<{ opacity: number }>; updateMesh?: (gl: WebGL2RenderingContext) => void }
      const layer = m.layers?.[this.#atlasLayerIndex]
      if (layer) {
        layer.opacity = opacity
        m.updateMesh?.(gl)
      }
    }
    this.render.drawScene()
  }

  // ---- function ON the surface (single categorical mesh layer with a 256-entry LUT) ----
  // The layer is loaded ONCE per selection via NVMesh.loadLayer (identical init to the working
  // atlas overlay), then its per-vertex values are swapped for the F-masked bin indices on every
  // threshold/brightness change (no re-fetch). Bin 0 is transparent so masked/no-data vertices
  // vanish. The layer sits ABOVE morphology + atlas; the colortable is re-applied via
  // setLayerProperty once global_max settles (the same fix the atlas needed).
  static readonly #FUNC_LAYER_PREFIX = 'brainana-func:'
  #funcLayerIndex = -1
  #funcLayerKey: string | null = null

  // Build the {R,G,B,A,I} surface colortable directly from a flat colormap RGBA LUT: sample it into
  // the shared 256-entry categorical surface LUT (bin 0 transparent) then convert. The single bridge
  // from "a continuous colormap" to "a mesh-layer colormapLabel", used by the func + atlas surfaces
  // AND the atlas volume, so all three derive identical colors from the same colormap.
  static #surfaceColortableFromColormap(cmapLut: ArrayLike<number>): LabelColortable {
    return MultiView.#lutToColortable(surfaceLutFromColormap(cmapLut).lut)
  }

  // Convert a dense 256-entry RGBA LUT into the {R,G,B,A,I} colortable the label path consumes.
  static #lutToColortable(lut: Uint8ClampedArray): LabelColortable {
    const R: number[] = []
    const G: number[] = []
    const B: number[] = []
    const A: number[] = []
    const I: number[] = []
    const labels: string[] = []
    for (let i = 0; i < 256; i++) {
      R.push(lut[i * 4])
      G.push(lut[i * 4 + 1])
      B.push(lut[i * 4 + 2])
      A.push(lut[i * 4 + 3])
      I.push(i)
      labels.push('')
    }
    return { R, G, B, A, I, labels }
  }

  #removeFunctionLayer(): void {
    if (this.#funcLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    for (const mesh of this.#displayMeshes.slice(0, 2)) {
      const m = mesh as unknown as { layers?: unknown[]; updateMesh?: (gl: WebGL2RenderingContext) => void }
      if (m.layers && m.layers.length > this.#funcLayerIndex) m.layers.splice(this.#funcLayerIndex, 1)
      m.updateMesh?.(gl)
    }
    this.#funcLayerIndex = -1
    this.#funcLayerKey = null
  }

  // Ensure a function-surface layer exists for `key`, loaded from the .func.gii pair (proper
  // readLayer init). Returns false if the base surface isn't present.
  async #ensureFunctionLayer(key: string, pair: SurfacePairUrls): Promise<boolean> {
    if (this.#funcLayerKey === key && this.#funcLayerIndex >= 0) return true
    this.#removeFunctionLayer()
    if (this.#displayMeshes.length < 2) return false
    const hemiUrls = [pair.left, pair.right]
    let idx = -1
    for (let h = 0; h < 2; h++) {
      const mesh = this.#displayMeshes[h]
      idx = (mesh as unknown as { layers?: unknown[] }).layers?.length ?? 0
      // The name MUST end in a real extension: NVMeshLoaders.readLayer picks its parser from the
      // filename extension and throws (`.toUpperCase()` of undefined) on a name without one.
      const layer = { url: this.#client.dataUrl(hemiUrls[h]), name: `${MultiView.#FUNC_LAYER_PREFIX}${key}.func.gii`, colormap: 'gray', opacity: 1, cal_min: 0, cal_max: 255 }
      await (NVMesh as unknown as { loadLayer: (layer: unknown, mesh: NVMesh) => Promise<void> }).loadLayer(layer, mesh)
    }
    this.#funcLayerIndex = idx
    this.#funcLayerKey = key
    return true
  }

  /**
   * Paint a longitudinal change map on the surface.
   *
   * Deliberately the SAME layer slot as the functional map rather than one of its own. The two are
   * both "a value overlay on the mesh" and only one may be shown at a time, and routing them
   * through one slot makes that structural instead of a rule the dashboard has to remember:
   * #ensureFunctionLayer drops the previous layer whenever the key changes.
   *
   * It also sidesteps a latent bug. #removeAtlasSurfaceLayer splices the atlas layer out of
   * mesh.layers WITHOUT decrementing #funcLayerIndex, which is harmless only because an atlas
   * overlay and a value overlay never coexist. A second independent value layer would make that
   * reachable.
   */
  async setChangeSurface(key: string, pair: SurfacePairUrls, leftBins: Float32Array, rightBins: Float32Array, lut: Uint8ClampedArray, opacity: number): Promise<void> {
    this.#urls.change = pair
    this.#urls.changeName = key
    await this.setFunctionSurface(`long:${key}`, pair, leftBins, rightBins, lut, opacity)
  }

  clearChangeSurface(): void {
    this.#urls.change = null
    this.#urls.changeName = null
    this.clearSurfaceFunctionLayers()
  }

  // Show the function-on-surface layer: load once for `key`, then swap in the F-masked bins and
  // apply the 256-entry LUT + opacity. `key` distinguishes retinotopy/somatotopy so switching
  // between them reloads the correct .func.gii; a threshold/brightness change keeps the same key
  // and only mutates values.
  async setFunctionSurface(key: string, pair: SurfacePairUrls, leftBins: Float32Array, rightBins: Float32Array, lut: Uint8ClampedArray, opacity: number): Promise<void> {
    const ok = await this.#ensureFunctionLayer(key, pair)
    if (!ok || this.#funcLayerIndex < 0) return
    const gl = (this.render as unknown as { gl: WebGL2RenderingContext }).gl
    const table = MultiView.#lutToColortable(lut)
    const bins = [leftBins, rightBins]
    for (let h = 0; h < 2; h++) {
      const mesh = this.#displayMeshes[h]
      const m = mesh as unknown as { layers?: Array<Record<string, unknown>>; updateMesh?: (gl: WebGL2RenderingContext) => void }
      const layer = m.layers?.[this.#funcLayerIndex]
      if (!layer) continue
      layer.values = bins[h]
      layer.nFrame4D = 1
      layer.frame4D = 0
      layer.opacity = opacity
      layer.global_min = 0
      layer.global_max = 255
      layer.cal_min = 0
      layer.cal_max = 255
      layer.isTransparentBelowCalMin = false
      m.updateMesh?.(gl)
    }
    await this.#applyLabelLutAt(this.#funcLayerIndex, table)
    this.render.drawScene()
  }

  clearSurfaceFunctionLayers(): void {
    this.#removeFunctionLayer()
    this.render.drawScene()
  }

  #baseScale = 2.0 // last fitted surface zoom; kept for snapshot (getCamera/setCamera) shape compat

  // Frame the displayed surface to fill the pane. The 3D projection is orthographic, so the mesh's
  // projected pixel size is LINEAR in volScaleMultiplier: we project every visible vertex at the
  // current zoom, measure the fraction of the pane the mesh's screen bounds fill, then rescale in a
  // single pass to hit SURFACE_FIT_FRACTION. This is aspect-/monitor-independent (unlike a fixed
  // constant) and adapts to the current view orientation, so no per-view zoom factor is needed.
  #fitSurfaceToView(): void {
    const canvas = (this.render as unknown as { gl?: { canvas?: HTMLCanvasElement } }).gl?.canvas
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return
    const visible = this.#displayMeshes.filter((m) => m && m.visible)
    if (!visible.length) return
    const m = this.#renderMvp(canvas)
    if (!m) return
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const mesh of visible) {
      const pts = mesh.pts
      for (let v = 0; v < pts.length; v += 3) {
        const sp = this.#screenPoint([pts[v], pts[v + 1], pts[v + 2]], m.mvp, m.ltwh)
        if (!sp || !(sp[3] > 0)) continue // behind the camera
        if (sp[0] < minX) minX = sp[0]
        if (sp[0] > maxX) maxX = sp[0]
        if (sp[1] < minY) minY = sp[1]
        if (sp[1] > maxY) maxY = sp[1]
      }
    }
    const pw = maxX - minX // projected mesh bounds, device px
    const ph = maxY - minY
    if (!(pw > 0) || !(ph > 0)) return
    const binding = Math.max(pw / canvas.width, ph / canvas.height) // fraction of limiting pane edge filled
    if (!(binding > 0)) return
    const cur = this.render.scene.volScaleMultiplier || 1
    const next = Math.min(SURFACE_SCALE_MAX, Math.max(SURFACE_SCALE_MIN, (cur * SURFACE_FIT_FRACTION) / binding))
    this.#baseScale = next
    try {
      this.render.scene.volScaleMultiplier = next
      this.render.drawScene()
    } catch {
      // ignore
    }
  }

  // Auto-frame the current surface to the current pane + view. Called on subject load and on each
  // view preset (not on plain window resize — that only redraws).
  fitSurface(): void {
    this.#fitSurfaceToView()
  }

  // Read/restore the surface camera (azimuth/elevation + zoom) so a monkey switch can keep the exact
  // same view. `scale` is the live zoom (volScaleMultiplier); `baseScale` mirrors the last fitted
  // zoom and is retained for snapshot backward-compat (restoring a saved camera wins over auto-fit).
  getCamera(): { azimuth: number; elevation: number; scale: number; baseScale: number } {
    const s = this.render.scene as unknown as { renderAzimuth?: number; renderElevation?: number; volScaleMultiplier?: number }
    return {
      azimuth: s.renderAzimuth ?? 0,
      elevation: s.renderElevation ?? 0,
      scale: s.volScaleMultiplier ?? this.#baseScale,
      baseScale: this.#baseScale,
    }
  }

  setCamera(cam: { azimuth: number; elevation: number; scale: number; baseScale: number }): void {
    this.#baseScale = cam.baseScale
    try {
      this.render.scene.volScaleMultiplier = cam.scale
      this.render.setRenderAzimuthElevation(cam.azimuth, cam.elevation)
      this.render.drawScene()
    } catch {
      // no surface yet
    }
  }

  // Nearest reference-surface vertex to a world crosshair. The index is reused across all
  // displayed surfaces (pial/white/inflated/sphere), preserving vertex correspondence.
  nearestNode(mm: [number, number, number]): SurfaceNode | null {
    if (this.#refMeshes.length < 2) return null
    let best: SurfaceNode | null = null
    let bestDist = Infinity
    for (let hemi = 0 as 0 | 1; hemi <= 1; hemi = (hemi + 1) as 0 | 1) {
      const pts = this.#refMeshes[hemi].pts
      for (let i = 0, v = 0; v < pts.length; i++, v += 3) {
        const dx = pts[v] - mm[0]
        const dy = pts[v + 1] - mm[1]
        const dz = pts[v + 2] - mm[2]
        const d = dx * dx + dy * dy + dz * dz
        if (d < bestDist) {
          bestDist = d
          best = { hemi, index: i }
        }
      }
    }
    return best
  }

  // World position of a node on the CURRENTLY displayed surface.
  nodeWorld(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#displayMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    return [mesh.pts[v], mesh.pts[v + 1], mesh.pts[v + 2]]
  }

  // World position of a node on the REFERENCE (volume-space) surface — for crosshair distance.
  referenceVertexWorld(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#refMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    return [mesh.pts[v], mesh.pts[v + 1], mesh.pts[v + 2]]
  }

  // Cheap outward normal at a node: direction from the hemisphere centroid to the vertex.
  // Good enough to orient/lift the marker off any of the display surfaces (all roughly convex
  // per hemisphere); the centroid is cached per mesh object (invalidated on surface reload).
  #centroidCache = new WeakMap<NVMesh, [number, number, number]>()
  #centroidOf(mesh: NVMesh): [number, number, number] {
    const cached = this.#centroidCache.get(mesh)
    if (cached) return cached
    const pts = mesh.pts
    let x = 0
    let y = 0
    let z = 0
    const n = pts.length / 3
    for (let v = 0; v < pts.length; v += 3) {
      x += pts[v]
      y += pts[v + 1]
      z += pts[v + 2]
    }
    const cen: [number, number, number] = [x / n, y / n, z / n]
    this.#centroidCache.set(mesh, cen)
    return cen
  }

  nodeWorldNormal(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#displayMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    const c = this.#centroidOf(mesh)
    const nx = mesh.pts[v] - c[0]
    const ny = mesh.pts[v + 1] - c[1]
    const nz = mesh.pts[v + 2] - c[2]
    const len = Math.hypot(nx, ny, nz)
    return len > 1e-6 ? [nx / len, ny / len, nz / len] : [0, 1, 0]
  }

  // ---- render-instance screen projection (for marker drag picking) ----
  #renderMvp(canvas: HTMLCanvasElement): { mvp: unknown; ltwh: number[] } | null {
    const nv = this.render as unknown as {
      scene?: { renderAzimuth?: number; renderElevation?: number }
      calculateMvpMatrix?: (u: unknown, ltwh: number[], az: number, el: number) => unknown[]
    }
    if (!nv.calculateMvpMatrix) return null
    const az = nv.scene?.renderAzimuth ?? 0
    const el = nv.scene?.renderElevation ?? 0
    const ltwh = [0, 0, canvas.width, canvas.height]
    try {
      const mtx = nv.calculateMvpMatrix(null, ltwh, az, el)
      const mvp = Array.isArray(mtx) ? mtx[0] : mtx
      return mvp ? { mvp, ltwh } : null
    } catch {
      return null
    }
  }

  #screenPoint(world: [number, number, number], mvp: unknown, ltwh: number[]): number[] | null {
    const nv = this.render as unknown as { calculateScreenPoint?: (p: [number, number, number], m: unknown, l: number[]) => ArrayLike<number> }
    if (!nv.calculateScreenPoint) return null
    const sp = nv.calculateScreenPoint(world, mvp, ltwh)
    return [sp[0], sp[1], sp[2], sp[3]]
  }

  // Project a world point to CLIENT (CSS-pixel) coordinates for the surface canvas.
  projectToScreen(world: [number, number, number], canvas: HTMLCanvasElement): { x: number; y: number; depth: number; w: number } | null {
    const m = this.#renderMvp(canvas)
    if (!m) return null
    const sp = this.#screenPoint(world, m.mvp, m.ltwh)
    if (!sp) return null
    const dpr = canvas.width / Math.max(1, canvas.clientWidth)
    const rect = canvas.getBoundingClientRect()
    return { x: rect.left + sp[0] / dpr, y: rect.top + sp[1] / dpr, depth: sp[2], w: sp[3] }
  }

  // Pick the displayed-surface vertex NEAREST the cursor on the visible (front-facing) sheet.
  // Reuses NiiVue's own projection (calculateScreenPoint uses top-left device pixels).
  //
  // We can't just take the frontmost vertex within a hit radius: on a folded cortical surface that
  // snaps to whichever gyral crown bulges most toward the camera, so the marker lands a few pixels
  // off from the cursor. Instead we split each (roughly convex) hemisphere into a near and far sheet
  // by projecting its centroid: a vertex is front-facing when it projects nearer the camera than the
  // centroid. Among front-facing vertices we take the one closest to the cursor in screen space —
  // that IS the point under the cursor. The centroid split reuses the convex-hemisphere assumption
  // this class already relies on for nodeWorldNormal.
  pickNodeAtScreen(clientX: number, clientY: number, canvas: HTMLCanvasElement): SurfaceNode | null {
    if (this.#displayMeshes.length < 2) return null
    const m = this.#renderMvp(canvas)
    if (!m) return null
    const dpr = canvas.width / Math.max(1, canvas.clientWidth)
    const rect = canvas.getBoundingClientRect()
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr
    const R2 = (36 * dpr) * (36 * dpr)
    // Only ever consider vertices WITHIN the hit radius (d2 < R2). Two candidates are tracked, both
    // restricted to that radius so a drag never escapes to the far side of the surface:
    //   best  — the front-facing vertex NEAREST the cursor (the point actually under the cursor)
    //   front — the FRONTMOST (least-depth) vertex, always on the near sheet; used only when the
    //           front-facing test finds nothing (e.g. grazing the silhouette, where surface vertices
    //           sit right at the centroid depth). Never the nearest-of-any-depth — that could grab a
    //           back-hemisphere vertex, throwing the crosshair into the interior and hiding the pin.
    let best: SurfaceNode | null = null
    let bestDist = Infinity
    let front: SurfaceNode | null = null
    let frontDepth = Infinity
    for (let hemi = 0 as 0 | 1; hemi <= 1; hemi = (hemi + 1) as 0 | 1) {
      const mesh = this.#displayMeshes[hemi]
      if (!mesh || !mesh.visible) continue
      // Depth of this hemisphere's centroid — the near/far divider for the convex sheet.
      const cenSp = this.#screenPoint(this.#centroidOf(mesh), m.mvp, m.ltwh)
      const cenDepth = cenSp ? cenSp[2] : Infinity
      const pts = mesh.pts
      for (let i = 0, v = 0; v < pts.length; i++, v += 3) {
        const sp = this.#screenPoint([pts[v], pts[v + 1], pts[v + 2]], m.mvp, m.ltwh)
        if (!sp || !(sp[3] > 0)) continue // behind the camera
        const dx = sp[0] - px
        const dy = sp[1] - py
        const d2 = dx * dx + dy * dy
        if (d2 >= R2) continue // outside the hit radius — ignore entirely
        if (sp[2] < cenDepth && d2 < bestDist) {
          bestDist = d2
          best = { hemi, index: i }
        }
        if (sp[2] < frontDepth) {
          frontDepth = sp[2]
          front = { hemi, index: i }
        }
      }
    }
    // Nearest front-facing vertex under the cursor; else the frontmost vertex in range (still the near
    // sheet); else null — an off-surface drag leaves the marker where it was rather than jumping off.
    return best ?? front
  }

  // Constrained drag pick: from the marker's CURRENT vertex, walk along mesh edges to the vertex
  // nearest the cursor, staying on the same connected hemisphere. The lateral and medial walls are
  // edge-connected only the long way around the pole, so a bounded LOCAL walk can never cross the
  // (thin) cortical ribbon to the far wall — eliminating the "jump" a global screen pick suffers.
  // Returns null when the hemisphere has no adjacency, so the caller can fall back to pickNodeAtScreen.
  walkNode(fromNode: SurfaceNode, clientX: number, clientY: number, canvas: HTMLCanvasElement): SurfaceNode | null {
    const adj = this.#adjacency[fromNode.hemi]
    const mesh = this.#displayMeshes[fromNode.hemi]
    if (!adj || !mesh) return null
    const m = this.#renderMvp(canvas)
    if (!m) return null
    const dpr = canvas.width / Math.max(1, canvas.clientWidth)
    const rect = canvas.getBoundingClientRect()
    const px = (clientX - rect.left) * dpr
    const py = (clientY - rect.top) * dpr
    const pts = mesh.pts
    const { offsets, neighbors, visited } = adj
    const gen = ++this.#walkGen // stamp; visited entries equal to gen were seen this call
    // Screen-distance² from vertex i to the cursor (Infinity if the vertex is behind the camera).
    const dist2 = (i: number): number => {
      const v = i * 3
      const sp = this.#screenPoint([pts[v], pts[v + 1], pts[v + 2]], m.mvp, m.ltwh)
      if (!sp || !(sp[3] > 0)) return Infinity
      const dx = sp[0] - px
      const dy = sp[1] - py
      return dx * dx + dy * dy
    }
    // Bounded BFS. The hop + visited caps keep the walk a small patch — far short of the hop count
    // needed to wrap around the pole to the far wall — and ARRIVE2 stops early once we reach the
    // cursor. `best` is seeded with the current vertex, so a drag that can't improve stays put.
    const MAX_HOPS = 48
    const MAX_VISITS = 8000
    const ARRIVE2 = (4 * dpr) * (4 * dpr)
    let best = fromNode.index
    let bestD2 = dist2(fromNode.index)
    visited[fromNode.index] = gen
    let frontier: number[] = [fromNode.index]
    let visits = 1
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && visits < MAX_VISITS && bestD2 > ARRIVE2; hop++) {
      const next: number[] = []
      for (const u of frontier) {
        const end = offsets[u + 1]
        for (let e = offsets[u]; e < end; e++) {
          const w = neighbors[e]
          if (visited[w] === gen) continue
          visited[w] = gen
          visits++
          const d2 = dist2(w)
          if (d2 < bestD2) {
            bestD2 = d2
            best = w
          }
          next.push(w)
          if (visits >= MAX_VISITS) break
        }
        if (visits >= MAX_VISITS) break
      }
      frontier = next
    }
    return { hemi: fromNode.hemi, index: best }
  }

  // Reference-surface (volume-space) position for a node — used to sync the slice crosshair when
  // the marker is dragged on a display surface that isn't in volume space (inflated/sphere).
  refNodeWorld(node: SurfaceNode): [number, number, number] | null {
    const mesh = this.#refMeshes[node.hemi]
    if (!mesh) return null
    const v = node.index * 3
    return [mesh.pts[v], mesh.pts[v + 1], mesh.pts[v + 2]]
  }

  // Move the crosshair to a world mm coordinate (slice instance) and re-emit, so the marker and
  // reports follow. Mirrors nudgeCrosshair but takes an absolute position.
  moveCrosshairToWorld(mm: [number, number, number]): void {
    try {
      this.slices.scene.crosshairPos = this.slices.mm2frac(mm)
      this.slices.drawScene()
    } catch {
      // no volume yet
    }
    this.#crosshairCb?.({ mm })
  }

  // ---- camera view presets (surf row) ----
  // Absolute NiiVue azimuth/elevation per named view; the zoom is then auto-fit to the mesh bounds
  // (#fitSurfaceToView), so each view reframes to best-fit without per-view zoom constants — this
  // handles the elongated dorsal/ventral profiles automatically. Lateral/Medial are hemisphere-aware
  // (Req 8: the left hemisphere's lateral face is toward RIGHT_SIDE azimuth, its medial toward LEFT_SIDE).
  // NOTE: the angle constants are the most likely things to need a visual tweak.
  setView(name: 'lateral' | 'medial' | 'ventral' | 'dorsal' | 'anterior' | 'posterior', preferHemi: 0 | 1 = 0): void {
    const LEFT_SIDE = 270
    const RIGHT_SIDE = 90
    let az = 110
    let el = 0
    switch (name) {
      case 'lateral':
        az = preferHemi === 0 ? RIGHT_SIDE : LEFT_SIDE
        break
      case 'medial':
        az = preferHemi === 0 ? LEFT_SIDE : RIGHT_SIDE
        break
      case 'anterior':
        az = 180
        break
      case 'posterior':
        az = 0
        break
      case 'dorsal':
        az = 0
        el = 90
        break
      case 'ventral':
        az = 0
        el = -90
        break
    }
    try {
      this.render.setRenderAzimuthElevation(az, el)
      this.#fitSurfaceToView() // reframe to fill the pane at the new orientation (redraws)
    } catch {
      // no surface yet
    }
  }

  // Per-hemisphere visibility (LH/RH checkboxes). hemi 0 = left, 1 = right.
  setHemisphereVisible(hemi: 0 | 1, visible: boolean): void {
    const mesh = this.#displayMeshes[hemi]
    if (mesh) {
      mesh.visible = visible
      this.render.drawScene()
    }
  }

  // Shift the crosshair by a world-mm delta (arrow keys), then re-emit.
  nudgeCrosshair(delta: [number, number, number]): void {
    if (!this.#baseVol) return
    try {
      const cur = Array.from(this.slices.frac2mm(this.slices.scene.crosshairPos)) as number[]
      const mm: [number, number, number] = [cur[0] + delta[0], cur[1] + delta[1], cur[2] + delta[2]]
      this.slices.scene.crosshairPos = this.slices.mm2frac(mm)
      this.slices.drawScene()
      this.#crosshairCb?.({ mm })
    } catch {
      // no volume yet
    }
  }

  resize(): void {
    this.slices.drawScene()
    this.render.drawScene()
  }
}
