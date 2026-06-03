import { describe, expect, it } from 'vitest'

import { hostOf, overlapDuration, registrableDomain, round, sameSite, within } from './time.js'

describe('round', () => {
  it('rounds to integer ms by default', () => {
    expect(round(123.6)).toBe(124)
  })
  it('keeps decimals when asked', () => {
    expect(round(1.234, 1)).toBe(1.2)
  })
  it('returns undefined for non-finite', () => {
    expect(round(undefined)).toBeUndefined()
    expect(round(Infinity)).toBeUndefined()
  })
})

describe('hostOf', () => {
  it('lowercases the hostname', () => {
    expect(hostOf('https://WWW.Example.COM/path')).toBe('www.example.com')
  })
  it('returns empty for non-URLs (e.g. data:)', () => {
    expect(hostOf('data:image/png;base64,AAAA')).toBe('')
  })
})

describe('registrableDomain', () => {
  it('keeps a bare domain', () => {
    expect(registrableDomain('example.com')).toBe('example.com')
  })
  it('strips a subdomain', () => {
    expect(registrableDomain('static.files.example.com')).toBe('example.com')
  })
  it('handles two-level public suffixes', () => {
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(registrableDomain('a.b.example.co.jp')).toBe('example.co.jp')
  })
})

describe('sameSite', () => {
  it('treats subdomains as the same site', () => {
    expect(sameSite('img.example.com', 'www.example.com')).toBe(true)
  })
  it('separates different registrable domains', () => {
    expect(sameSite('cdn.other.com', 'www.example.com')).toBe(false)
  })
  it('is false for empty hosts', () => {
    expect(sameSite('', 'example.com')).toBe(false)
  })
})

describe('overlapDuration / within', () => {
  const w = { start: 0, end: 100 }
  it('clamps a straddling task to the window', () => {
    expect(overlapDuration(80, 160, w)).toBe(20)
    expect(overlapDuration(-50, 30, w)).toBe(30)
  })
  it('is zero when fully outside', () => {
    expect(overlapDuration(120, 130, w)).toBe(0)
  })
  it('within checks point membership (half-open)', () => {
    expect(within(0, w)).toBe(true)
    expect(within(100, w)).toBe(false)
  })
})
