import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { NoteTemplatesController } from './note-templates.controller'
import { NoteTemplatesService } from './note-templates.service'

@Module({
  imports: [PrismaModule],
  controllers: [NoteTemplatesController],
  providers: [NoteTemplatesService],
})
export class NoteTemplatesModule {}
