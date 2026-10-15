import { config } from "../config.js";

/**
 * Gabarits d'e-mails aux couleurs de SmartCampus (mêmes valeurs que le thème du front : src/index.css).
 * HTML en tableaux et styles en ligne : c'est le seul format rendu de façon fiable par Gmail, Outlook et les mobiles.
 * Chaque gabarit renvoie { subject, html, text } ; la version texte sert de repli.
 */
const C = {
  primary: "#1E3A8A", // --primary
  bg: "#F8FAFC", // --background
  accent: "#DBEAFE", // --accent
  text: "#0F172A", // --foreground
  muted: "#475569", // --muted-foreground
  border: "#E2E8F0",
};
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const ROLE_LABEL = { student: "Étudiant", teacher: "Enseignant", admin: "Administrateur" };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const url = (path) => `${config.frontendUrl.replace(/\/$/, "")}${path}`;

const button = (href, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px"><tr>
    <td style="background:${C.primary};border-radius:10px">
      <a href="${esc(href)}" style="display:inline-block;padding:14px 28px;font:600 15px ${FONT};color:#ffffff;text-decoration:none">${esc(label)}</a>
    </td></tr></table>`;

const panel = (inner) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;background:${C.bg};border:1px solid ${C.border};border-radius:12px"><tr><td style="padding:18px 20px;font:15px ${FONT};color:${C.text}">${inner}</td></tr></table>`;

const mono = (v) => `<span style="font:700 18px 'Courier New',monospace;letter-spacing:2px;color:${C.primary}">${esc(v)}</span>`;

function layout({ preheader, title, body }) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${C.border};border-radius:16px;overflow:hidden">
    <tr><td style="background:${C.primary};padding:22px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:38px;height:38px;background:#ffffff;border-radius:10px;text-align:center;font-size:20px;line-height:38px">🎓</td>
        <td style="padding-left:12px;font:700 20px ${FONT};color:#ffffff;letter-spacing:-0.2px">SmartCampus</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:32px;font:15px/1.6 ${FONT};color:${C.text}">
      <h1 style="margin:0 0 16px;font:700 22px/1.3 ${FONT};color:${C.text}">${esc(title)}</h1>
      ${body}
    </td></tr>
    <tr><td style="background:${C.accent};padding:16px 32px;font:12px/1.5 ${FONT};color:${C.primary}">
      Message automatique de la plateforme SmartCampus, merci de ne pas y répondre.<br>Cours, notes, salles, résidences, clubs et bibliothèque, au même endroit.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const p = (t) => `<p style="margin:0 0 14px;color:${C.text}">${t}</p>`;
const small = (t) => `<p style="margin:14px 0 0;font-size:13px;color:${C.muted}">${t}</p>`;

/** Compte créé par un administrateur : identifiant + mot de passe temporaire. */
export function accountCreated(user, temporary) {
  const role = ROLE_LABEL[user.role] ?? user.role;
  const link = url("/connexion");
  return {
    subject: "Bienvenue sur SmartCampus : votre compte est prêt",
    html: layout({
      preheader: "Votre compte SmartCampus a été créé. Voici vos identifiants de première connexion.",
      title: `Bienvenue, ${user.firstName}`,
      body:
        p(`Un compte <strong>${esc(role)}</strong> vient d'être créé pour vous sur SmartCampus.`) +
        panel(
          `<div style="font-size:13px;color:${C.muted}">Identifiant</div><div style="margin:2px 0 14px;font-weight:600">${esc(user.email)}</div>` +
            `<div style="font-size:13px;color:${C.muted}">Mot de passe temporaire</div><div style="margin-top:4px">${mono(temporary)}</div>`,
        ) +
        p("À votre première connexion, vous devrez choisir un nouveau mot de passe personnel, différent du mot de passe temporaire.") +
        button(link, "Se connecter à SmartCampus") +
        small("Ne communiquez ce mot de passe à personne. Si vous n'attendiez pas ce message, vous pouvez l'ignorer."),
    }),
    text: `Bienvenue sur SmartCampus, ${user.firstName}.\n\nUn compte ${role} a été créé pour vous.\nIdentifiant : ${user.email}\nMot de passe temporaire : ${temporary}\n\nÀ la première connexion, vous devrez choisir un nouveau mot de passe.\nConnexion : ${link}\n`,
  };
}

/** Code de vérification d'adresse e-mail (6 chiffres, 15 minutes). */
export function verificationCode(code) {
  return {
    subject: `${code} est votre code de vérification SmartCampus`,
    html: layout({
      preheader: `Votre code de vérification : ${code}`,
      title: "Vérifiez votre adresse e-mail",
      body:
        p("Saisissez ce code dans SmartCampus pour confirmer votre adresse :") +
        `<div style="margin:20px 0;padding:20px;text-align:center;background:${C.accent};border-radius:12px;font:700 34px 'Courier New',monospace;letter-spacing:10px;color:${C.primary}">${esc(code)}</div>` +
        small("Ce code expire dans 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."),
    }),
    text: `Votre code de vérification SmartCampus : ${code}\nIl expire dans 15 minutes.\n`,
  };
}

/** Lien de réinitialisation du mot de passe (1 heure, usage unique). */
export function passwordReset(email, token) {
  const link = url(`/reinitialiser-mot-de-passe?email=${encodeURIComponent(email)}&token=${token}`);
  return {
    subject: "Réinitialisation de votre mot de passe SmartCampus",
    html: layout({
      preheader: "Choisissez un nouveau mot de passe. Ce lien est valable 1 heure.",
      title: "Réinitialiser votre mot de passe",
      body:
        p("Vous avez demandé à réinitialiser votre mot de passe SmartCampus.") +
        button(link, "Choisir un nouveau mot de passe") +
        small("Ce lien est valable 1 heure et ne peut être utilisé qu'une seule fois. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valide."),
    }),
    text: `Pour choisir un nouveau mot de passe SmartCampus (lien valable 1 heure) :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n`,
  };
}
