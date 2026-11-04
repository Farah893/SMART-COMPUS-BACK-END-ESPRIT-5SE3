import nodemailer, { type Transporter } from "nodemailer";
import type { MailService } from "../../shared/ports/index.js";
import type { Config } from "../../config/index.js";
import { logger } from "../logging/logger.js";
import { accountCreated, passwordReset, verificationCode, type MailContent } from "./templates.js";

export class SmtpMailer implements MailService {
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(smtp: Config["smtp"]) {
    this.from = smtp.from;
    this.transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    });
  }

  /** Un échec d'envoi ne doit jamais faire échouer la création du compte : on journalise. */
  private async send(to: string, { subject, html, text }: MailContent): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.from, to, subject, html, text });
    } catch (e) {
      logger.warn({ err: e, to }, "e-mail non envoyé");
    }
  }

  sendTemporaryPassword = (user: Parameters<MailService["sendTemporaryPassword"]>[0], temporary: string) =>
    this.send(user.email, accountCreated(user, temporary));
  sendVerificationCode = (email: string, code: string) => this.send(email, verificationCode(code));
  sendResetLink = (email: string, token: string) => this.send(email, passwordReset(email, token));
}
