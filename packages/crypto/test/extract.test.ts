import { describe, expect, it } from 'vitest';
import { buildThreadLinks, canonicalSendStringV3, classify, extractLinks, htmlToText } from '../src';

// The API's inbound pipeline and the self-hosted kit share these functions: the behaviour below must not change.
describe('classify (moved from apps/api, behaviour unchanged)', () => {
  it.each([
    ['Your verification code', 'Your code is 123456. It expires in 10 minutes.', '123456'],
    ['Sign in', 'Use this one-time passcode: 4821', '4821'],
    ['Security code', 'Your security code is 123 456. Do not share it.', '123456'],
    ['Login code 998877', 'Hello', '998877'],
  ])('%s', (subject, body, otp) => {
    expect(classify(subject, body)).toEqual({ type: 'otp', otp });
  });

  it('plain conversation and long mail are not OTP', () => {
    expect(classify('Lunch?', 'Are you free at 12:30 tomorrow, room 4821?')).toEqual({ type: 'conversation' });
    expect(classify('verification code', `code is 123456 ${'x'.repeat(2100)}`)).toEqual({ type: 'conversation' });
  });

  it('does not take a longer number as a code', () => {
    expect(classify('verify', 'Your code is 123456789012')).toEqual({ type: 'conversation' });
  });
});

describe('extractLinks / htmlToText', () => {
  it('collects text and href links, trims trailing punctuation, dedupes, caps at 20', () => {
    expect(extractLinks('see https://a.example/x?y=1. and https://a.example/x?y=1', '<a href="https://b.example/z">b</a>')).toEqual([
      'https://b.example/z',
      'https://a.example/x?y=1',
    ]);
    const many = Array.from({ length: 30 }, (_, i) => `https://e.example/${i}`).join(' ');
    expect(extractLinks(many, null)).toHaveLength(20);
    expect(extractLinks(`https://e.example/${'a'.repeat(2100)}`, null)).toEqual([]);
  });

  it('htmlToText drops style/script and decodes the basic entities', () => {
    expect(htmlToText('<style>p{}</style><p>a &amp; b</p><script>x()</script><br>c&nbsp;d')).toBe('a & b\n\nc d');
  });
});

describe('buildThreadLinks', () => {
  it('answers the id, chains its references, drops junk', () => {
    expect(buildThreadLinks('<c@x>', ['<a@x>', '<b@x>', 'junk', '<a@x>'])).toEqual({ inReplyTo: '<c@x>', references: ['<a@x>', '<b@x>', '<c@x>'] });
    expect(buildThreadLinks('<c@x>', undefined)).toEqual({ inReplyTo: '<c@x>', references: ['<c@x>'] });
  });
  it('is null for an unusable id and trims long chains keeping root and newest', () => {
    expect(buildThreadLinks('no-brackets', [])).toBeNull();
    expect(buildThreadLinks('<a b@x>', [])).toBeNull();
    const refs = Array.from({ length: 40 }, (_, i) => `<r${i}@x>`);
    const t = buildThreadLinks('<last@x>', refs)!;
    expect(t.references.length).toBeLessThanOrEqual(20);
    expect(t.references[0]).toBe('<r0@x>');
    expect(t.references.at(-1)).toBe('<last@x>');
  });
});

describe('canonicalSendStringV3', () => {
  it('has the documented layout', () => {
    const s = canonicalSendStringV3({ ensName: 'a.b.eth', from: 'a@d.io', to: 'x@y.z', subject: 's', body: 'b', date: 'Fri, 06 Nov 2026 10:00:00 GMT', naniteMessageId: '<i@d.io>' });
    const l = s.split('\n');
    expect(l[0]).toBe('nanite-send-v3');
    expect(l).toHaveLength(8);
    expect(l[4]).toMatch(/^[0-9a-f]{64}$/);
    expect(l[7]).toBe('<i@d.io>');
  });
});
