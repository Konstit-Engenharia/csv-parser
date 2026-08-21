# Third-Party Notices

This file tracks third-party code incorporated into distributed native binaries and third-party test data, examples, and compatibility references used by this repository.

## Highway

- Source: https://github.com/google/highway
- License choice for this distribution: BSD-3-Clause
- Use in this project: compiled into the distributed native CSV library.

Copyright (c) The Highway Project Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## unordered_dense

- Source: https://github.com/martinus/unordered_dense
- License: MIT
- Use in this project: incorporated into the distributed native CSV library.

MIT License

Copyright (c) 2022 Martin Leitner-Ankerl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## zlib-ng

- Source: https://github.com/zlib-ng/zlib-ng
- Version: 2.3.3
- License: zlib License
- Use in this project: compiled into the distributed native library for streaming ZIP DEFLATE and CRC32 processing.

Copyright (C) 1995-2024 Jean-loup Gailly and Mark Adler

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held
liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter
it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If
   you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not
   required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original
   software.
3. This notice may not be removed or altered from any source distribution.

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
