import { IsBoolean, IsDateString, IsOptional } from 'class-validator'

/**
 * Only the fields you send are changed:
 *   { taken: true }                 -> mark taken
 *   { skipped: true }               -> mark skipped
 *   { taken: false, skipped: false} -> back to pending (undo)
 *   { snoozedUntil: '<iso>' }       -> remember a snooze (null clears it)
 */
export class MarkDoseDto {
  @IsDateString()
  scheduledAt: string

  @IsOptional() @IsBoolean()
  taken?: boolean

  @IsOptional() @IsBoolean()
  skipped?: boolean

  @IsOptional() @IsDateString()
  snoozedUntil?: string | null
}
