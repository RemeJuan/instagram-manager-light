import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { getHostedConfig } from "./hosted-config";

async function bootstrap() {
  const config = getHostedConfig();
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: config.webOrigin });
  await app.listen(config.port, config.bindAddress);
}
bootstrap().catch((error: unknown) => {
  console.error("API startup failed:", error);
  process.exitCode = 1;
});
