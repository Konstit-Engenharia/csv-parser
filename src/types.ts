import type { NativeCsvRowView } from './batches.ts';

export type CsvEncoding = 'utf8' | 'latin1' | 'iso88591' | 'iso-8859-1';
export interface CsvZipCompression {
  format: 'zip';
  entry: string;
  maxCompressionRatio?: number;
  maxDecompressedBytes?: number;
}
export type CsvCompression = Bun.CompressionFormat | 'auto' | CsvZipCompression;
export type CsvDelimiter =
  | 'auto'
  | ','
  | ';'
  | '\t'
  | '|'
  | ':'
  | '^'
  | '~'
  | (string & {});
export type CsvRow = string[];
export type CsvColumns = readonly number[];
export type CsvFieldValue = string | Buffer | Uint8Array;

export interface CsvFieldRange {
  start: number;
  end: number;
}

export interface CsvShard {
  start: number;
  end: number;
}

export interface CsvParserOptions {
  encoding?: CsvEncoding;
  delimiter?: CsvDelimiter;
  selectedColumns?: CsvColumns;
  fixedColumns?: number;
  strict?: boolean;
  expectedHeaders?: readonly string[];
  requireHeader?: boolean;
  minDataRows?: number;
}

export interface CsvFileOptions extends CsvParserOptions {
  chunkSize?: number;
  compression?: CsvCompression;
}

export type CsvShardingOptions = Omit<CsvFileOptions, 'compression'> & {
  compression?: never;
};

export type CsvWherePredicate =
  | CsvWhereEqualsFilter
  | CsvWhereInFilter
  | CsvWhereStartsWithFilter;

export interface CsvWhereAllFilter {
  all: readonly CsvWherePredicate[];
}

export type CsvWhereFilter = CsvWherePredicate | CsvWhereAllFilter;

export interface CsvEqualsFilter {
  column: number;
  value: CsvFieldValue;
}

export interface CsvInFilter {
  column: number;
  values: readonly CsvFieldValue[];
}

export interface CsvStartsWithFilter {
  column: number;
  prefix: CsvFieldValue;
}

export type CsvNativeFilter = CsvEqualsFilter | CsvInFilter | CsvStartsWithFilter;

export interface CsvWhereEqualsFilter {
  column: number;
  equals: CsvFieldValue;
}

export interface CsvWhereInFilter {
  column: number;
  in: readonly CsvFieldValue[];
}

export interface CsvWhereStartsWithFilter {
  column: number;
  startsWith: CsvFieldValue;
}

export interface CsvNativeProjectionOptions {
  selectedColumns?: CsvColumns;
  equalsFilter?: CsvEqualsFilter;
  filters?: readonly CsvNativeFilter[];
}

export interface CsvApiFileOptions extends CsvFileOptions {
  columns?: CsvColumns;
  workerCount?: number;
  where?: CsvWhereFilter;
}

export type CsvColumnSelection<TColumns extends CsvColumns | undefined> =
  | {
    columns?: TColumns;
    selectedColumns?: never;
  }
  | {
    columns?: never;
    selectedColumns?: TColumns;
  };

type CsvApiOptionsWithoutSelection = Omit<CsvApiFileOptions, 'columns' | 'selectedColumns'>;
type CsvDistributiveOmit<T, TKeys extends PropertyKey> = T extends unknown ? Omit<T, TKeys> : never;

type CsvOptionsWithoutWhereWorkerCount<TColumns extends CsvColumns | undefined> =
  & Omit<
    CsvApiOptionsWithoutSelection,
    'where' | 'workerCount'
  >
  & CsvColumnSelection<TColumns>;

export type CsvSingleThreadRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  | (CsvDistributiveOmit<CsvOptionsWithoutWhereWorkerCount<TColumns>, 'strict'> & {
    strict?: false | undefined;
    where?: CsvWhereFilter | undefined;
    workerCount?: 1 | undefined;
  })
  | (CsvDistributiveOmit<CsvOptionsWithoutWhereWorkerCount<TColumns>, 'strict'> & {
    strict: true;
    where?: undefined;
    workerCount?: 1 | undefined;
  });

export type CsvParallelRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  & Omit<
    CsvApiOptionsWithoutSelection,
    'compression' | 'where' | 'workerCount' | 'strict'
  >
  & CsvColumnSelection<TColumns>
  & {
    compression?: never;
    where?: CsvWhereFilter | undefined;
    workerCount: number;
    strict?: false | undefined;
  };

export type CsvParseOptions<TColumns extends CsvColumns | undefined = undefined> = CsvDistributiveOmit<
  CsvSingleThreadRowsOptions<TColumns>,
  'compression'
>;

export type CsvRowsOptions<TColumns extends CsvColumns | undefined = undefined> =
  | CsvSingleThreadRowsOptions<TColumns>
  | CsvParallelRowsOptions<TColumns>;

