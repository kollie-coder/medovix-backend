// src/hospitals/hospitals.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

const nearbyCache = new Map<string, { data: any[]; expiresAt: number }>()
const detailsCache = new Map<string, { data: any; expiresAt: number }>()

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

@Injectable()
export class HospitalsService {
  private readonly logger = new Logger(HospitalsService.name)

  constructor(private prisma: PrismaService) {}

  async findAll(query: {
    search?: string
    city?: string
    state?: string
    type?: string
    verified?: string
    page?: string
    limit?: string
  }) {
    const page = parseInt(query.page ?? '1')
    const limit = parseInt(query.limit ?? '20')
    const skip = (page - 1) * limit

    const where: any = { active: true, deletedAt: null }

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { city: { contains: query.search, mode: 'insensitive' } },
      ]
    }

    if (query.city) where.city = { contains: query.city, mode: 'insensitive' }
    if (query.state) where.state = { contains: query.state, mode: 'insensitive' }
    if (query.type) where.type = query.type.toUpperCase()
    if (query.verified === 'true') where.verified = true

    const [hospitals, total] = await Promise.all([
      this.prisma.hospital.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          type: true,
          address: true,
          city: true,
          state: true,
          phone: true,
          email: true,
          logo: true,
          latitude: true,
          longitude: true,
          googlePlaceId: true,
          verified: true,
          listing: {
            select: {
              description: true,
              specialties: true,
              services: true,
              openingHours: true,
              rating: true,
              reviewCount: true,
              medoviteVerified: true,
              emergencyAvailable: true,
              photos: true,
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.hospital.count({ where }),
    ])

    return {
      data: hospitals,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }

  async findNearby(lat: number, lng: number, radiusKm: number = 5) {
    this.logger.log(`DEBUG: findNearby called with lat=${lat}, lng=${lng}, radiusKm=${radiusKm}`)

    const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${radiusKm}`
    const cached = nearbyCache.get(cacheKey)

    let googleHospitals: any[]

    if (cached && cached.expiresAt > Date.now()) {
      this.logger.log('DEBUG: using cached Google results')
      googleHospitals = cached.data
    } else {
      this.logger.log('DEBUG: fetching fresh Google results')
      googleHospitals = await this.queryGooglePlacesNearby(lat, lng, radiusKm)
      nearbyCache.set(cacheKey, { data: googleHospitals, expiresAt: Date.now() + CACHE_TTL_MS })
    }

    const medoviteHospitals = await this.prisma.hospital.findMany({
      where: { active: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        address: true,
        phone: true,
        website: true,
        googlePlaceId: true,
        latitude: true,
        longitude: true,
        listing: {
          select: {
            medoviteVerified: true,
            rating: true,
            specialties: true,
            emergencyAvailable: true,
            photos: true,
          },
        },
      },
    })

    this.logger.log(`DEBUG: medoviteHospitals fetched from DB, count = ${medoviteHospitals.length}`)
    for (const h of medoviteHospitals) {
      this.logger.log(`DEBUG: DB hospital -> id=${h.id}, name=${h.name}, lat=${h.latitude}, lng=${h.longitude}`)
    }

    const matchedMedoviteIds = new Set<string>()

    const results = googleHospitals.map((place: any) => {
      const medoviteMatch = medoviteHospitals.find(m => {
        if (m.googlePlaceId && m.googlePlaceId === place.placeId) return true
        if (m.latitude && m.longitude) {
          const dist = this.haversineDistance(place.lat, place.lng, m.latitude, m.longitude)
          return dist < 0.1
        }
        return false
      })

      if (medoviteMatch) {
        this.logger.log(`DEBUG: matched Google place "${place.name}" to DB hospital "${medoviteMatch.name}"`)
        matchedMedoviteIds.add(medoviteMatch.id)
      }

      return {
        ...place,
        medoviteId: medoviteMatch?.id ?? null,
        isMedovite: !!medoviteMatch,
        medoviteVerified: medoviteMatch?.listing?.medoviteVerified ?? false,
        rating: medoviteMatch?.listing?.rating ?? place.rating,
        specialties: medoviteMatch?.listing?.specialties ?? [],
        emergencyAvailable: medoviteMatch?.listing?.emergencyAvailable ?? false,
        distance: this.haversineDistance(lat, lng, place.lat, place.lng),
      }
    })

    this.logger.log(`DEBUG: matchedMedoviteIds after Google matching = ${JSON.stringify([...matchedMedoviteIds])}`)
    this.logger.log('DEBUG: entering standalone-entry loop now')

    for (const hospital of medoviteHospitals) {
      this.logger.log(`DEBUG: checking hospital "${hospital.name}" (id=${hospital.id})`)

      if (matchedMedoviteIds.has(hospital.id)) {
        this.logger.log(`DEBUG: "${hospital.name}" was already matched to a Google place — skipping`)
        continue
      }

      if (!hospital.latitude || !hospital.longitude) {
        this.logger.log(`DEBUG: "${hospital.name}" has no coordinates (lat=${hospital.latitude}, lng=${hospital.longitude}) — skipping`)
        continue
      }

      const distance = this.haversineDistance(lat, lng, hospital.latitude, hospital.longitude)
      this.logger.log(`DEBUG: "${hospital.name}" distance = ${distance}km, radius limit = ${radiusKm}km`)

      if (distance > radiusKm) {
        this.logger.log(`DEBUG: "${hospital.name}" is outside the radius — skipping`)
        continue
      }

      this.logger.log(`DEBUG: "${hospital.name}" PASSED all checks — adding as standalone entry now`)

      results.push({
        placeId: hospital.googlePlaceId ?? null,
        medoviteId: hospital.id,
        name: hospital.name,
        type: hospital.type ?? 'General',
        address: hospital.address ?? 'Address not available',
        lat: hospital.latitude,
        lng: hospital.longitude,
        isOpenNow: null,
        rating: hospital.listing?.rating ?? null,
        userRatingsTotal: 0,
        thumbnail: hospital.listing?.photos?.[0] ?? null,
        phone: hospital.phone ?? null,
        website: hospital.website ?? null,
        openingHours: null,
        photos: hospital.listing?.photos ?? [],
        emergency: hospital.listing?.emergencyAvailable ?? false,
        isMedovite: true,
        medoviteVerified: hospital.listing?.medoviteVerified ?? false,
        specialties: hospital.listing?.specialties ?? [],
        emergencyAvailable: hospital.listing?.emergencyAvailable ?? false,
        distance,
      })
    }

    this.logger.log(`DEBUG: final results count = ${results.length}`)

    results.sort((a: any, b: any) => a.distance - b.distance)
    return results
  }

  async getPlaceFullDetails(placeId: string) {
    const cached = detailsCache.get(placeId)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data
    }

    const details = await this.fetchPlaceDetails(placeId)
    if (details) {
      detailsCache.set(placeId, { data: details, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return details
  }

  async findOne(id: string) {
    const hospital = await this.prisma.hospital.findFirst({
      where: { id, active: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        address: true,
        city: true,
        state: true,
        phone: true,
        email: true,
        website: true,
        logo: true,
        latitude: true,
        longitude: true,
        googlePlaceId: true,
        listing: {
          select: {
            description: true,
            specialties: true,
            services: true,
            openingHours: true,
            rating: true,
            reviewCount: true,
            medoviteVerified: true,
            emergencyAvailable: true,
            photos: true,
          },
        },
        departments: {
          where: { deletedAt: null },
          select: { id: true, name: true },
        },
        _count: { select: { staff: true } },
      },
    })

    if (!hospital) throw new NotFoundException('Hospital not found')
    return hospital
  }

  private async queryGooglePlacesNearby(lat: number, lng: number, radiusKm: number) {
    const radiusMetres = Math.min(radiusKm * 1000, 50000)
    const key = process.env.GOOGLE_PLACES_API_KEY

    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}` +
      `&radius=${radiusMetres}` +
      `&type=hospital` +
      `&key=${key}`

    try {
      const response = await fetch(url)
      const data = await response.json()

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        this.logger.warn(`Google Places nearby search returned status: ${data.status}`)
        return []
      }

      return (data.results ?? []).slice(0, 20).map((place: any) => ({
        placeId: place.place_id,
        name: place.name,
        type: this.mapGoogleType(place.types ?? [], place.name),
        address: place.vicinity ?? 'Address not available',
        lat: place.geometry?.location?.lat,
        lng: place.geometry?.location?.lng,
        isOpenNow: place.opening_hours?.open_now ?? null,
        rating: place.rating ?? null,
        userRatingsTotal: place.user_ratings_total ?? 0,
        thumbnail: place.photos?.[0]
          ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=200&photo_reference=${place.photos[0].photo_reference}&key=${key}`
          : null,
        phone: null,
        website: null,
        openingHours: null,
        photos: [],
        emergency: false,
      })).filter((h: any) => h.lat && h.lng)
    } catch (err) {
      this.logger.error('Google Places nearby search failed', err)
      return []
    }
  }

  private async fetchPlaceDetails(placeId: string) {
    const key = process.env.GOOGLE_PLACES_API_KEY
    const fields = 'place_id,name,formatted_address,formatted_phone_number,website,opening_hours,rating,photos,geometry,types,user_ratings_total'

    const url = `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${placeId}` +
      `&fields=${fields}` +
      `&key=${key}`

    try {
      const response = await fetch(url)
      const data = await response.json()

      if (data.status !== 'OK') {
        this.logger.warn(`Google Place Details returned status: ${data.status} for placeId ${placeId}`)
        return null
      }

      const place = data.result
      const photos = (place.photos ?? []).slice(0, 5).map((p: any) =>
        `https://maps.googleapis.com/maps/api/place/photo?maxwidth=400&photo_reference=${p.photo_reference}&key=${key}`
      )

      return {
        placeId: place.place_id,
        name: place.name,
        type: this.mapGoogleType(place.types ?? [], place.name),
        address: place.formatted_address ?? 'Address not available',
        phone: place.formatted_phone_number ?? null,
        website: place.website ?? null,
        lat: place.geometry?.location?.lat,
        lng: place.geometry?.location?.lng,
        openingHours: place.opening_hours?.weekday_text ?? [],
        isOpenNow: place.opening_hours?.open_now ?? null,
        rating: place.rating ?? null,
        userRatingsTotal: place.user_ratings_total ?? 0,
        photos,
      }
    } catch (err) {
      this.logger.error(`Google Place Details fetch failed for placeId ${placeId}`, err)
      return null
    }
  }

  private mapGoogleType(types: string[], name?: string): string {
    const lowerName = (name ?? '').toLowerCase()

    if (lowerName.includes('teaching') || lowerName.includes('university')) return 'Teaching'
    if (lowerName.includes('specialist') || lowerName.includes('cardiology') ||
        lowerName.includes('cancer') || lowerName.includes('eye') ||
        lowerName.includes('dental') || lowerName.includes('orthopaedic') ||
        lowerName.includes('orthopedic')) return 'Specialist'
    if (lowerName.includes('clinic') || lowerName.includes('surgery') ||
        lowerName.includes('practice') || lowerName.includes('gp ')) return 'Clinic'

    if (types.includes('doctor')) return 'Clinic'
    if (types.includes('pharmacy')) return 'Clinic'
    if (types.includes('hospital')) return 'General'

    return 'General'
  }

  private haversineDistance(
    lat1: number, lng1: number,
    lat2: number, lng2: number,
  ): number {
    const R = 6371
    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLng = ((lng2 - lng1) * Math.PI) / 180
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2)
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }
}