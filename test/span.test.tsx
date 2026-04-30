import { it, describe, expect } from 'vitest'

import { initFonts, toImage } from './utils.js'
import satori from '../src/index.js'

describe('Span', () => {
  let fonts
  initFonts((f) => (fonts = f))

  it('should render an inline span with a different color', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 24,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        Hello <span style={{ color: '#e00' }}>red world</span>!
      </div>,
      { width: 200, height: 100, fonts, embedFont: true }
    )
    expect(toImage(svg, 200)).toMatchImageSnapshot()
  })

  it('should render multiple sibling spans on the same line', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        <span style={{ color: '#e00' }}>red</span>
        <span> </span>
        <span style={{ color: '#0c0' }}>green</span>
        <span> </span>
        <span style={{ color: '#06f' }}>blue</span>
      </div>,
      { width: 220, height: 80, fonts, embedFont: true }
    )
    expect(toImage(svg, 220)).toMatchImageSnapshot()
  })

  it('should support font-weight inside a span', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        normal <b>bold</b> normal
      </div>,
      { width: 250, height: 60, fonts, embedFont: true }
    )
    expect(toImage(svg, 250)).toMatchImageSnapshot()
  })

  it('should paint background-color on a span', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        plain <span style={{ backgroundColor: 'yellow' }}>highlighted</span>{' '}
        plain
      </div>,
      { width: 280, height: 60, fonts, embedFont: true }
    )
    expect(toImage(svg, 280)).toMatchImageSnapshot()
  })

  it('should emit one bg rect per line for a span that wraps', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        before{' '}
        <span style={{ backgroundColor: 'yellow' }}>
          this span wraps onto multiple lines deliberately
        </span>{' '}
        after
      </div>,
      { width: 200, height: 200, fonts, embedFont: true }
    )
    expect(toImage(svg, 200)).toMatchImageSnapshot()
  })

  it('should support nested spans', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        <span style={{ color: '#e00' }}>
          outer <span style={{ color: '#06f' }}>inner</span> outer
        </span>
      </div>,
      { width: 280, height: 60, fonts, embedFont: true }
    )
    expect(toImage(svg, 280)).toMatchImageSnapshot()
  })

  it('should paint padding and border on a span (paint-only)', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        a{' '}
        <span
          style={{
            backgroundColor: '#f0f0f0',
            borderTopWidth: 2,
            borderRightWidth: 2,
            borderBottomWidth: 2,
            borderLeftWidth: 2,
            borderTopColor: '#888',
            borderRightColor: '#888',
            borderBottomColor: '#888',
            borderLeftColor: '#888',
            paddingTop: 2,
            paddingRight: 4,
            paddingBottom: 2,
            paddingLeft: 4,
          }}
        >
          chip
        </span>{' '}
        b
      </div>,
      { width: 200, height: 60, fonts, embedFont: true }
    )
    expect(toImage(svg, 200)).toMatchImageSnapshot()
  })

  it('should not require display:flex on a div with text + span children', async () => {
    const svg = await satori(
      <div
        style={{
          width: '100%',
          height: '100%',
          fontSize: 22,
          color: 'black',
          background: 'white',
          padding: 10,
        }}
      >
        text <span>and a span</span>
      </div>,
      { width: 240, height: 60, fonts, embedFont: true }
    )
    expect(toImage(svg, 240)).toMatchImageSnapshot()
  })
})
