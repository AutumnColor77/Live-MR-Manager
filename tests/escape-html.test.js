import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/js/utils.js';

describe('escapeHtml', () => {
  it('encodes HTML metacharacters for text and attributes', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
    expect(escapeHtml('"quoted" & \'apos\'')).toBe(
      '&quot;quoted&quot; &amp; &#39;apos&#39;',
    );
  });

  it('stringifies nullish values', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
