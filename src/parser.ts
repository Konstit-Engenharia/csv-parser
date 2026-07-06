import type { Pointer } from 'bun:ffi';
import {
  NativeCsvBatch,
  NativeCsvColumnStatsBatch,
  NativeCsvDictionaryBatch,
  NativeCsvGroupByCountBatch,
  takeMultiColumnStatsBatches,
} from './batches.ts';
import { native } from './native.ts';
import {
  encodingCode,
  normalizeChunk,
  normalizeColumns,
  normalizeColumnStatsColumns,
  normalizeEqualsFilter,
  normalizeFixedColumnsCount,
  normalizeInFilter,
  normalizeStartsWithFilter,
  normalizeTrustedFixedColumns,
} from './normalize.ts';
import type {
  CsvColumns,
  CsvEqualsFilter,
  CsvInFilter,
  CsvNativeProjectionOptions,
  CsvParserOptions,
  CsvRow,
  CsvStartsWithFilter,
} from './types.ts';

export class NativeCsvParser {
  #handle: Pointer | null;
  readonly #strict: boolean;
  readonly #fixedColumns: number | undefined;
  readonly #trustedFixedColumns: number | undefined;

  constructor(options: CsvParserOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1) {
      throw new Error('delimiter must be one character');
    }
    this.#strict = options.strict === true;
    this.#fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
    this.#trustedFixedColumns = normalizeTrustedFixedColumns(options.trusted);
    if (this.#fixedColumns !== undefined && this.#trustedFixedColumns !== undefined) {
      throw new Error('use fixedColumns or trusted.fixedColumns, not both');
    }

