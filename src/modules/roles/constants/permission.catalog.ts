import type { Role } from "../../../shared/constants/index.js";

export interface PermissionDefinition {
  key: string;
  label: string;
  group: string;
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
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
export const DEFAULT_GRANTS: Readonly<Record<Role, readonly string[]>> = {
  student: ["academic.view", "housing.request", "library.borrow", "resources.book", "clubs.join"],
  teacher: ["academic.view", "academic.grades", "resources.book", "library.borrow", "clubs.join"],
  admin: PERMISSIONS.map((p) => p.key),
};
