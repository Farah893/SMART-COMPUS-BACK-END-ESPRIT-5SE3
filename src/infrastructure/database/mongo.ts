import mongoose from "mongoose";

export interface DatabaseOptions {
  maxPoolSize?: number;
  serverSelectionTimeoutMS?: number;
}

/**
 * Délais bornés : une base injoignable fait échouer le démarrage en quelques secondes (l'orchestrateur relance)
 * au lieu de laisser le processus suspendu. Le pilote se reconnecte seul après une coupure en cours d'exécution.
 */
export const connectDatabase = (uri: string, options: DatabaseOptions = {}) =>
  mongoose.connect(uri, { socketTimeoutMS: 45_000, ...options });
export const disconnectDatabase = () => mongoose.disconnect();
export const isDatabaseUp = (): boolean => mongoose.connection.readyState === 1;

/**
 * Les index uniques (e-mail, rôle+permission) doivent exister AVANT d'insérer : sinon deux instances qui
 * démarrent ensemble créent des doublons, et MongoDB refuse ensuite de construire l'index.
 */
export const ensureIndexes = async (): Promise<void> => {
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
};
