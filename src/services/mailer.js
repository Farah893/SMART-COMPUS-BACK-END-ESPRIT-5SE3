import nodemailer from "nodemailer";
import { config } from "../config.js";
import { accountCreated, passwordReset, verificationCode } from "./emailTemplates.js";

const transport = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

/** Un échec d'envoi ne doit jamais faire échouer la création du compte : on journalise. */
async function send(to, { subject, html, text }) {
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, html, text });
  } catch (e) {
    console.warn(`[user-service] e-mail non envoyé à ${to} :`, e.message);
  }
}

export const sendTemporaryPassword = (user, temporary) => send(user.email, accountCreated(user, temporary));
export const sendVerificationCode = (email, code) => send(email, verificationCode(code));
export const sendResetLink = (email, token) => send(email, passwordReset(email, token));
