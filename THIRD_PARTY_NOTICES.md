# Third-Party Notices

This file tracks third-party test data, examples, and compatibility references used by this repository. Runtime dependencies remain governed by their own package metadata in `bun.lock` and `node_modules`.

## csv-spectrum

- Source: https://github.com/maxogden/csv-spectrum
- npm package: `csv-spectrum@2.0.0`
- License: BSD-2-Clause
- Use in this repo: compatibility fixtures loaded by `test/csv-parser/spectrum.test.ts`.
- Notice: csv-spectrum is copyright its authors and contributors. Redistribution of source or binary forms must retain the BSD-2-Clause copyright notice, conditions, and disclaimer.

## csvkit

- Source: https://github.com/wireservice/csvkit
- License: MIT
- Use in this repo: compatibility attribution note for CSV examples/expectations derived from csvkit-related CSV parser corpus material.
- Notice: csvkit is copyright Christopher Groskopf and contributors. MIT-licensed material requires keeping the copyright and permission notice with substantial copied portions.

## W3C CSV on the Web

- Source: https://github.com/w3c/csvw and https://w3c.github.io/csvw/tests/
- License note: W3C CSVW documents are covered by the W3C Document License. The CSVW test distribution also documents W3C test-suite licensing terms.
- Use in this repo: raw parser subset fixtures in `test/csv-parser/csvw-basic.test.ts`.
- Notice: W3C materials are copyright W3C and contributors. Keep W3C license notices with copied or adapted CSVW material.
