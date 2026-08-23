import { createReadStream } from 'node:fs';
import { DEFAULT_CHUNK_SIZE } from '../native.js';
import { NativeCsvParser } from '../parser.js';
import type {
  CsvEncoding,
  CsvRegex,
} from '../types.js';

interface WorkerEqualsFilterMessage {
  column: number;
  value: Uint8Array;
}

interface WorkerInFilterMessage {
  column: number;
  values: Uint8Array[];
}

interface WorkerNotEqualsFilterMessage {
  column: number;
  notEquals: Uint8Array;
}

interface WorkerNotInFilterMessage {
  column: number;
  notIn: Uint8Array[];
}

interface WorkerStartsWithFilterMessage {
  column: number;
  prefix: Uint8Array;
}

interface WorkerRegexFilterMessage {
  column: number;
  regex: CsvRegex;
}

type WorkerFilterMessage =
  | WorkerEqualsFilterMessage
  | WorkerInFilterMessage
  | WorkerNotInFilterMessage
  | WorkerNotEqualsFilterMessage
  | WorkerRegexFilterMessage
  | WorkerStartsWithFilterMessage;

interface WorkerCountMessage {
  chunkSize?: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  filters?: WorkerFilterMessage[];
}

addEventListener('message', async (event: MessageEvent<WorkerCountMessage>) => {
  const message = event.data;
  try {
    const rows = await countShard(message);
    postMessage({
      rows,
      shardIndex: message.shardIndex,
      type: 'done',
    });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
      shardIndex: message.shardIndex,
      type: 'error',
    });
  }
});

async function countShard(message: WorkerCountMessage): Promise<number> {
  const parser = new NativeCsvParser({
    delimiter: message.delimiter,
    encoding: message.encoding,
  });
  let rows = 0;
  try {
    for await (
      const chunk of createReadStream(message.path, {
        end: message.shard.end,
        highWaterMark: message.chunkSize ?? DEFAULT_CHUNK_SIZE,
        start: message.shard.start,
      })
    ) {
      rows += writeCount(parser, chunk as Buffer, message.filters);
    }
    rows += finishCount(parser, message.filters);
    return rows;
  } finally {
    parser.close();
  }
}

function writeCount(parser: NativeCsvParser, chunk: Buffer, filters: WorkerFilterMessage[] | undefined): number {
  if (filters === undefined) {
    return parser.writeCount(chunk);
  }
  return parser.writeCountWhereAll(chunk, filters);
}

function finishCount(parser: NativeCsvParser, filters: WorkerFilterMessage[] | undefined): number {
  if (filters === undefined) {
    return parser.endCount();
  }
  return parser.endCountWhereAll(filters);
}
