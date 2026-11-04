// Transforme le rapport JSON de Trivy en annotations GitHub (`::error::`), lisibles dans l'onglet Actions et via l'API,
// puis termine en échec (code 1) s'il y a au moins un constat. Usage : node trivy-annotations.mjs rapport.json
import { readFileSync } from "node:fs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const clean = (s) => String(s ?? "").replace(/[\r\n%]/g, " ").slice(0, 200); // une annotation tient sur une ligne
const findings = [];

for (const result of report.Results ?? []) {
  for (const v of result.Vulnerabilities ?? []) {
    findings.push({
      key: `${v.PkgName}@${v.InstalledVersion}`,
      text: `${v.Severity} ${v.VulnerabilityID} : ${v.PkgName} ${v.InstalledVersion} -> corrigé en ${v.FixedVersion || "?"} [${result.Target}]`,
    });
  }
  for (const m of result.Misconfigurations ?? []) {
    findings.push({ key: m.ID, text: `${m.Severity} ${m.ID} : ${m.Title} [${result.Target}]` });
  }
  for (const s of result.Secrets ?? []) {
    findings.push({ key: s.RuleID, text: `${s.Severity} SECRET ${s.RuleID} : ${s.Title} [${result.Target}]` });
  }
}

// GitHub n'affiche que 10 annotations d'erreur par étape : on regroupe par paquet, et le total est dit à part.
const unique = [...new Map(findings.map((f) => [f.key, f])).values()];
console.info(`Trivy : ${findings.length} constat(s), ${unique.length} paquet(s) ou règle(s) distinct(s).`);
for (const f of unique) console.info(f.text); // aussi dans le journal complet
for (const f of unique.slice(0, 9)) console.info(`::error title=Trivy::${clean(f.text)}`);
if (unique.length > 9) console.info(`::error title=Trivy::... et ${unique.length - 9} autre(s) : voir le journal de l'étape`);
process.exit(findings.length > 0 ? 1 : 0);
