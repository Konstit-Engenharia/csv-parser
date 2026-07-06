import { createReadStream } from 'node:fs';
import { DEFAULT_CHUNK_SIZE } from '../native.ts';
import { NativeCsvParser } from '../parser.ts';
import type {
  CsvEncoding,
} from '../types.ts';

interface WorkerEqualsFilterMessage {
  column: number;
  value: Uint8Array;
}

interface WorkerInFilterMessage {
  column: number;
  values: Uint8Array[];
}

interface WorkerStartsWithFilterMessage {
  column: number;
  prefix: Uint8Array;
}

type WorkerCountFilterMessage =
  | { equals: WorkerEqualsFilterMessage; }
  | { in: WorkerInFilterMessage; }
  | { startsWith: WorkerStartsWithFilterMessage; };

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
  where?: WorkerCountFilterMessage;
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
      rows += writeCount(parser, chunk as Buffer, message.where);
    }
    rows += finishCount(parser, message.where);
    return rows;
  } finally {
    parser.close();
  }
}

function writeCount(parser: NativeCsvParser, chunk: Buffer, where: WorkerCountFilterMessage | undefined): number {
  if (where === undefined) {
    return parser.writeCount(chunk);
  }
  if ('equals' in where) {
    return parser.writeCountWhereEquals(chunk, where.equals);
  }
  if ('in' in where) {
    return parser.writeCountWhereIn(chunk, where.in);
  }
  return parser.writeCountWhereStartsWith(chunk, where.startsWith);
}

function finishCount(parser: NativeCsvParser, where: WorkerCountFilterMessage | undefined): number {
  if (where === undefined) {
    return parser.endCount();
  }
  if ('equals' in where) {
    return parser.endCountWhereEquals(where.equals);
  }
  if ('in' in where) {
    return parser.endCountWhereIn(where.in);
  }
  return parser.endCountWhereStartsWith(where.startsWith);
}
