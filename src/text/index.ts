/**
 * This module calculates the layout of a text string. The text content can
 * either be a plain string (the simple/legacy path) or a list of inline
 * segments produced by `inline.ts` — segments enable mixed colors, fonts,
 * weights, etc. on a shared line via `<span>` and similar inline elements.
 *
 * Per-segment padding/border/background-color is paint-only: it does not
 * influence layout. This is a deliberate determinism tradeoff over full
 * HTML compatibility.
 */
import type { LayoutContext } from '../layout.js'
import {
  v,
  segment,
  wordSeparators,
  buildXMLString,
  isUndefined,
  isString,
  lengthToNumber,
} from '../utils.js'
import { getYoga, TYoga, YogaNode } from '../yoga.js'
import buildText, { container } from '../builder/text.js'
import { buildDropShadow } from '../builder/shadow.js'
import buildDecoration from '../builder/text-decoration.js'
import type { FontEngine, GlyphBox } from '../font.js'
import { Locale } from '../language.js'
import { HorizontalEllipsis, Space, Tab } from './characters.js'
import { genMeasurer } from './measurer.js'
import { preprocess } from './processor.js'
import cssColorParse from 'parse-css-color'
import type { InlineSegment, InlineSpan } from './inline.js'
import radius from '../builder/border-radius.js'

export type TextContent =
  | string
  | { segments: InlineSegment[]; spans: InlineSpan[] }

const skippedWordWhenFindingMissingFont = new Set([Tab])

function shouldSkipWhenFindingMissingFont(word: string): boolean {
  return skippedWordWhenFindingMissingFont.has(word)
}

function isFullyTransparent(color: string): boolean {
  if (color === 'transparent') return true
  const parsed = cssColorParse(color)
  return parsed ? parsed.alpha === 0 : false
}

function isOpaqueWhite(color: string): boolean {
  if (!color) return false
  const parsed = cssColorParse(color)
  if (!parsed) return false
  const [r, g, b, a] = parsed.values
  return r === 255 && g === 255 && b === 255 && (a === undefined || a === 1)
}

