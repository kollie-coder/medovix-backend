import { createHmac, timingSafeEqual } from 'crypto'
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

// ─────────────────────────────────────────────────────────────
// Google Places cost protection
//
// Every call to Google costs money, so this file enforces SIX rules:
//   1. Cache successful results (nearby 24h, details 24h, photos 6h).
//   2. NEVER cache a failure (a bad key or billing problem used to be
//      cached as "no hospitals" for 24 hours).
//   3. Share one in-flight request between callers asking for the same
//      thing at the same moment ("single flight").
//   4. After a failure, wait 60s before asking Google again.
//   5. Hard budget: at most GOOGLE_PLACES_DAILY_LIMIT calls per day and
//      GOOGLE_PLACES_MINUTE_LIMIT per minute across ALL users. When the
//      budget is used up we serve the last (stale) result instead.
//   6. Caches have a maximum size, so memory cannot grow without limit.
//
// Medovite's own hospital data is never cached here: it is our own
// database, cheap, and must always be fresh.
// ─────────────────────────────────────────────────────────────
type CacheEntry<T> = { data: T; expiresAt: number }

const nearbyCache = new Map<string, CacheEntry<any[]>>()
const detailsCache = new Map<string, CacheEntry<any>>()
const photoCache = new Map<string, CacheEntry<string>>()
const failedUntil = new Map<string, number>() // key -> do not retry before
const inflight = new Map<string, Promise<any>>()

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const PHOTO_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
const FAILURE_COOLDOWN_MS = 60 * 1000 // 1 minute
const GOOGLE_TIMEOUT_MS = 8000

const MAX_NEARBY_ENTRIES = 500
const MAX_DETAILS_ENTRIES = 2000
const MAX_PHOTO_ENTRIES = 5000

