import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'

/**
 * Every hospital-staff route filters its data by the caller's hospitalId.
 * In Prisma a filter whose value is `undefined` is silently dropped, so a
 * missing hospitalId would turn "this hospital's patients" into "every
 * hospital's patients". This guard makes that impossible: a caller with no
 * hospitalId on their account never reaches the handler.
 *
 * Use it after JwtAuthGuard, e.g. @UseGuards(JwtAuthGuard, RolesGuard, HospitalScopeGuard)
 */
@Injectable()
export class HospitalScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest()

    if (!user?.hospitalId) {
      throw new ForbiddenException('This account is not linked to a hospital')
    }

    return true
  }
}