// SVG figure exporter for publication.
//
// Flattens the 3D surface and multiplanar volume slices into a publication-ready 2D vector &
// raster composite (.svg). Structures the document with native Adobe Illustrator & Inkscape
// layers (`<g inkscape:groupmode="layer">`) so researchers can inspect, toggle, or delete the
// overlay layer while keeping the underlying anatomical base intact.
import type { MultiView } from '../niivue/multiView.ts'
import type { Layout } from '../state/store.ts'
import { downloadBlob } from '@brainana/core-client/exportDestination.ts'

export type ExportBackground = 'white' | 'dark' | 'transparent'

export interface LegendExportInfo {
  title?: string
  gradient?: string
  lut?: ArrayLike<number>
  displayRange?: { min: number; max: number }
  barTicks?: [string, string, string]
}

export interface SvgExportOptions {
  background: ExportBackground
  scale?: number // defaults to 1
  separateOverlay: boolean
  includeAnnotations: boolean
  includeLegend: boolean
  filename: string
}

export interface SvgExportDeps {
  view: MultiView
  activeLayout: Layout
  volEnabled: boolean
  surfEnabled: boolean
  legendInfo: LegendExportInfo | null
}

/**
 * Ensures that outer background surrounding the brain anatomy is fully transparent.
 * If WebGL already cleared with alpha=0, this is a fast no-op.
 * If the background is opaque (e.g. white or dark), flood-fills from the borders
 * to clear the surrounding background to alpha=0, leaving the brain anatomy intact.
 */
export function makeOuterBackgroundTransparent(
  canvas: HTMLCanvasElement,
  bgRgb: [number, number, number] = [255, 255, 255],
  tolerance = 12,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width === 0 || canvas.height === 0) return

  const w = canvas.width
  const h = canvas.height
  const imgData = ctx.getImageData(0, 0, w, h)
  const data = imgData.data

  // Fast check: if the 4 corners already have alpha === 0, verify and return
  const c1 = data[3]
  const c2 = data[(w - 1) * 4 + 3]
  const c3 = data[(h - 1) * w * 4 + 3]
  const c4 = data[((w - 1) + (h - 1) * w) * 4 + 3]
  if (c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0) {
    let hasOpaqueEdge = false
    const step = Math.max(1, Math.floor(w / 8))
    for (let x = 0; x < w; x += step) {
      if (data[x * 4 + 3] !== 0 || data[(x + (h - 1) * w) * 4 + 3] !== 0) {
        hasOpaqueEdge = true
        break
      }
    }
    if (!hasOpaqueEdge) return // Already fully transparent outside
  }

  const [targetR, targetG, targetB] = bgRgb
  const visited = new Uint8Array(w * h)
  const queue: number[] = []

  const isMatch = (idx: number): boolean => {
    const p = idx * 4
    if (data[p + 3] === 0) return true
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    return (
      Math.abs(r - targetR) <= tolerance &&
      Math.abs(g - targetG) <= tolerance &&
      Math.abs(b - targetB) <= tolerance
    )
  }

  for (let x = 0; x < w; x++) {
    const top = x
    const bot = x + (h - 1) * w
    if (isMatch(top)) { visited[top] = 1; queue.push(top) }
    if (isMatch(bot)) { visited[bot] = 1; queue.push(bot) }
  }
  for (let y = 0; y < h; y++) {
    const left = y * w
    const right = (w - 1) + y * w
    if (!visited[left] && isMatch(left)) { visited[left] = 1; queue.push(left) }
    if (!visited[right] && isMatch(right)) { visited[right] = 1; queue.push(right) }
  }

  let head = 0
  while (head < queue.length) {
    const curr = queue[head++]
    const cx = curr % w
    const cy = Math.floor(curr / w)

    if (cx > 0) {
      const n = curr - 1
      if (!visited[n] && isMatch(n)) { visited[n] = 1; queue.push(n) }
    }
    if (cx < w - 1) {
      const n = curr + 1
      if (!visited[n] && isMatch(n)) { visited[n] = 1; queue.push(n) }
    }
    if (cy > 0) {
      const n = curr - w
      if (!visited[n] && isMatch(n)) { visited[n] = 1; queue.push(n) }
    }
    if (cy < h - 1) {
      const n = curr + w
      if (!visited[n] && isMatch(n)) { visited[n] = 1; queue.push(n) }
    }
  }

  for (let i = 0; i < visited.length; i++) {
    if (visited[i]) {
      data[i * 4 + 3] = 0
    }
  }

  ctx.putImageData(imgData, 0, 0)
}

