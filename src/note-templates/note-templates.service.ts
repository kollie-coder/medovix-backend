import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { CreateNoteTemplateDto } from './note-templates.dto'

const MAX_TEMPLATES_PER_DOCTOR = 30

const templateSelect = {
  id: true,
  name: true,
  symptoms: true,
  findings: true,
  notes: true,
} satisfies Prisma.NoteTemplateSelect

// A doctor's own reusable consultation layouts. Private to the doctor who wrote
// them. They hold wording only, never patient details.
@Injectable()
export class NoteTemplatesService {
  constructor(private prisma: PrismaService) {}

  list(userId: string, hospitalId: string) {
    return this.prisma.noteTemplate.findMany({
      where: { userId, hospitalId },
      select: templateSelect,
      orderBy: { name: 'asc' },
    })
  }

  async create(userId: string, hospitalId: string, dto: CreateNoteTemplateDto) {
    const name = dto.name.trim()
    const symptoms = (dto.symptoms ?? '').trim()
    const findings = (dto.findings ?? '').trim()
    const notes = (dto.notes ?? '').trim()

    if (name.length < 2) throw new BadRequestException('Give the template a name')
    if (!symptoms && !findings && !notes) {
      throw new BadRequestException('A template needs some text to save')
    }

    const count = await this.prisma.noteTemplate.count({ where: { userId, hospitalId } })
    if (count >= MAX_TEMPLATES_PER_DOCTOR) {
      throw new BadRequestException(
        `You can keep up to ${MAX_TEMPLATES_PER_DOCTOR} templates. Delete one you no longer use first.`,
      )
    }

    const clash = await this.prisma.noteTemplate.findFirst({
      where: { userId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (clash) throw new ConflictException('You already have a template with this name')

    try {
      return await this.prisma.noteTemplate.create({
        data: { userId, hospitalId, name, symptoms, findings, notes },
        select: templateSelect,
      })
    } catch (err) {
      // Two quick clicks can both pass the check above; the unique index catches the second.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException('You already have a template with this name')
      }
      throw err
    }
  }

  async remove(userId: string, hospitalId: string, id: string) {
    const { count } = await this.prisma.noteTemplate.deleteMany({ where: { id, userId, hospitalId } })
    if (count === 0) throw new NotFoundException('Template not found')
    return { deleted: true }
  }
}
