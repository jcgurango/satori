/**
 * Inline text segment collection.
 *
 * When a parent element contains only text and inline-level children
 * (`<span>`, `<b>`, `<strong>`, `<i>`, `<em>`, `<u>`, `<s>`, `<code>`,
 * `<kbd>`, `<mark>`, `<big>`, `<small>`), the children do NOT get their
 * own Yoga nodes. Their text is flattened into the parent's text flow with
 * per-segment style metadata so the text builder can render mixed colors,
 * weights, fonts, etc. on a shared line.
 *
 * Padding/border/background-color on inline spans is paint-time only — they
 * do not influence layout. This is a deliberate determinism tradeoff over
 * full HTML compatibility.
 */
import type { ReactNode, ReactElement } from 'react'
import {
  isReactElement,
  isReactComponent,
  isClass,
  isForwardRefComponent,
  normalizeChildren,
} from '../utils.js'
import expand, { SerializedStyle } from '../handler/expand.js'
import inheritable from './../handler/inheritable.js'
import presets from '../handler/presets.js'

export const INLINE_ELEMENTS = new Set([
  'span',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'code',
  'kbd',
  'mark',
  'big',
  'small',
])

export type InlineSpan = {
  id: string
  style: SerializedStyle
  // Index range into the segment array, inclusive on both ends. Set after the
  // collection finishes so a span's range covers all of its descendants too.
  startSegment: number
  endSegment: number
}

export type InlineSegment = {
  text: string
  // The fully resolved style for this run.
  style: SerializedStyle
  // The chain of spans that contain this segment, outermost first. Empty if
  // the segment came from a bare text node directly under the parent.
  spans: InlineSpan[]
}

export function isInlineEligibleChild(child: ReactNode): boolean {
  if (
    typeof child === 'undefined' ||
    child === null ||
    typeof child === 'boolean'
  ) {
    return true
  }
  if (typeof child === 'string' || typeof child === 'number') return true
  if (!isReactElement(child)) return false
  // Components are evaluated lazily when collecting segments; we treat them
  // as inline-eligible at this stage.
  if (isReactComponent(child.type)) return true
  if (typeof child.type !== 'string') return false
  return INLINE_ELEMENTS.has(child.type)
}

/**
 * Returns true if the given children list contains at least one inline element
 * and every child is inline-eligible. Bare text-only content does not trigger
 * the inline path because the existing string fast path handles it correctly.
 */
export function shouldUseInlinePath(children: ReactNode[]): boolean {
  let hasInlineElement = false
  for (const child of children) {
    if (!isInlineEligibleChild(child)) return false
    if (
      isReactElement(child) &&
      typeof child.type === 'string' &&
      INLINE_ELEMENTS.has(child.type)
    ) {
      hasInlineElement = true
    }
  }
  return hasInlineElement
}

let spanIdCounter = 0
function nextSpanId(): string {
  return `span_${++spanIdCounter}`
}

/**
 * Recursively flatten the inline subtree into a list of {text, style, spans}
 * segments. Each span node contributes a span entry but not a Yoga node.
 *
 * Component children are expanded by calling them as functions (Satori
 * already requires component children to be pure stateless functions).
 */
export async function flattenInline(
  children: ReactNode,
  inheritedStyle: SerializedStyle,
  parentSpans: InlineSpan[],
  segments: InlineSegment[],
  collectedSpans: InlineSpan[]
): Promise<void> {
  const normalized = normalizeChildren(children)
  for (const child of normalized) {
    if (typeof child === 'string') {
      if (child.length === 0) continue
      segments.push({
        text: child,
        style: inheritedStyle,
        spans: parentSpans.slice(),
      })
      continue
    }
    if (!isReactElement(child)) continue

    // Component child — evaluate and recurse.
    if (isReactComponent(child.type)) {
      if (isClass(child.type as Function)) {
        throw new Error('Class component is not supported.')
      }
      const render = isForwardRefComponent(child.type)
        ? (child.type as any).render
        : (child.type as Function)
      const evaluated = await render((child as ReactElement).props)
      await flattenInline(
        evaluated,
        inheritedStyle,
        parentSpans,
        segments,
        collectedSpans
      )
      continue
    }

    if (typeof child.type !== 'string') continue
    if (!INLINE_ELEMENTS.has(child.type)) continue

    // Compute style for this inline element.
    const definedStyle = (child.props && child.props.style) || {}
    const elementPreset = presets[child.type]
    const mergedStyle: SerializedStyle = Object.assign(
      {},
      inheritedStyle,
      expand(elementPreset, inheritedStyle),
      expand(definedStyle, inheritedStyle)
    )

    const span: InlineSpan = {
      id: nextSpanId(),
      style: mergedStyle,
      startSegment: segments.length,
      endSegment: -1,
    }
    collectedSpans.push(span)

    const childSpans = parentSpans.concat(span)
    const inheritedForChildren = inheritable(mergedStyle)
    await flattenInline(
      child.props && child.props.children,
      inheritedForChildren,
      childSpans,
      segments,
      collectedSpans
    )

    span.endSegment = segments.length - 1
  }
}
