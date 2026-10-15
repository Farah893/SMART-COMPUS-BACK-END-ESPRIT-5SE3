import { Permission } from "../models/index.js";
import { ROLES } from "../utils/validation.js";

export const PERMISSIONS = [
  { key: "users.manage", label: "Gérer les comptes utilisateurs", group: "Utilisateurs" },
  { key: "users.roles", label: "Modifier les rôles et permissions", group: "Utilisateurs" },
  { key: "academic.view", label: "Consulter le parcours académique", group: "Académique" },
  { key: "academic.manage", label: "Créer et gérer les cours, affecter les enseignants", group: "Académique" },
  { key: "academic.grades", label: "Saisir et publier les notes", group: "Académique" },
  { key: "resources.book", label: "Réserver une salle ou un équipement", group: "Ressources" },
  { key: "resources.manage", label: "Gérer les salles, valider les réservations et la maintenance", group: "Ressources" },
  { key: "housing.request", label: "Déposer une demande d'hébergement", group: "Résidences" },
  { key: "housing.assign", label: "Affecter les chambres", group: "Résidences" },
  { key: "clubs.join", label: "Adhérer aux clubs et événements", group: "Vie étudiante" },
  { key: "clubs.manage", label: "Gérer les clubs et leurs événements", group: "Vie étudiante" },
  { key: "library.borrow", label: "Emprunter et réserver des ouvrages", group: "Bibliothèque" },
  { key: "library.manage", label: "Gérer le catalogue et les prêts", group: "Bibliothèque" },
];

/** Droits par défaut, appliqués au premier démarrage seulement. */
const DEFAULT_GRANTS = {
  student: ["academic.view", "housing.request", "library.borrow", "resources.book", "clubs.join"],
  teacher: ["academic.view", "academic.grades", "resources.book", "library.borrow", "clubs.join"],
  admin: PERMISSIONS.map((p) => p.key),
};

export async function seedPermissions() {
  await Permission.bulkWrite(
    ROLES.flatMap((role) =>
      PERMISSIONS.map(({ key }) => ({
        updateOne: { filter: { role, key }, update: { $setOnInsert: { granted: DEFAULT_GRANTS[role].includes(key) } }, upsert: true },
      })),
    ),
  );
}

export async function permissionMatrix() {
  const rows = await Permission.find();
  const matrix = Object.fromEntries(ROLES.map((r) => [r, Object.fromEntries(PERMISSIONS.map((p) => [p.key, false]))]));
  for (const { role, key, granted } of rows) if (matrix[role] && key in matrix[role]) matrix[role][key] = granted;
  return matrix;
}
