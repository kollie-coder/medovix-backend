import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ValidationPipe } from '@nestjs/common'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.setGlobalPrefix('api/v1')

  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true })
  )

  await app.listen(process.env.PORT || 3001)
  console.log(`Medovix API running on http://localhost:3001/api/v1`)
}
bootstrap()



// import { NestFactory } from '@nestjs/core';
// import { AppModule } from './app.module';

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule);
//   app.setGlobalPrefix('api/v1');
//   await app.listen(process.env.PORT || 3001);
//   console.log(`Medovix API running on http://localhost:3001/api/v1`);
// }
// bootstrap();

