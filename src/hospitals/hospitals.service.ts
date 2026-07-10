// src/hospitals/hospitals.service.ts
import { Injectable, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

// In-memory cache: key = rounded lat,lng,radius -> { data, expiresAt }
const nearbyCache = new Map<string, { data: any[]; expiresAt: number }>()
const detailsCache = new Map<string, { data: any; expiresAt: number }>()

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

@Injectable()
export class HospitalsService {
  constructor(private prisma: PrismaService) {}

  // ── Search Medovix hospitals ─────────────────────────────
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
              medovixVerified: true,
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

  // ── Search nearby hospitals (list view — cheap, no details calls) ──
  async findNearby(lat: number, lng: number, radiusKm: number = 5) {
    // Round coordinates to ~1km precision for effective caching
    const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${radiusKm}`
    const cached = nearbyCache.get(cacheKey)

    let googleHospitals: any[]

    if (cached && cached.expiresAt > Date.now()) {
      console.log('Returning cached nearby results for', cacheKey)
      googleHospitals = cached.data
    } else {
      googleHospitals = await this.queryGooglePlacesNearby(lat, lng, radiusKm)
      nearbyCache.set(cacheKey, { data: googleHospitals, expiresAt: Date.now() + CACHE_TTL_MS })
    }

    const medovixHospitals = await this.prisma.hospital.findMany({
      where: { active: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        googlePlaceId: true,
        latitude: true,
        longitude: true,
        listing: {
          select: {
            medovixVerified: true,
            rating: true,
            specialties: true,
            emergencyAvailable: true,
          },
        },
      },
    })

    const results = googleHospitals.map((place: any) => {
      const medovixMatch = medovixHospitals.find(m => {
        if (m.googlePlaceId && m.googlePlaceId === place.placeId) return true
        if (m.latitude && m.longitude) {
          const dist = this.haversineDistance(place.lat, place.lng, m.latitude, m.longitude)
          return dist < 0.1
        }
        return m.name.toLowerCase().includes(place.name.toLowerCase()) ||
          place.name.toLowerCase().includes(m.name.toLowerCase())
      })

      return {
        ...place,
        medovixId: medovixMatch?.id ?? null,
        isMedovix: !!medovixMatch,
        medovixVerified: medovixMatch?.listing?.medovixVerified ?? false,
        rating: medovixMatch?.listing?.rating ?? place.rating,
        specialties: medovixMatch?.listing?.specialties ?? [],
        emergencyAvailable: medovixMatch?.listing?.emergencyAvailable ?? false,
        distance: this.haversineDistance(lat, lng, place.lat, place.lng),
      }
    })

    results.sort((a: any, b: any) => a.distance - b.distance)
    return results
  }

  // ── Get full place details (called only when user taps a hospital) ──
  async getPlaceFullDetails(placeId: string) {
    const cached = detailsCache.get(placeId)
    if (cached && cached.expiresAt > Date.now()) {
      console.log('Returning cached details for', placeId)
      return cached.data
    }

    const details = await this.fetchPlaceDetails(placeId)
    if (details) {
      detailsCache.set(placeId, { data: details, expiresAt: Date.now() + CACHE_TTL_MS })
    }
    return details
  }

  // ── Get single Medovix hospital ──────────────────────────
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
            medovixVerified: true,
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

  // ── Google Places Nearby Search (cheap — no details) ─────
  private async queryGooglePlacesNearby(lat: number, lng: number, radiusKm: number) {
    const radiusMetres = Math.min(radiusKm * 1000, 50000)
    const key = process.env.GOOGLE_PLACES_API_KEY

    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}` +
      `&radius=${radiusMetres}` +
      `&type=hospital` +
      `&key=${key}`

    console.log('Querying Google Places nearby (1 API call)...')

    try {
      const response = await fetch(url)
      const data = await response.json()

      console.log('Google Places status:', data.status, '| results:', data.results?.length)

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        console.error('Google Places error:', data.error_message)
        return []
      }

      // No Place Details call here — just use what Nearby Search gives us
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
        // Single thumbnail only — cheaper than fetching all photos
        thumbnail: place.photos?.[0]
          ? `https://maps.googleapis.com/maps/api/place/photo?maxwidth=200&photo_reference=${place.photos[0].photo_reference}&key=${key}`
          : null,
        // Phone/website/full-hours NOT fetched here — only on detail tap
        phone: null,
        website: null,
        openingHours: null,
        photos: [],
        emergency: false,
      })).filter((h: any) => h.lat && h.lng)
    } catch (err) {
      console.error('Google Places fetch error:', err)
      return []
    }
  }

  // ── Fetch full Place Details (only called when user taps) ──
  private async fetchPlaceDetails(placeId: string) {
    const key = process.env.GOOGLE_PLACES_API_KEY
    const fields = 'place_id,name,formatted_address,formatted_phone_number,website,opening_hours,rating,photos,geometry,types,user_ratings_total'

    const url = `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${placeId}` +
      `&fields=${fields}` +
      `&key=${key}`

    console.log('Fetching place details (1 API call) for', placeId)

    try {
      const response = await fetch(url)
      const data = await response.json()

      if (data.status !== 'OK') {
        console.error('Place Details error:', data.status, data.error_message)
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
      console.error('Place Details fetch error:', err)
      return null
    }
  }

  // ── Map Google place types to our filter categories ─────
  // Aligns with HOSPITAL_TYPES: 'General' | 'Specialist' | 'Teaching' | 'Clinic'
  private mapGoogleType(types: string[], name?: string): string {
    const lowerName = (name ?? '').toLowerCase()

    // Name-based heuristics first — Google's "types" array is too generic
    if (lowerName.includes('teaching') || lowerName.includes('university')) return 'Teaching'
    if (lowerName.includes('specialist') || lowerName.includes('cardiology') ||
        lowerName.includes('cancer') || lowerName.includes('eye') ||
        lowerName.includes('dental') || lowerName.includes('orthopaedic') ||
        lowerName.includes('orthopedic')) return 'Specialist'
    if (lowerName.includes('clinic') || lowerName.includes('surgery') ||
        lowerName.includes('practice') || lowerName.includes('gp ')) return 'Clinic'

    // Fallback to Google's types array
    if (types.includes('doctor')) return 'Clinic'
    if (types.includes('pharmacy')) return 'Clinic'
    if (types.includes('hospital')) return 'General'

    return 'General'
  }

  // ── Haversine distance (km) ──────────────────────────────
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