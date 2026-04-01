import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { RequestContextService } from './request-context.service';
import { AuthedUser } from '../auth/auth.types';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly ctx: RequestContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthedUser }>();

    const store = {
      actorId: req.user?.id ?? null,
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string) ?? null,
    };

    return new Observable((subscriber) => {
      this.ctx.run(store, () => {
        next.handle().subscribe({
          next: (val) => subscriber.next(val),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}
