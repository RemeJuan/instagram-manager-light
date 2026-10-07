import { MiddlewareConsumer, Module, RequestMethod } from "@nestjs/common";
import { AppController } from "./app.controller";
import { RelationshipService } from "./relationship.service";
import { LocalRequestGuardMiddleware } from "./local-request-guard.middleware";
import { AuthService } from "./auth.service";
import { AuthController, HealthController } from "./auth.controller";

@Module({
  controllers: [AppController, AuthController, HealthController],
  providers: [RelationshipService, AuthService],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LocalRequestGuardMiddleware)
      .forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
