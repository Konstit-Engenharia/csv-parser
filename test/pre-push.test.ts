import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  main,
  run,
} from '../scripts/pre-push.ts';

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw new Error('expected operation to reject');
  }
  return caught;
}

describe('pre-push checks', () => {
  test('runs only the prepush package script', async () => {
    const invocations: Array<{ command: string[]; label: string; }> = [];

    await main({
      run: async (command, label) => {
        invocations.push({ command, label });
      },
    });

    expect(invocations).toEqual([{
      command: [process.execPath, 'run', 'prepush'],
      label: 'pre-push checks',
    }]);
  });

  test('runs commands and reports failures', async () => {
    await run([process.execPath, '-e', 'void 0'], 'success');
    expect((await rejectedError(run([process.execPath, '-e', 'process.exit(7)'], 'checks'))).message).toBe(
      'checks failed with exit code 7',
    );
  });
});
