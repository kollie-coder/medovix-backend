import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module'
import { ValidationPipe, Logger } from '@nestjs/common'
import { PrismaExceptionFilter } from './common/prisma-exception.filter'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)
  const logger = new Logger('Bootstrap')

  // Render puts a proxy in front of the app. Without this, every request looks
  // like it comes from the proxy's IP and rate limits would apply to everyone at once.
  app.set('trust proxy', 1)

  app.setGlobalPrefix('api/v1')

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true })
  )

  app.useGlobalFilters(new PrismaExceptionFilter())

  const port = process.env.PORT || 3001
  await app.listen(port)

  logger.log(`Medovite API running on port ${port}`)
}
bootstrap()