export default async function* buildTextNodes(
  content: TextContent,
  context: LayoutContext
): AsyncGenerator<{ word: string; locale?: Locale }[], string, [any, any]> {
  const Yoga = await getYoga()
  const inlineSegments: InlineSegment[] | null =
    typeof content === 'string' ? null : content.segments
  const inlineSpans: InlineSpan[] =
    typeof content === 'string' ? [] : content.spans
  // Concatenate segment text for the segment path. Word-level segment lookup
  // will be tracked separately via `wordSegmentIndex`.
  const rawContent: string =
    typeof content === 'string'
      ? content
      : inlineSegments.map((s) => s.text).join('')

  const {
    parentStyle,
    inheritedStyle,
    parent,
    font,
    id,
    isInheritingTransform,
    debug,
    embedFont,
    graphemeImages,
    locale,
    canLoadAdditionalAssets,
  } = context

  const {
    textAlign,
    textIndent = 0,
    lineHeight,
    textWrap,
    fontSize,
    filter: cssFilter,
    tabSize = 8,
    letterSpacing,
    _inheritedBackgroundClipTextPath,
    _inheritedBackgroundClipTextHasBackground,
    flexShrink,
  } = parentStyle

  // Build the words / requiredBreaks list. For inline segments we run the
  // preprocess on each segment in turn (using the segment's own white-space
  // and word-break rules — though typically these are inherited and shared
  // with the parent). The resulting word list is parallel to
  // `wordSegmentIndex`, which records which inline segment each word came
  // from. For the simple string path, every word belongs to segment 0.
  let words: string[]
  let requiredBreaks: boolean[]
  let allowSoftWrap: boolean
  let allowBreakWord: boolean
  let processedContent: string
  let shouldCollapseTabsAndSpaces: boolean
  let lineLimit: number
  let blockEllipsis: string | undefined
  let wordSegmentIndex: number[] = []

  if (inlineSegments) {
    words = []
    requiredBreaks = []
    processedContent = ''
    let firstPP: ReturnType<typeof preprocess> | null = null
    // Whether the running concatenated word list ends with a whitespace
    // character. Used to suppress redundant leading-space restoration when
    // the previous segment already provided the inter-segment space.
    let lastWordEndsWithSpace = false
    for (let si = 0; si < inlineSegments.length; si++) {
      const seg = inlineSegments[si]
      const isFirst = si === 0
      const isLast = si === inlineSegments.length - 1
      const hadLeadingSpace = /^\s/.test(seg.text)
      const hadTrailingSpace = /\s$/.test(seg.text)

      const pp = preprocess(seg.text, seg.style, locale)
      if (!firstPP) firstPP = pp

      // The default `preprocess` strips leading/trailing whitespace. For
      // inline segments we want to preserve whitespace at segment
      // boundaries so the natural inter-word spacing of the original
      // markup survives. We re-attach a single space to the adjacent
      // word when the original segment had it and we're not at a global
      // edge.
      if (hadLeadingSpace && !isFirst && !lastWordEndsWithSpace) {
        if (pp.words.length > 0) {
          pp.words[0] = ' ' + pp.words[0]
        } else {
          pp.words.push(' ')
          pp.requiredBreaks.push(false)
        }
      }
      if (hadTrailingSpace && !isLast) {
        if (pp.words.length > 0) {
          if (!/\s$/.test(pp.words[pp.words.length - 1])) {
            pp.words[pp.words.length - 1] += ' '
          }
        } else {
          pp.words.push(' ')
          pp.requiredBreaks.push(false)
        }
      }

      // Append words. requiredBreaks has length words.length+1 (with a
      // leading false). When concatenating, drop the leading false on
      // every segment after the first so the global array stays aligned.
      for (let wi = 0; wi < pp.words.length; wi++) {
        words.push(pp.words[wi])
        wordSegmentIndex.push(si)
      }
      if (requiredBreaks.length === 0) {
        requiredBreaks.push(...pp.requiredBreaks)
      } else {
        for (let wi = 1; wi < pp.requiredBreaks.length; wi++) {
          requiredBreaks.push(pp.requiredBreaks[wi])
        }
      }
      processedContent += pp.processedContent
      if (pp.words.length > 0) {
        lastWordEndsWithSpace = /\s$/.test(pp.words[pp.words.length - 1])
      }
    }
    // Use the first segment's preprocess result for shared flags. For the
    // common case all spans inherit from the parent so these values are
    // identical across segments.
    allowSoftWrap = firstPP ? firstPP.allowSoftWrap : true
    allowBreakWord = firstPP ? firstPP.allowBreakWord : false
    shouldCollapseTabsAndSpaces = firstPP
      ? firstPP.shouldCollapseTabsAndSpaces
      : true
    lineLimit = firstPP ? firstPP.lineLimit : Infinity
    blockEllipsis = firstPP ? firstPP.blockEllipsis : undefined
  } else {
    const pp = preprocess(rawContent, parentStyle, locale)
    words = pp.words
    requiredBreaks = pp.requiredBreaks
    allowSoftWrap = pp.allowSoftWrap
    allowBreakWord = pp.allowBreakWord
    processedContent = pp.processedContent
    shouldCollapseTabsAndSpaces = pp.shouldCollapseTabsAndSpaces
    lineLimit = pp.lineLimit
    blockEllipsis = pp.blockEllipsis
    for (let i = 0; i < words.length; i++) wordSegmentIndex.push(0)
  }

  const textContainer = createTextContainerNode(Yoga, textAlign)
  parent.insertChild(textContainer, parent.getChildCount())

  if (isUndefined(flexShrink)) {
    parent.setFlexShrink(1)
  }

  // Resolve a font engine for a given segment. For the string path there is
  // a single engine. For the segment path we cache by style key so segments
  // that share the same {fontFamily, fontWeight, fontStyle, fontSize} share
  // an engine instance.
  const engineCache = new Map<string, FontEngine>()
  const segmentStyles: any[] = inlineSegments
    ? inlineSegments.map((s) => s.style)
    : [parentStyle]
  function getEngineFor(segIndex: number): FontEngine {
    const sStyle = segmentStyles[segIndex] || parentStyle
    const key = `${sStyle.fontFamily}|${sStyle.fontWeight}|${sStyle.fontStyle}|${sStyle.fontSize}|${sStyle.lineHeight}`
    let e = engineCache.get(key)
    if (!e) {
      e = font.getEngine(
        sStyle.fontSize || fontSize,
        sStyle.lineHeight || lineHeight,
        sStyle,
        locale
      )
      engineCache.set(key, e)
    }
    return e
  }

  // Get the correct font according to the container style.
  // https://www.w3.org/TR/CSS2/visudet.html
  let engine = font.getEngine(fontSize, lineHeight, parentStyle, locale)

  // Yield segments that are missing a font. For the segment path we check
  // each segment with its own engine so font fallback is correctly scoped.
  const wordsMissingFont: string[] = canLoadAdditionalAssets
    ? (() => {
        if (inlineSegments) {
          const out: string[] = []
          for (let si = 0; si < inlineSegments.length; si++) {
            const segText = inlineSegments[si].text
            const segEngine = getEngineFor(si)
            for (const w of segment(segText, 'grapheme')) {
              if (!shouldSkipWhenFindingMissingFont(w) && !segEngine.has(w)) {
                out.push(w)
              }
            }
          }
          return out
        }
        return segment(processedContent, 'grapheme').filter(
          (word) => !shouldSkipWhenFindingMissingFont(word) && !engine.has(word)
        )
      })()
    : []

  yield wordsMissingFont.map((word) => {
    return {
      word,
      locale,
    }
  })

  if (wordsMissingFont.length) {
    // Reload the engine(s) with additional fonts.
    engine = font.getEngine(fontSize, lineHeight, parentStyle, locale)
    engineCache.clear()
  }

  function isImage(s: string): boolean {
    return !!(graphemeImages && graphemeImages[s])
  }

  const { measureGrapheme, measureGraphemeArray, measureText } = genMeasurer(
    engine,
    isImage,
    {
      fontSize,
      letterSpacing,
    }
  )

  // Per-segment measurers for the inline-segment path. Each entry uses the
  // segment's own engine + fontSize + letterSpacing so widths reflect the
  // span's style. For the string path this map is unused.
  type Measurer = ReturnType<typeof genMeasurer>
  const measurerCache = new Map<number, Measurer>()
  function getMeasurerFor(segIndex: number): Measurer {
    let m = measurerCache.get(segIndex)
    if (m) return m
    if (!inlineSegments) {
      measurerCache.set(segIndex, {
        measureGrapheme,
        measureGraphemeArray,
        measureText,
      })
      return measurerCache.get(segIndex)!
    }
    const sStyle = segmentStyles[segIndex] || parentStyle
    const segEngine = getEngineFor(segIndex)
    m = genMeasurer(segEngine, isImage, {
      fontSize: sStyle.fontSize || fontSize,
      letterSpacing:
        sStyle.letterSpacing !== undefined
          ? sStyle.letterSpacing
          : letterSpacing,
    })
    measurerCache.set(segIndex, m)
    return m
  }

  const tabWidth = isString(tabSize)
    ? lengthToNumber(tabSize, fontSize, 1, parentStyle)
    : measureGrapheme(Space) * tabSize

  const calc = (
    text: string,
    currentWidth: number,
    segIndex = 0
  ): {
    originWidth: number
    endingSpacesWidth: number
    text: string
  } => {
    if (text.length === 0) {
      return {
        originWidth: 0,
        endingSpacesWidth: 0,
        text,
      }
    }

    const { measureText: m } = inlineSegments
      ? getMeasurerFor(segIndex)
      : { measureText }

    const { index, tabCount } = detectTabs(text)

    let originWidth = 0

    if (tabCount > 0) {
      const textBeforeTab = text.slice(0, index)
      const textAfterTab = text.slice(index + tabCount)
      const textWidthBeforeTab = m(textBeforeTab)
      const offsetBeforeTab = textWidthBeforeTab + currentWidth
      const tabMoveDistance =
        tabWidth === 0
          ? textWidthBeforeTab
          : (Math.floor(offsetBeforeTab / tabWidth) + tabCount) * tabWidth
      originWidth = tabMoveDistance + m(textAfterTab)
    } else {
      originWidth = m(text)
    }

    const afterTrimEndWidth =
      text.trimEnd() === text ? originWidth : m(text.trimEnd())

    return {
      originWidth,
      endingSpacesWidth: originWidth - afterTrimEndWidth,
      text,
    }
  }

  // Global variables used to compute the text layout.
  // @TODO: Use segments instead of words to properly support kerning.
  let lineWidths = []
  let baselines = []
  let lineSegmentNumber = []
  let texts: string[] = []
  // Per-emitted-text segment index. Mirrors `texts[]` and
  // `wordPositionInLayout[]` length-wise so the emission loop can look up
  // each piece's owning inline segment.
  let textSegments: number[] = []
  let wordPositionInLayout: (null | {
    x: number
    y: number
    width: number
    line: number
    lineIndex: number
    isImage: boolean
  })[] = []

  // With the given container width, compute the text layout.
  function flow(width: number) {
    let lines = 0
    let maxWidth = 0
    let lineIndex = -1
    let height = 0
    let currentWidth = 0
    let currentLineHeight = 0
    let currentBaselineOffset = 0

    lineWidths = []
    lineSegmentNumber = [0]
    texts = []
    textSegments = []
    wordPositionInLayout = []

    // We naively implement the width calculation without proper kerning.
    // @TODO: Support different writing modes.
    // @TODO: Support RTL languages.
    let i = 0
    let prevLineEndingSpacesWidth = 0
    while (i < words.length && lines < lineLimit) {
      let word = words[i]
      const forceBreak = requiredBreaks[i]
      const segIdx = wordSegmentIndex[i] ?? 0
      const wordEngine = inlineSegments ? getEngineFor(segIdx) : engine
      const wordMeasurer = inlineSegments
        ? getMeasurerFor(segIdx)
        : { measureGrapheme, measureText }

      let w = 0

      const {
        originWidth,
        endingSpacesWidth,
        text: _word,
      } = calc(word, currentWidth, segIdx)
      word = _word

      w = originWidth
      const lineEndingSpacesWidth = endingSpacesWidth

      // When starting a new line from an empty line, we should push one extra
      // line height.
      if (forceBreak && currentLineHeight === 0) {
        currentLineHeight = wordEngine.height(word)
      }

      const allowedToJustify = textAlign === 'justify'

      const willWrap =
        i &&
        // When determining whether a line break is necessary, the width of the
        // trailing spaces is not included in the calculation, as the end boundary
        // can be closely adjacent to the last non-space character.
        // e.g.
        // 'aaa bbb ccc'
        // When the break line happens at the end of the `bbb`, what we see looks like this
        // |aaa bbb|
        // |ccc    |
        currentWidth + w > width + lineEndingSpacesWidth &&
        allowSoftWrap

      // Need to break the word if:
      // - we have break-word
      // - the word is wider than the container width
      // - the word will be put at the beginning of the line
      const needToBreakWord =
        allowBreakWord && w > width && (!currentWidth || willWrap || forceBreak)

      if (needToBreakWord) {
        // Break the word into multiple segments and continue the loop.
        const chars = segment(word, 'grapheme')
        words.splice(i, 1, ...chars)
        // Replicate the segment-index entry so each new char keeps its
        // owning inline segment.
        wordSegmentIndex.splice(i, 1, ...new Array(chars.length).fill(segIdx))
        if (currentWidth > 0) {
          // Start a new line, spaces can be ignored.
          lineWidths.push(currentWidth - prevLineEndingSpacesWidth)
          baselines.push(currentBaselineOffset)
          lines++
          height += currentLineHeight
          currentWidth = 0
          currentLineHeight = 0
          currentBaselineOffset = 0
          lineSegmentNumber.push(1)
          lineIndex = -1
        }
        prevLineEndingSpacesWidth = lineEndingSpacesWidth
        continue
      }
      if (forceBreak || willWrap) {
        // Start a new line, spaces can be ignored.
        if (shouldCollapseTabsAndSpaces && word === Space) {
          w = 0
        }

        lineWidths.push(currentWidth - prevLineEndingSpacesWidth)
        baselines.push(currentBaselineOffset)
        lines++
        height += currentLineHeight
        currentWidth = w
        currentLineHeight = w ? Math.round(wordEngine.height(word)) : 0
        currentBaselineOffset = w ? Math.round(wordEngine.baseline(word)) : 0
        lineSegmentNumber.push(1)
        lineIndex = -1

        // If it's naturally broken, we update the max width.
        // Since if there are multiple lines, the width should fit the
        // container.
        if (!forceBreak) {
          maxWidth = Math.max(maxWidth, width)
        }
      } else {
        // It fits into the current line.
        currentWidth += w
        const glyphHeight = Math.round(wordEngine.height(word))
        if (glyphHeight > currentLineHeight) {
          // Use the baseline of the highest segment as the baseline of the line.
          currentLineHeight = glyphHeight
          currentBaselineOffset = Math.round(wordEngine.baseline(word))
        }
        if (allowedToJustify) {
          lineSegmentNumber[lineSegmentNumber.length - 1]++
        }
      }

      if (allowedToJustify) {
        lineIndex++
      }

      maxWidth = Math.max(maxWidth, currentWidth)

      let x = currentWidth - w

      if (w === 0) {
        wordPositionInLayout.push({
          y: height,
          x,
          width: 0,
          line: lines,
          lineIndex,
          isImage: false,
        })
      } else {
        const _texts = segment(word, 'word')
        const segFontSize = inlineSegments
          ? segmentStyles[segIdx]?.fontSize ?? fontSize
          : fontSize

        for (let j = 0; j < _texts.length; j++) {
          const _text = _texts[j]
          let _width = 0
          let _isImage = false

          if (isImage(_text)) {
            _width = segFontSize
            _isImage = true
          } else if (!embedFont && _text.length > 1) {
            // When embedFont is false, use measureText for multi-character strings
            // to ensure consistency with how currentWidth is accumulated (sum of
            // grapheme widths). measureGrapheme uses getAdvanceWidth which includes
            // kerning, causing position mismatches between consecutive <text> elements.
            _width = wordMeasurer.measureText(_text)
          } else {
            _width = wordMeasurer.measureGrapheme(_text)
          }

          texts.push(_text)
          textSegments.push(segIdx)
          wordPositionInLayout.push({
            y: height,
            x,
            width: _width,
            line: lines,
            lineIndex,
            isImage: _isImage,
          })

          x += _width
        }
      }

      i++
      prevLineEndingSpacesWidth = lineEndingSpacesWidth
    }

    if (currentWidth) {
      if (lines < lineLimit) {
        height += currentLineHeight
      }
      lines++
      lineWidths.push(currentWidth)
      baselines.push(currentBaselineOffset)
    }

    // @TODO: Support `line-height`.
    return { width: maxWidth, height }
  }

  // It's possible that the text's measured size is different from the container's
  // size, because the container might have a fixed width or height or being
  // expanded by its parent.
  let measuredTextSize = { width: 0, height: 0 }
  textContainer.setMeasureFunc((containerWidth) => {
    const { width, height } = flow(containerWidth)

    // When doing `text-wrap: balance`, we reflow the text multiple times
    // using binary search to find the best width.
    // https://www.w3.org/TR/css-text-4/#valdef-text-wrap-balance
    if (textWrap === 'balance') {
      let l = width / 2
      let r = width
      let m: number = width
      while (l + 1 < r) {
        m = (l + r) / 2
        const { height: mHeight } = flow(m)
        if (mHeight > height) {
          l = m
        } else {
          r = m
        }
      }
      flow(r)
      const _width = Math.ceil(r)
      measuredTextSize = { width: _width, height }
      return { width: _width, height }
    }

    // When doing `text-wrap: pretty`, we try to avoid ending a paragraph with a single word
    // by reshaping all lines in a way that achieves more balanced line lengths
    // This "pretty" line breaking algorithm tries to achieve optimal line breaks
    // that avoid orphans (single words at the end of a paragraph) and create
    // visually pleasing line lengths.
    if (textWrap === 'pretty') {
      // Check if the last line has a single word or is very short
      // (typically less than 1/3 of the container width)
      const lastLineWidth = lineWidths[lineWidths.length - 1]
      const isLastLineShort = lastLineWidth < width / 3

      if (isLastLineShort) {
        // Reflow the paragraph with slightly adjusted line breaks
        // to avoid orphans and create more even line lengths
        // This is a simplified approach - a real implementation would use a
        // more sophisticated algorithm to find optimal line breaks

        // We'll just reflow once with slightly reduced width to force
        // redistribution of words. This is much simplified from the actual
        // paragraph-level line breaking algorithm which would compute scores
        // for different line break combinations.
        const adjustedWidth = width * 0.9
        const result = flow(adjustedWidth)

        // Use the result if it reduces orphans without adding too many lines
        if (result.height <= height * 1.3) {
          measuredTextSize = { width, height: result.height }
          return { width, height: result.height }
        }
      }
    }

    const _width = Math.ceil(width)
    measuredTextSize = { width: _width, height }
    // This may be a temporary fix, I didn't dig deep into yoga.
    // But when the return value of width here doesn't change (assuming the value of width is 216.9),
    // when we later get the width through `parent.getComputedWidth()`, sometimes it returns 216 and sometimes 217.
    // I'm not sure if this is a yoga bug, but it seems related to the entire page width.
    // So I use Math.ceil.
    return { width: _width, height }
  })

  const [x, y] = yield

  let result = ''
  // Per-word `<text>` emissions accumulate here when embedFont is false.
  // They are kept separate from `result` so the span paint pass (bg/border
  // rects) can be inserted BEFORE them in document order — otherwise the
  // rects paint on top of the text in the !embedFont path.
  let textEmissions = ''
  let backgroundClipDef = ''

  const clipPathId = inheritedStyle._inheritedClipPathId as string | undefined
  const overflowMaskId = inheritedStyle._inheritedMaskId as number | undefined

  const {
    left: containerLeft,
    top: containerTop,
    width: containerWidth,
    height: containerHeight,
  } = textContainer.getComputedLayout()

  // Convert textIndent to number if it's a string (e.g., percentage)
  const textIndentNumber =
    typeof textIndent === 'string'
      ? lengthToNumber(
          textIndent,
          fontSize,
          containerWidth,
          parentStyle,
          true
        ) || 0
      : textIndent

  const parentContainerInnerWidth =
    parent.getComputedWidth() -
    parent.getComputedPadding(Yoga.EDGE_LEFT) -
    parent.getComputedPadding(Yoga.EDGE_RIGHT) -
    parent.getComputedBorder(Yoga.EDGE_LEFT) -
    parent.getComputedBorder(Yoga.EDGE_RIGHT)

  // Attach offset to the current node.
  const left = x + containerLeft
  const top = y + containerTop

  const { matrix, opacity } = container(
    {
      left: containerLeft,
      top: containerTop,
      width: containerWidth,
      height: containerHeight,
      isInheritingTransform,
    },
    parentStyle
  )

  let filter = ''
  if (parentStyle.textShadowOffset) {
    const { textShadowColor, textShadowOffset, textShadowRadius } = parentStyle

    filter = buildDropShadow(
      {
        width: measuredTextSize.width,
        height: measuredTextSize.height,
        id,
      },
      {
        shadowColor: textShadowColor,
        shadowOffset: textShadowOffset,
        shadowRadius: textShadowRadius,
      },
      isFullyTransparent(parentStyle.color) ||
        (_inheritedBackgroundClipTextHasBackground &&
          isOpaqueWhite(parentStyle.color))
    )

    filter = buildXMLString('defs', {}, filter)
  }

  let decorationShape = ''
  let mergedPath = ''
  let extra = ''
  let skippedLine = -1
  type DecorationLine = {
    left: number
    top: number
    ascender: number
    width: number
  }
  let decorationLines: Record<number, DecorationLine | null> = {}
  let decorationGlyphs: Record<number, GlyphBox[]> = {}
  let wordBuffer: string | null = null
  let bufferedOffset = 0
  let bufferedSegIdx = 0

  // Path fragments grouped by style key so paths with different fill/stroke
  // emit as separate <path> elements. For the string path there is one
  // fragment with parent style. For inline segments we add one fragment
  // per distinct color/stroke combination.
  type PathFragment = { style: any; path: string }
  const pathFragments = new Map<string, PathFragment>()
  const styleKey = (s: any) =>
    `${s.color || ''}|${s.WebkitTextStrokeWidth || ''}|${
      s.WebkitTextStrokeColor || ''
    }`
  const appendPath = (segIdx: number, p: string) => {
    const sStyle = (inlineSegments && segmentStyles[segIdx]) || parentStyle
    const k = styleKey(sStyle)
    let entry = pathFragments.get(k)
    if (!entry) {
      entry = { style: sStyle, path: '' }
      pathFragments.set(k, entry)
    }
    entry.path += p + ' '
    // Keep mergedPath for background-clip: text and the "any path was
    // produced" check. It contains every segment's path concatenated.
    mergedPath += p + ' '
  }
  // Per-line-and-span word position tracking, used by the span paint pass to
  // emit per-line bg/border rects.
  type SpanWordEntry = {
    line: number
    leftOffset: number
    rightOffset: number
    topOffset: number
    height: number
    baselineDelta: number
    baselineOfWord: number
  }
  const spanWordEntries: Map<string, SpanWordEntry[]> = new Map()
  const recordSpanWord = (
    segIdx: number,
    leftOffset: number,
    rightOffset: number,
    topOffset: number,
    heightOfWord: number,
    baselineDelta: number,
    baselineOfWord: number,
    line: number
  ) => {
    if (!inlineSegments) return
    const seg = inlineSegments[segIdx]
    if (!seg) return
    for (const span of seg.spans) {
      let arr = spanWordEntries.get(span.id)
      if (!arr) {
        arr = []
        spanWordEntries.set(span.id, arr)
      }
      arr.push({
        line,
        leftOffset,
        rightOffset,
        topOffset,
        height: heightOfWord,
        baselineDelta,
        baselineOfWord,
      })
    }
  }

  for (let i = 0; i < texts.length; i++) {
    // Skip whitespace and empty characters.
    const layout = wordPositionInLayout[i]
    const nextLayout = wordPositionInLayout[i + 1]

    if (!layout) continue

    let text = texts[i]
    const wordSegIdx = textSegments[i] ?? 0
    const wordSegStyle =
      (inlineSegments && segmentStyles[wordSegIdx]) || parentStyle
    const wordEngineEmit = inlineSegments ? getEngineFor(wordSegIdx) : engine
    const wordFontSize = inlineSegments
      ? wordSegStyle.fontSize ?? fontSize
      : fontSize
    const wordLetterSpacing = inlineSegments
      ? wordSegStyle.letterSpacing !== undefined
        ? wordSegStyle.letterSpacing
        : letterSpacing
      : letterSpacing
    let path: string | null = null
    let isLastDisplayedBeforeEllipsis = false

    const image = graphemeImages ? graphemeImages[text] : null

    let topOffset = layout.y
    const lineTopOffset = layout.y
    let leftOffset = layout.x
    const width = layout.width
    const line = layout.line
    const shouldCollectDecorationBoxes =
      parentStyle.textDecorationLine === 'underline' &&
      (parentStyle.textDecorationSkipInk || 'auto') !== 'none'

    if (line === skippedLine) {
      continue
    }

    // When `text-align` is `justify`, the width of the line will be adjusted.
    let extendedWidth = false

    // Apply text-indent to the first line (for both single and multi-line text)
    if (line === 0 && textIndentNumber !== 0) {
      leftOffset += textIndentNumber
    }

    if (lineWidths.length > 1) {
      // Calculate alignment. Note that for Flexbox, there is only text
      // alignment when the container is multi-line.
      const remainingWidth = containerWidth - lineWidths[line]
      if (textAlign === 'right' || textAlign === 'end') {
        leftOffset += remainingWidth
      } else if (textAlign === 'center') {
        leftOffset += remainingWidth / 2
      } else if (textAlign === 'justify') {
        // Don't justify the last line.
        if (line < lineWidths.length - 1) {
          const segments = lineSegmentNumber[line]
          const gutter = segments > 1 ? remainingWidth / (segments - 1) : 0
          leftOffset += gutter * layout.lineIndex
          extendedWidth = true
        }
      }

      // Only round for embedded fonts (paths benefit from pixel alignment).
      // For non-embedded fonts (<text> elements), keep fractional positions
      // to maintain consistent spacing between consecutive elements.
      if (embedFont) {
        leftOffset = Math.round(leftOffset)
      }
    }

    const baselineOfLine = baselines[line]
    const baselineOfWord = wordEngineEmit.baseline(text)
    const heightOfWord = wordEngineEmit.height(text)
    const baselineDelta = baselineOfLine - baselineOfWord

    const buildUnderlineBand = (offset: number) => {
      if (
        !shouldCollectDecorationBoxes ||
        parentStyle.textDecorationLine !== 'underline'
      ) {
        return undefined
      }
      const baseline = top + offset + baselineDelta + baselineOfWord
      return {
        underlineY: baseline + baselineOfWord * 0.1,
        strokeWidth: Math.max(1, wordFontSize * 0.1),
      }
    }

    if (!decorationLines[line]) {
      decorationLines[line] = {
        left: leftOffset,
        top: top + topOffset + baselineDelta,
        ascender: baselineOfWord,
        width: extendedWidth ? containerWidth : lineWidths[line],
      }
    }

    if (lineLimit !== Infinity) {
      let _blockEllipsis = blockEllipsis
      let ellipsisWidth = measureGrapheme(blockEllipsis)
      if (ellipsisWidth > parentContainerInnerWidth) {
        _blockEllipsis = HorizontalEllipsis
        ellipsisWidth = measureGrapheme(_blockEllipsis)
      }
      const spaceWidth = measureGrapheme(Space)
      const isNotLastLine = line < lineWidths.length - 1
      const isLastAllowedLine = line + 1 === lineLimit

      function calcEllipsis(baseWidth: number, _text: string) {
        const chars = segment(_text, 'grapheme', locale)

        let subset = ''
        let resolvedWidth = 0

        for (const char of chars) {
          const w = baseWidth + measureGraphemeArray([subset + char])
          if (
            // Keep at least one character:
            // > The first character or atomic inline-level element on a line
            // must be clipped rather than ellipsed.
            // https://drafts.csswg.org/css-overflow/#text-overflow
            subset &&
            w + ellipsisWidth > parentContainerInnerWidth
          ) {
            break
          }
          subset += char
          resolvedWidth = w
        }

        return {
          subset,
          resolvedWidth,
        }
      }

      if (
        isLastAllowedLine &&
        (isNotLastLine || lineWidths[line] > parentContainerInnerWidth)
      ) {
        if (
          leftOffset + width + ellipsisWidth + spaceWidth >
          parentContainerInnerWidth
        ) {
          const { subset, resolvedWidth } = calcEllipsis(leftOffset, text)

          text = subset + _blockEllipsis
          skippedLine = line
          decorationLines[line].width = Math.max(
            0,
            resolvedWidth - decorationLines[line].left
          )
          isLastDisplayedBeforeEllipsis = true
        } else if (nextLayout && nextLayout.line !== line) {
          if (textAlign === 'center') {
            const { subset, resolvedWidth } = calcEllipsis(leftOffset, text)

            text = subset + _blockEllipsis
            skippedLine = line
            decorationLines[line].width = Math.max(
              0,
              resolvedWidth - decorationLines[line].left
            )
            isLastDisplayedBeforeEllipsis = true
          } else {
            const nextLineText = texts[i + 1]

            const { subset, resolvedWidth } = calcEllipsis(
              width + leftOffset,
              nextLineText
            )

            text = text + subset + _blockEllipsis
            skippedLine = line
            decorationLines[line].width = Math.max(
              0,
              resolvedWidth - decorationLines[line].left
            )
            isLastDisplayedBeforeEllipsis = true
          }
        }
      }
    }

    // Record this word's geometry for the span paint pass. This must run
    // BEFORE the embedFont kerning-buffer branch — otherwise words that get
    // merged into a buffer hit `continue` and never get recorded, which
    // causes the span's per-line bg rect to only cover the last word of
    // each kerning run instead of the full span.
    recordSpanWord(
      wordSegIdx,
      leftOffset,
      leftOffset + width,
      lineTopOffset,
      heightOfWord,
      baselineDelta,
      baselineOfWord,
      line
    )

    if (image) {
      // For images, we remove the baseline offset.
      topOffset += 0
    } else if (embedFont) {
      // If the current word and the next word are on the same line AND share
      // the same inline segment style, we try to merge them together to
      // better handle the kerning. When the next word belongs to a different
      // segment we must flush the buffer so each style emits its own path
      // with the correct color/font.
      const nextSegIdx = textSegments[i + 1] ?? 0
      const sameSegmentAsNext = nextSegIdx === wordSegIdx
      if (
        !text.includes(Tab) &&
        !wordSeparators.includes(text) &&
        texts[i + 1] &&
        nextLayout &&
        !nextLayout.isImage &&
        topOffset === nextLayout.y &&
        !isLastDisplayedBeforeEllipsis &&
        sameSegmentAsNext
      ) {
        if (wordBuffer === null) {
          bufferedOffset = leftOffset
          bufferedSegIdx = wordSegIdx
        }
        wordBuffer = wordBuffer === null ? text : wordBuffer + text
        continue
      }

      const finalizedSegment = wordBuffer === null ? text : wordBuffer + text
      const finalizedLeftOffset =
        wordBuffer === null ? leftOffset : bufferedOffset
      const finalizedWidth = layout.width + leftOffset - finalizedLeftOffset

      const band = buildUnderlineBand(topOffset)

      const svg = wordEngineEmit.getSVG(
        finalizedSegment.replace(/(\t)+/g, ''),
        {
          fontSize: wordFontSize,
          left: left + finalizedLeftOffset,
          // Since we need to pass the baseline position, add the ascender to the top.
          top: top + topOffset + baselineOfWord + baselineDelta,
          letterSpacing: wordLetterSpacing,
        },
        band
      )

      path = svg.path

      if (shouldCollectDecorationBoxes && svg.boxes && svg.boxes.length) {
        ;(decorationGlyphs[line] || (decorationGlyphs[line] = [])).push(
          ...svg.boxes
        )
      }

      wordBuffer = null

      if (debug) {
        extra +=
          // Glyph
          buildXMLString('rect', {
            x: left + finalizedLeftOffset,
            y: top + topOffset + baselineDelta,
            width: finalizedWidth,
            height: heightOfWord,
            fill: 'transparent',
            stroke: '#575eff',
            'stroke-width': 1,
            transform: matrix ? matrix : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
          }) +
          // Baseline
          buildXMLString('line', {
            x1: left + leftOffset,
            x2: left + leftOffset + layout.width,
            y1: top + topOffset + baselineDelta + baselineOfWord,
            y2: top + topOffset + baselineDelta + baselineOfWord,
            stroke: '#14c000',
            'stroke-width': 1,
            transform: matrix ? matrix : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
          })
      }
    } else {
      // We need manually add the font ascender height to ensure it starts
      // at the baseline because <text>'s alignment baseline is set to `hanging`
      // by default and supported to change in SVG 1.1.
      topOffset += baselineOfWord + baselineDelta

      if (shouldCollectDecorationBoxes && !image) {
        const band = buildUnderlineBand(topOffset)

        const svg = wordEngineEmit.getSVG(
          text.replace(/(\t)+/g, ''),
          {
            fontSize: wordFontSize,
            left: left + leftOffset,
            top: top + topOffset,
            letterSpacing: wordLetterSpacing,
          },
          band
        )

        if (svg.boxes && svg.boxes.length) {
          ;(decorationGlyphs[line] || (decorationGlyphs[line] = [])).push(
            ...svg.boxes
          )
        }
      }
    }

    if (path !== null) {
      // Group by segment style so paths with different colors render as
      // separate <path> elements at the end. The segment index here is the
      // buffered segment for this flush (set when the buffer started) or
      // this word's segment if there was no buffer.
      const flushSegIdx = wordBuffer === null ? wordSegIdx : bufferedSegIdx
      appendPath(flushSegIdx, path)
    } else {
      const [t, shape] = buildText(
        {
          content: text,
          filter,
          id,
          left: left + leftOffset,
          top: top + topOffset,
          width,
          height: heightOfWord,
          matrix,
          opacity,
          image,
          clipPathId,
          debug,
          shape: !!_inheritedBackgroundClipTextPath,
        },
        // Use the segment's own style when rendering as <text> so font and
        // color attributes match the inline span.
        wordSegStyle
      )
      textEmissions += t
      backgroundClipDef += shape
    }

    if (isLastDisplayedBeforeEllipsis) {
      break
    }
  }

  if (parentStyle.textDecorationLine) {
    decorationShape = Object.entries(decorationLines)
      .map(([lineIndex, deco]) => {
        if (!deco) return ''
        const glyphBoxes = decorationGlyphs[lineIndex] || []

        return buildDecoration(
          {
            left: left + deco.left,
            top: deco.top,
            width: deco.width,
            ascender: deco.ascender,
            clipPathId,
            matrix,
            glyphBoxes,
          },
          parentStyle
        )
      })
      .join('')
  }

  // Span paint pass: emit per-line bg/border rects for each inline span.
  // Padding inflates the rect outwards (visual only — does not affect
  // layout). Border draws on the inflated rect's edges.
  let spanPaint = ''
  if (inlineSegments && inlineSpans.length > 0) {
    for (const span of inlineSpans) {
      const entries = spanWordEntries.get(span.id)
      if (!entries || entries.length === 0) continue
      const sStyle: any = span.style
      const hasBg =
        sStyle.backgroundColor &&
        sStyle.backgroundColor !== 'transparent' &&
        !isFullyTransparent(sStyle.backgroundColor)
      const borderTopWidth = sStyle.borderTopWidth || 0
      const borderRightWidth = sStyle.borderRightWidth || 0
      const borderBottomWidth = sStyle.borderBottomWidth || 0
      const borderLeftWidth = sStyle.borderLeftWidth || 0
      const hasBorder =
        borderTopWidth ||
        borderRightWidth ||
        borderBottomWidth ||
        borderLeftWidth
      if (!hasBg && !hasBorder) continue

      const padTop = sStyle.paddingTop || 0
      const padRight = sStyle.paddingRight || 0
      const padBottom = sStyle.paddingBottom || 0
      const padLeft = sStyle.paddingLeft || 0

      // Group entries by line.
      const byLine: Record<number, SpanWordEntry[]> = {}
      for (const entry of entries) {
        ;(byLine[entry.line] || (byLine[entry.line] = [])).push(entry)
      }

      for (const lineKey in byLine) {
        const lineEntries = byLine[lineKey]
        let minLeft = Infinity
        let maxRight = -Infinity
        let lineTop = Infinity
        let maxHeight = 0
        for (const e of lineEntries) {
          if (e.leftOffset < minLeft) minLeft = e.leftOffset
          if (e.rightOffset > maxRight) maxRight = e.rightOffset
          if (e.topOffset < lineTop) lineTop = e.topOffset
          if (e.height > maxHeight) maxHeight = e.height
        }
        const rectLeft = left + minLeft - padLeft
        const rectTop = top + lineTop - padTop
        const rectWidth = maxRight - minLeft + padLeft + padRight
        const rectHeight = maxHeight + padTop + padBottom

        const rPath = radius(
          {
            left: rectLeft,
            top: rectTop,
            width: rectWidth,
            height: rectHeight,
          },
          sStyle as Record<string, number>
        )

        if (hasBg) {
          spanPaint += buildXMLString(rPath ? 'path' : 'rect', {
            x: rPath ? undefined : rectLeft,
            y: rPath ? undefined : rectTop,
            width: rPath ? undefined : rectWidth,
            height: rPath ? undefined : rectHeight,
            d: rPath || undefined,
            fill: sStyle.backgroundColor,
            transform: matrix ? matrix : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
          })
        }

        if (hasBorder) {
          // Inline span borders are rendered as a single stroked rect.
          // Per-side widths/colors are intentionally collapsed to the top
          // border's values for determinism and simplicity — see the inline
          // tradeoff noted in this module's header comment.
          const strokeColor = sStyle.borderTopColor || sStyle.color
          const strokeWidth =
            borderTopWidth ||
            borderRightWidth ||
            borderBottomWidth ||
            borderLeftWidth
          spanPaint += buildXMLString(rPath ? 'path' : 'rect', {
            x: rPath ? undefined : rectLeft,
            y: rPath ? undefined : rectTop,
            width: rPath ? undefined : rectWidth,
            height: rPath ? undefined : rectHeight,
            d: rPath || undefined,
            fill: 'none',
            stroke: strokeColor,
            'stroke-width': strokeWidth,
            transform: matrix ? matrix : undefined,
            'clip-path': clipPathId ? `url(#${clipPathId})` : undefined,
          })
        }
      }
    }
  }

  // Emit the path fragments. For the string path there is exactly one
  // fragment using parent style; for the segment path there is one fragment
  // per distinct color/stroke combination.
  let pathsMarkup = ''
  if (mergedPath) {
    const fragments =
      pathFragments.size > 0
        ? Array.from(pathFragments.values())
        : [{ style: parentStyle, path: mergedPath }]

    for (const frag of fragments) {
      const fStyle: any = frag.style
      const fColor = fStyle.color
      const fStrokeWidth =
        fStyle.WebkitTextStrokeWidth || inheritedStyle.WebkitTextStrokeWidth
      const fStrokeColor =
        fStyle.WebkitTextStrokeColor || inheritedStyle.WebkitTextStrokeColor

      const p =
        (!isFullyTransparent(fColor) || filter) && opacity !== 0
          ? `<g ${overflowMaskId ? `mask="url(#${overflowMaskId})"` : ''} ${
              clipPathId ? `clip-path="url(#${clipPathId})"` : ''
            }>` +
            buildXMLString('path', {
              fill:
                filter &&
                (isFullyTransparent(fColor) ||
                  (_inheritedBackgroundClipTextHasBackground &&
                    isOpaqueWhite(fColor)))
                  ? 'black'
                  : fColor,
              d: frag.path,
              transform: matrix ? matrix : undefined,
              opacity: opacity !== 1 ? opacity : undefined,
              style: cssFilter ? `filter:${cssFilter}` : undefined,
              'stroke-width': fStrokeWidth ? `${fStrokeWidth}px` : undefined,
              stroke: fStrokeWidth ? fStrokeColor : undefined,
              'stroke-linejoin': fStrokeWidth ? 'round' : undefined,
              'paint-order': fStrokeWidth ? 'stroke' : undefined,
            }) +
            '</g>'
          : ''
      pathsMarkup += p
    }

    if (_inheritedBackgroundClipTextPath) {
      backgroundClipDef = buildXMLString('path', {
        d: mergedPath,
        transform: matrix ? matrix : undefined,
      })
    }

    // Prepend spanPaint so bg/border rects render UNDER the text paths.
    // textEmissions is empty in the embedFont path (paths go through
    // pathFragments instead), but we include it here for completeness.
    result =
      spanPaint +
      textEmissions +
      result +
      (filter
        ? filter +
          buildXMLString(
            'g',
            { filter: `url(#satori_s-${id})` },
            pathsMarkup + decorationShape
          )
        : pathsMarkup + decorationShape) +
      extra
  } else if (decorationShape) {
    result =
      spanPaint +
      textEmissions +
      result +
      (filter
        ? buildXMLString(
            'g',
            { filter: `url(#satori_s-${id})` },
            decorationShape
          )
        : decorationShape)
  } else {
    // No font paths and no decoration — emit span bg/border rects first
    // so they sit under any !embedFont <text> emissions.
    result = spanPaint + textEmissions + result
  }

  // Attach information to the parent node.
  if (backgroundClipDef) {
    ;(parentStyle._inheritedBackgroundClipTextPath as any).value +=
      backgroundClipDef
  }

  return result
}

function createTextContainerNode(Yoga: TYoga, textAlign: string): YogaNode {
  // Create a container node for this text fragment.
  const textContainer = Yoga.Node.create()
  textContainer.setAlignItems(Yoga.ALIGN_BASELINE)
  textContainer.setJustifyContent(
    v(
      textAlign,
      {
        left: Yoga.JUSTIFY_FLEX_START,
        right: Yoga.JUSTIFY_FLEX_END,
        center: Yoga.JUSTIFY_CENTER,
        justify: Yoga.JUSTIFY_SPACE_BETWEEN,
        // We don't have other writing modes yet.
        start: Yoga.JUSTIFY_FLEX_START,
        end: Yoga.JUSTIFY_FLEX_END,
      },
      Yoga.JUSTIFY_FLEX_START,
      'textAlign'
    )
  )

  return textContainer
}

function detectTabs(text: string):
  | {
      index: null
      tabCount: 0
    }
  | {
      index: number
      tabCount: number
    } {
  const result = /(\t)+/.exec(text)
  return result
    ? {
        index: result.index,
        tabCount: result[0].length,
      }
    : {
        index: null,
        tabCount: 0,
      }
}
