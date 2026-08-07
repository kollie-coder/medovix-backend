// src/auth/auth.service.ts
import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  NotFoundException,  
  BadRequestException, 
} from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '../prisma/prisma.service'
import { RegisterDto } from './dto/register.dto'
import { LoginDto } from './dto/login.dto'
import * as bcrypt from 'bcryptjs'
import * as crypto from 'crypto'
import { Role } from '@prisma/client'

import { generateSecret, generate, verify, generateURI } from 'otplib'
import * as qrcode from 'qrcode'

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
      id: true, email: true, firstName: true, lastName: true, role: true,
      hospitalId: true, passwordHash: true, active: true,
      twoFactorEnabled: true,
    },
  })
 
  if (!user) throw new UnauthorizedException('Invalid email or password')
  if (!user.active) throw new UnauthorizedException('Your account has been deactivated')
 
  const passwordValid = await bcrypt.compare(dto.password, user.passwordHash)
  if (!passwordValid) throw new UnauthorizedException('Invalid email or password')
 
  // If 2FA is enabled, don't issue tokens yet — require a second step
  if (user.twoFactorEnabled) {
    // Short-lived token just to prove they passed step 1 (password check)
    // Used to call /auth/2fa/login-verify next
    const pendingToken = this.jwt.sign(
      { sub: user.id, purpose: '2fa_pending' },
      { expiresIn: '5m' as any },
    )
    return {
      requires2FA: true,
      pendingToken,
    }
  }
 
  await this.prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })
 
  const tokens = await this.generateTokens(user.id, user.email, user.role)
  const { passwordHash, twoFactorEnabled, ...userWithoutPassword } = user
  return { user: userWithoutPassword, ...tokens }
}
 
// ── Complete login after 2FA code verification ─────────────
async completeLogin2FA(pendingToken: string, code: string) {
  let payload: any
  try {
    payload = this.jwt.verify(pendingToken)
  } catch {
    throw new UnauthorizedException('Login session expired. Please log in again.')
  }
 
  if (payload.purpose !== '2fa_pending') {
    throw new UnauthorizedException('Invalid session')
  }
 
  // Try TOTP code first (6 digits), fall back to backup code format (XXXXX-XXXXX)
  const isTotpFormat = /^\d{6}$/.test(code.trim())
 
  let isValidCode = false
  let usedBackupCode = false
 
  if (isTotpFormat) {
    isValidCode = await this.verify2FALogin(payload.sub, code)
  }
 
  if (!isValidCode) {
    // Either it wasn't TOTP-shaped, or the TOTP check failed —
    // try it as a backup code before giving up
    isValidCode = await this.tryVerifyBackupCode(payload.sub, code)
    usedBackupCode = isValidCode
  }
 
  if (!isValidCode) {
    throw new UnauthorizedException('Invalid code. Please check your authenticator app or use a backup code.')
  }
 
  const user = await this.prisma.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      role: true, hospitalId: true,
    },
  })
 
  if (!user) throw new UnauthorizedException('User not found')
 
  await this.prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  })
 
  const tokens = await this.generateTokens(user.id, user.email, user.role)
 
  return {
    user,
    ...tokens,
    ...(usedBackupCode && {
      warning: 'You logged in using a backup code. This code can no longer be used.',
    }),
  }
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
      dateOfBirth: true,
      gender: true,
      role: true,
      hospitalId: true,
      avatar: true,
      emailVerified: true,
      twoFactorEnabled: true,
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


async changePassword(userId: string, dto: {
  currentPassword: string
  newPassword: string
}) {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  })
 
  if (!user) throw new NotFoundException('User not found')
 
  const isValid = await bcrypt.compare(dto.currentPassword, user.passwordHash)
  if (!isValid) {
    throw new UnauthorizedException('Current password is incorrect')
  }
 
  if (dto.newPassword.length < 8) {
    throw new BadRequestException('New password must be at least 8 characters')
  }
 
  const newHash = await bcrypt.hash(dto.newPassword, 12)
 
  await this.prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newHash },
  })
 
  // Revoke all existing refresh tokens so other devices are logged out
  // for security — the user will need to log in again everywhere except
  // the device they just changed the password from
  await this.prisma.refreshToken.updateMany({
    where: { userId },
    data: { revoked: true },
  })
 
  return { message: 'Password changed successfully' }
}  


// ── 2FA: Generate setup (secret + QR code) ─────────────────
// Reuses the existing secret if one is already saved, instead of
// generating a new one every time — this avoids the authenticator app
// ending up with duplicate "Medovix" entries after disable/re-enable cycles.
async setup2FA(userId: string, userEmail: string) {
  const existing = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true },
  })
 
  const secret = existing?.twoFactorSecret ?? generateSecret()
 
  await this.prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: secret },
  })
 
  const otpauthUrl = generateURI({
    issuer: 'Medovix',
    label: userEmail,
    secret,
  })
  const qrCodeDataUrl = await qrcode.toDataURL(otpauthUrl)
 
  return {
    secret,
    qrCode: qrCodeDataUrl,
  }
}

private generateBackupCodes(count: number = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase() // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}` // e.g. "A1B2C-3D4E5"
  })
}
 
private async hashBackupCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map(code => bcrypt.hash(code, 10)))
}

// ── Regenerate backup codes (if user wants fresh ones) ──────
async regenerateBackupCodes(userId: string, password: string) {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, twoFactorEnabled: true },
  })
 
  if (!user) throw new NotFoundException('User not found')
  if (!user.twoFactorEnabled) {
    throw new BadRequestException('2FA is not enabled on this account')
  }
 
  const isValid = await bcrypt.compare(password, user.passwordHash)
  if (!isValid) throw new UnauthorizedException('Incorrect password')
 
  const backupCodes = this.generateBackupCodes()
  const hashedCodes = await this.hashBackupCodes(backupCodes)
 
  await this.prisma.user.update({
    where: { id: userId },
    data: { backupCodes: hashedCodes },
  })
 
  return { backupCodes }
}
 
