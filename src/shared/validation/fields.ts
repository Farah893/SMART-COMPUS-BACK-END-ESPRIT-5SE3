import { z } from "zod";
import { ROLES } from "../constants/index.js";

/** Briques réutilisées par les DTO d'entrée de tous les modules. */
export const nameField = z.string().trim().min(1, "Champ requis").max(60);
export const emailField = z.string().trim().toLowerCase().email("Adresse e-mail invalide");
export const roleField = z.enum(ROLES);
/** bcrypt ignore tout après 72 octets : on refuse plus long plutôt que de tronquer en silence. */
const within72Bytes = (s: string) => Buffer.byteLength(s, "utf8") <= 72;
export const passwordField = z.string().min(8).refine(within72Bytes, "Mot de passe trop long (72 octets maximum)");