    this.#handle = native.symbols.csv_parser_create(encodingCode(options.encoding), delimiter.charCodeAt(0));
    if (this.#handle === null) {
      throw new Error('failed to create native CSV parser');
    }
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  write(chunk: NodeJS.TypedArray | DataView, final = false): CsvRow[] {
    const batch = this.writeBatch(chunk, final);
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  writeBatch(chunk: NodeJS.TypedArray | DataView, final = false): NativeCsvBatch {
    if (chunk.byteLength === 0 && final) {
      return this.endBatch();
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const batch = this.#strict && this.#trustedFixedColumns !== undefined
      ? native.symbols.csv_parser_write_strict_trusted_fixed_batch(
        handle,
        input,
        BigInt(input.byteLength),
        final,
        this.#trustedFixedColumns,
      )
      : this.#strict && this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_write_strict_fixed_batch(
        handle,
        input,
        BigInt(input.byteLength),
        final,
        this.#fixedColumns,
      )
      : this.#strict
      ? native.symbols.csv_parser_write_strict_batch(handle, input, BigInt(input.byteLength), final)
      : this.#trustedFixedColumns !== undefined
      ? native.symbols.csv_parser_write_trusted_fixed_batch(
        handle,
        input,
        BigInt(input.byteLength),
        final,
        this.#trustedFixedColumns,
      )
      : this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_write_fixed_batch(
        handle,
        input,
        BigInt(input.byteLength),
        final,
        this.#fixedColumns,
      )
      : native.symbols.csv_parser_write_batch(handle, input, BigInt(input.byteLength), final);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  writeProjectedBatch(
    chunk: NodeJS.TypedArray | DataView,
    options: CsvNativeProjectionOptions = {},
    final = false,
  ): NativeCsvBatch {
    this.#rejectStrictUnsupported('projected batches');
    if (chunk.byteLength === 0 && final) {
      return this.endProjectedBatch(options);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const columns = normalizeColumns(options.selectedColumns);
    const filter = normalizeEqualsFilter(options.equalsFilter);
    const batch = native.symbols.csv_parser_write_projected_batch(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      options.selectedColumns !== undefined,
      columns,
      BigInt(options.selectedColumns?.length ?? 0),
      filter.enabled,
      filter.column,
      filter.value,
      BigInt(filter.valueLength),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  writeDictionaryBatch(chunk: NodeJS.TypedArray | DataView, column: number, final = false): NativeCsvDictionaryBatch {
    this.#rejectStrictUnsupported('dictionary batches');
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`dictionary column out of range: ${column}`);
    }
    if (chunk.byteLength === 0 && final) {
      return this.endDictionaryBatch(column);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const batch = native.symbols.csv_parser_write_dictionary_batch(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      column,
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvDictionaryBatch(batch);
  }

  writeGroupByCount(chunk: NodeJS.TypedArray | DataView, column: number): number {
    this.#rejectStrictUnsupported('groupBy count');
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`groupBy count column out of range: ${column}`);
    }
    if (chunk.byteLength === 0) {
      return 0;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_group_by_count(
      handle,
      input,
      BigInt(input.byteLength),
      column,
    ));
  }

  writeColumnStats(chunk: NodeJS.TypedArray | DataView, column: number): number {
    this.#rejectStrictUnsupported('column stats');
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`column stats column out of range: ${column}`);
    }
    if (chunk.byteLength === 0) {
      return 0;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_column_stats(
      handle,
      input,
      BigInt(input.byteLength),
      column,
    ));
  }

  writeMultiColumnStats(chunk: NodeJS.TypedArray | DataView, columns: CsvColumns): number {
    this.#rejectStrictUnsupported('multi-column stats');
    if (chunk.byteLength === 0 || columns.length === 0) {
      return 0;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const normalizedColumns = normalizeColumnStatsColumns(columns);
    return Number(native.symbols.csv_parser_write_multi_column_stats(
      handle,
      input,
      BigInt(input.byteLength),
      normalizedColumns,
      BigInt(normalizedColumns.length),
    ));
  }

  end(): CsvRow[] {
    const batch = this.endBatch();
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  endBatch(): NativeCsvBatch {
    const batch = this.#strict && this.#trustedFixedColumns !== undefined
      ? native.symbols.csv_parser_finish_strict_trusted_fixed_batch(this.#requireHandle(), this.#trustedFixedColumns)
      : this.#strict && this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_finish_strict_fixed_batch(this.#requireHandle(), this.#fixedColumns)
      : this.#strict
      ? native.symbols.csv_parser_finish_strict_batch(this.#requireHandle())
      : this.#trustedFixedColumns !== undefined
      ? native.symbols.csv_parser_finish_trusted_fixed_batch(this.#requireHandle(), this.#trustedFixedColumns)
      : this.#fixedColumns !== undefined
      ? native.symbols.csv_parser_finish_fixed_batch(this.#requireHandle(), this.#fixedColumns)
      : native.symbols.csv_parser_finish_batch(this.#requireHandle());
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  endProjectedBatch(options: CsvNativeProjectionOptions = {}): NativeCsvBatch {
    this.#rejectStrictUnsupported('projected batches');
    const columns = normalizeColumns(options.selectedColumns);
    const filter = normalizeEqualsFilter(options.equalsFilter);
    const batch = native.symbols.csv_parser_finish_projected_batch(
      this.#requireHandle(),
      options.selectedColumns !== undefined,
      columns,
      BigInt(options.selectedColumns?.length ?? 0),
      filter.enabled,
      filter.column,
      filter.value,
      BigInt(filter.valueLength),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  endDictionaryBatch(column: number): NativeCsvDictionaryBatch {
    this.#rejectStrictUnsupported('dictionary batches');
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`dictionary column out of range: ${column}`);
    }
    const batch = native.symbols.csv_parser_finish_dictionary_batch(this.#requireHandle(), column);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvDictionaryBatch(batch);
  }

  endGroupByCount(column: number): NativeCsvGroupByCountBatch {
    this.#rejectStrictUnsupported('groupBy count');
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`groupBy count column out of range: ${column}`);
    }
    const batch = native.symbols.csv_parser_finish_group_by_count(this.#requireHandle(), column);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvGroupByCountBatch(batch);
  }

  endColumnStats(column: number): NativeCsvColumnStatsBatch {
    this.#rejectStrictUnsupported('column stats');
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`column stats column out of range: ${column}`);
    }
    const batch = native.symbols.csv_parser_finish_column_stats(this.#requireHandle(), column);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvColumnStatsBatch(batch);
  }

  endMultiColumnStats(columns: CsvColumns): NativeCsvColumnStatsBatch[] {
    this.#rejectStrictUnsupported('multi-column stats');
    if (columns.length === 0) {
      return [];
    }

    const normalizedColumns = normalizeColumnStatsColumns(columns);
    const batch = native.symbols.csv_parser_finish_multi_column_stats(
      this.#requireHandle(),
      normalizedColumns,
      BigInt(normalizedColumns.length),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return takeMultiColumnStatsBatches(batch);
  }

  writeCount(chunk: NodeJS.TypedArray | DataView, final = false): number {
    this.#rejectStrictUnsupported('count');
    if (chunk.byteLength === 0 && final) {
      return this.endCount();
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_count(handle, input, BigInt(input.byteLength), final));
  }

  endCount(): number {
    this.#rejectStrictUnsupported('count');
    return Number(native.symbols.csv_parser_finish_count(this.#requireHandle()));
  }

  writeCountWhereEquals(chunk: NodeJS.TypedArray | DataView, filter: CsvEqualsFilter, final = false): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereEquals(filter);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const normalized = normalizeEqualsFilter(filter);
    return Number(native.symbols.csv_parser_write_count_where_equals(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  endCountWhereEquals(filter: CsvEqualsFilter): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeEqualsFilter(filter);
    return Number(native.symbols.csv_parser_finish_count_where_equals(
      this.#requireHandle(),
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  writeCountWhereIn(chunk: NodeJS.TypedArray | DataView, filter: CsvInFilter, final = false): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereIn(filter);
    }

    const normalized = normalizeInFilter(filter);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_count_where_in(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      normalized.column,
      normalized.valuesData,
      BigInt(normalized.valuesDataLength),
      normalized.offsets,
      BigInt(normalized.valueCount),
    ));
  }

  endCountWhereIn(filter: CsvInFilter): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeInFilter(filter);
    return Number(native.symbols.csv_parser_finish_count_where_in(
      this.#requireHandle(),
      normalized.column,
      normalized.valuesData,
      BigInt(normalized.valuesDataLength),
      normalized.offsets,
      BigInt(normalized.valueCount),
    ));
  }

  writeCountWhereStartsWith(chunk: NodeJS.TypedArray | DataView, filter: CsvStartsWithFilter, final = false): number {
    this.#rejectStrictUnsupported('count filters');
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereStartsWith(filter);
    }

    const normalized = normalizeStartsWithFilter(filter);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_count_where_starts_with(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  endCountWhereStartsWith(filter: CsvStartsWithFilter): number {
    this.#rejectStrictUnsupported('count filters');
    const normalized = normalizeStartsWithFilter(filter);
    return Number(native.symbols.csv_parser_finish_count_where_starts_with(
      this.#requireHandle(),
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  reset(): void {
    native.symbols.csv_parser_reset(this.#requireHandle());
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_parser_destroy(this.#handle);
      this.#handle = null;
    }
  }

  dispose(): void {
    this.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): Pointer {
    if (this.#handle === null) {
      throw new Error('native CSV parser is closed');
    }
    return this.#handle;
  }

  #lastError(): string {
    if (this.#handle === null) {
      return 'parser is closed';
    }
    const value = native.symbols.csv_parser_last_error(this.#handle);
    return value.toString();
  }

  #rejectStrictUnsupported(operation: string): void {
    if (this.#strict) {
      throw new Error(`strict CSV validation is not supported for ${operation}`);
    }
  }
}