export function extractOverlayCanvas(underlay: HTMLCanvasElement, composite: HTMLCanvasElement): { canvas: HTMLCanvasElement; hasDiff: boolean } {
  const w = composite.width
  const h = composite.height
  const overlay = document.createElement('canvas')
  overlay.width = w
  overlay.height = h
  const oCtx = overlay.getContext('2d')
  const uCtx = underlay.getContext('2d')
  const cCtx = composite.getContext('2d')

  if (!oCtx || !uCtx || !cCtx || w === 0 || h === 0) {
    return { canvas: overlay, hasDiff: false }
  }

  const uData = uCtx.getImageData(0, 0, w, h).data
  const cData = cCtx.getImageData(0, 0, w, h).data
  const oImg = oCtx.createImageData(w, h)
  const oData = oImg.data

  let hasDiff = false
  for (let i = 0; i < cData.length; i += 4) {
    // If composite pixel is transparent, overlay pixel is transparent
    if (cData[i + 3] === 0) {
      oData[i + 3] = 0
      continue
    }
    const dr = Math.abs(cData[i] - uData[i])
    const dg = Math.abs(cData[i + 1] - uData[i + 1])
    const db = Math.abs(cData[i + 2] - uData[i + 2])
    // Threshold of 2 to absorb minor GPU precision/quantization noise
    if (dr > 2 || dg > 2 || db > 2) {
      oData[i] = cData[i]
      oData[i + 1] = cData[i + 1]
      oData[i + 2] = cData[i + 2]
      oData[i + 3] = cData[i + 3]
      hasDiff = true
    } else {
      oData[i + 3] = 0
    }
  }

  if (hasDiff) {
    oCtx.putImageData(oImg, 0, 0)
  }
  return { canvas: overlay, hasDiff }
}

/**
 * Generate a vector colorbar SVG group with gradient and min/max labels.
 */
