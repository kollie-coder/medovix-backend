import { Injectable } from '@nestjs/common'

@Injectable()
export class EmailService {
  private readonly apiKey = process.env.BREVO_API_KEY
  private readonly senderEmail = process.env.BREVO_SENDER_EMAIL ?? 'noreply@medovix.com'
  private readonly senderName = process.env.BREVO_SENDER_NAME ?? 'Medovix'

  async sendPasswordResetCode(toEmail: string, toName: string, code: string) {
    const html = `
      <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="color: #0A7EA4; font-size: 22px; margin-bottom: 4px;">Medovix</h1>
        <p style="color: #6B7280; font-size: 13px; margin-top: 0; margin-bottom: 24px;">Healthcare Platform</p>

        <h2 style="color: #0D1117; font-size: 18px;">Reset your password</h2>
        <p style="color: #374151; font-size: 14px; line-height: 22px;">
          Hi ${toName},<br><br>
          We received a request to reset your Medovix password. Use the code below to continue:
        </p>

        <div style="background: #F0F7FA; border: 1.5px solid #B8DFF0; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: 700; color: #0A7EA4; letter-spacing: 6px;">${code}</span>
        </div>

        <p style="color: #6B7280; font-size: 13px; line-height: 20px;">
          This code expires in 15 minutes. If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.
        </p>

        <div style="border-top: 1px solid #E5E7EB; margin-top: 32px; padding-top: 16px;">
          <p style="color: #9CA3AF; font-size: 11px;">Medovix Healthcare Platform · This is an automated message, please do not reply.</p>
        </div>
      </div>
    `

    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'api-key': this.apiKey as string,
        },
        body: JSON.stringify({
          sender: { email: this.senderEmail, name: this.senderName },
          to: [{ email: toEmail, name: toName }],
          subject: 'Reset your Medovix password',
          htmlContent: html,
        }),
      })

      if (!response.ok) {
        const err = await response.text()
        console.error('Brevo email error:', err)
        throw new Error('Failed to send email')
      }

      return true
    } catch (err) {
      console.error('Email send error:', err)
      throw err
    }
  }
}