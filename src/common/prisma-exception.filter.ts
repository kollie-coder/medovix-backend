import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { Response } from 'express'

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>()

    // Duplicate value on a unique field (email, phone, ...)
    if (exception.code === 'P2002') {
      return res.status(HttpStatus.CONFLICT).json({
        statusCode: 409,
        message:
          'Could not create account with those details. If you already have an account, try signing in or resetting your password.',
        error: 'Conflict',
      })
    }

    // Record to update/delete not found
    if (exception.code === 'P2025') {
      return res.status(HttpStatus.NOT_FOUND).json({
        statusCode: 404,
        message: 'Record not found',
        error: 'Not Found',
      })
    }

    // Anything else stays a generic 500, with details only in the server log
    console.error(exception)
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: 500,
      message: 'Internal server error',
    })
  }
}