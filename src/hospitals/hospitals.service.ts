// src/hospitals/hospitals.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

// In-memory cache for Google Places results only — keyed by rounded
// coordinates + radius, so nearby requests within ~1km of each other
// reuse the same Google API call instead of paying for a fresh one.
// Medovite's own hospital data is NEVER cached here — it's queried
// live on every request, since it's cheap (our own database) and
// always needs to be fresh.
const nearbyCache = new Map<string, { data: any[]; expiresAt: number }>()
const detailsCache = new Map<string, { data: any; expiresAt: number }>()

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

@Injectable()
export class HospitalsService {
  private readonly logger = new Logger(HospitalsService.name)

  constructor(private prisma: PrismaService) {}

  // ── Search Medovite hospitals (registered on our platform) ──
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

  // ── Search nearby hospitals — blends two data sources ────────
  //
  // The nearby list is built from TWO sources merged together:
  //   1. Google Places — public hospitals/clinics near the user,
  //      even ones not registered with Medovite at all.
  //   2. Our own database — hospitals that have actually signed
  //      up on the Medovite platform.
  //
  // A Medovite hospital that also has a real Google Maps listing
  // gets "matched" and shown as one enriched entry (Google's public
  // info + our verified badge/rating). But a Medovite hospital with
  // NO Google Maps presence yet (a new clinic, a small practice that
  // hasn't been indexed by Google) would otherwise be invisible in
  // the app — since the old version of this method only ever looped
  // over Google's results and used our data purely to decorate them.
  //
  // The fix: after building the Google-based list, we separately
  // check every Medovite hospital that DIDN'T get matched, and if
  // it's within the search radius, add it as its own standalone
  // entry. This guarantees every registered hospital shows up for
  // nearby users, regardless of whether Google knows about it yet.
  async findNearby(lat: number, lng: number, radiusKm: number = 5) {
    const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${radiusKm}`
    const cached = nearbyCache.get(cacheKey)

    let googleHospitals: any[]

    if (cached && cached.expiresAt > Date.now()) {
      googleHospitals = cached.data
    } else {
      googleHospitals = await this.queryGooglePlacesNearby(lat, lng, radiusKm)
      nearbyCache.set(cacheKey, { data: googleHospitals, expiresAt: Date.now() + CACHE_TTL_MS })
    }

    // Fetch every active Medovite hospital — not just ones near the
    // user — so we can check each one for a Google match OR distance.
    // This is cheap since it's our own database, not an external API call.
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

    // Tracks which Medovite hospitals get successfully matched to a
    // Google result below — anything left unmatched after this loop
    // still needs to be added on its own (see the second loop further down).
    const matchedMedoviteIds = new Set<string>()

    const results = googleHospitals.map((place: any) => {
      const medoviteMatch = medoviteHospitals.find(m => {
        // Best match: exact Google Place ID on file
        if (m.googlePlaceId && m.googlePlaceId === place.placeId) return true
        // Fallback: same physical location within ~100m
        if (m.latitude && m.longitude) {
          const dist = this.haversineDistance(place.lat, place.lng, m.latitude, m.longitude)
          return dist < 0.1
        }
        // No loose name-matching fallback — a generic/short hospital
        // name could accidentally match an unrelated Google result,
        // silently "consuming" a Medovite hospital as a false match
        // and preventing it from ever reaching the standalone-entry
        // loop below. Exact ID or genuine proximity only.
        return false
      })

      if (medoviteMatch) matchedMedoviteIds.add(medoviteMatch.id)

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

    // ── Standalone entries ──────────────────────────────────────
    // Add any Medovite hospital that never matched a Google result,
    // as long as it has coordinates and falls within the search radius.
    for (const hospital of medoviteHospitals) {
      if (matchedMedoviteIds.has(hospital.id)) continue
      if (!hospital.latitude || !hospital.longitude) continue

      const distance = this.haversineDistance(lat, lng, hospital.latitude, hospital.longitude)
      if (distance > radiusKm) continue

      results.push({
        placeId: hospital.googlePlaceId ?? null, // no Google presence — null is expected here
        medoviteId: hospital.id,
        name: hospital.name,
        type: hospital.type ?? 'General',
        address: hospital.address ?? 'Address not available',
        lat: hospital.latitude,
        lng: hospital.longitude,
        isOpenNow: null, // unknown without a Google listing
        rating: hospital.listing?.rating ?? null,
        userRatingsTotal: 0,
        thumbnail: hospital.listing?.photos?.[0] ?? null,
        phone: hospital.phone ?? null,
        website: hospital.website ?? null,
        openingHours: null,
        photos: hospital.listing?.photos ?? [],
        emergency: hospital.listing?.emergencyAvailable ?? false,
        isMedovite: true, // always true — this branch only runs for our own hospitals
        medoviteVerified: hospital.listing?.medoviteVerified ?? false,
        specialties: hospital.listing?.specialties ?? [],
        emergencyAvailable: hospital.listing?.emergencyAvailable ?? false,
        distance,
      })
    }

    results.sort((a: any, b: any) => a.distance - b.distance)
    return results
  }

  // ── Get full place details (called only when user taps a hospital) ──
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

  // ── Get single Medovite hospital ──────────────────────────
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

  // ── Google Places Nearby Search (cheap — no details) ─────
  // Returns basic info only (name, address, rating, one thumbnail).
  // Full details (phone, website, opening hours) are fetched
  // separately and only when a user actually taps into a hospital,
  // to keep Google Places API costs down.
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
      this.logger.error('Google Places nearby search failed', err)
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