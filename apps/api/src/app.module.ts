import { MiddlewareConsumer, Module, RequestMethod } from "@nestjs/common";
import { AppController } from "./app.controller";
import { RelationshipService } from "./relationship.service";
import { LocalRequestGuardMiddleware } from "./local-request-guard.middleware";

@Module({ controllers: [AppController], providers: [RelationshipService] })
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LocalRequestGuardMiddleware)
      .forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
