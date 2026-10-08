import { Injectable, BadRequestException } from '@nestjs/common'
import { StorageClient } from '@supabase/storage-js'
import * as crypto from 'crypto'

const BUCKET = 'medovite-uploads'
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5MB

@Injectable()
export class StorageService {
  private client: StorageClient

  constructor() {
    const base = process.env.SUPABASE_URL!.replace(/\/$/, '')
    const url = `${base}/storage/v1`
    this.client = new StorageClient(url, {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    })
  }

  async uploadImage(file: Express.Multer.File, folder: 'logos' | 'avatars'): Promise<string> {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG or WebP images are allowed')
    }
    if (file.size > MAX_SIZE_BYTES) {
      throw new BadRequestException('Image must be under 5MB')
    }

    const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg'
    const path = `${folder}/${crypto.randomUUID()}.${ext}`

    const { error } = await this.client
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: false })

    if (error) throw new BadRequestException(`Upload failed: ${error.message}`)

    const { data } = this.client.from(BUCKET).getPublicUrl(path)
    return data.publicUrl
  }
}