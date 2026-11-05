import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { DocumentsController, VerifyController } from './documents.controller'
import { DocumentsService } from './documents.service'

@Module({
  imports: [PrismaModule],
  controllers: [DocumentsController, VerifyController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
