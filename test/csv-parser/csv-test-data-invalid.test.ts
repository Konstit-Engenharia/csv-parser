import { test } from 'bun:test';

// Invalid RFC 4180 cases from https://github.com/sineemore/csv-test-data.
// Current parser is permissive and does not expose strict validation errors.
for (
  const name of [
    'bad-header-less-fields',
    'bad-header-more-fields',
    'bad-header-no-header',
    'bad-header-wrong-header',
    'bad-missing-quote',
    'bad-quotes-with-unescaped-quote',
    'bad-unescaped-quote',
  ]
) {
  test.todo(`csv-test-data invalid corpus rejects ${name}`, () => {
    throw new Error('strict RFC validation mode is not implemented');
  });
}
