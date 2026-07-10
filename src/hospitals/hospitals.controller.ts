import { Controller, Get, Param, Query } from '@nestjs/common'
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
  // Cheap — Nearby Search only, cached 24h
  @Get('nearby')
  findNearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
  ) {
    return this.hospitalsService.findNearby(
      parseFloat(lat),
      parseFloat(lng),
      radius ? parseFloat(radius) : 5,
    )
  }

  // GET /api/v1/hospitals/place-details/:placeId
  // Called only when user taps a hospital — fetches phone/website/hours, cached 24h
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


// // src/hospitals/hospitals.controller.ts
// import { Controller, Get, Param, Query } from '@nestjs/common'
// import { HospitalsService } from './hospitals.service'

// @Controller('hospitals')
// export class HospitalsController {
//   constructor(private hospitalsService: HospitalsService) {}

//   // GET /api/v1/hospitals?search=lagos&type=general&verified=true
//   @Get()
//   findAll(
//     @Query('search') search?: string,
//     @Query('city') city?: string,
//     @Query('state') state?: string,
//     @Query('type') type?: string,
//     @Query('verified') verified?: string,
//     @Query('page') page?: string,
//     @Query('limit') limit?: string,
//   ) {
//     return this.hospitalsService.findAll({
//       search, city, state, type, verified, page, limit,
//     })
//   }

//   // GET /api/v1/hospitals/:id
//   @Get(':id')
//   findOne(@Param('id') id: string) {
//     return this.hospitalsService.findOne(id)
//   }
// }