function setCache<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  data: T,
  ttlMs: number,
  maxEntries: number,
) {
  map.delete(key) // re-insert so the newest entry is last
  map.set(key, { data, expiresAt: Date.now() + ttlMs })
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

@Injectable()
export class HospitalsService {
  private readonly logger = new Logger(HospitalsService.name)

  constructor(private prisma: PrismaService) {}

  // Daily / per-minute budget for calls to Google (all users combined).
  private budget = { day: '', dayCount: 0, minuteStart: 0, minuteCount: 0 }

  private allowGoogleCall(kind: string): boolean {
    const now = Date.now()
    const today = new Date(now).toISOString().slice(0, 10)
    if (this.budget.day !== today) {
      this.budget.day = today
      this.budget.dayCount = 0
    }
    if (now - this.budget.minuteStart >= 60_000) {
      this.budget.minuteStart = now
      this.budget.minuteCount = 0
    }

    const dailyLimit = positiveNumberFromEnv('GOOGLE_PLACES_DAILY_LIMIT', 500)
    const minuteLimit = positiveNumberFromEnv('GOOGLE_PLACES_MINUTE_LIMIT', 30)

    if (this.budget.dayCount >= dailyLimit || this.budget.minuteCount >= minuteLimit) {
      this.logger.warn(
        `Google Places budget reached (${kind}): ` +
          `${this.budget.dayCount}/${dailyLimit} today, ` +
          `${this.budget.minuteCount}/${minuteLimit} this minute`,
      )
      return false
    }
    this.budget.dayCount++
    this.budget.minuteCount++
    return true
  }

  // Run fn once for a given key; concurrent callers share the same promise.
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key)
    if (existing) return existing as Promise<T>
    const promise = fn().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  private inCooldown(key: string): boolean {
    const until = failedUntil.get(key)
    if (until === undefined) return false
    if (until > Date.now()) return true
    failedUntil.delete(key)
    return false
  }

  private markFailed(key: string) {
    failedUntil.set(key, Date.now() + FAILURE_COOLDOWN_MS)
    if (failedUntil.size > 1000) {
      const oldest = failedUntil.keys().next().value
      if (oldest !== undefined) failedUntil.delete(oldest)
    }
  }

  // ── Photo proxy: the Google key must never reach a phone ──
  // Phones get a URL on OUR server, signed so nobody can use it to ask
  // for arbitrary photos. The server looks the photo up (and caches it).
  private photoSecret(): string | null {
    return process.env.PHOTO_SIGNING_SECRET || process.env.JWT_SECRET || null
  }

  private signPhoto(ref: string, width: number): string | null {
    const secret = this.photoSecret()
    if (!secret) return null
    return createHmac('sha256', secret).update(`${ref}|${width}`).digest('hex').slice(0, 32)
  }

  private photoUrl(ref: string | undefined, width: number): string | null {
    if (!ref) return null
    const sig = this.signPhoto(ref, width)
    if (!sig) return null
    const base = (process.env.PUBLIC_API_URL ?? 'https://medovix-api.onrender.com').replace(/\/$/, '')
    return `${base}/api/v1/hospitals/photo?ref=${encodeURIComponent(ref)}&w=${width}&sig=${sig}`
  }

  // Called by GET /hospitals/photo — returns the image URL to redirect to.
  async getPhotoRedirect(ref: string, width: number, sig: string): Promise<string> {
    const validShape =
      typeof ref === 'string' && /^[A-Za-z0-9_-]{20,1500}$/.test(ref) &&
      Number.isInteger(width) && width >= 50 && width <= 800 &&
      typeof sig === 'string' && /^[a-f0-9]{32}$/.test(sig)
    if (!validShape) throw new BadRequestException('Invalid photo request')

    const expected = this.signPhoto(ref, width)
    if (!expected || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      throw new NotFoundException('Photo not found')
    }

    const cacheKey = `${ref}|${width}`
    const cached = photoCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.data

    if (this.inCooldown(`photo:${cacheKey}`)) {
      if (cached) return cached.data
      throw new NotFoundException('Photo not available')
    }

    return this.once(`photo:${cacheKey}`, async () => {
      const key = process.env.GOOGLE_PLACES_API_KEY
      if (!key || !this.allowGoogleCall('photo')) {
        if (cached) return cached.data
        throw new NotFoundException('Photo not available')
      }

      try {
        const response = await fetch(
          `https://maps.googleapis.com/maps/api/place/photo` +
            `?maxwidth=${width}&photo_reference=${encodeURIComponent(ref)}&key=${key}`,
          { redirect: 'manual', signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) },
        )
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
          setCache(photoCache, cacheKey, location, PHOTO_TTL_MS, MAX_PHOTO_ENTRIES)
          return location
        }
        this.logger.warn(`Google photo request returned status ${response.status}`)
      } catch (err) {
        this.logger.error('Google photo request failed', err)
      }
      this.markFailed(`photo:${cacheKey}`)
      if (cached) return cached.data
      throw new NotFoundException('Photo not available')
    })
  }

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
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new BadRequestException('Valid lat and lng are required')
    }
    // Whole-km radius, 1-25 km: stops callers busting the cache with odd values
    radiusKm = Number.isFinite(radiusKm) ? Math.min(Math.max(Math.round(radiusKm), 1), 25) : 5

    // lat/lng rounded to 2 decimals (~1 km) so nearby users share one Google call
    const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${radiusKm}`
    const googleHospitals = await this.getGoogleNearbyCached(cacheKey, lat, lng, radiusKm)

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
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(placeId ?? '')) {
      throw new BadRequestException('Invalid place id')
    }

    const cached = detailsCache.get(placeId)
    if (cached && cached.expiresAt > Date.now()) return cached.data

    const cooldownKey = `details:${placeId}`
    if (this.inCooldown(cooldownKey)) return cached?.data ?? null

    return this.once(cooldownKey, async () => {
      if (!this.allowGoogleCall('details')) return cached?.data ?? null

      const details = await this.fetchPlaceDetails(placeId)
      if (details) {
        setCache(detailsCache, placeId, details, CACHE_TTL_MS, MAX_DETAILS_ENTRIES)
        return details
      }
      this.markFailed(cooldownKey)
      return cached?.data ?? null
    })
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

  // ── Cached, single-flight, budget-checked nearby lookup ──
  private async getGoogleNearbyCached(
    cacheKey: string,
    lat: number,
    lng: number,
    radiusKm: number,
  ): Promise<any[]> {
    const cached = nearbyCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.data

    const cooldownKey = `nearby:${cacheKey}`
    // Recent failure or used-up budget: serve the old (stale) list if we have one
    if (this.inCooldown(cooldownKey)) return cached?.data ?? []

    return this.once(cooldownKey, async () => {
      if (!this.allowGoogleCall('nearby')) return cached?.data ?? []

      const fresh = await this.queryGooglePlacesNearby(lat, lng, radiusKm)
      if (fresh === null) {
        // Failure: do NOT cache it. Back off for a minute, then try again.
        this.markFailed(cooldownKey)
        return cached?.data ?? []
      }
      setCache(nearbyCache, cacheKey, fresh, CACHE_TTL_MS, MAX_NEARBY_ENTRIES)
      return fresh
    })
  }

  // ── Google Places Nearby Search (cheap — no details) ─────
  // Returns basic info only (name, address, rating, one thumbnail).
  // Full details (phone, website, opening hours) are fetched
  // separately and only when a user actually taps into a hospital,
  // to keep Google Places API costs down.
  // Returns null when the request FAILED (so callers never cache it),
  // and an array (possibly empty) when Google answered properly.
  private async queryGooglePlacesNearby(lat: number, lng: number, radiusKm: number) {
    const radiusMetres = Math.min(radiusKm * 1000, 50000)
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) {
      this.logger.error('GOOGLE_PLACES_API_KEY is not set')
      return null
    }

    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json` +
      `?location=${lat},${lng}` +
      `&radius=${radiusMetres}` +
      `&type=hospital` +
      `&key=${key}`

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) })
      const data: any = await response.json()

      if (data.status === 'ZERO_RESULTS') return []
      if (data.status !== 'OK') {
        this.logger.warn(
          `Google Places nearby search returned status: ${data.status}` +
            (data.error_message ? ` (${data.error_message})` : ''),
        )
        return null
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
        // Single thumbnail, served through OUR photo proxy (no Google key in the URL)
        thumbnail: this.photoUrl(place.photos?.[0]?.photo_reference, 200),
        // Phone/website/full-hours NOT fetched here — only on detail tap
        phone: null,
        website: null,
        openingHours: null,
        photos: [],
        emergency: false,
      })).filter((h: any) => h.lat && h.lng)
    } catch (err) {
      this.logger.error('Google Places nearby search failed', err)
      return null
    }
  }

  // ── Fetch full Place Details (only called when user taps) ──
  private async fetchPlaceDetails(placeId: string) {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) {
      this.logger.error('GOOGLE_PLACES_API_KEY is not set')
      return null
    }
    const fields = 'place_id,name,formatted_address,formatted_phone_number,website,opening_hours,rating,photos,geometry,types,user_ratings_total'

    const url = `https://maps.googleapis.com/maps/api/place/details/json` +
      `?place_id=${encodeURIComponent(placeId)}` +
      `&fields=${fields}` +
      `&key=${key}`

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) })
      const data: any = await response.json()

      if (data.status !== 'OK') {
        this.logger.warn(
          `Google Place Details returned status: ${data.status} for placeId ${placeId}`,
        )
        return null
      }

      const place = data.result
      const photos = (place.photos ?? [])
        .slice(0, 5)
        .map((p: any) => this.photoUrl(p.photo_reference, 400))
        .filter((u: string | null): u is string => !!u)

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