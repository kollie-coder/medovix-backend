import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { HospitalsService } from './hospitals.service'

@Controller('hospitals')
export class HospitalsController {
  constructor(private hospitalsService: HospitalsService) {}

  // GET /api/v1/hospitals — Medovix registered hospitals
  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('city') city?: string,
    @Query('state') state?: string,
    @Query('type') type?: string,
    @Query('verified') verified?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.hospitalsService.findAll({
      search, city, state, type, verified, page, limit,
    })
  }

  // GET /api/v1/hospitals/nearby?lat=6.5&lng=3.3&radius=5
  // Cheap — Nearby Search only. Cached, single-flight and budget-limited
  // inside the service, so repeated calls do not reach Google.
  @Get('nearby')
  findNearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
  ) {
    const latitude = parseFloat(lat)
    const longitude = parseFloat(lng)
    if (
      !Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 || Math.abs(longitude) > 180
    ) {
      throw new BadRequestException('Valid lat and lng are required')
    }

    const radiusKm = radius ? parseFloat(radius) : 5
    return this.hospitalsService.findNearby(
      latitude,
      longitude,
      Number.isFinite(radiusKm) ? radiusKm : 5,
    )
  }

  // GET /api/v1/hospitals/photo?ref=...&w=200&sig=...
  // Photo proxy: phones never see the Google API key. The signature is
  // created by the server when it builds the thumbnail/photo URLs.
  // Must stay ABOVE ':id' so "photo" is not treated as a hospital id.
  @Get('photo')
  async getPhoto(
    @Query('ref') ref: string,
    @Query('w') w: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ) {
    const url = await this.hospitalsService.getPhotoRedirect(
      ref,
      parseInt(w ?? '200', 10),
      sig,
    )
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.redirect(302, url)
  }

  // GET /api/v1/hospitals/place-details/:placeId
  // Called only when user taps a hospital — phone/website/hours, cached 24h
  @Get('place-details/:placeId')
  getPlaceDetails(@Param('placeId') placeId: string) {
    return this.hospitalsService.getPlaceFullDetails(placeId)
  }

  // GET /api/v1/hospitals/:id — Medovix hospital by internal ID
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.hospitalsService.findOne(id)
  }
}