export type CsvBatchesOptions = CsvSingleThreadRowsOptions<CsvColumns | undefined>;

export type CsvRowViewsOptions<TColumns extends CsvColumns | undefined = undefined> = CsvSingleThreadRowsOptions<TColumns>;

export type CsvColumnarBatchOptions<TColumns extends CsvColumns | undefined = undefined> = [TColumns] extends [undefined]
  ? CsvSingleThreadRowsOptions<TColumns>
  : CsvDistributiveOmit<CsvSingleThreadRowsOptions<TColumns>, 'strict'> & { strict?: false | undefined; };

type CsvCountSingleThreadOptions =
  | (Omit<CsvApiOptionsWithoutSelection, 'where' | 'workerCount' | 'strict'> & CsvColumnSelection<CsvColumns | undefined> & {
    strict?: false | undefined;
    where?: CsvWhereFilter | undefined;
    workerCount?: 1 | undefined;
  })
  | (Omit<CsvApiOptionsWithoutSelection, 'where' | 'workerCount' | 'strict'> & CsvColumnSelection<CsvColumns | undefined> & {
    strict: true;
    where?: undefined;
    workerCount?: 1 | undefined;
  });

export type CsvParallelCountOptions =
  & Omit<CsvApiOptionsWithoutSelection, 'compression' | 'where' | 'workerCount' | 'strict'>
  & CsvColumnSelection<CsvColumns | undefined>
  & {
    compression?: never;
    where?: CsvWhereFilter | undefined;
    workerCount: number;
    strict?: false | undefined;
  };

export type CsvCountOptions =
  | CsvCountSingleThreadOptions
  | CsvParallelCountOptions;

export type CsvWorkerPoolOptions<TColumns extends CsvColumns | undefined = undefined> = CsvParallelRowsOptions<TColumns>;

export type CsvProjectedRow<TColumns extends CsvColumns | undefined> = TColumns extends readonly unknown[]
  ? { -readonly [Index in keyof TColumns]: string; }
  : CsvRow;

export type CsvRowView<TSelectedColumns extends CsvColumns | undefined = undefined> =
  & Pick<
    NativeCsvRowView,
    | 'rowIndex'
    | 'fieldCount'
    | 'fieldRange'
    | 'range'
    | 'fieldBytes'
    | 'bytes'
    | 'fieldBuffer'
    | 'buffer'
    | 'fieldString'
    | 'getPhysical'
    | 'get'
    | 'pickPhysical'
    | 'pick'
  >
  & {
    /**
     * Selected output columns requested for the stream, when present.
     *
     * `CsvRowView` still reads physical CSV column indexes through `get()`, `fieldString()`,
     * `bytes()`, `range()`, and `pick()`. This metadata is useful when you need to map projected
     * output positions back to source column indexes.
     */
    readonly selectedColumns: TSelectedColumns;
  };

export type CsvRowViewCallback<TSelectedColumns extends CsvColumns | undefined = undefined> = (
  row: CsvRowView<TSelectedColumns>,
  rowIndex: number,
) => void;
export type NativeCsvRowCallback = (row: NativeCsvRowView, rowIndex: number) => void;
export type CsvColumnRangeCallback = (rowIndex: number, start: number, end: number) => void;
export type CsvColumnBytesCallback = (rowIndex: number, bytes: Uint8Array) => void;
export type CsvScanColumnsCallback = (rowIndex: number, ranges: Float64Array, data: Buffer) => void;

export interface CsvColumnarBatchView<TSelectedColumns extends CsvColumns | undefined = undefined> {
  readonly rowCount: number;
  readonly totalFields: number;
  readonly dataLength: number;
  /**
   * Selected output columns requested for this batch. Unlike `CsvRowView`, column indexes on the
   * batch are relative to the projected output when `selectedColumns` is defined.
   */
  readonly selectedColumns: TSelectedColumns;
  data(): Buffer;
  dataView(): Uint8Array;
  rowOffsets(): BigUint64Array;
  fieldOffsets(): BigUint64Array;
  rowFieldCount(rowIndex: number): number;
  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null;
  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null;
  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null;
  forEachColumnRange(columnIndex: number, callback: CsvColumnRangeCallback, startRow?: number, endRow?: number): void;
  forEachColumnBytes(columnIndex: number, callback: CsvColumnBytesCallback, startRow?: number, endRow?: number): void;
  scanColumns(columns: CsvColumns, callback: CsvScanColumnsCallback, startRow?: number, endRow?: number): void;
}

export type CsvColumnarBatchCallback<TSelectedColumns extends CsvColumns | undefined = undefined> = (
  batch: CsvColumnarBatchView<TSelectedColumns>,
  batchIndex: number,
) => void;
