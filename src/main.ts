import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ValidationPipe, Logger } from '@nestjs/common'
import { PrismaExceptionFilter } from './common/prisma-exception.filter'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)
  const logger = new Logger('Bootstrap')

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