// ── Get remaining backup code count (for settings display) ──
async getBackupCodeStatus(userId: string) {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { backupCodes: true, twoFactorEnabled: true },
  })
 
  return {
    twoFactorEnabled: user?.twoFactorEnabled ?? false,
    remainingBackupCodes: user?.backupCodes?.length ?? 0,
  }
}
 
// ── Verify a backup code (single-use) ────────────────────────
private async tryVerifyBackupCode(userId: string, code: string): Promise<boolean> {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { backupCodes: true },
  })
 
  if (!user?.backupCodes || user.backupCodes.length === 0) return false
 
  const normalizedInput = code.trim().toUpperCase()
 
  for (const hashedCode of user.backupCodes) {
    const matches = await bcrypt.compare(normalizedInput, hashedCode)
    if (matches) {
      // Remove this code — single use only
      const remaining = user.backupCodes.filter(c => c !== hashedCode)
      await this.prisma.user.update({
        where: { id: userId },
        data: { backupCodes: remaining },
      })
      return true
    }
  }
 
  return false
}
 
// ── 2FA: Verify code and enable (now also issues backup codes) ──
async verify2FA(userId: string, code: string) {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true },
  })
 
  if (!user?.twoFactorSecret) {
    throw new BadRequestException('2FA setup not started. Please request a new QR code.')
  }
 
  const result = await verify({ secret: user.twoFactorSecret, token: code })
  const isValid = result.valid
 
  if (!isValid) {
    throw new UnauthorizedException('Invalid code. Please check your authenticator app and try again.')
  }
 
  // Generate backup codes fresh every time 2FA is (re-)enabled —
  // any previous codes are invalidated by this overwrite
  const backupCodes = this.generateBackupCodes()
  const hashedCodes = await this.hashBackupCodes(backupCodes)
 
  await this.prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: true, backupCodes: hashedCodes },
  })
 
  return {
    message: '2FA enabled successfully',
    backupCodes, // plaintext — shown ONCE, never retrievable again after this response
  }
}
 
// ── 2FA: Disable ──────────────────────────────────────────
// Only flips twoFactorEnabled to false — keeps twoFactorSecret intact
// so re-enabling reuses the SAME authenticator app entry rather than
// creating a confusing duplicate with a different secret.
async disable2FA(userId: string, password: string) {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  })
 
  if (!user) throw new NotFoundException('User not found')
 
  const isValid = await bcrypt.compare(password, user.passwordHash)
  if (!isValid) {
    throw new UnauthorizedException('Incorrect password')
  }
 
  await this.prisma.user.update({
    where: { id: userId },
    data: { twoFactorEnabled: false }, // twoFactorSecret intentionally left untouched
  })
 
  return { message: '2FA disabled' }
}
 
// ── 2FA: Full reset (new secret, forces re-scan) ───────────
// Only call this if the user explicitly wants to reset — e.g. they
// lost their phone/authenticator app and need a completely fresh secret.
async reset2FASecret(userId: string, password: string) {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  })
 
  if (!user) throw new NotFoundException('User not found')
 
  const isValid = await bcrypt.compare(password, user.passwordHash)
  if (!isValid) {
    throw new UnauthorizedException('Incorrect password')
  }
 
  await this.prisma.user.update({
    where: { id: userId },
    data: { twoFactorSecret: null, twoFactorEnabled: false },
  })
 
  return { message: '2FA reset — set up again with a new QR code' }
}
 
// ── 2FA: Verify code during login (called from login flow) ─
async verify2FALogin(userId: string, code: string): Promise<boolean> {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorSecret: true },
  })
 
  if (!user?.twoFactorSecret) return false
 
  const result = await verify({ secret: user.twoFactorSecret, token: code })
  return result.valid
}


async updateProfile(userId: string, dto: {
  firstName?: string
  lastName?: string
  phone?: string
  dateOfBirth?: string
  gender?: 'MALE' | 'FEMALE' | 'OTHER' | 'PREFER_NOT_TO_SAY'
  bloodGroup?: string
  allergies?: string[]
  weight?: number
  height?: number
}) {
  const { bloodGroup, allergies, weight, height, ...userFields } = dto
 
  // Update User table fields
  const userUpdateData: any = { ...userFields }
  if (dto.dateOfBirth) {
    userUpdateData.dateOfBirth = new Date(dto.dateOfBirth)
  }
 
  const user = await this.prisma.user.update({
    where: { id: userId },
    data: userUpdateData,
    select: {
      id: true, email: true, phone: true, firstName: true, lastName: true,
      dateOfBirth: true, gender: true, role: true, hospitalId: true,
      avatar: true, emailVerified: true,
    },
  })
 
  // Update or create PublicProfile fields (only for PUBLIC role users)
  let publicProfile: any = null
  if (user.role === 'PUBLIC' && (bloodGroup || allergies || weight || height)) {
    publicProfile = await this.prisma.publicProfile.upsert({
      where: { userId },
      update: {
        ...(bloodGroup && { bloodGroup: bloodGroup as any }),
        ...(allergies && { allergies }),
        ...(weight !== undefined && { weight }),
        ...(height !== undefined && { height }),
      },
      create: {
        userId,
        bloodGroup: (bloodGroup as any) ?? 'UNKNOWN',
        allergies: allergies ?? [],
        weight,
        height,
      },
    })
  }
 
  return { ...user, publicProfile }
}



}