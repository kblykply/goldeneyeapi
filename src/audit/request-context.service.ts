import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { RequestContext } from './audit.types';

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContext>();

  run<T>(ctx: RequestContext, fn: () => T): T {
    return this.storage.run(ctx, fn);
  }

  get(): RequestContext | undefined {
    return this.storage.getStore();
  }
}