function buildVectorLegendSvg(
  x: number,
  y: number,
  width: number,
  legend: LegendExportInfo,
  textColor: string,
): string {
  const barWidth = Math.min(280, width - 40)
  const barHeight = 14
  const barX = x + Math.round((width - barWidth) / 2)
  const barY = y + 20

  const range = legend.displayRange ?? { min: 0, max: 1 }
  const leftLabel = legend.barTicks ? legend.barTicks[0] : range.min.toFixed(2)
  const midLabel = legend.barTicks ? legend.barTicks[1] : ''
  const rightLabel = legend.barTicks ? legend.barTicks[2] : range.max.toFixed(2)
  const title = legend.title ? legend.title : 'Colorbar'

  // Build gradient stops from LUT or simple fallback
  let stops = ''
  if (legend.lut && legend.lut.length >= 256 * 4) {
    const step = 16
    for (let i = 0; i <= 256; i += step) {
      const idx = Math.min(255, i) * 4
      const r = legend.lut[idx]
      const g = legend.lut[idx + 1]
      const b = legend.lut[idx + 2]
      const pct = (i / 256) * 100
      stops += `<stop offset="${pct.toFixed(1)}%" stop-color="rgb(${r},${g},${b})" />\n`
    }
  } else {
    stops = `<stop offset="0%" stop-color="#000000" />\n<stop offset="100%" stop-color="#ffffff" />\n`
  }

  return `
    <g id="Legend" inkscape:groupmode="layer" inkscape:label="Colorbar Legend">
      <defs>
        <linearGradient id="legend-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          ${stops}
        </linearGradient>
      </defs>
      <!-- Title -->
      <text x="${x + width / 2}" y="${y + 12}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="${textColor}">${escapeXml(title)}</text>
      <!-- Colorbar -->
      <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="2" fill="url(#legend-gradient)" stroke="${textColor}" stroke-opacity="0.3" stroke-width="1" />
      <!-- Labels -->
      <text x="${barX}" y="${barY + barHeight + 14}" text-anchor="start" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="${textColor}">${escapeXml(leftLabel)}</text>
      ${midLabel ? `<text x="${barX + barWidth / 2}" y="${barY + barHeight + 14}" text-anchor="middle" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="${textColor}">${escapeXml(midLabel)}</text>` : ''}
      <text x="${barX + barWidth}" y="${barY + barHeight + 14}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="${textColor}">${escapeXml(rightLabel)}</text>
    </g>
  `
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

/**
 * Orchestrates capture, layer extraction, SVG generation, and saving/downloading.
 */
export function exportSvgFigure(
  deps: SvgExportDeps,
  options: SvgExportOptions,
): { blob: Blob } {
  const { view, activeLayout, volEnabled, surfEnabled, legendInfo } = deps
  const { background, scale = 1, separateOverlay, includeAnnotations, includeLegend, filename } = options

  const isWhite = background === 'white'
  const isDark = background === 'dark'

  const doSlices = volEnabled
  const doSurface = surfEnabled

  // 1. Capture slices canvases (transparent background)
  const slicesData = doSlices ? view.captureSlicesCanvases(scale, isWhite, !includeAnnotations, true) : null

  // 2. Capture surface canvases (transparent background)
  const surfaceData = doSurface ? view.captureSurfaceCanvases(scale, isWhite, !includeAnnotations, true) : null

  // Ensure outer background surrounding the brain anatomy is 100% transparent in all layers
  const bgRgb: [number, number, number] = isWhite ? [255, 255, 255] : [0, 0, 0]
  if (slicesData) {
    makeOuterBackgroundTransparent(slicesData.underlay, bgRgb)
    makeOuterBackgroundTransparent(slicesData.composite, bgRgb)
    if (slicesData.annotations) makeOuterBackgroundTransparent(slicesData.annotations, bgRgb)
  }
  if (surfaceData) {
    makeOuterBackgroundTransparent(surfaceData.underlay, bgRgb)
    makeOuterBackgroundTransparent(surfaceData.composite, bgRgb)
    if (surfaceData.annotations) makeOuterBackgroundTransparent(surfaceData.annotations, bgRgb)
  }

  // 3. Process overlay & annotation layer separation
  let slicesUnderlayUrl: string | null = null
  let slicesOverlayUrl: string | null = null
  let slicesAnnotationsUrl: string | null = null
  let surfaceUnderlayUrl: string | null = null
  let surfaceOverlayUrl: string | null = null
  let surfaceAnnotationsUrl: string | null = null

  if (slicesData) {
    if (separateOverlay) {
      const { canvas: overlayCanvas, hasDiff } = extractOverlayCanvas(slicesData.underlay, slicesData.composite)
      slicesUnderlayUrl = slicesData.underlay.toDataURL('image/png')
      slicesOverlayUrl = hasDiff ? overlayCanvas.toDataURL('image/png') : null
    } else {
      slicesUnderlayUrl = slicesData.composite.toDataURL('image/png')
    }
    if (includeAnnotations && slicesData.annotations) {
      const { canvas: annotCanvas, hasDiff } = extractOverlayCanvas(slicesData.underlay, slicesData.annotations)
      slicesAnnotationsUrl = hasDiff ? annotCanvas.toDataURL('image/png') : null
    }
  }

  if (surfaceData) {
    if (separateOverlay) {
      const { canvas: overlayCanvas, hasDiff } = extractOverlayCanvas(surfaceData.underlay, surfaceData.composite)
      surfaceUnderlayUrl = surfaceData.underlay.toDataURL('image/png')
      surfaceOverlayUrl = hasDiff ? overlayCanvas.toDataURL('image/png') : null
    } else {
      surfaceUnderlayUrl = surfaceData.composite.toDataURL('image/png')
    }
    if (includeAnnotations && surfaceData.annotations) {
      const { canvas: annotCanvas, hasDiff } = extractOverlayCanvas(surfaceData.underlay, surfaceData.annotations)
      surfaceAnnotationsUrl = hasDiff ? annotCanvas.toDataURL('image/png') : null
    }
  }

  // 4. Compute layout dimensions and positioning
  const sW = slicesData?.underlay.width ?? 0
  const sH = slicesData?.underlay.height ?? 0
  const mW = surfaceData?.underlay.width ?? 0
  const mH = surfaceData?.underlay.height ?? 0

  let totalW = 0
  let totalH = 0
  let sX = 0
  let sY = 0
  let mX = 0
  let mY = 0

  if (slicesData && surfaceData) {
    if (activeLayout === 'row') {
      totalW = Math.max(sW, mW)
      sX = Math.round((totalW - sW) / 2)
      sY = 0
      mX = Math.round((totalW - mW) / 2)
      mY = sH
      totalH = sH + mH
    } else {
      // 'grid' or 'column'
      totalW = sW + mW
      totalH = Math.max(sH, mH)
      sX = 0
      sY = Math.round((totalH - sH) / 2)
      mX = sW
      mY = Math.round((totalH - mH) / 2)
    }
  } else if (slicesData) {
    totalW = sW
    totalH = sH
  } else if (surfaceData) {
    totalW = mW
    totalH = mH
  }

  // Legend dimension adjustments
  const legendH = includeLegend && legendInfo ? 60 : 0
  const finalH = totalH + legendH
  const finalW = Math.max(totalW, includeLegend && legendInfo ? 320 : 0)

  // 5. Build SVG document
  const textColor = isWhite ? '#222222' : '#eeeeee'
  const bgFill = isWhite ? '#ffffff' : isDark ? '#000000' : 'none'

  let svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     version="1.1"
     width="${finalW}" height="${finalH}" viewBox="0 0 ${finalW} ${finalH}">
`

  // Layer 1: Background
  if (background !== 'transparent') {
    svg += `  <g id="Background" inkscape:groupmode="layer" inkscape:label="Background">
    <rect width="100%" height="100%" fill="${bgFill}" />
  </g>
`
  }

  // Layer 2: Underlay (Base Anatomy)
  svg += `  <g id="Underlay" inkscape:groupmode="layer" inkscape:label="Underlay (Base Anatomy)">
`
  if (slicesUnderlayUrl) {
    svg += `    <image id="underlay-slices" x="${sX}" y="${sY}" width="${sW}" height="${sH}" href="${slicesUnderlayUrl}" />\n`
  }
  if (surfaceUnderlayUrl) {
    svg += `    <image id="underlay-surface" x="${mX}" y="${mY}" width="${mW}" height="${mH}" href="${surfaceUnderlayUrl}" />\n`
  }
  svg += `  </g>\n`

  // Layer 3: Removable Overlay
  if (slicesOverlayUrl || surfaceOverlayUrl) {
    svg += `  <g id="Overlay" inkscape:groupmode="layer" inkscape:label="Overlay (Atlas &amp; Functional)">
`
    if (slicesOverlayUrl) {
      svg += `    <image id="overlay-slices" x="${sX}" y="${sY}" width="${sW}" height="${sH}" href="${slicesOverlayUrl}" />\n`
    }
    if (surfaceOverlayUrl) {
      svg += `    <image id="overlay-surface" x="${mX}" y="${mY}" width="${mW}" height="${mH}" href="${surfaceOverlayUrl}" />\n`
    }
    svg += `  </g>\n`
  }

  // Layer 4: Annotations (Crosshairs, Orientation & Marker)
  if (slicesAnnotationsUrl || surfaceAnnotationsUrl) {
    svg += `  <g id="Annotations" inkscape:groupmode="layer" inkscape:label="Annotations (Crosshairs, Orientation &amp; Marker)">\n`
    if (slicesAnnotationsUrl) {
      svg += `    <image id="annotations-slices" x="${sX}" y="${sY}" width="${sW}" height="${sH}" href="${slicesAnnotationsUrl}" />\n`
    }
    if (surfaceAnnotationsUrl) {
      svg += `    <image id="annotations-surface" x="${mX}" y="${mY}" width="${mW}" height="${mH}" href="${surfaceAnnotationsUrl}" />\n`
    }
    svg += `  </g>\n`
  }

  // Layer 5: Legend
  if (includeLegend && legendInfo) {
    svg += buildVectorLegendSvg(0, totalH, finalW, legendInfo, textColor)
  }

  svg += `</svg>`

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  downloadBlob(blob, filename)
  return { blob }
}
