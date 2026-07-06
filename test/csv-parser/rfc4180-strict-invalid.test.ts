import { test } from 'bun:test';

// Corpus: project-owned invalid RFC 4180 fixture names.
// Scope: strict validation backlog. Current parser is permissive and does not expose strict validation errors.
for (
  const name of [
    'header-too-few-fields',
    'header-too-many-fields',
    'header-missing-row',
    'header-name-mismatch',
    'missing-closing-quote',
    'unescaped-quote-inside-quoted-field',
    'unescaped-quote-in-unquoted-field',
  ]
) {
  test.todo(`strict RFC 4180 mode rejects ${name}`, () => {
    throw new Error('strict RFC validation mode is not implemented');
  });
}
