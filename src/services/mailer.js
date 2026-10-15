import nodemailer from "nodemailer";
import { config } from "../config.js";

const transport = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

/** Un échec d'envoi ne doit jamais faire échouer la création du compte : on journalise. */
async function send(to, subject, text) {
  try {
    await transport.sendMail({ from: config.smtp.from, to, subject, text });
  } catch (e) {
    console.warn(`[user-service] e-mail non envoyé à ${to} :`, e.message);
  }
}

export const sendTemporaryPassword = (user, temporary) =>
  send(
    user.email,
    "Votre compte SmartCampus",
    `Bonjour ${user.firstName},\n\nUn compte SmartCampus a été créé pour vous.\n\nIdentifiant : ${user.email}\nMot de passe temporaire : ${temporary}\n\nÀ votre première connexion, vous devrez choisir un nouveau mot de passe.\n${config.frontendUrl}/connexion\n`,
  );

export const sendVerificationCode = (email, code) =>
  send(email, "Code de vérification SmartCampus", `Votre code de vérification : ${code}\nIl expire dans 15 minutes.\n`);

export const sendResetLink = (email, token) =>
  send(
    email,
    "Réinitialisation de votre mot de passe",
    `Pour choisir un nouveau mot de passe (lien valable 1 heure) :\n${config.frontendUrl}/reinitialiser-mot-de-passe?email=${encodeURIComponent(email)}&token=${token}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n`,
  );
