// src/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '../prisma/prisma.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import * as bcrypt from 'bcryptjs'
import { Role } from '@prisma/client'

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  // ── Register ────────────────────────────────────────────
  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    })
    if (existing) {
      throw new ConflictException('An account with this email already exists')
    }

    const passwordHash = await bcrypt.hash(dto.password, 12)

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        phone: dto.phone,
        role: dto.role ?? Role.PUBLIC,
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
      },
    })

    if (user.role === Role.PUBLIC) {
      await this.prisma.publicProfile.create({
        data: { userId: user.id },
      })
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role)
    return { user, ...tokens }
  }

  // ── Login ───────────────────────────────────────────────
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        passwordHash: true,
        active: true,
      },
    })

    if (!user) throw new UnauthorizedException('Invalid email or password')
    if (!user.active) throw new UnauthorizedException('Your account has been deactivated')

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash)
    if (!passwordValid) throw new UnauthorizedException('Invalid email or password')

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    const tokens = await this.generateTokens(user.id, user.email, user.role)
    const { passwordHash, ...userWithoutPassword } = user
    return { user: userWithoutPassword, ...tokens }
  }

  // ── Google OAuth ─────────────────────────────────────────
  async googleAuth(code: string, codeVerifier: string, redirectUri: string) {
  // Exchange authorization code for tokens
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID as string,
      client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString(),
  })
 
  if (!tokenResponse.ok) {
    const err = await tokenResponse.json()
    console.error('Google token exchange error:', err)
    throw new UnauthorizedException('Failed to exchange Google authorization code')
  }
 
  const { access_token } = await tokenResponse.json()
 
  // Get user info using access token
  const userInfoResponse = await fetch(
    'https://www.googleapis.com/oauth2/v3/userinfo',
    { headers: { Authorization: `Bearer ${access_token}` } }
  )
 
  if (!userInfoResponse.ok) {
    throw new UnauthorizedException('Failed to get Google user info')
  }
 
  const { email, given_name, family_name, picture, sub: googleId } = await userInfoResponse.json()
 
  if (!email) throw new UnauthorizedException('Google account has no email')
 
  // Find or create user
  let user = await this.prisma.user.findUnique({
    where: { email },
    select: {
      id: true, email: true, firstName: true,
      lastName: true, role: true, hospitalId: true, active: true,
    },
  })
 
  if (user) {
    if (!user.active) throw new UnauthorizedException('Your account has been deactivated')
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), avatar: picture ?? undefined },
    })
  } else {
    const newUser = await this.prisma.user.create({
      data: {
        email,
        firstName: given_name ?? 'User',
        lastName: family_name ?? '',
        passwordHash: await bcrypt.hash(googleId, 12),
        role: Role.PUBLIC,
        avatar: picture ?? null,
        emailVerified: true,
      },
      select: {
        id: true, email: true, firstName: true,
        lastName: true, role: true, hospitalId: true, active: true,
      },
    })
    await this.prisma.publicProfile.create({ data: { userId: newUser.id } })
    user = newUser
  }
 
  const tokens = await this.generateTokens(user.id, user.email, user.role)
  return { user, ...tokens }
}

  // ── Refresh token ───────────────────────────────────────
  async refresh(token: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { token },
      include: { user: true },
    })

    if (!stored || stored.revoked || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token')
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revoked: true },
    })

    const tokens = await this.generateTokens(
      stored.user.id,
      stored.user.email,
      stored.user.role,
    )
    return tokens
  }

  // ── Logout ──────────────────────────────────────────────
  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({
      where: { token },
      data: { revoked: true },
    })
    return { message: 'Logged out successfully' }
  }

  // ── Get current user ────────────────────────────────────
  async getMe(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        hospitalId: true,
        avatar: true,
        emailVerified: true,
        createdAt: true,
        publicProfile: true,
        patientProfile: true,
      },
    })
  }

  // ── Generate tokens ─────────────────────────────────────
  private async generateTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role }

    const accessToken = this.jwt.sign(payload)

    const refreshToken = this.jwt.sign(payload, {
      expiresIn: '7d' as any,
      secret: (process.env.JWT_SECRET as string) + '_refresh',
    })

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    await this.prisma.refreshToken.create({
      data: { token: refreshToken, userId, expiresAt },
    })

    return { accessToken, refreshToken }
  }
}