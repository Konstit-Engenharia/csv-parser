import { AsyncLocalStorage } from 'node:async_hooks';

export type WorkerFactory = (url: string | URL, options: WorkerOptions) => Worker;

const testFactory = new AsyncLocalStorage<WorkerFactory>();

export function createWorker(url: string | URL, options: WorkerOptions): Worker {
  const factory = testFactory.getStore();
  return factory === undefined ? new Worker(url, options) : factory(url, options);
}

export function withWorkerFactoryForTests<T>(factory: WorkerFactory, operation: () => T): T {
  return testFactory.run(factory, operation);
}
